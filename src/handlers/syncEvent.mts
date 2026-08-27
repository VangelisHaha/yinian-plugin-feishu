/**
 * 日历同步：把飞书日程（含视频会议）拉成一念的只读日历事件。
 *
 * **pull-only，远端权威**（契约 §5.1.1）。宿主不会对 event 调 `sync.push`，外部日历
 * 一律落成只读日历——飞书里的会议改到几点是外部已经发生的事实，两边各改一半再 merge
 * 结果和两边都不一致。想在一念里改，就手工建一个 Event。
 *
 * ## 为什么不开 `eventsComplete`
 *
 * 我们拉的是一个**滚动窗口**（默认过去 7 天 ~ 未来 90 天），不是「这些日历的完整集合」。
 * 开了它，第 8 天时滑出窗口的历史会议会被宿主全部标成「已取消」——用户会看到上周的会
 * 集体变成取消状态。所以删除靠两条显式信号：
 *
 * 1. 飞书自己把取消的日程以 `status: cancelled` 返回（官方 CLI 也是靠它过滤的）；
 * 2. 插件记账：上一轮在窗口内见过、这一轮没见到，就是真的删了。**只报仍落在当前
 *    窗口内的 id**，否则每轮都会把刚滑出窗口的事件误报成删除。
 *
 * 记账落 `dataDir`，不落 `host.setState`：state 上限 64KB，一个季度的日程 id 能顶到。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { context, logger, setState } from "../sdk/index.mjs";
import type {
  ExternalCalendar,
  ExternalEvent,
  PullRequest,
  PullResult,
} from "../sdk/index.mjs";
import {
  FeishuCalendarClient,
  type CalendarEventInstance,
  type CalendarSummary,
} from "../feishu/calendar.mjs";
import { parseDate, parseSeconds, toExternalEvent } from "../feishu/calendarMapping.mjs";
import { configOf, credentialsFrom } from "../feishu/pluginConfig.mjs";
import { FeishuVcClient } from "../feishu/vc.mjs";
import { syncVcMeetings, VC_CALENDAR_ID } from "./vcSync.mjs";

/** 默认往前拉几天。太长没意义（历史会议看不了几眼），太短会漏掉本周一。 */
const DEFAULT_PAST_DAYS = 7;
/** 默认往后拉几天。一个季度，覆盖绝大多数已排好的事。 */
const DEFAULT_FUTURE_DAYS = 90;
/** 窗口上下限。往后拉一年以上会让每轮同步都在翻十几个 30 天分片。 */
const MAX_PAST_DAYS = 90;
const MAX_FUTURE_DAYS = 365;
/** 一轮最多同步几个日历。个人日历 + 几个订阅日历足够，防止误选一堆资源日历。 */
const MAX_CALENDARS = 10;

const DAY_MS = 86_400_000;
const CALENDAR_THROTTLE_MS = 300_000;
const lastCalendarPull = new Map<string, number>();
const calendarEventCache = new Map<string, ExternalEvent[]>();

function intFrom(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 实例配置里选中的日历 id。空表示「只同步主日历」。 */
export function selectedCalendarIds(config: Record<string, unknown>): string[] {
  const raw = config["calendars"];
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item !== "");
  return [...new Set(ids)].slice(0, MAX_CALENDARS);
}

/** 同步窗口，返回秒级时间戳（日历 API 用秒，任务 API 用毫秒）。 */
export function syncWindow(
  config: Record<string, unknown>,
  now = Date.now(),
): { startSec: number; endSec: number } {
  const past = intFrom(config["calendarPastDays"], DEFAULT_PAST_DAYS, 0, MAX_PAST_DAYS);
  const future = intFrom(
    config["calendarFutureDays"],
    DEFAULT_FUTURE_DAYS,
    1,
    MAX_FUTURE_DAYS,
  );
  return {
    startSec: Math.floor((now - past * DAY_MS) / 1000),
    endSec: Math.floor((now + future * DAY_MS) / 1000),
  };
}

/**
 * `externalId` 的开始时间是否落在窗口内。
 *
 * 只有落在窗口内的「上轮见过、本轮没见到」才是真删除；窗口外的那些只是滑出了视野。
 */
export function withinWindow(
  externalId: string,
  startSec: number,
  endSec: number,
): boolean {
  const at = externalId.lastIndexOf("@");
  if (at === -1) return false;
  const suffix = externalId.slice(at + 1);

  const date = parseDate(suffix);
  if (date !== null) {
    const ms = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(ms)) return false;
    const sec = Math.floor(ms / 1000);
    // 全天日程按当天整体算，只要有交集就算在窗口内
    return sec + 86_400 >= startSec && sec <= endSec;
  }

  const ms = parseSeconds(suffix);
  if (ms === null) return false;
  const sec = Math.floor(ms / 1000);
  return sec >= startSec && sec <= endSec;
}

function seenPath(dataDir: string, integrationId: string): string {
  const safe = integrationId.replace(/[^a-zA-Z0-9_-]/g, "") || "default";
  return join(dataDir, `calendar-seen-${safe}.json`);
}

export function loadSeen(dataDir: string, integrationId: string): Set<string> {
  try {
    const parsed = JSON.parse(
      readFileSync(seenPath(dataDir, integrationId), "utf8"),
    ) as { ids?: unknown };
    if (!Array.isArray(parsed?.ids)) return new Set();
    return new Set(parsed.ids.filter((id): id is string => typeof id === "string"));
  } catch {
    // 文件不存在或坏了都当「第一次同步」：这一轮不报任何删除，下一轮就有基线了
    return new Set();
  }
}

function saveSeen(dataDir: string, integrationId: string, ids: string[]): void {
  const path = seenPath(dataDir, integrationId);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ids })}\n`, { mode: 0o600 });
  } catch (error) {
    // 记账失败只影响「能不能发现远端删除」，不该让整轮同步失败
    logger.warn(
      `日程记账写入失败：${error instanceof Error ? error.message : String(error)}`,
      { code: "FEISHU_CAL_SEEN_WRITE" },
    );
  }
}

/** `resource: "event"` 的 pull。普通日历 5 分钟一次，VC 每轮（默认 60 秒）检查。 */
export async function pull(request: PullRequest): Promise<PullResult> {
  const ctx = context();
  const config = configOf(request);
  const integrationId = request.integrationId || ctx.integrationId || "default";
  const syncCalendars = config["syncCalendars"] !== false;
  const syncVc = config["syncVcMeetings"] === true;

  if (!syncCalendars && !syncVc) {
    return {
      items: [],
      events: [],
      eventsComplete: false,
      hasMore: false,
      deletedExternalIds: [],
    };
  }

  const lastPull = lastCalendarPull.get(integrationId) ?? 0;
  const calendarDue = request.full || Date.now() - lastPull >= CALENDAR_THROTTLE_MS;
  let regular: PullResult = {
    items: [],
    calendars: [],
    events: [],
    eventsComplete: false,
    hasMore: false,
    deletedExternalIds: [],
  };
  if (syncCalendars && calendarDue) {
    regular = await pullCalendars(request);
    lastCalendarPull.set(integrationId, Date.now());
    calendarEventCache.set(integrationId, regular.events ?? []);
  }

  if (!syncVc) return regular;

  const vc = await syncVcMeetings({
    client: new FeishuVcClient(credentialsFrom(config), ctx.dataDir),
    dataDir: ctx.dataDir,
    integrationId,
    traceId: request.traceId,
    regularEvents: calendarEventCache.get(integrationId) ?? regular.events ?? [],
  });
  setState({
    ...(request.integrationId ? { integrationId: request.integrationId } : {}),
    state: {
      lastVcPullAt: new Date().toISOString(),
      vcEventCount: vc.events.length,
      vcDegraded: vc.degraded,
    },
  });
  return {
    ...regular,
    calendars: [
      ...(regular.calendars ?? []),
      { externalId: VC_CALENDAR_ID, name: "临时会议" },
    ],
    events: [...(regular.events ?? []), ...vc.events],
    deletedExternalIds: [
      ...(regular.deletedExternalIds ?? []),
      ...vc.deletedExternalIds,
    ],
  };
}

async function pullCalendars(request: PullRequest): Promise<PullResult> {
  const ctx = context();
  const config = configOf(request);

  const api = new FeishuCalendarClient(credentialsFrom(config), ctx.dataDir);

  const { calendars, targets } = await resolveTargets(api, config);
  const { startSec, endSec } = syncWindow(config);
  const integrationId = request.integrationId || ctx.integrationId || "default";
  const previousSeen = loadSeen(ctx.dataDir, integrationId);

  const events: ExternalEvent[] = [];
  const seen: string[] = [];
  let skipped = 0;

  for (const target of targets) {
    const instances = await api.instances(
      target.calendarId,
      startSec,
      endSec,
      request.traceId,
    );
    for (const instance of dedupe(instances)) {
      const event = toExternalEvent(instance, {
        calendarExternalId: target.calendarId,
        ...(target.name ? { calendarName: target.name } : {}),
      });
      if (!event) {
        skipped += 1;
        continue;
      }
      seen.push(event.externalId);

      // 已取消的日程：只有之前同步过的才回传（让用户看到「这个会取消了」）。
      // 没导入过的直接跳过——凭空出现一条取消事件只是噪声
      if (event.status === "canceled" && !previousSeen.has(event.externalId)) {
        continue;
      }
      events.push(event);
    }
  }

  const seenSet = new Set(seen);
  const deletedExternalIds = [...previousSeen].filter(
    (id) => !seenSet.has(id) && withinWindow(id, startSec, endSec),
  );

  saveSeen(ctx.dataDir, integrationId, seen);
  setState({
    ...(request.integrationId ? { integrationId: request.integrationId } : {}),
    state: {
      lastCalendarPullAt: new Date().toISOString(),
      calendarCount: targets.length,
      eventCount: events.length,
    },
  });

  if (skipped > 0) {
    logger.warn(`有 ${skipped} 条日程时间不完整，已跳过`, {
      traceId: request.traceId,
      code: "FEISHU_CAL_SKIPPED",
    });
  }
  logger.info(
    `日历同步完成：${targets.length} 个日历、${events.length} 条日程` +
      (deletedExternalIds.length > 0
        ? `，${deletedExternalIds.length} 条已从远端消失`
        : ""),
    { traceId: request.traceId, code: "FEISHU_CAL_PULL_DONE" },
  );

  return {
    items: [],
    calendars,
    events,
    // 滚动窗口不是完整集合，开了它会把滑出窗口的历史日程全标成取消
    eventsComplete: false,
    hasMore: false,
    deletedExternalIds,
  };
}

/**
 * 决定这次同步哪些日历，并给出 `ExternalCalendar` 列表。
 *
 * 用户没选（首次启用、或选项还没加载）时退回主日历：一个都不同步会让人以为插件坏了。
 */
async function resolveTargets(
  api: FeishuCalendarClient,
  config: Record<string, unknown>,
): Promise<{ calendars: ExternalCalendar[]; targets: CalendarSummary[] }> {
  const selected = selectedCalendarIds(config);
  const all = await api.listCalendars();
  const byId = new Map(all.map((item) => [item.calendarId, item]));

  let targets: CalendarSummary[];
  if (selected.length > 0) {
    targets = selected.map(
      (calendarId) =>
        byId.get(calendarId) ?? {
          calendarId,
          // 选中的日历已经不在列表里（取消订阅了）也照拉：拉不到会报错，
          // 静默丢掉反而让人以为同步正常
          name: "已移除的日历",
          type: "unknown",
          isDeleted: false,
        },
    );
  } else {
    const primaryId = await api.primaryCalendarId();
    targets = [
      byId.get(primaryId) ?? {
        calendarId: primaryId,
        name: "我的日历",
        type: "primary",
        isDeleted: false,
      },
    ];
  }

  const calendars = targets.map((item) => ({
    externalId: item.calendarId,
    name: item.name.slice(0, 64),
  }));
  return { calendars, targets };
}

/**
 * 同一实例可能重复返回（跨分片边界的日程会在两片里各出现一次）。
 *
 * 去重键与官方 CLI 一致：`event_id` + 开始 + 结束。
 */
function dedupe(
  instances: readonly CalendarEventInstance[],
): CalendarEventInstance[] {
  const seen = new Set<string>();
  const result: CalendarEventInstance[] = [];
  for (const instance of instances) {
    const key = [
      instance.event_id,
      instance.start_time?.timestamp ?? instance.start_time?.date ?? "",
      instance.end_time?.timestamp ?? instance.end_time?.date ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(instance);
  }
  return result;
}
