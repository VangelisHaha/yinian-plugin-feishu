/**
 * 飞书日历 API v4 客户端。
 *
 * 端点与参数逐字段核对过飞书官方 CLI（`~/ops/my/cli-main`）的实现：
 * - 日历列表：`GET /open-apis/calendar/v4/calendars?page_size=&page_token=` → `data.calendar_list`
 * - 主日历：`POST /open-apis/calendar/v4/calendars/primary` → `data.calendars[].calendar`
 * - 日程视图：`GET /open-apis/calendar/v4/calendars/{id}/events/instance_view?start_time=&end_time=`
 *
 * ## 为什么用 `instance_view` 而不是 `events.list`
 *
 * `instance_view` 返回的是**已经展开的重复日程实例**。一念一期不展开 RRULE
 * occurrence（`docs/01-roadmap.md` 还挂着），拉原始 event 的话每周例会在日历上
 * 只会出现一次——用户看到的日历就是错的。代价是同一个 `event_id` 会带回多个实例，
 * 所以 `externalId` 必须自己拼上实例开始时间，见 `calendarMapping.mts`。
 *
 * ## 两个必须处理的上限
 *
 * `instance_view` 的时间跨度上限 40 天（`193103`），单次实例数上限 1000（`193104`）。
 * 两者都不是失败，是「请求拆小一点」的信号：命中就把窗口二分再来。CLI 也是这么做的，
 * 递归深度与最小窗口照搬它的值。**不要靠调小默认窗口来回避**——日程密度是用户的，
 * 不是我们能预设的。
 */

import { logger } from "../sdk/index.mjs";
import { type Credentials } from "./auth.mjs";
import { apiRequest, apiRequestRaw, toApiError } from "./request.mjs";

/** 单次 `instance_view` 的跨度上限，飞书硬限制。 */
const MAX_SPAN_SECONDS = 40 * 24 * 60 * 60;
/** 主动切分的窗口大小。留出余量，别贴着 40 天上限发。 */
const CHUNK_SECONDS = 30 * 24 * 60 * 60;
/** 二分到这个跨度还超 1000 实例就只能放弃——再切下去也拿不完。 */
const MIN_SPLIT_SECONDS = 2 * 60 * 60;
/** 二分递归深度上限，防跑飞。 */
const MAX_SPLIT_DEPTH = 10;
/** 日历列表单页条数。 */
const CALENDAR_PAGE_SIZE = 50;
/** 日历列表最多翻多少页。个人账号不可能有 500 个日历。 */
const MAX_CALENDAR_PAGES = 10;

/** 跨度超限。 */
const ERR_TIME_RANGE_EXCEEDED = 193103;
/** 实例数超 1000。 */
const ERR_TOO_MANY_INSTANCES = 193104;

/** 日历时间：定时用 `timestamp`（**秒**级字符串），全天用 `date`。 */
export interface CalendarEventTime {
  /** 秒级时间戳字符串。注意日历用秒，任务用毫秒。 */
  timestamp?: string;
  /** `YYYY-MM-DD`，全天日程用。飞书这里给的是**右开**区间的结束日。 */
  date?: string;
  timezone?: string;
}

/** 视频会议信息。`vc_type` 为 `no_meeting` 时这条日程不是会议。 */
export interface CalendarVchat {
  vc_type?: string;
  icon_type?: string;
  description?: string;
  meeting_url?: string;
}

export interface CalendarEventInstance {
  event_id: string;
  summary?: string;
  description?: string;
  start_time?: CalendarEventTime;
  end_time?: CalendarEventTime;
  /** `confirmed` / `tentative` / `cancelled`。 */
  status?: string;
  /** `busy` / `free`。 */
  free_busy_status?: string;
  /** `needs_action` / `accept` / `decline` / `tentative`。 */
  self_rsvp_status?: string;
  /** 客户端跳转链接。 */
  app_link?: string;
  is_exception?: boolean;
  location?: { name?: string; address?: string };
  vchat?: CalendarVchat;
  attendees?: unknown[];
  organizer_calendar_id?: string;
  [key: string]: unknown;
}

export interface CalendarSummary {
  calendarId: string;
  name: string;
  /** `primary` / `shared` / `google` / `resource` / `exchange` / `unknown`。 */
  type: string;
  isDeleted: boolean;
}

export class FeishuCalendarClient {
  #credentials: Credentials;
  #dataDir: string;

  constructor(credentials: Credentials, dataDir: string) {
    this.#credentials = credentials;
    this.#dataDir = dataDir;
  }

  #get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return apiRequest<T>({
      credentials: this.#credentials,
      dataDir: this.#dataDir,
      method: "GET",
      path,
      ...(query ? { query } : {}),
    });
  }

  /** 主日历 id。用户没选日历时同步它。 */
  async primaryCalendarId(): Promise<string> {
    const data = await apiRequest<{
      calendars?: Array<{ calendar?: { calendar_id?: string } }>;
    }>({
      credentials: this.#credentials,
      dataDir: this.#dataDir,
      method: "POST",
      path: "/open-apis/calendar/v4/calendars/primary",
    });
    const first = data?.calendars?.[0]?.calendar?.calendar_id ?? "";
    if (!first) throw new Error("飞书没有返回主日历 id");
    return first;
  }

  /** 日历列表（含订阅的共享日历）。已删除的日历会被过滤掉。 */
  async listCalendars(): Promise<CalendarSummary[]> {
    const all: CalendarSummary[] = [];
    let pageToken = "";

    for (let page = 1; page <= MAX_CALENDAR_PAGES; page += 1) {
      const query: Record<string, string> = {
        page_size: String(CALENDAR_PAGE_SIZE),
      };
      if (pageToken) query["page_token"] = pageToken;

      const data = await this.#get<{
        calendar_list?: Array<{
          calendar_id?: string;
          summary?: string;
          type?: string;
          is_deleted?: boolean;
        }>;
        page_token?: string;
        has_more?: boolean;
      }>("/open-apis/calendar/v4/calendars", query);

      for (const item of data?.calendar_list ?? []) {
        const calendarId = item.calendar_id ?? "";
        if (!calendarId || item.is_deleted === true) continue;
        all.push({
          calendarId,
          name: (item.summary ?? "").trim() || "未命名日历",
          type: item.type ?? "unknown",
          isDeleted: false,
        });
      }

      if (data?.has_more !== true || !data.page_token) break;
      pageToken = data.page_token;
    }
    return all;
  }

  /**
   * 拉一个日历在 `[startSec, endSec]` 内的全部日程实例。
   *
   * 窗口先按 30 天主动切，再对超限错误二分——只做后者的话，一个 90 天的窗口
   * 每轮都要先撞一次 `193103` 才开始拆，白花两次往返。
   */
  async instances(
    calendarId: string,
    startSec: number,
    endSec: number,
    traceId?: string,
  ): Promise<CalendarEventInstance[]> {
    const collected: CalendarEventInstance[] = [];
    for (let from = startSec; from <= endSec; from += CHUNK_SECONDS) {
      const to = Math.min(from + CHUNK_SECONDS - 1, endSec);
      collected.push(
        ...(await this.#fetchRange(calendarId, from, to, 0, traceId)),
      );
    }
    return collected;
  }

  async #fetchRange(
    calendarId: string,
    startSec: number,
    endSec: number,
    depth: number,
    traceId?: string,
  ): Promise<CalendarEventInstance[]> {
    if (startSec > endSec) return [];
    if (depth > MAX_SPLIT_DEPTH) {
      throw new Error(`日程视图拆分层数过多（日历 ${calendarId}）`);
    }

    const span = endSec - startSec;
    if (span > MAX_SPAN_SECONDS) {
      return this.#split(calendarId, startSec, endSec, depth, traceId);
    }

    const raw = await apiRequestRaw<{ items?: CalendarEventInstance[] }>({
      credentials: this.#credentials,
      dataDir: this.#dataDir,
      method: "GET",
      path: `/open-apis/calendar/v4/calendars/${encodeURIComponent(calendarId)}/events/instance_view`,
      query: { start_time: String(startSec), end_time: String(endSec) },
      // 193103 / 193104 要自己看 code 决定怎么拆，不能被抛成异常
      rawErrors: true,
    });

    if (raw.code === 0) {
      const items = raw.data?.items;
      return Array.isArray(items) ? items.filter((item) => item?.event_id) : [];
    }

    const splittable =
      raw.code === ERR_TIME_RANGE_EXCEEDED ||
      (raw.code === ERR_TOO_MANY_INSTANCES && span > MIN_SPLIT_SECONDS);
    if (splittable) {
      logger.debug(
        `日程视图需要拆分（code ${raw.code}，跨度 ${Math.round(span / 3600)}h）`,
        traceId ? { traceId } : undefined,
      );
      return this.#split(calendarId, startSec, endSec, depth, traceId);
    }

    throw toApiError(raw.code, raw.msg);
  }

  async #split(
    calendarId: string,
    startSec: number,
    endSec: number,
    depth: number,
    traceId?: string,
  ): Promise<CalendarEventInstance[]> {
    const mid = startSec + Math.floor((endSec - startSec) / 2);
    if (mid <= startSec) {
      throw new Error(
        `日程视图无法再拆分（日历 ${calendarId}），请缩小同步窗口`,
      );
    }
    const left = await this.#fetchRange(
      calendarId,
      startSec,
      mid,
      depth + 1,
      traceId,
    );
    const right = await this.#fetchRange(
      calendarId,
      mid + 1,
      endSec,
      depth + 1,
      traceId,
    );
    return [...left, ...right];
  }
}
