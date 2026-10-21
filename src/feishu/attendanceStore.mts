/**
 * 考勤缓存与后台刷新。
 *
 * 契约 §8.4 明确要求：**`calendarOverlay.list` 里不许发网络请求**，它在 UI 路径上、
 * 超时只有 8 秒，用户翻一页月视图就等着它。所以取数与展示彻底分开：
 *
 * - `list` 只读这里的缓存，**永远同步返回**；
 * - 刷新跑在插件自己的后台节奏里（`setInterval`），写进 `dataDir` 的一个 JSON。
 *
 * ## 后台刷新只在用户显式启用之后才开始
 *
 * 这个扩展点默认关闭，关着的时候宿主根本不会调 `calendarOverlay.list`
 * （`services/calendar_overlay.rs` 那道闸门）。所以**「第一次被调到」就是唯一可靠的
 * 授权信号**——在那之前去拉考勤，等于未经确认就拿着用户的凭据访问外部系统。
 *
 * 代价是第一次打开日历时缓存是空的。所以：
 *
 * - 缓存文件一旦存在，就说明用户此前启用过，`plugin.init` 时可以直接续上后台刷新
 *   （重启后不必再等一次 UI 调用）；
 * - 真正的「有生以来第一次」那一下返回一条 `加载中`，别让用户以为坏了。
 *
 * ## 关注区间跟着用户翻月走
 *
 * 后台不猜要拉哪段时间，而是记住 `list` 最近问过的区间（并向后覆盖到今天）。用户在看
 * 8 月就刷 8 月，不会为了「以防万一」把全年拉一遍。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { logger } from "../sdk/index.mjs";
import type { Credentials } from "./auth.mjs";
import {
  dateFromKey,
  fetchAttendance,
  resolveEmployeeId,
  toDateKey,
  type AttendanceDay,
} from "./attendance.mjs";
import { fetchOvertimeApprovals } from "./overtime.mjs";

/**
 * 缓存文件格式版本。**改 [`AttendanceDay`] 的形状必须同时加这个数**——
 * 版本对不上就整份丢掉重拉，比读到半旧半新的结构安全（那种错会画出错的角标）。
 *
 * `2`（2026-09-15）：加了 `punchIn` / `punchOut` / `leavePeriod`，日历上的环形角标要
 * 靠它们把上下班两段分开画。旧缓存里没有这三个字段，留着会让整月的环都是空的。
 *
 * `3`（2026-10-16）：加了班次时刻 `shiftStart` / `shiftEnd` / `shiftId` 与加班审批 `overtimeApproval`。
 */
const CACHE_VERSION = 3;

/** 后台刷新间隔。考勤几分钟级的新鲜度完全够用，打卡也不是秒级要看到的事。 */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * 请求节流（2026-10-21 用户：尽量减少对飞书的请求，没必要反复查历史的考勤）。
 *
 * 原来每 15 分钟把整个关注区间（≥ 90 天、30 天一段）和审批列表全拉一遍，一天 500+ 个请求，
 * 九成九是已经不会再变的历史。现在分层：
 *
 * - **近的**（前天到明天）每 15 分钟拉，1 个请求——打卡、请假、批了加班都在这里变；
 * - **近 30 天的已结算部分**每天核对一次，1 个请求——补卡、改卡通常在几天内；
 * - **更早的历史**只在没拉过时补一次，之后不再碰；
 * - **加班审批**每小时一次；认到审批定义 code 之后只查这一种，通常 1 页；
 * - **夜里**（0–6 点）定时器不动。
 */
const RECENT_BACK_DAYS = 2;
const SETTLED_RECHECK_DAYS = 30;
const SETTLED_RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const OVERTIME_INTERVAL_MS = 60 * 60 * 1000;
/** 加班申请先于加班发起；往前看这么多天就够，更早的只在第一次全量时扫。 */
const OVERTIME_RECENT_DAYS = 45;
const OVERTIME_LOOKBACK_DAYS = 31;

/**
 * 关注区间**至少**覆盖最近这么多天（2026-10-16 用户：历史要能看到近 90 天的考勤与加班）。
 * 原来只拉用户翻到过的月份，没翻过的历史就一直是空的；同步给手机的投影也是 90 天。
 */
const MIN_HISTORY_DAYS = 90;

/** 两次刷新之间的最小间隔，挡住「翻月翻得飞快」时的连续触发。 */
const MIN_REFRESH_GAP_MS = 60 * 1000;

interface CacheFile {
  version: number;
  employeeId: string;
  /** 日期键 → 结论。用对象而不是数组：查一天是 O(1)，而 `list` 要逐格查。 */
  days: Record<string, AttendanceDay>;
  /** 最近一次成功刷新的时刻（毫秒）。 */
  fetchedAt: number;
  /** 关注区间，后台按它刷。 */
  watchFrom: string;
  watchTo: string;
  /** 已结算历史拉到了哪天（含）。更早的不再碰；空 = 还没拉过。 */
  loadedFrom?: string;
  /** 上次核对近 30 天的时刻（毫秒）。 */
  recheckedAt?: number;
  /** 加班审批：上次拉取时刻、已覆盖到的发起日期下界、认到的审批定义 code 与审批名。 */
  overtimeAt?: number;
  overtimeFrom?: string;
  overtimeCode?: string;
  overtimeName?: string;
}

/** 这一轮要发哪些请求。纯函数的产物，单测直接断言。 */
export interface RefreshPlan {
  /** 要拉考勤的闭区间（每段内部还会按 30 天切）。 */
  attendance: Array<[string, string]>;
  /** 要拉加班审批吗；`mode` 说是全量扫还是只看最近。 */
  overtime: null | { mode: "full" | "recent"; sinceDate: string; definitionCode?: string };
}

function shiftKey(key: string, days: number): string {
  const date = dateFromKey(key);
  if (!date) return key;
  date.setUTCDate(date.getUTCDate() + days);
  return toDateKey(date);
}

/**
 * 决定这一轮拉什么。**纯函数**：只看缓存里的记账、现在几点、今天几号。
 *
 * 为什么「已结算」线画在前天：打卡补卡、请假回填常在当天或第二天，前天之前的基本定了；
 * 更早出错的话靠每天一次的近 30 天核对兜住。
 */
export function planRefresh(
  cache: Pick<
    CacheFile,
    | "watchFrom"
    | "watchTo"
    | "loadedFrom"
    | "recheckedAt"
    | "overtimeAt"
    | "overtimeFrom"
    | "overtimeCode"
    | "overtimeName"
  >,
  nowMs: number,
  today: string,
  overtimeName: string | null,
): RefreshPlan {
  const attendance: Array<[string, string]> = [];
  const tomorrow = shiftKey(today, 1);
  attendance.push([shiftKey(today, -RECENT_BACK_DAYS), tomorrow]);

  const settledTo = shiftKey(today, -RECENT_BACK_DAYS - 1);
  const loadedFrom = cache.loadedFrom ?? "";
  if (cache.watchFrom && (!loadedFrom || cache.watchFrom < loadedFrom)) {
    // 历史没拉全：只补缺的那一段（从没拉过就是整段）
    const to = loadedFrom && loadedFrom <= settledTo ? shiftKey(loadedFrom, -1) : settledTo;
    if (cache.watchFrom <= to) attendance.push([cache.watchFrom, to]);
  } else {
    const due = nowMs - (cache.recheckedAt ?? 0) >= SETTLED_RECHECK_INTERVAL_MS;
    if (due) {
      const from = shiftKey(today, -SETTLED_RECHECK_DAYS);
      attendance.push([from < cache.watchFrom ? cache.watchFrom : from, settledTo]);
    }
  }

  let overtime: RefreshPlan["overtime"] = null;
  if (overtimeName !== null) {
    const nameChanged = (cache.overtimeName ?? "") !== overtimeName;
    const due = nameChanged || nowMs - (cache.overtimeAt ?? 0) >= OVERTIME_INTERVAL_MS;
    if (due) {
      const wantFrom = shiftKey(cache.watchFrom || today, -OVERTIME_LOOKBACK_DAYS);
      const full = nameChanged || !cache.overtimeFrom || wantFrom < cache.overtimeFrom;
      overtime = {
        mode: full ? "full" : "recent",
        sinceDate: full ? wantFrom : shiftKey(today, -OVERTIME_RECENT_DAYS),
        ...(!nameChanged && cache.overtimeCode ? { definitionCode: cache.overtimeCode } : {}),
      };
    }
  }
  return { attendance, overtime };
}

interface RuntimeState {
  cache: CacheFile | null;
  timer: NodeJS.Timeout | null;
  /** 正在刷新时不再并发发起第二次。 */
  refreshing: boolean;
  lastAttemptAt: number;
  /** 有生以来第一次拉还没回来。界面据此显示「加载中」而不是空白。 */
  warmingUp: boolean;
}

const state: RuntimeState = {
  cache: null,
  timer: null,
  refreshing: false,
  lastAttemptAt: 0,
  warmingUp: false,
};

export interface AttendanceSource {
  credentials: Credentials;
  dataDir: string;
  utcOffset?: string;
  /** 勾了「飞书加班审批」时有：按这个审批名拉加班申请。 */
  overtime?: { approvalName: string };
}

function cachePath(dataDir: string): string {
  return join(dataDir, "attendance-cache.json");
}

function emptyCache(): CacheFile {
  return {
    version: CACHE_VERSION,
    employeeId: "",
    days: {},
    fetchedAt: 0,
    watchFrom: "",
    watchTo: "",
  };
}

/** 读缓存。版本不符、文件坏了都当没有——重拉一次的代价远小于画错角标。 */
function loadCache(dataDir: string): CacheFile | null {
  try {
    const raw = readFileSync(cachePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== CACHE_VERSION) return null;
    if (!parsed.days || typeof parsed.days !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 夜里（0–6 点，本机时间）定时器不发请求：没人在看，也不会有人打卡。 */
function isQuietHour(at: Date = new Date()): boolean {
  return at.getHours() < 6;
}

/**
 * 原子写：先写临时文件再 rename。
 *
 * 后台刷新可能正好撞上宿主发来的 `list`（同一个进程、不同的微任务），
 * 半截 JSON 会让下一次读缓存整份作废。
 */
function saveCache(dataDir: string, cache: CacheFile): void {
  const target = cachePath(dataDir);
  try {
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    // 写不进去只是下次要重拉，不该让 list 失败
    logger.warn("考勤缓存写入失败", {
      code: "FEISHU_ATTENDANCE_CACHE_WRITE",
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** 缓存里有没有这份数据（不管有没有内容）。用来判断用户此前是否启用过。 */
export function hasCache(dataDir: string): boolean {
  return existsSync(cachePath(dataDir));
}

/** 有生以来第一次、还没拉到任何数据。 */
export function isWarmingUp(): boolean {
  return state.warmingUp;
}

/** 取缓存里 `[from, to]` 闭区间内的天，缺的就是缺（不补零、不猜）。 */
export function readDays(
  dataDir: string,
  from: string,
  to: string,
): AttendanceDay[] {
  const cache = state.cache ?? loadCache(dataDir);
  if (cache) state.cache = cache;
  if (!cache) return [];

  const start = dateFromKey(from);
  const end = dateFromKey(to);
  if (!start || !end || end < start) return [];

  const days: AttendanceDay[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cache.days[toDateKey(cursor)];
    if (day) days.push(day);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/**
 * 缓存里见过的班次时刻：`shift_id → { start, end }`（最近那天的为准）。
 *
 * 飞书只在**有打卡记录**的日子带应上 / 应下时刻；未来的排班日 `records` 是空的，
 * 但 `shift_id` 一样——借同一班次见过的时刻，「预计下班」与按上下班提醒的锚点才排得出
 * 未来几天（`docs/workspace/28` §4）。读缓存，不联网。
 */
export function knownShiftTimes(
  dataDir: string,
): Map<string, { start: string; end: string }> {
  const cache = state.cache ?? loadCache(dataDir);
  if (cache) state.cache = cache;
  const known = new Map<string, { start: string; end: string }>();
  if (!cache) return known;
  const days = Object.values(cache.days).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  for (const day of days) {
    if (day.shiftId && day.shiftStart && day.shiftEnd) {
      known.set(day.shiftId, { start: day.shiftStart, end: day.shiftEnd });
    }
  }
  return known;
}

/**
 * 记下用户正在看哪段时间，并确保后台刷新在跑。
 *
 * **由 `calendarOverlay.list` 调用，而它只在用户显式启用后才会被宿主调到**——
 * 所以这个函数同时是「已获授权」的信号。
 *
 * 不 await 任何网络请求：`list` 必须同步返回缓存。
 */
export function noteInterest(source: AttendanceSource, from: string, to: string): void {
  const cache = state.cache ?? loadCache(dataDir(source)) ?? emptyCache();
  state.cache = cache;

  const historyFrom = historyFloor();
  const merged = widen(cache.watchFrom, cache.watchTo, from < historyFrom ? from : historyFrom, to);
  const changed = merged.from !== cache.watchFrom || merged.to !== cache.watchTo;
  cache.watchFrom = merged.from;
  cache.watchTo = merged.to;

  const stale = Date.now() - cache.fetchedAt > REFRESH_INTERVAL_MS;
  // 首次（没有 fetchedAt）也算 stale，于是第一次被调到就会拉一次
  if (changed || stale) void refresh(source);
  ensureTimer(source);
}

/** 关注区间取并集，但不无限扩张——最多回溯与前瞻各一段。 */
function widen(
  currentFrom: string,
  currentTo: string,
  from: string,
  to: string,
): { from: string; to: string } {
  const candidates = [currentFrom, from].filter(Boolean).sort();
  const ends = [currentTo, to].filter(Boolean).sort();
  const earliest = candidates[0] ?? from;
  const latest = ends[ends.length - 1] ?? to;

  // 上限 400 天：用户翻到很久以前看过一眼，不该让后台从此每 15 分钟拉几年数据
  const start = dateFromKey(earliest);
  const end = dateFromKey(latest);
  if (!start || !end) return { from, to };
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (span <= 400) return { from: earliest, to: latest };
  // 超了就以本次请求为准，丢掉旧的关注区间
  return { from, to };
}

function dataDir(source: AttendanceSource): string {
  return source.dataDir;
}

/** 起后台定时器。幂等——每次 `list` 都会调，已经在跑就不动。 */
function ensureTimer(source: AttendanceSource): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    if (isQuietHour()) return;
    void refresh(source);
  }, REFRESH_INTERVAL_MS);
  // 别让定时器把进程钉住：宿主要关插件时应当能干净退出
  state.timer.unref?.();
}

/**
 * 进程重启后续上后台刷新。
 *
 * 只在缓存文件已存在时启动——那说明用户此前显式启用过这个 provider。
 * 缓存不存在时什么都不做，等第一次 `list` 来。
 */
export function resumeIfEnabled(source: AttendanceSource): void {
  if (!hasCache(source.dataDir)) return;
  const cache = loadCache(source.dataDir);
  if (!cache) return;
  state.cache = cache;
  if (!cache.watchFrom || !cache.watchTo) return;
  // 启动时就把近 90 天并进关注区间：不然这一轮按旧区间拉，紧接着的 list 扩了区间又被
  // 「两次刷新至少隔 1 分钟」挡住，历史要等 15 分钟后的下一轮才出现
  const merged = widen(cache.watchFrom, cache.watchTo, historyFloor(), cache.watchTo);
  cache.watchFrom = merged.from;
  cache.watchTo = merged.to;
  void refresh(source);
  ensureTimer(source);
}

/** 最近 [`MIN_HISTORY_DAYS`] 天的起点日期键。 */
function historyFloor(): string {
  const floor = new Date(Date.now() - MIN_HISTORY_DAYS * 86_400_000);
  return toDateKey(new Date(Date.UTC(floor.getFullYear(), floor.getMonth(), floor.getDate())));
}

/**
 * 拉一次并写缓存。**失败只记日志**——叠加层是装饰性显示，
 * 拉不到就少几个角标，不该让宿主那一侧看到错误。
 */
async function refresh(source: AttendanceSource): Promise<void> {
  if (state.refreshing) return;
  const now = Date.now();
  if (now - state.lastAttemptAt < MIN_REFRESH_GAP_MS) return;
  state.lastAttemptAt = now;

  const cache = state.cache ?? loadCache(source.dataDir) ?? emptyCache();
  state.cache = cache;
  if (!cache.watchFrom || !cache.watchTo) return;

  state.refreshing = true;
  if (cache.fetchedAt === 0) state.warmingUp = true;
  try {
    let employeeId = cache.employeeId;
    if (!employeeId) {
      employeeId = await resolveEmployeeId(source.credentials, source.dataDir);
      if (!employeeId) {
        // 应用没有「获取用户 user ID」权限时会走到这里。说清楚，否则用户只看到
        // 一张空日历，而问题其实在开放平台的权限页上
        logger.warn("拿不到 user_id，考勤无法查询", {
          code: "FEISHU_ATTENDANCE_NO_EMPLOYEE_ID",
          detail: {
            hint: "开放平台需要「获取用户 user ID」权限，改过权限后要重新授权",
          },
        });
        return;
      }
      cache.employeeId = employeeId;
    }

    const nowMs = Date.now();
    const today = toDateKey(new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())));
    const plan = planRefresh(cache, nowMs, today, source.overtime ? source.overtime.approvalName : null);

    let fetched = 0;
    for (const [from, to] of plan.attendance) {
      const days = await fetchAttendance({
        credentials: source.credentials,
        dataDir: source.dataDir,
        employeeId,
        from,
        to,
        ...(source.utcOffset === undefined ? {} : { utcOffset: source.utcOffset }),
      });
      // 合并而不是替换：用户翻回上个月时，这个月的数据还在
      for (const day of days) {
        const old = cache.days[day.date];
        // 加班审批的标记不属于考勤接口，合并时带过去
        cache.days[day.date] = old?.overtimeApproval ? { ...day, overtimeApproval: old.overtimeApproval } : day;
      }
      fetched += days.length;
    }
    // 记账：这一轮覆盖到的历史段、核对时刻。fetchAttendance 单段失败只记日志不抛，所以这里
    // 只在整轮没抛异常时推进——抛了就留着下一轮重试
    const recentFrom = plan.attendance[0]?.[0] ?? today;
    if (plan.attendance.length > 1) {
      const settled = plan.attendance[1];
      if (settled) {
        const loadedFrom = cache.loadedFrom ?? "";
        if (!loadedFrom || settled[0] < loadedFrom) cache.loadedFrom = settled[0];
        // 只有这一段碰到了近 30 天才算「核对过」；只补更早的历史时不算
        if (settled[1] > shiftKey(today, -SETTLED_RECHECK_DAYS)) cache.recheckedAt = nowMs;
      }
    } else if (!cache.loadedFrom) {
      cache.loadedFrom = recentFrom;
    }

    // 加班审批（勾了「飞书加班审批」才拉，到点才拉）
    if (source.overtime && plan.overtime) {
      const sinceMs = (dateFromKey(plan.overtime.sinceDate)?.getTime() ?? nowMs);
      const result = await fetchOvertimeApprovals({
        credentials: source.credentials,
        dataDir: source.dataDir,
        approvalName: source.overtime.approvalName,
        sinceSeconds: Math.floor(sinceMs / 1000),
        ...(plan.overtime.definitionCode ? { definitionCode: plan.overtime.definitionCode } : {}),
      });
      if (result) {
        // 先清掉这个窗口里旧的标记：撤回 / 被拒的要消失
        for (const day of Object.values(cache.days)) {
          if (day.date >= plan.overtime.sinceDate) delete day.overtimeApproval;
        }
        for (const approval of result.approvals.values()) {
          const day = cache.days[approval.date] ?? { date: approval.date, kind: "rest" as const };
          day.overtimeApproval = { start: approval.start, end: approval.end, status: approval.status };
          cache.days[approval.date] = day;
        }
        cache.overtimeAt = nowMs;
        cache.overtimeName = source.overtime.approvalName;
        if (result.definitionCode) cache.overtimeCode = result.definitionCode;
        if (plan.overtime.mode === "full" && (!cache.overtimeFrom || plan.overtime.sinceDate < cache.overtimeFrom)) {
          cache.overtimeFrom = plan.overtime.sinceDate;
        }
      }
    }
    cache.fetchedAt = Date.now();
    saveCache(source.dataDir, cache);
    logger.info("考勤缓存已刷新", {
      code: "FEISHU_ATTENDANCE_REFRESHED",
      detail: {
        segments: plan.attendance.length,
        days: fetched,
        overtime: plan.overtime ? plan.overtime.mode : "skip",
      },
    });
  } catch (error) {
    logger.warn("考勤刷新失败，日历上会少几个角标", {
      code: "FEISHU_ATTENDANCE_REFRESH_FAILED",
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    state.refreshing = false;
    state.warmingUp = false;
  }
}

/** 只给测试用：把模块级状态清干净。 */
export function resetForTests(): void {
  if (state.timer) clearInterval(state.timer);
  state.cache = null;
  state.timer = null;
  state.refreshing = false;
  state.lastAttemptAt = 0;
  state.warmingUp = false;
}
