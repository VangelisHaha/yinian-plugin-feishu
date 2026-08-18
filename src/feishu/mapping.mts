/**
 * 飞书任务 ↔ 一念外部条目的字段映射。
 *
 * 这个文件是纯函数，全部有单测覆盖——时间映射是这个插件最容易出错的地方，
 * 而错了的表现是「任务出现在错误的一天」，用户很难自己判断是哪一层的问题。
 *
 * ## 飞书的时间形态
 *
 * 所有时间都是**毫秒时间戳的字符串**（不是数字，不是 ISO）。`due` 与 `start` 是
 * 对象：`{ timestamp, is_all_day }`。
 *
 * ## 全天任务怎么映射
 *
 * 飞书全天任务的 `timestamp` 指向那一天的零点，而**「哪一天」要按本地时区解释**
 * （`nikou-screen` 上实测：按 UTC 取会偏一天）。所以这里用本机时区取出年月日，
 * 再折成当地 23:59:59.999。
 *
 * 为什么是当天结束而不是零点：一念的 `dueAt` 语义是 deadline（最晚什么时候完成），
 * 一个全天任务的 deadline 是那天结束，不是那天开始。映射成零点会让当天的任务
 * 一整天都显示为已逾期。
 */

import type { ExternalItem, ExternalStatus } from "../sdk/index.mjs";
import type { FeishuTask, FeishuTime } from "./client.mjs";

/** 毫秒字符串 → 数字。非法值（包括飞书用来表示「无」的 "0"）返回 null。 */
export function parseMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** 毫秒 → RFC3339（UTC）。 */
export function msToIso(ms: number | null): string | undefined {
  if (ms === null) return undefined;
  return new Date(ms).toISOString();
}

/**
 * 全天时间戳 → 当地那一天结束时刻的 RFC3339。
 *
 * `timeZone` 只在测试里显式传，运行时用本机时区——用户视角的「今天」就是本机时区
 * 的今天，硬编码某个时区会让跨时区出差的人看到错误的日期。
 *
 * 实现上必须**先按目标时区取出年月日，再按同一时区的偏移折回 UTC**。
 * 只做前半步（取日期后用 `new Date(y, m, d, 23, 59)` 构造）会用本机时区去解释
 * 那个日期，一旦目标时区不是本机就会差出几小时甚至一天。
 */
export function allDayEndIso(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));

  const pick = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "1");
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");

  // 用当天正午探偏移：避开夏令时切换点（切换通常发生在凌晨）
  const probe = Date.UTC(year, month - 1, day, 12);
  const offsetMs = zoneOffsetMs(probe, timeZone);

  return new Date(
    Date.UTC(year, month - 1, day, 23, 59, 59, 999) - offsetMs,
  ).toISOString();
}

/** 某个瞬时在指定时区的 UTC 偏移（毫秒）。不传时区则用本机。 */
function zoneOffsetMs(utcMs: number, timeZone?: string): number {
  if (!timeZone) {
    // getTimezoneOffset 的符号与 UTC 偏移相反
    return -new Date(utcMs).getTimezoneOffset() * 60_000;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));

  const pick = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    pick("year"),
    pick("month") - 1,
    pick("day"),
    // hour12: false 在午夜会给出 24，取模折回 0
    pick("hour") % 24,
    pick("minute"),
    pick("second"),
  );
  return asIfUtc - utcMs;
}

/** 把飞书的时间对象折成一念要的 RFC3339。 */
export function timeToIso(
  time: FeishuTime | undefined,
  timeZone?: string,
): string | undefined {
  const ms = parseMs(time?.timestamp);
  if (ms === null) return undefined;
  return time?.is_all_day ? allDayEndIso(ms, timeZone) : msToIso(ms);
}

/** 飞书任务里除了已识别字段之外的部分，原样带给宿主存档。 */
function remoteData(task: FeishuTask): Record<string, unknown> {
  return { ...task };
}

/**
 * 一条飞书任务 → 一念外部条目。
 *
 * `status` 由调用方给：列表接口是按 `completed` 分两次拉的，任务在哪一批里就决定
 * 了它的状态，任务对象本身没有状态字段。
 */
export function toExternalItem(
  task: FeishuTask,
  status: ExternalStatus,
  timeZone?: string,
): ExternalItem | null {
  if (!task.guid) return null;

  const completedMs = parseMs(task.completed_at);
  const item: ExternalItem = {
    externalId: task.guid,
    title: task.summary?.trim() || "(无标题)",
    status,
    remoteData: remoteData(task),
  };

  if (task.url) item.externalUrl = task.url;
  if (task.description) item.notes = task.description;

  const dueAt = timeToIso(task.due, timeZone);
  if (dueAt) item.dueAt = dueAt;

  // 只有真的知道完成时间才传。传当前时间会让历史任务全堆在同一秒，
  // 一念的「今日完成」会瞬间多出一堆（nikou-screen 踩过这个坑）
  if (status === "done" && completedMs !== null) {
    item.completedAt = new Date(completedMs).toISOString();
  }

  // 宿主的字段级冲突判定靠它。飞书没有独立的 updated_at，
  // 用「完成时间与创建时间里较晚的那个」近似——比完全不给强
  const createdMs = parseMs(task.created_at);
  const updated = Math.max(completedMs ?? 0, createdMs ?? 0);
  if (updated > 0) item.remoteUpdatedAt = new Date(updated).toISOString();

  if (task.parent_task_guid) item.parentExternalId = task.parent_task_guid;

  return item;
}

/**
 * 一念的字段变更 → 飞书的 PATCH 载荷。
 *
 * 返回 `null` 表示没有飞书能接受的改动，调用方应当跳过这次回写而不是发空请求。
 */
export function toUpdatePayload(
  item: ExternalItem,
  changedFields: readonly string[],
): { fields: Record<string, unknown>; updateFields: string[] } | null {
  const fields: Record<string, unknown> = {};
  const updateFields: string[] = [];

  for (const field of changedFields) {
    switch (field) {
      case "title":
        fields["summary"] = item.title;
        updateFields.push("summary");
        break;
      case "notes":
        // 清空要显式传空串：不传这个键飞书会保留原值
        fields["description"] = item.notes ?? "";
        updateFields.push("description");
        break;
      case "due_at": {
        const ms = item.dueAt ? Date.parse(item.dueAt) : Number.NaN;
        fields["due"] = Number.isFinite(ms)
          ? { timestamp: String(ms), is_all_day: false }
          : // 一念清空了截止时间 → 飞书用零值表示「无」
            { timestamp: "0", is_all_day: false };
        updateFields.push("due");
        break;
      }
      default:
        // 飞书任务没有优先级、标签这些概念，收到也没处安放。
        // manifest 的 capabilities.fields 已经限制了宿主只会下发上面这几个
        break;
    }
  }

  return updateFields.length > 0 ? { fields, updateFields } : null;
}

/**
 * 需要补详情的条目。
 *
 * 列表接口不给 `start` 与 `completed_at`：
 * - 已完成的缺真实完成时间，不补的话一念只能显示「不知道什么时候完成的」；
 * - 未完成的缺开始时间，不补的话跨天任务在时间轴上只剩截止那一天。
 */
export function needsDetail(item: ExternalItem): boolean {
  if (item.status === "done") return item.completedAt === undefined;
  return true;
}

/** 用详情补齐条目。 */
export function applyDetail(
  item: ExternalItem,
  detail: FeishuTask | null,
  timeZone?: string,
): ExternalItem {
  if (!detail) return item;

  const merged: ExternalItem = { ...item, remoteData: remoteData(detail) };

  const completedMs = parseMs(detail.completed_at);
  if (item.status === "done" && completedMs !== null) {
    merged.completedAt = new Date(completedMs).toISOString();
  }

  const dueAt = timeToIso(detail.due, timeZone);
  if (dueAt) merged.dueAt = dueAt;

  // 一念的 Task 只有 due_at（deadline），没有「开始时间」字段——那属于排期块，
  // 由用户在一念里自己安排。所以 start 只用来算估时，不覆盖 dueAt。
  const startMs = parseMs(detail.start?.timestamp);
  const dueMs = parseMs(detail.due?.timestamp);
  if (startMs !== null && dueMs !== null && dueMs > startMs) {
    const minutes = Math.round((dueMs - startMs) / 60_000);
    // 跨天任务算出来的「估时」是日历跨度而不是工作量，超过一天就没有参考价值
    if (minutes > 0 && minutes <= 24 * 60) {
      merged.estimateMinutes = minutes;
    }
  }

  if (detail.description) merged.notes = detail.description;
  if (detail.parent_task_guid) merged.parentExternalId = detail.parent_task_guid;

  const createdMs = parseMs(detail.created_at);
  const updated = Math.max(completedMs ?? 0, createdMs ?? 0);
  if (updated > 0) merged.remoteUpdatedAt = new Date(updated).toISOString();

  return merged;
}
