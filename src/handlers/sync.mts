/**
 * 同步：把飞书「我的任务」拉进一念，把一念里的完成/重开/改字段推回飞书。
 *
 * ## 一次 pull 做三件事
 *
 * 1. 拉未完成与已完成两批（列表接口按 `completed` 分开，不会混在一起返回）；
 * 2. 去重（极少数任务会同时出现在两批里，以已完成为准）；
 * 3. 补详情——列表接口不给 `start` 与 `completed_at`。
 *
 * 补详情要限流：每条任务一次请求，而 `sync.pull` 只有 120 秒。并发数与单轮上限
 * 照搬 `nikou-screen` 上实测可用的值（4 / 80），剩下的下一轮再补，首次同步会分
 * 几轮逐步补齐。
 */

import { context, logger, progress, setState } from "../sdk/index.mjs";
import type {
  ExternalItem,
  PullRequest,
  PullResult,
  PushRequest,
  PushResult,
} from "../sdk/index.mjs";
import { AuthError } from "../feishu/auth.mjs";
import { FeishuClient, type FeishuTask } from "../feishu/client.mjs";
import { configOf, credentialsFrom } from "../feishu/pluginConfig.mjs";
import {
  applyDetail,
  needsDetail,
  parseMs,
  toUpdatePayload,
} from "../feishu/mapping.mjs";
import { toExternalItem } from "../feishu/mapping.mjs";
import { pull as pullEvents } from "./syncEvent.mjs";

/** 同时最多发几个详情请求。太高会撞飞书限流，太低补不完。 */
const DETAIL_CONCURRENCY = 4;
/** 单轮最多补多少条详情。剩下的下一轮再补，避免一次同步跑超时。 */
const DETAIL_MAX_PER_ROUND = 80;
/** 一次 pull 最多翻多少页列表。50 条一页，40 页 = 2000 条，够个人用量。 */
const MAX_PAGES = 40;

function client(config: Record<string, unknown>): FeishuClient {
  return new FeishuClient(credentialsFrom(config), context().dataDir);
}

/**
 * 合并两批任务并去重。
 *
 * **以已完成为准**：未完成列表偶尔会残留刚被标完成的任务（飞书两个列表不是同一
 * 时刻的快照）。若以未完成为准，用户刚在飞书里勾完的任务会被拉回成未完成，
 * 下一轮又被改回去，来回抖动。
 */
export function mergeTasks(
  open: readonly FeishuTask[],
  done: readonly FeishuTask[],
  timeZone?: string,
): ExternalItem[] {
  const byId = new Map<string, ExternalItem>();
  for (const task of open) {
    const item = toExternalItem(task, "todo", timeZone);
    if (item) byId.set(item.externalId, item);
  }
  for (const task of done) {
    const item = toExternalItem(task, "done", timeZone);
    if (item) byId.set(item.externalId, item);
  }
  return [...byId.values()];
}

export async function pull(request: PullRequest): Promise<PullResult> {
  // 宿主按 manifest 声明的 resources 逐个调用，task 与 event 是两次独立的 pull
  if (request.resource === "event") {
    return pullEvents(request);
  }

  const config = configOf(request);
  // 用户可以把一个实例设成「只同步日历」。返回空 items 是安全的：
  // task 的删除只认 deletedExternalIds，不会因为这轮没给条目就动本地数据
  if (config["syncTasks"] === false) {
    return { items: [], hasMore: false, deletedExternalIds: [] };
  }

  const api = client(config);
  const syncCompleted = config["syncCompleted"] !== false;
  const detailBackfill = config["detailBackfill"] !== false;

  const [open, done] = await Promise.all([
    listAll(api, false, request.traceId),
    syncCompleted ? listAll(api, true, request.traceId) : Promise.resolve([]),
  ]);

  const items = mergeTasks(open, done);
  const filled = detailBackfill
    ? await backfillDetails(api, items, request.traceId)
    : items;

  // 记一下补到哪了，界面上能看出首次同步还没补完
  const remaining = detailBackfill ? filled.filter(needsDetail).length : 0;
  setState({
    ...(request.integrationId ? { integrationId: request.integrationId } : {}),
    state: { detailBacklog: remaining, lastPullAt: new Date().toISOString() },
  });

  logger.info(
    `拉取完成：未完成 ${open.length}、已完成 ${done.length}，待补详情 ${remaining}`,
    { traceId: request.traceId, code: "FEISHU_PULL_DONE" },
  );

  return {
    items: filled,
    // 一次 pull 内部已经翻完所有页，不需要宿主再调一轮
    hasMore: false,
    // 飞书列表接口不告诉我们「哪些被删了」，只能靠任务从列表里消失来推断，
    // 而那无法与「被移出我的任务」区分开。不报删除，交给用户自己处理
    deletedExternalIds: [],
  };
}

async function listAll(
  api: FeishuClient,
  completed: boolean,
  traceId: string,
): Promise<Array<Awaited<ReturnType<FeishuClient["getTask"]>> & object>> {
  const all: NonNullable<Awaited<ReturnType<FeishuClient["getTask"]>>>[] = [];
  let pageToken = "";

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await api.listMyTasks({
      completed,
      ...(pageToken ? { pageToken } : {}),
    });
    all.push(...result.items);
    if (!result.hasMore || !result.pageToken) break;
    pageToken = result.pageToken;

    if (page === MAX_PAGES) {
      logger.warn(
        `${completed ? "已完成" : "未完成"}任务超过 ${MAX_PAGES} 页，剩下的没拉`,
        { traceId, code: "FEISHU_PAGE_LIMIT" },
      );
    }
  }
  return all;
}

/** 并发补详情，保留原顺序无所谓，重点是限流与单轮上限。 */
async function backfillDetails(
  api: FeishuClient,
  items: ExternalItem[],
  traceId: string,
): Promise<ExternalItem[]> {
  const targets = items.filter(needsDetail).slice(0, DETAIL_MAX_PER_ROUND);
  if (targets.length === 0) return items;

  const details = new Map<string, Awaited<ReturnType<FeishuClient["getTask"]>>>();
  let cursor = 0;
  let finished = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      if (!target) return;
      try {
        details.set(target.externalId, await api.getTask(target.externalId));
      } catch (error) {
        // 单条补不到不该让整轮同步失败：主字段已经从列表拿到了
        if (error instanceof AuthError) throw error;
        logger.debug(
          `补详情失败 ${target.externalId}：${error instanceof Error ? error.message : String(error)}`,
          { traceId },
        );
      }
      finished += 1;
      if (finished % 20 === 0) {
        progress({
          traceId,
          phase: "backfill",
          current: finished,
          total: targets.length,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(DETAIL_CONCURRENCY, targets.length) }, worker),
  );

  return items.map((item) => {
    const detail = details.get(item.externalId);
    return detail === undefined ? item : applyDetail(item, detail);
  });
}

export async function push(request: PushRequest): Promise<PushResult> {
  const api = client(configOf(request));
  const guid = request.externalId;
  if (!guid) {
    // 一期不做双向创建，宿主也不会下发 create
    throw new Error("回写缺少 externalId");
  }

  switch (request.action) {
    case "complete": {
      // 用一念记录的真实完成时间，不用当前时间：补同步历史任务时，
      // 用当前时间会把它们的完成时间全改成今天
      const ms = parseMs(
        request.item.completedAt ? Date.parse(request.item.completedAt) : null,
      );
      const task = await api.complete(guid, ms ?? Date.now());
      return outcome(guid, task);
    }

    case "reopen": {
      const task = await api.reopen(guid);
      return outcome(guid, task);
    }

    case "cancel": {
      // 飞书任务没有「取消」状态。manifest 里没声明 cancel，宿主会先降级；
      // 真收到了就按完成处理，总比丢掉这次变更好
      logger.warn("飞书没有取消状态，按完成处理", { traceId: request.traceId });
      const task = await api.complete(guid, Date.now());
      return outcome(guid, task);
    }

    case "update": {
      const payload = toUpdatePayload(request.item, request.changedFields ?? []);
      if (!payload) {
        // 改的都是飞书没有的字段（优先级、标签）→ 明确说「没改」，
        // 报错会让宿主一直重试一件本来就做不到的事
        return { applied: false };
      }
      const task = await api.update(guid, payload.fields, payload.updateFields);
      return outcome(guid, task);
    }

    default:
      throw new Error(`飞书插件不支持动作 ${request.action}`);
  }
}

function outcome(
  guid: string,
  task: Awaited<ReturnType<FeishuClient["getTask"]>>,
): PushResult {
  const result: PushResult = { applied: true, externalId: guid };
  const completedMs = parseMs(task?.completed_at);
  const createdMs = parseMs(task?.created_at);
  const updated = Math.max(completedMs ?? 0, createdMs ?? 0);
  // 把远端时间报回去，宿主的 ack 窗口才能判断下一轮拉到的值是不是旧的
  if (updated > 0) result.remoteUpdatedAt = new Date(updated).toISOString();
  if (task) result.remoteData = task;
  return result;
}
