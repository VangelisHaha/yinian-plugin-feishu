/**
 * 考勤 → 时间轴叠加（docs/workspace/28 §2.3）。
 *
 * 错了不报错，只是线画到别处或者「预计下班」不出现，所以由测试守：
 * 班次时刻按秒级时间戳与公司时区换算、未来日子借同一班次的时刻、今天还没下班才有预计线。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify } from "../dist/feishu/attendance.mjs";
import {
  nowIn,
  shiftOf,
  timelineCopyFor,
  toDetailRows,
  toTimeline,
} from "../dist/handlers/attendanceTimeline.mjs";

const OFFSET = 8 * 60;
const ZH = timelineCopyFor("zh-CN");
const ts = (y, m, d, hh, mm) => String(Math.floor(Date.UTC(y, m - 1, d, hh - 8, mm) / 1000));

function raw(day, inAt, outAt) {
  const [y, m, d] = [Math.floor(day / 10000), Math.floor(day / 100) % 100, day % 100];
  const record = {
    check_in_result: inAt ? "Normal" : "Todo",
    check_out_result: outAt ? "Normal" : "Todo",
    check_in_shift_time: ts(y, m, d, 9, 0),
    check_out_shift_time: ts(y, m, d, 18, 0),
  };
  if (inAt) {
    record.check_in_record_id = "1";
    record.check_in_record = { check_time: ts(y, m, d, ...inAt) };
  }
  if (outAt) {
    record.check_out_record_id = "2";
    record.check_out_record = { check_time: ts(y, m, d, ...outAt) };
  }
  return { day, shift_id: "S1", records: [record] };
}

describe("班次时刻", () => {
  it("应上 / 应下按公司时区渲染成 HH:mm", () => {
    const day = classify(raw(20261015, [8, 58], null), OFFSET, "2026-10-15");
    assert.equal(day.shiftStart, "09:00");
    assert.equal(day.shiftEnd, "18:00");
    assert.equal(day.shiftId, "S1");
  });

  it("未来的日子没有记录，借同一班次见过的时刻", () => {
    const future = { date: "2026-10-20", kind: "scheduled", shiftId: "S1" };
    const shifts = new Map([["S1", { start: "09:00", end: "18:00" }]]);
    assert.deepEqual(shiftOf(future, shifts), { start: "09:00", end: "18:00" });
  });
});

describe("toTimeline", () => {
  const shifts = new Map();

  it("今天上了班还没下：上班线 + 预计下班虚线 + 在岗实底 + 到预计下班斜纹", () => {
    const day = classify(raw(20261015, [8, 58], null), OFFSET, "2026-10-15");
    const line = toTimeline(day, ZH, { date: "2026-10-15", clock: "14:20" }, shifts);
    assert.deepEqual(
      line.markers.map((m) => [m.at, m.side, m.expected ?? false, m.label]),
      [
        ["08:58", "leading", false, "上班打卡"],
        ["18:00", "trailing", true, "预计下班 · 排班"],
      ],
    );
    assert.deepEqual(
      line.bands.map((b) => [b.from, b.to, b.expected ?? false]),
      [
        ["08:58", "14:20", false],
        ["14:20", "18:00", true],
      ],
    );
    assert.deepEqual(
      line.anchors.map((a) => a.key),
      ["workStart", "workEnd", "checkIn"],
    );
    assert.deepEqual(
      line.strip.items.map((i) => i.text),
      ["上班 08:58", "下班 —", "在岗 5 小时 22 分"],
    );
  });

  it("下过班的日子：两根实线、没有预计线", () => {
    const day = classify(raw(20261014, [9, 1], [18, 40]), OFFSET, "2026-10-15");
    const line = toTimeline(day, ZH, { date: "2026-10-15", clock: "14:20" }, shifts);
    assert.deepEqual(line.markers.map((m) => m.at), ["09:01", "18:40"]);
    assert.ok(line.markers.every((m) => !m.expected));
    assert.equal(line.bands.length, 1);
  });

  it("未来的上班日只给锚点，不画线", () => {
    const day = { date: "2026-10-20", kind: "scheduled", shiftId: "S1" };
    const line = toTimeline(
      day,
      ZH,
      { date: "2026-10-15", clock: "14:20" },
      new Map([["S1", { start: "09:00", end: "18:00" }]]),
    );
    assert.equal(line.markers.length, 0);
    assert.equal(line.bands.length, 0);
    assert.equal(line.strip, null);
    assert.deepEqual(line.anchors.map((a) => [a.key, a.at]), [
      ["workStart", "09:00"],
      ["workEnd", "18:00"],
    ]);
  });

  it("悬停键值行：性质 / 排班 / 上班卡 / 下班卡 / 在岗", () => {
    const day = classify(raw(20261014, [9, 1], [18, 40]), OFFSET, "2026-10-15");
    const rows = toDetailRows(day, ZH, { date: "2026-10-15", clock: "14:20" }, shifts);
    assert.deepEqual(rows.map((r) => r.k), ["性质", "排班", "上班卡", "下班卡", "在岗"]);
    assert.equal(rows[2].arc, "done");
    assert.equal(rows[4].v, "9 小时 39 分");
  });
});

describe("nowIn", () => {
  it("按公司偏移给日期与时刻", () => {
    assert.deepEqual(nowIn(OFFSET, new Date(Date.UTC(2026, 9, 15, 6, 20))), {
      date: "2026-10-15",
      clock: "14:20",
    });
  });
});
