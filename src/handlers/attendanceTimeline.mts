/**
 * 考勤 → 时间轴叠加：打卡线、工作时段、命名时刻、日期面板考勤条、悬停键值行
 * （`docs/workspace/28` §2.3，宿主契约见 `src/sdk/types.mts` 的 `TimeMarker` 等）。
 *
 * **纯函数**，不读缓存不联网；`list` 把读好的天、班次表与「现在」交进来。
 *
 * 宿主不认识「上班」：这里给的全是线、色段、文案与锚点 key，判定与文案只在插件里。
 */
import type {
  BadgeArc,
  DayStrip,
  OverlayAnchor,
  OverlayDetailRow,
  TimeBand,
  TimeMarker,
} from "../sdk/index.mjs";
import type { AttendanceDay, PunchStatus } from "../feishu/attendance.mjs";

export interface TimelineCopy {
  checkIn: string;
  checkOut: string;
  expectedOut: string;
  onDuty: string;
  toExpected: string;
  stripIn: (time: string) => string;
  stripOut: (time: string) => string;
  stripOutPending: string;
  stripWorked: (minutes: number) => string;
  stripShift: (start: string, end: string) => string;
  rowKind: string;
  rowShift: string;
  rowIn: string;
  rowOut: string;
  rowWorked: string;
  rowApproval: string;
  notYet: string;
  status: Record<PunchStatus, string>;
  kind: Record<AttendanceDay["kind"], string>;
  leave: { am: string; pm: string; full: string };
  anchorWorkStart: string;
  anchorWorkEnd: string;
  anchorCheckIn: string;
  anchorCheckOut: string;
  duration: (minutes: number) => string;
}

const ZH: TimelineCopy = {
  checkIn: "上班打卡",
  checkOut: "下班打卡",
  expectedOut: "预计下班 · 排班",
  onDuty: "在岗",
  toExpected: "到预计下班",
  stripIn: (time) => `上班 ${time}`,
  stripOut: (time) => `下班 ${time}`,
  stripOutPending: "下班 —",
  stripWorked: (minutes) => `在岗 ${durationZh(minutes)}`,
  stripShift: (start, end) => `排班 ${start}–${end}`,
  rowKind: "性质",
  rowShift: "排班",
  rowIn: "上班卡",
  rowOut: "下班卡",
  rowWorked: "在岗",
  rowApproval: "加班申请",
  notYet: "还没打",
  status: { normal: "正常", late: "迟到", early: "早退", lack: "缺卡", todo: "还没打" },
  kind: {
    worked: "上班日",
    scheduled: "上班日（今天还没下班）",
    absent: "有排班但没打卡",
    overtime: "休息日加班",
    leave: "请假",
    rest: "休息",
  },
  leave: { am: "上午请假", pm: "下午请假", full: "全天请假" },
  anchorWorkStart: "上班（排班）",
  anchorWorkEnd: "下班（排班）",
  anchorCheckIn: "上班打卡",
  anchorCheckOut: "下班打卡",
  duration: durationZh,
};

const EN: TimelineCopy = {
  checkIn: "Clock-in",
  checkOut: "Clock-out",
  expectedOut: "Expected out · shift",
  onDuty: "On duty",
  toExpected: "Until expected out",
  stripIn: (time) => `In ${time}`,
  stripOut: (time) => `Out ${time}`,
  stripOutPending: "Out —",
  stripWorked: (minutes) => `On duty ${durationEn(minutes)}`,
  stripShift: (start, end) => `Shift ${start}–${end}`,
  rowKind: "Type",
  rowShift: "Shift",
  rowIn: "Clock-in",
  rowOut: "Clock-out",
  rowWorked: "On duty",
  rowApproval: "Overtime request",
  notYet: "not yet",
  status: { normal: "on time", late: "late", early: "early", lack: "missing", todo: "not yet" },
  kind: {
    worked: "Workday",
    scheduled: "Workday (in progress)",
    absent: "Scheduled, no clock-in",
    overtime: "Overtime on a rest day",
    leave: "Leave",
    rest: "Rest",
  },
  leave: { am: "Morning leave", pm: "Afternoon leave", full: "Full-day leave" },
  anchorWorkStart: "Work start (shift)",
  anchorWorkEnd: "Work end (shift)",
  anchorCheckIn: "Clock-in",
  anchorCheckOut: "Clock-out",
  duration: durationEn,
};

export function timelineCopyFor(locale: string): TimelineCopy {
  return locale.toLowerCase().startsWith("en") ? EN : ZH;
}

function durationZh(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

function durationEn(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** 公司时区里的「现在」：日期键 + `HH:mm`。 */
export interface Now {
  date: string;
  clock: string;
}

export type ShiftTable = Map<string, { start: string; end: string }>;

/** 这一天的班次时刻：自己带的优先，没有就借同一 `shiftId` 见过的。 */
export function shiftOf(
  day: AttendanceDay,
  shifts: ShiftTable,
): { start: string; end: string } | null {
  if (day.shiftStart && day.shiftEnd) return { start: day.shiftStart, end: day.shiftEnd };
  const known = day.shiftId ? shifts.get(day.shiftId) : undefined;
  if (known) return known;
  // 休息日加班：没有排班，用加班申请的时段当「这天的班」
  return day.overtimeApproval ? { start: day.overtimeApproval.start, end: day.overtimeApproval.end } : null;
}

function minutesOf(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

function arcOf(status: PunchStatus | undefined): BadgeArc {
  switch (status) {
    case "normal":
      return "done";
    case "late":
    case "early":
      return "warn";
    case "lack":
      return "miss";
    default:
      return "idle";
  }
}

function leadingArc(day: AttendanceDay): BadgeArc {
  if (day.leavePeriod === "am" || day.leavePeriod === "full") return "alt";
  return arcOf(day.punchIn);
}

function trailingArc(day: AttendanceDay): BadgeArc {
  if (day.leavePeriod === "pm" || day.leavePeriod === "full") return "alt";
  return arcOf(day.punchOut);
}

/** 在岗分钟：上班卡到下班卡；今天还没下班就到现在。算不出返回 `null`。 */
function workedMinutes(day: AttendanceDay, now: Now): number | null {
  if (!day.checkIn) return null;
  const end = day.checkOut ?? (day.date === now.date ? now.clock : null);
  if (!end) return null;
  const minutes = minutesOf(end) - minutesOf(day.checkIn);
  return minutes > 0 ? minutes : null;
}

export interface DayTimeline {
  markers: TimeMarker[];
  bands: TimeBand[];
  anchors: OverlayAnchor[];
  strip: DayStrip | null;
}

/**
 * 一天 → 时间轴叠加。
 *
 * - **线**：上班卡、下班卡各一根（实际）；今天还没下班且知道排班 → 一根「预计下班」（虚）。
 *   未来的日子不画线（还没发生，日历自己知道哪天上班）。
 * - **时段**：上班卡 → 下班卡（或现在）实底；今天没下班 → 现在 → 预计下班斜纹。
 * - **锚点**：有排班就给 `workStart` / `workEnd`（预计，未来几天也给，提醒要用）；
 *   打了卡再给 `checkIn` / `checkOut`（实际）。
 * - **考勤条**：上班 / 下班 / 在岗（或排班）三项。
 */
export function toTimeline(
  day: AttendanceDay,
  copy: TimelineCopy,
  now: Now,
  shifts: ShiftTable,
): DayTimeline {
  const markers: TimeMarker[] = [];
  const bands: TimeBand[] = [];
  const anchors: OverlayAnchor[] = [];
  const shift = shiftOf(day, shifts);
  const past = day.date <= now.date;

  if (
    shift &&
    (day.kind === "worked" ||
      day.kind === "scheduled" ||
      day.kind === "absent" ||
      day.kind === "leave" ||
      day.overtimeApproval)
  ) {
    anchors.push(
      { date: day.date, key: "workStart", at: shift.start, label: copy.anchorWorkStart, expected: true },
      { date: day.date, key: "workEnd", at: shift.end, label: copy.anchorWorkEnd, expected: true },
    );
  }
  if (day.checkIn) {
    anchors.push({ date: day.date, key: "checkIn", at: day.checkIn, label: copy.anchorCheckIn });
  }
  if (day.checkOut) {
    anchors.push({ date: day.date, key: "checkOut", at: day.checkOut, label: copy.anchorCheckOut });
  }

  if (past && day.checkIn) {
    markers.push({
      date: day.date,
      at: day.checkIn,
      side: "leading",
      arc: leadingArc(day),
      label: copy.checkIn,
      detail: copy.status[day.punchIn ?? "normal"],
    });
  }
  if (past && day.checkOut) {
    markers.push({
      date: day.date,
      at: day.checkOut,
      side: "trailing",
      arc: trailingArc(day),
      label: copy.checkOut,
      detail: copy.status[day.punchOut ?? "normal"],
    });
  }
  const today = day.date === now.date;
  if (today && !day.checkOut && shift && minutesOf(shift.end) > minutesOf(now.clock)) {
    markers.push({
      date: day.date,
      at: shift.end,
      side: "trailing",
      arc: "idle",
      expected: true,
      label: copy.expectedOut,
      detail: copy.stripShift(shift.start, shift.end),
    });
  }

  if (past && day.checkIn) {
    const end = day.checkOut ?? (today ? now.clock : null);
    if (end && minutesOf(end) > minutesOf(day.checkIn)) {
      bands.push({ date: day.date, from: day.checkIn, to: end, label: copy.onDuty });
    }
    if (today && !day.checkOut && shift) {
      const from = minutesOf(now.clock) > minutesOf(day.checkIn) ? now.clock : day.checkIn;
      if (minutesOf(shift.end) > minutesOf(from)) {
        bands.push({ date: day.date, from, to: shift.end, expected: true, label: copy.toExpected });
      }
    }
  }

  let strip: DayStrip | null = null;
  if (past && (day.checkIn || day.checkOut || shift)) {
    const items: DayStrip["items"] = [];
    if (day.checkIn) items.push({ text: copy.stripIn(day.checkIn), arc: leadingArc(day), side: "leading" });
    if (day.checkOut) {
      items.push({ text: copy.stripOut(day.checkOut), arc: trailingArc(day), side: "trailing" });
    } else if (day.checkIn) {
      items.push({ text: copy.stripOutPending, arc: "idle", side: "trailing" });
    }
    const worked = workedMinutes(day, now);
    if (worked !== null) items.push({ text: copy.stripWorked(worked), tone: "mute" });
    else if (shift) items.push({ text: copy.stripShift(shift.start, shift.end), tone: "mute" });
    if (items.length > 0) strip = { date: day.date, items: items.slice(0, 3) };
  }

  return { markers, bands, anchors, strip };
}

/** 悬停键值行（宿主「这天性质」环的悬停优先用它）。 */
export function toDetailRows(
  day: AttendanceDay,
  copy: TimelineCopy,
  now: Now,
  shifts: ShiftTable,
): OverlayDetailRow[] {
  const rows: OverlayDetailRow[] = [];
  const kind = day.leavePeriod
    ? copy.leave[day.leavePeriod]
    : day.overtimeApproval && day.kind !== "overtime"
      ? copy.kind.overtime
      : copy.kind[day.kind];
  rows.push({ k: copy.rowKind, v: kind });
  const shift = shiftOf(day, shifts);
  if (shift) rows.push({ k: copy.rowShift, v: `${shift.start}–${shift.end}` });
  rows.push({
    k: copy.rowIn,
    v: day.checkIn ? `${day.checkIn} ${copy.status[day.punchIn ?? "normal"]}` : copy.notYet,
    arc: leadingArc(day),
  });
  rows.push({
    k: copy.rowOut,
    v: day.checkOut ? `${day.checkOut} ${copy.status[day.punchOut ?? "normal"]}` : copy.notYet,
    arc: trailingArc(day),
  });
  const worked = workedMinutes(day, now);
  if (worked !== null) rows.push({ k: copy.rowWorked, v: copy.duration(worked) });
  if (day.overtimeApproval) {
    const { start, end, status } = day.overtimeApproval;
    rows.push({
      k: copy.rowApproval,
      v: `${start}–${end} · ${status === "2" ? (copy === EN ? "approved" : "已通过") : copy === EN ? "pending" : "审批中"}`,
    });
  }
  return rows;
}

/** 公司时区的「现在」。 */
export function nowIn(offsetMinutes: number, at: Date = new Date()): Now {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  const date = shifted.toISOString().slice(0, 10);
  const clock = `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`;
  return { date, clock };
}
