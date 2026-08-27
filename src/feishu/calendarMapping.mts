/**
 * 飞书日程实例 → 一念 ExternalEvent 的字段映射。
 *
 * 纯函数，全部有单测覆盖。时间是这里唯一容易出错的地方，而错了的表现是
 * 「会议出现在错误的一天/错误的一小时」，用户很难自己判断是哪一层的问题。
 *
 * ## 三个已核对过的事实（来自飞书官方 CLI 的实现）
 *
 * 1. **日历用秒级时间戳**，任务用毫秒级。同一个飞书里两套单位，`mapping.mts` 的
 *    `parseMs` 不能直接用在这里。
 * 2. **全天日程的 `end_time.date` 是右开的**：官方 CLI 展示给人看之前会先减 1 秒
 *    再取日期。一念契约要的也是右开区间，所以**原样传，不要加减一天**。
 * 3. `instance_view` 返回的是展开后的实例，同一个 `event_id` 会出现多次
 *    （每周例会的每一周）。`externalId` 必须带上实例开始时间，否则一周的会议
 *    会互相覆盖，日历上只剩一条。
 *
 * ## 会议信息去哪了
 *
 * 会议链接、地点、参会人数、我的回复状态都不进 Event 主模型——核心不该长成
 * 所有外部系统字段的并集（契约 §5.1）。它们走 `details`：插件整理成「标签 + 值」，
 * 宿主原样展示在事件详情的「来源」区。
 */

import type {
  ExternalBusyStatus,
  ExternalDetailField,
  ExternalEvent,
  ExternalEventStatus,
  ExternalResponseStatus,
} from "../sdk/index.mjs";
import type { CalendarEventInstance } from "./calendar.mjs";

/** 秒级时间戳字符串 → 毫秒数。`"0"` 与非法值返回 null。 */
export function parseSeconds(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value * 1000 : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : null;
}

/** `YYYY-MM-DD` 才算合法日期，其余（含空串）返回 null。 */
export function parseDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/**
 * 实例的稳定标识。
 *
 * 用开始时间而不是序号：序号会随「这一周的会被删了」整体错位，
 * 之后每条事件都对不上，宿主会把整个日历删一遍再建一遍。
 */
export function eventExternalId(instance: CalendarEventInstance): string {
  const start =
    parseDate(instance.start_time?.date) ??
    instance.start_time?.timestamp?.trim() ??
    "";
  return start ? `${instance.event_id}@${start}` : instance.event_id;
}

function busyStatus(value: unknown): ExternalBusyStatus {
  return value === "free" ? "free" : "busy";
}

/** 飞书的 rsvp 取值是 `accept` / `decline`，一念契约要 `accepted` / `declined`。 */
function responseStatus(value: unknown): ExternalResponseStatus {
  switch (value) {
    case "accept":
      return "accepted";
    case "decline":
      return "declined";
    case "tentative":
      return "tentative";
    default:
      return "needs_action";
  }
}

function eventStatus(value: unknown): ExternalEventStatus {
  return value === "cancelled" ? "canceled" : "active";
}

const RSVP_LABEL: Record<ExternalResponseStatus, string> = {
  needs_action: "待回复",
  accepted: "已接受",
  declined: "已拒绝",
  tentative: "待定",
};

/** 会议类型里只有这些算「真的是个会议」。 */
const MEETING_TYPES = new Set(["vc", "third_party", "lark_live"]);

export function isMeeting(instance: CalendarEventInstance): boolean {
  const vcType = instance.vchat?.vc_type;
  if (typeof vcType === "string" && MEETING_TYPES.has(vcType)) return true;
  // vc_type 缺省但给了链接的也当会议：三方会议有时只回链接
  return typeof instance.vchat?.meeting_url === "string"
    && instance.vchat.meeting_url.trim() !== "";
}

/**
 * 「来源」区的展示字段。
 *
 * 宿主的硬限制是 20 条、label ≤ 32、value ≤ 512，超出直接丢弃。这里给的远少于上限，
 * **只放看一眼就有用的**：会议链接、地点、参会人数、我的回复。
 */
export function toDetails(
  instance: CalendarEventInstance,
  calendarName?: string,
): ExternalDetailField[] {
  const details: ExternalDetailField[] = [];

  const meetingUrl = instance.vchat?.meeting_url?.trim();
  if (meetingUrl && /^https?:\/\//i.test(meetingUrl)) {
    details.push({ label: "会议链接", value: meetingUrl, kind: "link" });
  }

  const location = instance.location?.name?.trim();
  if (location) details.push({ label: "地点", value: location });

  const attendeeCount = Array.isArray(instance.attendees)
    ? instance.attendees.length
    : 0;
  if (attendeeCount > 0) {
    details.push({ label: "参与人", value: `${attendeeCount} 人` });
  }

  const rsvp = responseStatus(instance.self_rsvp_status);
  // 「已接受」是绝大多数日程的状态，写出来只是噪声；待回复与拒绝才值得提醒
  if (rsvp !== "accepted") {
    details.push({ label: "我的回复", value: RSVP_LABEL[rsvp] });
  }

  const name = calendarName?.trim();
  if (name) details.push({ label: "日历", value: name });

  if (instance.is_exception === true) {
    details.push({ label: "重复日程", value: "本次已被单独调整" });
  }

  return details;
}

export interface MapOptions {
  /** 归属日历的外部 id。 */
  calendarExternalId?: string;
  /** 日历名，只用于 details 展示。 */
  calendarName?: string;
}

/**
 * 映射一条日程实例。时间不完整的返回 `null`（调用方记一条日志跳过即可）。
 *
 * 全天与定时**必须互斥**：混着传宿主会跳过该条并记 `PLUGIN_CONTRACT_VIOLATION`，
 * 所以这里先判全天，判定成立就绝不带 `startAt` / `endAt`。
 */
export function toExternalEvent(
  instance: CalendarEventInstance,
  options: MapOptions = {},
): ExternalEvent | null {
  if (!instance?.event_id) return null;

  const startDate = parseDate(instance.start_time?.date);
  const endDate = parseDate(instance.end_time?.date);
  const startMs = parseSeconds(instance.start_time?.timestamp);
  const endMs = parseSeconds(instance.end_time?.timestamp);

  // 全天的判定标准是「给了日期且没给时间戳」。判定成立后绝不带 startAt / endAt：
  // 混着传宿主会跳过该条并记 PLUGIN_CONTRACT_VIOLATION
  const allDay = startDate !== null && startMs === null;
  if (!allDay && (startMs === null || endMs === null || endMs <= startMs)) {
    return null;
  }

  const event: ExternalEvent = {
    externalId: eventExternalId(instance),
    title: (instance.summary ?? "").trim() || "(无标题日程)",
    status: eventStatus(instance.status),
    allDay,
    busyStatus: busyStatus(instance.free_busy_status),
    responseStatus: responseStatus(instance.self_rsvp_status),
    remoteData: { ...instance },
    details: toDetails(instance, options.calendarName),
  };

  if (options.calendarExternalId) {
    event.calendarExternalId = options.calendarExternalId;
  }

  if (allDay && startDate !== null) {
    event.startDate = startDate;
    event.endDate = endDate ?? nextDay(startDate);
  } else if (startMs !== null && endMs !== null) {
    event.startAt = new Date(startMs).toISOString();
    event.endAt = new Date(endMs).toISOString();
  }

  const notes = (instance.description ?? "").trim();
  if (notes) event.notes = notes;

  const location = instance.location?.name?.trim();
  if (location) event.location = location;

  const appLink = instance.app_link?.trim();
  if (appLink && /^https?:\/\//i.test(appLink)) event.externalUrl = appLink;

  return event;
}

/** `YYYY-MM-DD` + 1 天。全天日程缺结束日时按「只占这一天」补右开边界。 */
export function nextDay(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return date;
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}
