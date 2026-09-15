/**
 * 日历叠加层：把飞书考勤画到安时的日历上。
 *
 * 两个落点（manifest 里声明的就是这两个 surface）：
 *
 * - **格子右上角的环形角标**：左半环上班卡、右半环下班卡（绿正常 / 琥珀迟到早退 /
 *   红缺卡 / 灰还没有结论 / 紫请假），中间一个字说这天的性质：「班」「加」「假」
 * - **日历侧栏「负载」卡里的几行**：出勤 / 加班 / 请假 / 异常的天数
 *
 * 刻意**不占视图右上角那条汇总**（`summary`）：契约 §8.4 说同一个指标不要两处都给，
 * 而那条很窄的横排最该留给「排期和出勤对不上」这类需要处理的事——那需要安时侧的排期
 * 数据，本期没做。侧栏那张卡竖排、空间宽松，正适合一组同类天数铺开。
 *
 * ## 这里一行网络请求都没有
 *
 * 契约的硬要求（§8.4）：`list` 在 UI 路径上、超时 8 秒，只读本地缓存。取数在
 * `feishu/attendanceStore.mts` 的后台节奏里。这个 handler 唯一的"副作用"是告诉
 * store「用户正在看哪段时间」，而那个调用不 await 任何 I/O。
 *
 * ## 文案在这里，颜色不在
 *
 * 宿主不认识「出勤」这个词，也就无从翻译它，所以它把界面语言下发给我们（`locale`）。
 * 反过来颜色一律归宿主：我们只给 `tone` 这个语义档位。
 */

import { context, logger } from "../sdk/index.mjs";
import type {
  BadgeArc,
  CalendarOverlayListRequest,
  CalendarOverlayListResult,
  DayBadge,
  OverlaySummaryItem,
  OverlayTone,
} from "../sdk/index.mjs";
import type { AttendanceDay, PunchStatus } from "../feishu/attendance.mjs";
import {
  isStrictDateKey,
  parseUtcOffset,
  todayKey,
} from "../feishu/attendance.mjs";
import {
  isWarmingUp,
  noteInterest,
  readDays,
  resumeIfEnabled,
  type AttendanceSource,
} from "../feishu/attendanceStore.mjs";
import { capabilitiesFrom } from "../feishu/capability.mjs";
import { configOf, credentialsFrom } from "../feishu/pluginConfig.mjs";

/** manifest 里声明的 provider id。 */
const PROVIDER_ID = "attendance";

/**
 * 界面语言 → 文案表。
 *
 * 只做中英两套：宿主自己也只有这两种界面语言。认不出的 locale 落到中文，
 * **不报错**（契约 §8.4 明确要求）。
 */
interface Copy {
  /**
   * 环中间那个字。**只有三种**——状态由弧的颜色说，不再有「缺」「异」这类字。
   *
   * 环内径只放得下 1 个汉字或 2 个拉丁字符，所以英文用缩写。
   */
  badge: { worked: string; overtime: string; leave: string };
  detail: {
    worked: string;
    overtime: string;
    leave: string;
    leaveAm: string;
    leavePm: string;
    scheduled: string;
    absent: string;
    punch: (checkIn: string, checkOut: string) => string;
    punchIn: (checkIn: string) => string;
    issues: string;
    late: string;
    early: string;
    lack: string;
  };
  stat: {
    attended: string;
    overtime: string;
    leave: string;
    issues: string;
    loading: string;
    loadingValue: string;
    days: (count: number) => string;
  };
  /** 配置不全时那一行怎么写。**不能静默空**，理由见 `list` 里的注释。 */
  blocked: Record<BlockedReason, { value: string; detail: string }>;
}

/**
 * 为什么拉不了考勤。
 *
 * `capability` 是真实踩到的那个：用户在日历侧栏打开了叠加层，却没在插件设置里勾
 * 「飞书考勤」——于是 token 里没有 `attendance:task:readonly`，而界面上什么都不说。
 */
type BlockedReason = "credentials" | "capability";

const ZH: Copy = {
  badge: { worked: "班", overtime: "加", leave: "假" },
  detail: {
    worked: "出勤",
    overtime: "休息日加班",
    leave: "全天请假",
    leaveAm: "上午请假",
    leavePm: "下午请假",
    scheduled: "今天有排班",
    absent: "有排班但没有打卡记录",
    punch: (checkIn, checkOut) => `打卡 ${checkIn}–${checkOut}`,
    punchIn: (checkIn) => `打卡 ${checkIn}，尚未下班`,
    issues: "异常",
    late: "迟到",
    early: "早退",
    lack: "缺卡",
  },
  stat: {
    attended: "出勤",
    overtime: "加班",
    leave: "请假",
    issues: "异常",
    loading: "考勤",
    loadingValue: "加载中",
    days: (count) => `${formatDays(count)} 天`,
  },
  blocked: {
    credentials: {
      value: "未配置",
      detail: "插件设置里还没填 App ID / App Secret",
    },
    capability: {
      value: "未勾选",
      detail:
        "去插件设置勾上「飞书考勤」，然后重新点一次「开始授权」——" +
        "飞书每次授权只给这一次请求的权限，不勾就不会申请考勤的读取范围",
    },
  },
};

const EN: Copy = {
  badge: { worked: "W", overtime: "OT", leave: "LV" },
  detail: {
    worked: "Attended",
    overtime: "Overtime on a day off",
    leave: "On leave all day",
    leaveAm: "On leave in the morning",
    leavePm: "On leave in the afternoon",
    scheduled: "Scheduled for today",
    absent: "Scheduled but no punch record",
    punch: (checkIn, checkOut) => `Punched ${checkIn}–${checkOut}`,
    punchIn: (checkIn) => `Punched in at ${checkIn}, no punch out yet`,
    issues: "Issues",
    late: "late",
    early: "left early",
    lack: "missing punch",
  },
  stat: {
    attended: "Attended",
    overtime: "Overtime",
    leave: "Leave",
    issues: "Issues",
    loading: "Attendance",
    loadingValue: "loading…",
    days: (count) => `${formatDays(count)}d`,
  },
  blocked: {
    credentials: {
      value: "not set up",
      detail: "App ID / App Secret are still empty in the plugin settings",
    },
    capability: {
      value: "not enabled",
      detail:
        "Tick “飞书考勤” in the plugin settings, then re-run the authorization — " +
        "Feishu only grants the scopes requested in that one round",
    },
  },
};

function copyFor(locale: string): Copy {
  return locale.toLowerCase().startsWith("en") ? EN : ZH;
}

/** 天数格式化归插件：宿主拿到的是字符串，它不知道该带什么单位。 */
function formatDays(count: number): string {
  return Number.isInteger(count) ? String(count) : count.toFixed(1);
}

export async function list(
  request: CalendarOverlayListRequest,
): Promise<CalendarOverlayListResult> {
  if (request.providerId !== PROVIDER_ID) {
    // 只声明了一个 provider，问别的说明契约层出了问题。返回空而不是抛：
    // 这个调用不重试，抛了用户只看到一个红色插件卡片
    logger.warn("calendarOverlay.list 收到未知 providerId", {
      code: "FEISHU_OVERLAY_UNKNOWN_PROVIDER",
      detail: { providerId: request.providerId },
    });
    return {};
  }
  if (
    !isStrictDateKey(request.from) ||
    !isStrictDateKey(request.to) ||
    !isStrictDateKey(request.summaryFrom) ||
    !isStrictDateKey(request.summaryTo)
  ) {
    logger.warn("calendarOverlay.list 收到非法区间", {
      code: "FEISHU_OVERLAY_RANGE",
      detail: { from: request.from, to: request.to },
    });
    return {};
  }

  const copy = copyFor(request.locale);
  const config = configOf();
  const blocked = blockedResult(config, copy);
  if (blocked) return blocked;

  const source = sourceFrom(config);
  if (!source) return {};

  // 记下用户在看哪段时间，并确保后台刷新在跑。**不 await**——契约要求 list 只读缓存
  noteInterest(source, request.from, request.to);

  // 角标按看得见的全部格子（月视图 42 天，含上下月边缘）
  const badgeDays = readDays(source.dataDir, request.from, request.to);
  // 汇总按当月首尾，**不是那 42 天**：拿 42 天算「本月出勤」会多算六七天，
  // 而界面上完全看不出错
  const summaryDays = readDays(
    source.dataDir,
    request.summaryFrom,
    request.summaryTo,
  );

  const showWorkdays = showWorkdayBadges(config);
  // 「今天」按公司时区算而不是本机时区：出差到别的时区时，今天那一格该跟着公司走
  const today = todayKey(parseUtcOffset(source.utcOffset));
  const badges = badgeDays
    .map((day) => toBadge(day, copy, showWorkdays, today))
    .filter((badge): badge is DayBadge => badge !== null);

  return {
    badges,
    sidebarStats: toStats(summaryDays, copy),
  };
}

/**
 * 一天 → 角标。返回 `null` 表示这天不画。
 *
 * 画出来的是**环形**（契约 `shape: "ring"`）：左半环是上班卡、右半环是下班卡，中间一个
 * 字说这天是什么性质（班 / 加 / 假）。上一版是一个文字小方块，「班」和「加」在格子里
 * 长得几乎一样，而「上午打了卡、下午忘打」只能靠悬浮才看得出来——那三件事恰好是一天
 * 里最该被一眼看到的，环把它们分成三个位置。
 *
 * **纯休息日永远不画**：一个月八九个周末各印一个「休」，把格子右上角那个位置占满，
 * 而它没有任何信息量——日历本来就知道周六周日是哪几天。
 *
 * 普通工作日出勤（`worked`）默认画，但可以在设置里关掉：它是常态，一个月二十来个环也
 * 接近噪声。想看的人要的是「这个月我到底出勤了哪些天」，所以默认开着。
 *
 * `scheduled`（有排班、那天还没过完）**只画今天**：今天那一格恰恰是最值得看的
 * （上班卡绿了、下班卡还灰着），而未来一整月的空环没有任何信息量——哪些天上班日历自己
 * 就知道。这一条替换了上一版「`scheduled` 一律不画」的规则：那时画出来是撒谎（一个
 * 「班」字说不出「还没打卡」），环形有 `idle` 这一档，说得出来。
 */
export function toBadge(
  day: AttendanceDay,
  copy: Copy,
  showWorkdays: boolean,
  today: string,
): DayBadge | null {
  if (day.kind === "rest") return null;
  if (day.kind === "scheduled" && day.date !== today) return null;
  if (
    (day.kind === "worked" || day.kind === "scheduled") &&
    !showWorkdays &&
    !hasIssues(day)
  ) {
    return null;
  }

  const badge: DayBadge = {
    date: day.date,
    label: ringLabel(day, copy),
    shape: "ring",
    arcs: {
      leading: leadingArc(day),
      trailing: trailingArc(day),
    },
  };
  const tone = badgeTone(day);
  if (tone !== "neutral") badge.tone = tone;
  // 环里只有一个字，detail 是它的唯一解释来源，一律给
  badge.detail = badgeDetail(day, copy);
  return badge;
}

/**
 * 中间那个字。**只有三种**：全天假「假」、休息日加班「加」、其余「班」。
 *
 * 上一版还有「缺」和「异」两种，现在由弧的颜色说：缺卡是红弧、迟到是琥珀弧。让字去说
 * 状态、弧去说状态，是把同一件事画两遍，而两处一旦不一致（比如「班」配一圈红弧）
 * 用户只会觉得其中一个是错的。
 */
function ringLabel(day: AttendanceDay, copy: Copy): string {
  if (day.leavePeriod === "full") return copy.badge.leave;
  if (day.kind === "overtime") return copy.badge.overtime;
  return copy.badge.worked;
}

/** 上班那半环。请假盖过打卡结论——请假是有交代的，没打卡是没有交代。 */
function leadingArc(day: AttendanceDay): BadgeArc {
  if (day.leavePeriod === "am" || day.leavePeriod === "full") return "alt";
  return arcOf(day.punchIn);
}

/** 下班那半环。 */
function trailingArc(day: AttendanceDay): BadgeArc {
  if (day.leavePeriod === "pm" || day.leavePeriod === "full") return "alt";
  return arcOf(day.punchOut);
}

/**
 * 一次打卡的结论 → 一段弧的语义档位。
 *
 * `absent`（有排班、已经过去、一次卡都没打）走的也是这里：飞书那天两侧都给 `Lack`，
 * 于是整圈是红的——比一个「缺」字更快看出「这天两次卡都没有」。
 */
function arcOf(status: PunchStatus | undefined): BadgeArc {
  switch (status) {
    case "normal":
      return "done";
    case "late":
    case "early":
      return "warn";
    case "lack":
      return "miss";
    // `todo`（该打还没打）与「不需要打卡」都是「还没有结论」：加班日无需打卡，
    // 画成灰环比画成缺卡诚实
    default:
      return "idle";
  }
}

function hasIssues(day: AttendanceDay): boolean {
  return (day.issues ?? []).length > 0;
}

/**
 * 语义档位。
 *
 * **不会返回 `alert`**：契约 §8.4 说角标上不许用强调色（它就在格子里，会和「今天」
 * 「高优先级」抢同一层注意力），宿主收到也会降级成 `strong`。
 */
function badgeTone(day: AttendanceDay): OverlayTone {
  if (day.kind === "overtime") return "strong";
  if (day.kind === "absent") return "strong";
  if (hasIssues(day)) return "strong";
  if (day.kind === "leave") return "mute";
  return "neutral";
}

function badgeDetail(day: AttendanceDay, copy: Copy): string {
  const parts: string[] = [];
  switch (day.kind) {
    case "overtime":
      parts.push(copy.detail.overtime);
      break;
    case "leave":
      // 半天假要说清是哪半天：环上是一段紫弧，说不出上午还是下午
      parts.push(
        day.leavePeriod === "am"
          ? copy.detail.leaveAm
          : day.leavePeriod === "pm"
            ? copy.detail.leavePm
            : copy.detail.leave,
      );
      break;
    case "scheduled":
      parts.push(copy.detail.scheduled);
      break;
    case "absent":
      parts.push(copy.detail.absent);
      break;
    default:
      parts.push(copy.detail.worked);
  }
  if (day.checkIn && day.checkOut) {
    parts.push(copy.detail.punch(day.checkIn, day.checkOut));
  } else if (day.checkIn) {
    parts.push(copy.detail.punchIn(day.checkIn));
  }
  const issues = day.issues ?? [];
  if (issues.length > 0) {
    const names = issues.map((issue) => copy.detail[issue]);
    parts.push(`${copy.detail.issues}: ${names.join(" / ")}`);
  }
  return parts.join(" · ");
}

/**
 * 汇总口径内的天数统计，最多 4 行（宿主的上限，超出丢弃）。
 *
 * 「零」用 `tone: "mute"` 说：`value` 是字符串，宿主看不出 `0 天` 是零。
 */
export function toStats(days: AttendanceDay[], copy: Copy): OverlaySummaryItem[] {
  if (days.length === 0 && isWarmingUp()) {
    // 有生以来第一次，后台还在拉。说一句，别让用户以为坏了
    return [
      {
        key: "loading",
        label: copy.stat.loading,
        value: copy.stat.loadingValue,
        tone: "mute",
      },
    ];
  }

  let attended = 0;
  let overtime = 0;
  let leave = 0;
  let issues = 0;
  for (const day of days) {
    // 出勤口径与 worktime-audit 一致：**加班日也算出勤**，
    // 周末打了卡同样要有排期工时覆盖
    if (day.kind === "worked" || day.kind === "overtime") attended += 1;
    if (day.kind === "overtime") overtime += 1;
    if (day.kind === "leave") leave += 1;
    if (hasIssues(day)) issues += 1;
  }

  const row = (
    key: string,
    label: string,
    count: number,
    mark: "bar" | "dot",
  ): OverlaySummaryItem => ({
    key,
    label,
    value: copy.stat.days(count),
    mark,
    ...(count === 0 ? { tone: "mute" as const } : {}),
  });

  const stats = [
    row("attended", copy.stat.attended, attended, "bar"),
    row("overtime", copy.stat.overtime, overtime, "bar"),
    row("leave", copy.stat.leave, leave, "dot"),
  ];
  // 第四行只在真的有异常时占位：宿主上限是 4 行，而「异常 0 天」不值得占掉一行
  if (issues > 0) {
    stats.push(row("issues", copy.stat.issues, issues, "dot"));
  }
  return stats;
}

/**
 * 配置不全时该显示什么。`null` 表示配置没问题。
 *
 * **不要静默返回空。** 用户已经在日历侧栏把这个 provider 打开了——那是一次显式的授权
 * 动作，界面理应给出回应。返回 `{}` 的表现是「开关开着、日历上什么都没有、插件日志里
 * 也一条记录都没有」，用户无从判断是没配好还是坏了（0.5.0 首次验收就撞在这上面：
 * 漏勾了「飞书考勤」这项能力）。
 */
export function blockedResult(
  config: Record<string, unknown>,
  copy: Copy,
): CalendarOverlayListResult | null {
  const reason = whyBlocked(config);
  if (!reason) return null;
  return {
    sidebarStats: [
      {
        key: "blocked",
        label: copy.stat.loading,
        value: copy.blocked[reason].value,
        // alert 档在侧栏是允许的，而它确实是「需要处理」：不处理就永远没有数据。
        // 契约要求 alert 必须带 detail，否则宿主降级成 strong
        tone: "alert",
        detail: copy.blocked[reason].detail,
      },
    ],
  };
}

/**
 * 配置为什么不够用。`null` 表示没问题。
 *
 * 与 `sourceFrom` 分开是为了让 `list` 能把原因**显示出来**——静默返回空会让用户面对
 * 「开关开着、日历上什么都没有、日志里也没有」这种无从下手的状态。
 */
function whyBlocked(config: Record<string, unknown>): BlockedReason | null {
  const credentials = credentialsFrom(config);
  if (!credentials.appId || !credentials.appSecret) return "credentials";
  if (!capabilitiesFrom(config).includes("attendance")) {
    // 没勾这项能力，token 里也就没有 `attendance:task:readonly`。硬拉只会撞一个 403，
    // 而那会被记成插件错误、还可能烧断路器
    logOnce(
      "勾了日历叠加但没勾「飞书考勤」这项能力，考勤拉不了",
      "FEISHU_ATTENDANCE_CAPABILITY_MISSING",
      { hint: "插件设置里勾上「飞书考勤」并重新授权" },
    );
    return "capability";
  }
  return null;
}

/** 已经过了 `whyBlocked` 才调。 */
function sourceFrom(config: Record<string, unknown>): AttendanceSource | null {
  const credentials = credentialsFrom(config);
  if (!credentials.appId || !credentials.appSecret) return null;
  const utcOffset = String(config["attendanceUtcOffset"] ?? "").trim();
  return {
    credentials,
    dataDir: context().dataDir,
    ...(utcOffset ? { utcOffset } : {}),
  };
}

/**
 * 同一条诊断只记一次。
 *
 * `calendarOverlay.list` 跟着用户翻月走，每次都记会把插件日志刷满，而真正的错误就被
 * 埋掉了——那恰恰是这条日志存在的意义。
 */
const logged = new Set<string>();

function logOnce(
  message: string,
  code: string,
  detail: Record<string, unknown>,
): void {
  if (logged.has(code)) return;
  logged.add(code);
  logger.warn(message, { code, detail });
}

/** 工作日要不要也打角标。默认**开**——用户装它就是想看到出勤。 */
function showWorkdayBadges(config: Record<string, unknown>): boolean {
  const raw = config["attendanceShowWorkdays"];
  return raw === undefined || raw === null ? true : Boolean(raw);
}

/** 只给测试用：拿到某个语言的文案表。 */
export function copyForTests(locale: string): Copy {
  return copyFor(locale);
}

/**
 * 进程启动时续上后台刷新（由 `main.mts` 的 `onInit` 调）。
 *
 * 只在缓存文件已存在时真的动——理由见 `attendanceStore.mts` 的文件头：那是「用户
 * 此前显式启用过」的唯一证据，没有它就不该去拉他的个人数据。
 */
export function resumeAttendance(): void {
  const source = sourceFrom(configOf());
  if (!source) return;
  resumeIfEnabled(source);
}
