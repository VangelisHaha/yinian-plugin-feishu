/**
 * 飞书考勤：取数与逐日判定。
 *
 * 端点 `POST /open-apis/attendance/v1/user_tasks/query`，用 **user_access_token**
 * （见 `request.mts`），所以只能看到自己的考勤——这正合意，叠加层要画的就是「我的」
 * 打卡（契约 §8.4）。需要开放平台上的 `attendance:task:readonly`。
 *
 * ## 三个实测出来的约束
 *
 * 1. **单次查询区间不能超过 30 天**（`1220001: interval is larger than 30`）。
 *    月视图一次要 42 个格子，所以必须分段拉再合并。不分段的表现是「翻到月视图什么
 *    都没有」，而错误只在插件日志里。
 * 2. `employee_type` 用 **`employee_id`**，值是飞书的 `user_id`（形如 `adged4ed`），
 *    不是 `open_id`。它由 `authen/v1/user_info` 返回，不用让用户手填。
 * 3. **`shift_id === "0"` 只表示当天没有排班，不代表没上班。** 周末加班打卡就是这个
 *    形态（`check_in_result` 会是 `NoNeedCheck`），要看 `check_in_record_id` /
 *    `check_out_record_id` 有没有值。只看 `check_in_result` 会把加班日判成休息日。
 */

import { logger } from "../sdk/index.mjs";
import { apiRequest } from "./request.mjs";
import type { Credentials } from "./auth.mjs";

/** 飞书的硬限制，实测报 `1220001`。 */
const MAX_QUERY_SPAN_DAYS = 30;

const QUERY_PATH = "/open-apis/attendance/v1/user_tasks/query";

/** 一天的考勤结论。**这是缓存文件的形状，改它要同时升 `CACHE_VERSION`。** */
export interface AttendanceDay {
  /** 严格 `YYYY-MM-DD`。 */
  date: string;
  kind: AttendanceKind;
  /** 上班打卡时刻 `HH:mm`，没打卡就没有。 */
  checkIn?: string;
  /** 下班打卡时刻 `HH:mm`。当天还没下班时没有。 */
  checkOut?: string;
  /**
   * 异常标记：迟到 / 早退 / 缺卡。
   *
   * **不影响 `kind`**——迟到仍然是出勤（`worked`）。工时口径按天算，
   * 迟到十分钟不该让这一天从出勤变成别的什么。
   */
  issues?: AttendanceIssue[];
}

/**
 * 一天属于哪一类。
 *
 * - `worked`：有排班且打过卡，**最常见的一类**
 * - `overtime`：没有排班却打了卡——周末 / 节假日加班
 * - `leave`：请假（含年假 / 事假 / 病假 / 调休，飞书不区分类型）
 * - `rest`：没有排班也没打卡，纯休息
 * - `scheduled`：有排班但**那天还没过完**——今天与未来的工作日
 * - `absent`：有排班、已经过去了、却一次卡都没打
 *
 * `scheduled` 与 `absent` 必须分开，这是真机上撞出来的：飞书会返回**未来**的排班
 * （明天是工作日，`shift_id` 非 0 而 `records` 为空），当成缺勤会在日历上给明天画一个
 * 「缺」——用户会以为自己旷工。今天同理：上午还没打卡不等于没来。
 */
export type AttendanceKind =
  | "worked"
  | "overtime"
  | "leave"
  | "rest"
  | "scheduled"
  | "absent";

export type AttendanceIssue = "late" | "early" | "lack";

// ── 线格式 ───────────────────────────────────────────────────────────────

interface UserTaskResult {
  day?: number;
  /** `"0"` 表示当天无排班。**不等于没上班**，见文件头。 */
  shift_id?: string;
  records?: TaskRecord[];
}

interface TaskRecord {
  check_in_record_id?: string;
  check_out_record_id?: string;
  check_in_result?: string;
  check_out_result?: string;
  check_in_result_supplement?: string;
  check_out_result_supplement?: string;
  check_in_record?: { check_time?: string };
  check_out_record?: { check_time?: string };
}

interface QueryResponse {
  user_task_results?: UserTaskResult[];
}

// ── 取数 ─────────────────────────────────────────────────────────────────

export interface FetchOptions {
  credentials: Credentials;
  dataDir: string;
  /** 飞书 `user_id`（`employee_id`），由 `resolveEmployeeId` 解析。 */
  employeeId: string;
  /** 闭区间起点，`YYYY-MM-DD`。 */
  from: string;
  /** 闭区间终点，`YYYY-MM-DD`。 */
  to: string;
  /** 打卡时刻按这个时区渲染成 `HH:mm`，来自实例配置的 `utcOffset`，默认 +08:00。 */
  utcOffset?: string;
}

/**
 * 拉一段区间的考勤，按天返回。
 *
 * 两层防护，都是真机上撞出来的：
 *
 * 1. **上界夹到明天。** 飞书校验 `dateFrom` 必须落在
 *    `[企业考勤起始日, 明天]`，超出直接报 `1220001`。而月视图一次要 42 个格子、
 *    后半段常常整段在未来——不夹的话那一段必然失败。
 * 2. **每段独立容错。** 分段之后一段失败不该带走其他段：企业考勤起始日之前的历史段
 *    同样会被拒，而当月那段本来是好的。不这么做的表现是「翻到某个月一个角标都没有」，
 *    而原因是另一段的日期越界。
 */
export async function fetchAttendance(
  options: FetchOptions,
): Promise<AttendanceDay[]> {
  const offsetMinutes = parseUtcOffset(options.utcOffset);
  const span = clampToPast(options.from, options.to);
  if (!span) return [];

  const days: AttendanceDay[] = [];
  for (const [from, to] of splitSpan(span[0], span[1])) {
    let response: QueryResponse;
    try {
      response = await apiRequest<QueryResponse>({
        credentials: options.credentials,
        dataDir: options.dataDir,
        method: "POST",
        path: QUERY_PATH,
        query: {
          employee_type: "employee_id",
          // 忽略无效用户：换过工号、或者应用被摘掉考勤权限时，宁可这一段没数据，
          // 也不要整个请求失败——日历上少几个角标好过整张日历翻不动
          ignore_invalid_users: "true",
        },
        body: {
          user_ids: [options.employeeId],
          check_date_from: compactDate(from),
          check_date_to: compactDate(to),
        },
      });
    } catch (error) {
      // 一段越界（比如早于企业的考勤起始日）不该带走其他段
      logger.warn("考勤分段查询失败，其余分段照常", {
        code: "FEISHU_ATTENDANCE_SEGMENT_FAILED",
        detail: {
          from,
          to,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }
    for (const result of response.user_task_results ?? []) {
      const day = classify(result, offsetMinutes);
      if (day) days.push(day);
    }
  }
  return days;
}

/**
 * 把查询区间的上界夹到**明天**，整段都在未来时返回 `null`。
 *
 * 考勤不可能有未来数据，而飞书对 `dateFrom` 越界是**直接报错**而不是返回空
 * （`1220001`）。所以这不是优化，是必要的：月视图后半段常常整段在未来。
 *
 * 夹到明天而不是今天：跨时区时「今天」两边可能差一天，多留一天比少一天安全
 * （多出来的那天飞书会返回空，而少了会让今天的打卡看不见）。
 */
export function clampToPast(
  from: string,
  to: string,
  now: Date = new Date(),
): [string, string] | null {
  const start = dateFromKey(from);
  const end = dateFromKey(to);
  if (!start || !end || end < start) return null;

  const tomorrow = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  );
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  // 整段都在未来：一次请求都不该发
  if (start > tomorrow) return null;
  const clampedEnd = end > tomorrow ? tomorrow : end;
  return [toDateKey(start), toDateKey(clampedEnd)];
}

/**
 * 查当前授权账号的 `user_id`。
 *
 * 走 `authen/v1/user_info`（user token），返回的 `user_id` 就是考勤接口要的
 * `employee_id`。**不让用户手填**：那个值在飞书界面上不好找，填错的表现是
 * 「一条考勤都没有」而不报错。
 *
 * 应用需要有「获取用户 user ID」的权限，否则这个字段是空的。
 */
export async function resolveEmployeeId(
  credentials: Credentials,
  dataDir: string,
): Promise<string> {
  const data = await apiRequest<{ user_id?: string }>({
    credentials,
    dataDir,
    method: "GET",
    path: "/open-apis/authen/v1/user_info",
  });
  return (data.user_id ?? "").trim();
}

// ── 判定 ─────────────────────────────────────────────────────────────────

/**
 * 一天的原始结果 → 结论。**纯函数，判定规则只在这里一处。**
 *
 * 判定顺序有讲究：**请假优先于出勤**。半天请假半天上班的日子两边都成立，而对用户
 * 来说「今天请了假」比「今天来了」更值得在日历上看到——工时也要按请假那半天补。
 *
 * `today` 用来区分 `scheduled` 与 `absent`（见 [`AttendanceKind`]）。默认按传入偏移
 * 算出的今天，**不用本机时区**：出差到别的时区时，「今天」该是公司时区的今天。
 */
export function classify(
  result: UserTaskResult,
  offsetMinutes: number,
  today: string = todayKey(offsetMinutes),
): AttendanceDay | null {
  const date = parseCompactDay(result.day);
  if (!date) return null;

  const records = result.records ?? [];
  const scheduled = (result.shift_id ?? "0") !== "0";
  const punched = records.some(
    (record) =>
      Boolean(record.check_in_record_id) || Boolean(record.check_out_record_id),
  );

  const checkIn = firstTime(records, "in", offsetMinutes);
  const checkOut = lastTime(records, "out", offsetMinutes);
  const issues = collectIssues(records);

  const day: AttendanceDay = { date, kind: "rest" };
  if (checkIn) day.checkIn = checkIn;
  if (checkOut) day.checkOut = checkOut;

  if (isLeave(records)) {
    day.kind = "leave";
    // 请假日的迟到早退没有意义，别把它标成异常
    return day;
  }
  if (issues.length > 0) day.issues = issues;

  if (scheduled) {
    if (punched) {
      day.kind = "worked";
    } else {
      // 那天还没过完就不算缺勤：飞书会返回未来的排班，而今天上午还没打卡也很正常。
      // 判成 absent 会在明天的格子里画一个「缺」，看起来像旷工
      day.kind = date < today ? "absent" : "scheduled";
    }
  } else {
    // shift_id = "0" 且打了卡 = 加班。这一条最容易错：`check_in_result` 此时是
    // `NoNeedCheck`（无班次无需打卡），只看它会把加班日判成休息日
    day.kind = punched ? "overtime" : "rest";
  }
  return day;
}

/** 请假：飞书把它放在 supplement 里，不区分年假 / 事假 / 病假 / 调休。 */
function isLeave(records: TaskRecord[]): boolean {
  return records.some(
    (record) =>
      record.check_in_result_supplement === "Leave" ||
      record.check_out_result_supplement === "Leave",
  );
}

/**
 * 收集异常。
 *
 * `Lack`（缺卡）来自 `check_*_result`；`Late` / `Early` 同理。**不含 `Todo`**——
 * 那是「今天还没到下班时间」，把它当异常会让每天下午的今天都显示一个红标。
 */
function collectIssues(records: TaskRecord[]): AttendanceIssue[] {
  const issues = new Set<AttendanceIssue>();
  for (const record of records) {
    for (const result of [record.check_in_result, record.check_out_result]) {
      if (result === "Late") issues.add("late");
      else if (result === "Early") issues.add("early");
      else if (result === "Lack") issues.add("lack");
    }
  }
  return [...issues];
}

function firstTime(
  records: TaskRecord[],
  which: "in" | "out",
  offsetMinutes: number,
): string | undefined {
  const times = punchTimes(records, which, offsetMinutes);
  return times[0];
}

function lastTime(
  records: TaskRecord[],
  which: "in" | "out",
  offsetMinutes: number,
): string | undefined {
  const times = punchTimes(records, which, offsetMinutes);
  return times[times.length - 1];
}

/**
 * 取打卡时刻并渲染成 `HH:mm`。
 *
 * `check_time` 是**秒级**时间戳字符串（不是毫秒，飞书这两种都在用，混了会算到 1970
 * 年或者五万年后）。按传入偏移渲染，不用本机时区——出差在别的时区打开一念时，
 * 考勤时间应当还是公司时区的那个时刻。
 */
function punchTimes(
  records: TaskRecord[],
  which: "in" | "out",
  offsetMinutes: number,
): string[] {
  const times: number[] = [];
  for (const record of records) {
    const raw =
      which === "in"
        ? record.check_in_record?.check_time
        : record.check_out_record?.check_time;
    const seconds = Number(raw);
    if (!raw || !Number.isFinite(seconds) || seconds <= 0) continue;
    times.push(seconds);
  }
  times.sort((left, right) => left - right);
  return times.map((seconds) => formatClock(seconds, offsetMinutes));
}

function formatClock(seconds: number, offsetMinutes: number): string {
  const shifted = new Date((seconds + offsetMinutes * 60) * 1000);
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

// ── 日期工具 ─────────────────────────────────────────────────────────────

/**
 * `+08:00` / `+0800` / `+8` → 分钟数。认不出按 +08:00（飞书主场）。
 *
 * 与 `mapping.mts` 那份刻意分开：这里只用来渲染 `HH:mm`，不参与 RFC3339 拼接。
 */
export function parseUtcOffset(value: string | undefined): number {
  const matched = /^([+-])(\d{1,2}):?(\d{2})?$/.exec((value ?? "").trim());
  if (!matched) return 8 * 60;
  const sign = matched[1] === "-" ? -1 : 1;
  const hours = Number(matched[2]);
  const minutes = Number(matched[3] ?? "0");
  if (!Number.isFinite(hours) || hours > 14) return 8 * 60;
  return sign * (hours * 60 + minutes);
}

/** `2026-09-01` → `20260901`（飞书的入参格式）。 */
function compactDate(value: string): string {
  return value.replace(/-/g, "");
}

/** `20260901`（number）→ `2026-09-01`。非法值返回 null 而不是抛。 */
export function parseCompactDay(day: number | undefined): string | null {
  if (typeof day !== "number" || !Number.isFinite(day)) return null;
  const text = String(day);
  if (!/^\d{8}$/.test(text)) return null;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  // 严格校验：日期键要当 Map key 用，`2026-02-30` 这类必须挡掉
  return isStrictDateKey(iso) ? iso : null;
}

export function isStrictDateKey(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * 把闭区间切成不超过 30 天的若干段。
 *
 * 切片左闭右闭且不重叠，所以合并结果时同一天不会出现两次。
 */
export function splitSpan(from: string, to: string): Array<[string, string]> {
  const start = dateFromKey(from);
  const end = dateFromKey(to);
  if (!start || !end || end < start) return [];
  const spans: Array<[string, string]> = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + MAX_QUERY_SPAN_DAYS - 1);
    const last = chunkEnd > end ? end : chunkEnd;
    spans.push([toDateKey(cursor), toDateKey(last)]);
    cursor.setTime(last.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return spans;
}

export function dateFromKey(value: string): Date | null {
  if (!isStrictDateKey(value)) return null;
  return new Date(`${value}T00:00:00Z`);
}

export function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 按给定偏移算出的今天。用 UTC 运算，全程不碰本机时区。 */
export function todayKey(offsetMinutes: number, now: Date = new Date()): string {
  return toDateKey(new Date(now.getTime() + offsetMinutes * 60_000));
}
