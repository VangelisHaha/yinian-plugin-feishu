/**
 * 日历同步的窗口与删除记账。
 *
 * 这几个纯函数决定「什么时候该告诉宿主一条日程被删了」。判错的代价不对称：
 * 漏报只是日历上多留一条陈旧日程，**误报会让用户看到上周开过的会集体变成「已取消」**。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  loadSeen,
  selectedCalendarIds,
  syncWindow,
  withinWindow,
} from "../dist/handlers/syncEvent.mjs";

const DAY = 86_400_000;
const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "yinian-cal-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("同步窗口", () => {
  const now = Date.UTC(2026, 7, 21, 12, 0, 0);

  it("默认过去 7 天到未来 90 天", () => {
    const { startSec, endSec } = syncWindow({}, now);
    assert.equal(startSec, Math.floor((now - 7 * DAY) / 1000));
    assert.equal(endSec, Math.floor((now + 90 * DAY) / 1000));
  });

  it("按配置取值", () => {
    const { startSec, endSec } = syncWindow(
      { calendarPastDays: 1, calendarFutureDays: 30 },
      now,
    );
    assert.equal(startSec, Math.floor((now - DAY) / 1000));
    assert.equal(endSec, Math.floor((now + 30 * DAY) / 1000));
  });

  it("越界值被夹到上下限而不是照用", () => {
    // 用户手填 9999 天的话，每轮同步要翻三百多个 30 天分片
    const { startSec, endSec } = syncWindow(
      { calendarPastDays: -5, calendarFutureDays: 9999 },
      now,
    );
    assert.equal(startSec, Math.floor(now / 1000));
    assert.equal(endSec, Math.floor((now + 365 * DAY) / 1000));
  });

  it("非法值退回默认", () => {
    const { endSec } = syncWindow({ calendarFutureDays: "很多天" }, now);
    assert.equal(endSec, Math.floor((now + 90 * DAY) / 1000));
  });
});

describe("窗口内判定", () => {
  const startSec = 1_755_000_000;
  const endSec = startSec + 30 * 86_400;

  it("窗口内的定时日程算在内", () => {
    assert.equal(withinWindow(`evt@${startSec + 3600}`, startSec, endSec), true);
  });

  it("窗口外的不算——滑出视野不等于被删了", () => {
    assert.equal(withinWindow(`evt@${startSec - 3600}`, startSec, endSec), false);
    assert.equal(withinWindow(`evt@${endSec + 3600}`, startSec, endSec), false);
  });

  it("全天日程按当天整体判交集", () => {
    const day = new Date(startSec * 1000).toISOString().slice(0, 10);
    assert.equal(withinWindow(`evt@${day}`, startSec, endSec), true);
  });

  it("认不出后缀的一律不报删除", () => {
    assert.equal(withinWindow("evt_no_suffix", startSec, endSec), false);
    assert.equal(withinWindow("evt@乱码", startSec, endSec), false);
  });
});

describe("删除记账", () => {
  it("第一次同步没有基线，读出空集合", () => {
    assert.equal(loadSeen(tempDir(), "int-1").size, 0);
  });

  it("文件坏了也当第一次，不让整轮同步失败", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "calendar-seen-int-1.json"), "{ 坏 JSON");
    assert.equal(loadSeen(dir, "int-1").size, 0);
  });

  it("按实例分文件：两个实例不能互相污染对方的基线", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "calendar-seen-int-1.json"),
      JSON.stringify({ ids: ["a", "b"] }),
    );
    assert.deepEqual([...loadSeen(dir, "int-1")], ["a", "b"]);
    assert.equal(loadSeen(dir, "int-2").size, 0);
  });
});

describe("日历选择", () => {
  it("留空表示只同步主日历", () => {
    assert.deepEqual(selectedCalendarIds({}), []);
    assert.deepEqual(selectedCalendarIds({ calendars: [] }), []);
  });

  it("去重并丢掉空值", () => {
    assert.deepEqual(
      selectedCalendarIds({ calendars: ["a", " a ", "", "b"] }),
      ["a", "b"],
    );
  });

  it("超过上限时截断，不让误选一堆资源日历把同步拖死", () => {
    const many = Array.from({ length: 30 }, (_, index) => `cal_${index}`);
    assert.equal(selectedCalendarIds({ calendars: many }).length, 10);
  });
});
