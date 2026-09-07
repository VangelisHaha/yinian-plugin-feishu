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

/**
 * 缓存文件格式版本。**改 [`AttendanceDay`] 的形状必须同时加这个数**——
 * 版本对不上就整份丢掉重拉，比读到半旧半新的结构安全（那种错会画出错的角标）。
 */
const CACHE_VERSION = 1;

/** 后台刷新间隔。考勤几分钟级的新鲜度完全够用，打卡也不是秒级要看到的事。 */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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

  const merged = widen(cache.watchFrom, cache.watchTo, from, to);
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
  void refresh(source);
  ensureTimer(source);
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

    const days = await fetchAttendance({
      credentials: source.credentials,
      dataDir: source.dataDir,
      employeeId,
      from: cache.watchFrom,
      to: cache.watchTo,
      ...(source.utcOffset === undefined ? {} : { utcOffset: source.utcOffset }),
    });

    // 合并而不是替换：用户翻回上个月时，这个月的数据还在
    for (const day of days) cache.days[day.date] = day;
    cache.fetchedAt = Date.now();
    saveCache(source.dataDir, cache);
    logger.info("考勤缓存已刷新", {
      code: "FEISHU_ATTENDANCE_REFRESHED",
      detail: { from: cache.watchFrom, to: cache.watchTo, days: days.length },
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
