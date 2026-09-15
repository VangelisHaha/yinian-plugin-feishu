/**
 * 考勤判定与角标渲染。
 *
 * 这块的错误几乎全是**静默的**——判错一天只是日历上少一个角标或多一个错角标，
 * 没有任何报错，所以必须由测试守住：
 *
 * - `shift_id === "0"` 被当成「没上班」→ 周末加班日整个丢掉，而工时审计正靠它；
 * - `check_time` 当毫秒解析 → 打卡时刻算到 1970 年；
 * - 42 天不分段 → 飞书报 `interval is larger than 30`，表现是「翻到月视图什么都没有」；
 * - 汇总口径拿 42 天算 → 「本月出勤」多算六七天，而界面上看不出错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  clampToPast,
  classify,
  isStrictDateKey,
  parseCompactDay,
  parseUtcOffset,
  splitSpan,
} from "../dist/feishu/attendance.mjs";
import {
  blockedResult,
  copyForTests,
  toBadge,
  toStats,
} from "../dist/handlers/calendarOverlay.mjs";

const OFFSET = 8 * 60;
const ZH = copyForTests("zh-CN");
const EN = copyForTests("en");

/** 工作日排班的 shift_id 随便给个非 "0" 的值即可。 */
const SHIFT = "7260773632637419523";

/** 2026-09-01 09:02 与 18:12（+08:00），秒级时间戳。 */
const IN_0902 = String(Math.floor(Date.UTC(2026, 8, 1, 1, 2) / 1000));
const OUT_1812 = String(Math.floor(Date.UTC(2026, 8, 1, 10, 12) / 1000));

function workday(overrides = {}) {
  return {
    day: 20260901,
    shift_id: SHIFT,
    records: [
      {
        check_in_record_id: "1",
        check_out_record_id: "2",
        check_in_result: "Normal",
        check_out_result: "Normal",
        check_in_result_supplement: "None",
        check_out_result_supplement: "None",
        check_in_record: { check_time: IN_0902 },
        check_out_record: { check_time: OUT_1812 },
        ...overrides,
      },
    ],
  };
}

describe("逐日判定", () => {
  it("有排班且打了卡是出勤，打卡时刻按偏移渲染", () => {
    const day = classify(workday(), OFFSET);
    assert.equal(day.kind, "worked");
    assert.equal(day.date, "2026-09-01");
    // check_time 是**秒级**（飞书两种都在用），当毫秒会算到 1970 年
    assert.equal(day.checkIn, "09:02");
    assert.equal(day.checkOut, "18:12");
  });

  it("休息日打了卡是加班，不是休息", () => {
    // 这是最容易错的一条：shift_id = "0" 时 check_in_result 是 NoNeedCheck，
    // 只看它会把加班日判成休息日，而工时审计恰恰要求加班日也有排期覆盖
    const day = classify(
      {
        day: 20260905,
        shift_id: "0",
        records: [
          {
            check_in_record_id: "9",
            check_in_result: "NoNeedCheck",
            check_out_result: "NoNeedCheck",
            check_in_record: { check_time: IN_0902 },
          },
        ],
      },
      OFFSET,
    );
    assert.equal(day.kind, "overtime");
  });

  it("休息日没打卡是纯休息", () => {
    const day = classify(
      {
        day: 20260906,
        shift_id: "0",
        records: [
          { check_in_result: "NoNeedCheck", check_out_result: "NoNeedCheck" },
        ],
      },
      OFFSET,
    );
    assert.equal(day.kind, "rest");
  });

  it("上下班两次打卡各自有结论", () => {
    // 环形角标要把两段分开画，而 `issues: ["lack"]` 说不出缺的是哪一次
    const day = classify(workday({ check_out_result: "Lack" }), OFFSET);
    assert.equal(day.punchIn, "normal");
    assert.equal(day.punchOut, "lack");
  });

  it("无需打卡不等于该打没打", () => {
    // 加班日两侧都是 NoNeedCheck，当成缺卡会让整圈环变红
    const day = classify(
      {
        day: 20260905,
        shift_id: "0",
        records: [
          {
            check_in_record_id: "9",
            check_in_result: "NoNeedCheck",
            check_out_result: "NoNeedCheck",
            check_in_record: { check_time: IN_0902 },
          },
        ],
      },
      OFFSET,
    );
    assert.equal(day.punchIn, undefined);
    assert.equal(day.punchOut, undefined);
  });

  it("一天多段班次取最差的那次结论", () => {
    // 取第一条会让「上午正常、下午那段缺卡」显示成正常
    const day = classify(
      {
        day: 20260901,
        shift_id: SHIFT,
        records: [
          {
            check_in_record_id: "1",
            check_in_result: "Normal",
            check_out_result: "Normal",
          },
          {
            check_in_record_id: "2",
            check_in_result: "Normal",
            check_out_result: "Lack",
          },
        ],
      },
      OFFSET,
    );
    assert.equal(day.punchOut, "lack");
  });

  it("请假优先于出勤，并读出是哪半天", () => {
    // 半天请假半天上班时两边都成立，但「今天请了假」更值得在日历上看到，
    // 而且工时要按请假那半天补。
    // 飞书的 supplement 上下两侧是分开的，半天假天然能读出来——上一版只判
    // 「有没有请假」，于是「上午假下午上班」和「全天假」在日历上长得一模一样
    const morning = classify(
      workday({ check_in_result_supplement: "Leave" }),
      OFFSET,
    );
    assert.equal(morning.kind, "leave");
    assert.equal(morning.leavePeriod, "am");

    const afternoon = classify(
      workday({ check_out_result_supplement: "Leave" }),
      OFFSET,
    );
    assert.equal(afternoon.leavePeriod, "pm");

    const allDay = classify(
      workday({
        check_in_result_supplement: "Leave",
        check_out_result_supplement: "Leave",
      }),
      OFFSET,
    );
    assert.equal(allDay.leavePeriod, "full");
  });

  it("请假日不标异常", () => {
    const day = classify(
      workday({ check_in_result_supplement: "Leave", check_in_result: "Late" }),
      OFFSET,
    );
    assert.equal(day.issues, undefined);
  });

  it("迟到早退缺卡是异常，但仍然算出勤", () => {
    // 工时口径按天算，迟到十分钟不该让这一天从出勤变成别的什么
    const day = classify(workday({ check_in_result: "Late" }), OFFSET);
    assert.equal(day.kind, "worked");
    assert.deepEqual(day.issues, ["late"]);
  });

  it("今天还没下班打卡不算异常", () => {
    // check_out_result = "Todo" 是查询当天的常态，当异常会让每天下午都有红标
    const day = classify(
      workday({ check_out_result: "Todo", check_out_record_id: "" }),
      OFFSET,
    );
    assert.equal(day.kind, "worked");
    assert.equal(day.issues, undefined);
  });

  it("有排班一次卡都没打，且那天已经过去了，才是缺勤", () => {
    const day = classify(
      { day: 20260902, shift_id: SHIFT, records: [] },
      OFFSET,
      "2026-09-07",
    );
    assert.equal(day.kind, "absent");
  });

  it("未来的排班日不算缺勤", () => {
    // 真机上撞出来的：飞书会返回未来的排班（明天是工作日、records 为空），
    // 判成 absent 会在明天的格子里画一个「缺」，看起来像旷工
    const day = classify(
      { day: 20260908, shift_id: SHIFT, records: [] },
      OFFSET,
      "2026-09-07",
    );
    assert.equal(day.kind, "scheduled");
  });

  it("今天上午还没打卡也不算缺勤", () => {
    const day = classify(
      { day: 20260907, shift_id: SHIFT, records: [] },
      OFFSET,
      "2026-09-07",
    );
    assert.equal(day.kind, "scheduled");
  });

  it("今天打了上班卡就是出勤，不等下班", () => {
    const day = classify(
      workday({ check_out_result: "Todo", check_out_record_id: "" }),
      OFFSET,
      "2026-09-01",
    );
    assert.equal(day.kind, "worked");
  });

  it("非法日期直接丢掉，不猜", () => {
    assert.equal(classify({ day: 20260230, shift_id: SHIFT }, OFFSET), null);
    assert.equal(classify({ shift_id: SHIFT }, OFFSET), null);
    assert.equal(classify({ day: 2026091, shift_id: SHIFT }, OFFSET), null);
  });
});

describe("日期工具", () => {
  it("紧凑日期宽松进严格出", () => {
    assert.equal(parseCompactDay(20260901), "2026-09-01");
    assert.equal(parseCompactDay(20260230), null, "2 月 30 日不存在");
  });

  it("严格日期键：补零的才算", () => {
    assert.ok(isStrictDateKey("2026-09-01"));
    // 宽松格式当 Map key 时和补零的对不上，界面表现为「那天没有角标」且不报错
    assert.equal(isStrictDateKey("2026-9-1"), false);
    assert.equal(isStrictDateKey("2026-02-30"), false);
  });

  it("42 天按 30 天上限分段，切片不重叠", () => {
    // 不分段的话飞书报 1220001，表现是「翻到月视图什么都没有」
    const spans = splitSpan("2026-08-31", "2026-10-11");
    assert.equal(spans.length, 2);
    assert.deepEqual(spans[0], ["2026-08-31", "2026-09-29"]);
    assert.deepEqual(spans[1], ["2026-09-30", "2026-10-11"]);
  });

  it("单段区间不拆", () => {
    assert.deepEqual(splitSpan("2026-09-01", "2026-09-30"), [
      ["2026-09-01", "2026-09-30"],
    ]);
  });

  it("颠倒或非法区间返回空", () => {
    assert.deepEqual(splitSpan("2026-09-30", "2026-09-01"), []);
    assert.deepEqual(splitSpan("2026-9-1", "2026-09-30"), []);
  });

  it("时区偏移认几种写法，认不出按 +08:00", () => {
    assert.equal(parseUtcOffset("+08:00"), 480);
    assert.equal(parseUtcOffset("+0800"), 480);
    assert.equal(parseUtcOffset("-05:00"), -300);
    assert.equal(parseUtcOffset("+05:30"), 330);
    assert.equal(parseUtcOffset("什么"), 480);
    assert.equal(parseUtcOffset(undefined), 480);
  });
});

describe("未来日期夹取", () => {
  // 真机上撞出来的：飞书校验 dateFrom 必须落在 [企业考勤起始日, 明天]，
  // 越界**直接报 1220001**而不是返回空。月视图 42 格的后半段常常整段在未来，
  // 不夹的话那一段必然失败——而它会把整轮刷新带走，表现是「一个角标都没有」
  const now = new Date(2026, 8, 7); // 2026-09-07 本地

  it("上界夹到明天", () => {
    assert.deepEqual(clampToPast("2026-08-31", "2026-10-11", now), [
      "2026-08-31",
      "2026-09-08",
    ]);
  });

  it("整段都在未来时一次请求都不发", () => {
    assert.equal(clampToPast("2026-10-01", "2026-10-31", now), null);
  });

  it("全在过去的区间原样返回", () => {
    assert.deepEqual(clampToPast("2026-07-01", "2026-07-31", now), [
      "2026-07-01",
      "2026-07-31",
    ]);
  });

  it("夹到明天而不是今天", () => {
    // 跨时区时两边的「今天」可能差一天，多留一天比少一天安全：
    // 多出来的那天飞书返回空，而少了会让今天的打卡看不见
    const [, end] = clampToPast("2026-09-01", "2026-09-30", now);
    assert.equal(end, "2026-09-08");
  });

  it("颠倒或非法区间返回 null", () => {
    assert.equal(clampToPast("2026-09-30", "2026-09-01", now), null);
    assert.equal(clampToPast("2026-9-1", "2026-09-30", now), null);
  });
});

describe("角标", () => {
  const TODAY = "2026-09-05";
  const day = (kind, extra = {}) => ({ date: TODAY, kind, ...extra });
  // 绝大多数用例的那一天都不是今天，免得「今天才画 scheduled」那条规则渗进来
  const badgeOf = (input, copy = ZH, showWorkdays = true) =>
    toBadge(input, copy, showWorkdays, "2026-09-30");

  it("一律画成环形", () => {
    // 「班」和「加」用文字小方块时在格子里长得几乎一样，而「上午打了卡下午忘打」
    // 只能靠悬浮看。环把上班卡 / 下班卡 / 这天的性质分成三个位置
    const badge = badgeOf(day("worked", { punchIn: "normal", punchOut: "normal" }));
    assert.equal(badge.shape, "ring");
    assert.deepEqual(badge.arcs, { leading: "done", trailing: "done" });
  });

  it("纯休息日永远不画", () => {
    // 一个月八九个周末各印一个「休」，把最值钱的位置占满而没有任何信息量——
    // 日历本来就知道周六周日是哪几天
    assert.equal(badgeOf(day("rest")), null);
    assert.equal(badgeOf(day("rest"), ZH, false), null);
  });

  it("有排班但还没过完的日子只画今天", () => {
    // 今天那一格恰恰最值得看（上班卡绿了、下班卡还灰着）；未来一整月的空环没有
    // 信息量——哪些天上班日历自己就知道
    assert.equal(badgeOf(day("scheduled")), null);
    const today = toBadge(day("scheduled"), ZH, true, TODAY);
    assert.equal(today.label, "班");
    assert.deepEqual(today.arcs, { leading: "idle", trailing: "idle" });
  });

  it("加班用「加」并强调", () => {
    const badge = badgeOf(day("overtime", { checkIn: "10:00" }));
    assert.equal(badge.label, "加");
    assert.equal(badge.tone, "strong");
    assert.match(badge.detail, /休息日加班/);
    assert.match(badge.detail, /10:00/);
  });

  it("全天请假两段都是 alt，半天假只有一段", () => {
    const full = badgeOf(day("leave", { leavePeriod: "full" }));
    assert.equal(full.label, "假");
    assert.equal(full.tone, "mute");
    assert.deepEqual(full.arcs, { leading: "alt", trailing: "alt" });

    // 半天假中间那个字仍然是「班」：那天确实来上班了，只有一半是假
    const morning = badgeOf(
      day("leave", { leavePeriod: "am", punchOut: "normal" }),
    );
    assert.equal(morning.label, "班");
    assert.deepEqual(morning.arcs, { leading: "alt", trailing: "done" });
    assert.match(morning.detail, /上午请假/);

    const afternoon = badgeOf(
      day("leave", { leavePeriod: "pm", punchIn: "late" }),
    );
    assert.deepEqual(afternoon.arcs, { leading: "warn", trailing: "alt" });
    assert.match(afternoon.detail, /下午请假/);
  });

  it("工作日出勤用「班」，可以关掉", () => {
    const attended = day("worked", { checkIn: "09:02", checkOut: "18:12" });
    const on = badgeOf(attended);
    assert.equal(on.label, "班");
    assert.equal(on.tone, undefined, "常态不该强调");
    assert.match(on.detail, /09:02–18:12/);
    // 关掉之后只剩非常态的日子
    assert.equal(badgeOf(attended, ZH, false), null);
  });

  it("上下班两段各自独立着色", () => {
    // 这是环形存在的理由：一天里最常见的异常是「只缺了一次卡」
    const badge = badgeOf(
      day("worked", { punchIn: "normal", punchOut: "lack", issues: ["lack"] }),
    );
    assert.deepEqual(badge.arcs, { leading: "done", trailing: "miss" });
    assert.equal(badge.label, "班", "状态由弧说，字只说这天的性质");
  });

  it("有异常的工作日即使关了工作日角标也要画", () => {
    // 缺卡是需要处理的事，不该被「不看常态」的开关一起藏掉
    const badge = badgeOf(
      day("worked", { issues: ["lack"], punchOut: "lack" }),
      ZH,
      false,
    );
    assert.equal(badge.tone, "strong");
    assert.equal(badge.arcs.trailing, "miss");
    assert.match(badge.detail, /缺卡/);
  });

  it("认不出的打卡结论当「还没有结论」而不是缺卡", () => {
    // 飞书加一个枚举不该让日历上冒出一片红环
    const badge = badgeOf(day("worked", { punchIn: "normal" }));
    assert.equal(badge.arcs.trailing, "idle");
  });

  it("角标永远不用 alert 档", () => {
    // 契约 §8.4：角标就在格子里，强调色会和「今天」「高优先级」抢注意力，
    // 宿主收到也会降级
    for (const kind of ["worked", "overtime", "leave", "absent"]) {
      const badge = badgeOf(day(kind, { issues: ["lack"] }));
      assert.notEqual(badge?.tone, "alert");
    }
  });

  it("环中间的文字不超过 2 字", () => {
    // 环内径只有 10px 出头，宿主截到 2 字符
    for (const kind of ["worked", "overtime", "leave", "absent"]) {
      const badge = badgeOf(day(kind));
      assert.ok([...badge.label].length <= 2, `${kind}: ${badge.label}`);
      for (const copy of [ZH, EN]) {
        const localized = badgeOf(day(kind), copy);
        assert.ok([...localized.label].length <= 2, localized.label);
      }
    }
  });

  it("每条角标都带 detail", () => {
    // 环里只有一个字，detail 是它的唯一解释来源
    for (const kind of ["worked", "overtime", "leave", "absent"]) {
      assert.ok(badgeOf(day(kind)).detail);
    }
  });

  it("英文界面出英文", () => {
    // 文案 100% 归插件，宿主不认识「出勤」也就无从翻译
    const badge = badgeOf(day("overtime"), EN);
    assert.equal(badge.label, "OT");
    assert.match(badge.detail, /Overtime/);
  });
});

describe("侧栏统计", () => {
  const days = [
    { date: "2026-09-01", kind: "worked" },
    { date: "2026-09-02", kind: "worked", issues: ["late"] },
    { date: "2026-09-03", kind: "leave" },
    { date: "2026-09-05", kind: "overtime" },
    { date: "2026-09-06", kind: "rest" },
    { date: "2026-09-07", kind: "absent" },
  ];

  it("加班日计入出勤", () => {
    // 与 worktime-audit 同一口径：周末打了卡同样要有排期工时覆盖
    const stats = toStats(days, ZH);
    const attended = stats.find((item) => item.key === "attended");
    assert.equal(attended.value, "3 天", "2 个工作日 + 1 个加班日");
  });

  it("零用 mute 档说，不指望宿主看出来", () => {
    // value 是字符串，"0 天" 宿主只当普通文本
    const stats = toStats([{ date: "2026-09-01", kind: "worked" }], ZH);
    const leave = stats.find((item) => item.key === "leave");
    assert.equal(leave.value, "0 天");
    assert.equal(leave.tone, "mute");
  });

  it("没有异常时不占那一行", () => {
    // 宿主上限 4 行，「异常 0 天」不值得占掉一行
    const stats = toStats([{ date: "2026-09-01", kind: "worked" }], ZH);
    assert.equal(
      stats.some((item) => item.key === "issues"),
      false,
    );
    assert.equal(stats.length, 3);
  });

  it("有异常时补第四行", () => {
    const stats = toStats(days, ZH);
    const issues = stats.find((item) => item.key === "issues");
    assert.equal(issues.value, "1 天");
    assert.ok(stats.length <= 4, "宿主上限是 4 行，超出的会被丢弃");
  });

  it("每行都有标记，且只用封闭的那三种", () => {
    for (const item of toStats(days, ZH)) {
      assert.ok(["bar", "dot"].includes(item.mark), `${item.key}: ${item.mark}`);
    }
  });

  it("key 在一次返回里唯一", () => {
    const keys = toStats(days, ZH).map((item) => item.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it("英文界面出英文与英文单位", () => {
    const stats = toStats(days, EN);
    assert.equal(stats[0].label, "Attended");
    assert.equal(stats[0].value, "3d");
  });

  it("空数据出零，不出加载中", () => {
    // 「加载中」只在有生以来第一次、后台还没拉回来时给。
    // 缓存已有但这段区间没记录时应当老实出 0
    const stats = toStats([], ZH);
    assert.equal(stats[0].value, "0 天");
    assert.equal(stats[0].tone, "mute");
  });
});

describe("配置不全时要说话", () => {
  // 0.5.0 首次验收就撞在这上面：用户在侧栏打开了叠加层，却漏勾了「飞书考勤」这项能力，
  // 于是插件静默返回空——界面上什么都没有、日志里也一条记录都没有，无从下手
  const configured = {
    appId: "cli_x",
    appSecret: "s",
    capabilities: ["tasks", "calendar", "meetings"],
  };

  it("没勾「飞书考勤」时给出一行 alert，而不是空", () => {
    const result = blockedResult(configured, ZH);
    const rows = result.sidebarStats;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, "未勾选");
    assert.equal(rows[0].tone, "alert");
    // 契约要求 alert 必须带 detail，否则宿主降级成 strong
    assert.ok(rows[0].detail, "alert 档必须说清为什么");
    assert.match(rows[0].detail, /重新/);
    assert.equal(result.badges, undefined, "拉不到就不该有角标");
  });

  it("没填凭据时说的是另一件事", () => {
    const result = blockedResult({ capabilities: ["attendance"] }, ZH);
    assert.equal(result.sidebarStats[0].value, "未配置");
  });

  it("配置齐了就不拦", () => {
    assert.equal(
      blockedResult({ ...configured, capabilities: ["attendance"] }, ZH),
      null,
    );
  });

  it("英文界面出英文", () => {
    assert.equal(blockedResult(configured, EN).sidebarStats[0].value, "not enabled");
  });
});
