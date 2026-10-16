/**
 * 加班审批 → 「加」（与个人看板 nikou-screen feishu-overtime 同一规则）。
 *
 * 错了不报错：要么加班的那天还是「班」，要么撤回的申请还挂着「加」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { foldOvertimeApprovals, parseChineseDateTime } from "../dist/feishu/overtime.mjs";
import { copyForTests, toBadge } from "../dist/handlers/calendarOverlay.mjs";

const ZH = copyForTests("zh-CN");

function instance(status, start, end, name = "加班申请") {
  return {
    definition_name: name,
    instance_status: status,
    instance_code: `code-${start}`,
    summaries: [
      { key: "开始时间", value: start },
      { key: "结束时间", value: end },
    ],
  };
}

describe("加班审批折成每天的时段", () => {
  it("审批中与已通过都算，被拒撤回终止不算", () => {
    const byDate = foldOvertimeApprovals([
      instance("1", "2026年10月17日 10:00", "2026年10月17日 16:00"),
      instance("2", "2026年10月18日 9:30", "2026年10月18日 12:00"),
      instance("3", "2026年10月19日 10:00", "2026年10月19日 16:00"),
      instance("4", "2026年10月20日 10:00", "2026年10月20日 16:00"),
      instance("2", "2026年10月21日 10:00", "2026年10月21日 16:00", "请假"),
    ]);
    assert.deepEqual([...byDate.keys()].sort(), ["2026-10-17", "2026-10-18"]);
    assert.deepEqual(byDate.get("2026-10-18"), { date: "2026-10-18", start: "09:30", end: "12:00", status: "2" });
  });

  it("跨天的申请不认", () => {
    const byDate = foldOvertimeApprovals([instance("2", "2026年10月17日 20:00", "2026年10月18日 02:00")]);
    assert.equal(byDate.size, 0);
  });

  it("中文日期时刻解析", () => {
    assert.deepEqual(parseChineseDateTime("2026年1月5日 9:05"), { date: "2026-01-05", time: "09:05" });
    assert.equal(parseChineseDateTime("2026-01-05 09:05"), null);
  });
});

describe("有加班申请的日子画「加」", () => {
  it("未来的休息日也画，环是空的", () => {
    const badge = toBadge(
      { date: "2026-10-18", kind: "rest", overtimeApproval: { start: "10:00", end: "16:00", status: "1" } },
      ZH,
      true,
      "2026-10-16",
    );
    assert.equal(badge.label, "加");
    assert.equal(badge.tone, "strong");
    assert.deepEqual(badge.arcs, { leading: "idle", trailing: "idle" });
    assert.match(badge.detail, /加班申请 10:00–16:00（审批中）/);
  });

  it("工作日有申请也是「加」", () => {
    const badge = toBadge(
      { date: "2026-10-15", kind: "worked", checkIn: "09:00", punchIn: "normal", overtimeApproval: { start: "19:00", end: "22:00", status: "2" } },
      ZH,
      false,
      "2026-10-16",
    );
    assert.equal(badge.label, "加");
  });

  it("全天请假优先", () => {
    const badge = toBadge(
      { date: "2026-10-15", kind: "leave", leavePeriod: "full", overtimeApproval: { start: "19:00", end: "22:00", status: "2" } },
      ZH,
      true,
      "2026-10-16",
    );
    assert.equal(badge.label, "假");
  });
});
