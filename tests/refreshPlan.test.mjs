/**
 * 刷新节流（2026-10-21 用户：尽量减少对飞书的请求）。
 *
 * 错了不报错：要么还在每 15 分钟重拉整个历史（请求量回到一天 500+），要么历史永远补不上。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planRefresh } from "../dist/feishu/attendanceStore.mjs";

const TODAY = "2026-10-21";
const NOW = Date.UTC(2026, 9, 21, 4, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const base = { watchFrom: "2026-07-18", watchTo: "2026-12-06" };

describe("考勤分层刷新", () => {
  it("从没拉过：近的 + 整段历史，各一次", () => {
    const plan = planRefresh({ ...base }, NOW, TODAY, null);
    assert.deepEqual(plan.attendance, [
      ["2026-10-19", "2026-10-22"],
      ["2026-07-18", "2026-10-18"],
    ]);
    assert.equal(plan.overtime, null);
  });

  it("历史拉全了、今天核对过：只拉近的，一个请求", () => {
    const plan = planRefresh(
      { ...base, loadedFrom: "2026-07-18", recheckedAt: NOW - 2 * HOUR },
      NOW,
      TODAY,
      null,
    );
    assert.deepEqual(plan.attendance, [["2026-10-19", "2026-10-22"]]);
  });

  it("超过一天没核对：多核对近 30 天（已结算的部分），仍不碰更早的", () => {
    const plan = planRefresh(
      { ...base, loadedFrom: "2026-07-18", recheckedAt: NOW - 25 * HOUR },
      NOW,
      TODAY,
      null,
    );
    assert.deepEqual(plan.attendance, [
      ["2026-10-19", "2026-10-22"],
      ["2026-09-21", "2026-10-18"],
    ]);
  });

  it("用户往回翻到更早的月份：只补缺的那一段", () => {
    const plan = planRefresh(
      { watchFrom: "2026-05-01", watchTo: "2026-12-06", loadedFrom: "2026-07-18", recheckedAt: NOW },
      NOW,
      TODAY,
      null,
    );
    assert.deepEqual(plan.attendance, [
      ["2026-10-19", "2026-10-22"],
      ["2026-05-01", "2026-07-17"],
    ]);
  });
});

describe("加班审批刷新", () => {
  const done = { ...base, loadedFrom: "2026-07-18", recheckedAt: NOW };

  it("没勾加班审批：不拉", () => {
    assert.equal(planRefresh(done, NOW, TODAY, null).overtime, null);
  });

  it("第一次：全量扫，从关注区间起点再往前 31 天", () => {
    const { overtime } = planRefresh(done, NOW, TODAY, "加班申请");
    assert.deepEqual(overtime, { mode: "full", sinceDate: "2026-06-17" });
  });

  it("一小时内不重拉", () => {
    const plan = planRefresh(
      { ...done, overtimeAt: NOW - 30 * 60_000, overtimeFrom: "2026-06-17", overtimeName: "加班申请" },
      NOW,
      TODAY,
      "加班申请",
    );
    assert.equal(plan.overtime, null);
  });

  it("到点只看最近 45 天，并带上认到的审批 code", () => {
    const { overtime } = planRefresh(
      {
        ...done,
        overtimeAt: NOW - 2 * HOUR,
        overtimeFrom: "2026-06-17",
        overtimeName: "加班申请",
        overtimeCode: "CODE-1",
      },
      NOW,
      TODAY,
      "加班申请",
    );
    assert.deepEqual(overtime, { mode: "recent", sinceDate: "2026-09-06", definitionCode: "CODE-1" });
  });

  it("改了审批名：重新全量扫，不带旧 code", () => {
    const { overtime } = planRefresh(
      { ...done, overtimeAt: NOW, overtimeFrom: "2026-06-17", overtimeName: "加班申请", overtimeCode: "CODE-1" },
      NOW,
      TODAY,
      "加班审批单",
    );
    assert.equal(overtime.mode, "full");
    assert.equal("definitionCode" in overtime, false);
  });

  it("关注区间往回扩了：补扫更早的审批", () => {
    const { overtime } = planRefresh(
      { watchFrom: "2026-05-01", watchTo: "2026-12-06", loadedFrom: "2026-05-01", recheckedAt: NOW,
        overtimeAt: NOW - 2 * HOUR, overtimeFrom: "2026-06-17", overtimeName: "加班申请", overtimeCode: "C" },
      NOW,
      TODAY,
      "加班申请",
    );
    assert.equal(overtime.mode, "full");
    assert.equal(overtime.sinceDate, "2026-03-31");
  });
});
