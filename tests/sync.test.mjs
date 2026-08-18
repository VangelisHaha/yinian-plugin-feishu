/**
 * 两批任务的合并去重。
 *
 * 这是个只有几行的函数，但那个「以哪边为准」的决策直接决定用户会不会看到状态抖动，
 * 所以单独钉住。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeTasks } from "../dist/handlers/sync.mjs";

describe("合并两批任务", () => {
  it("分别标出未完成与已完成", () => {
    const items = mergeTasks(
      [{ guid: "a", summary: "待办" }],
      [{ guid: "b", summary: "已完成" }],
    );

    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.externalId === "a").status, "todo");
    assert.equal(items.find((item) => item.externalId === "b").status, "done");
  });

  it("同时出现在两批里时以已完成为准", () => {
    // 飞书的两个列表不是同一时刻的快照，未完成列表会残留刚被标完成的任务。
    // 若以未完成为准，用户刚勾完的任务会被拉回未完成，下一轮又改回去，来回抖动
    const items = mergeTasks(
      [{ guid: "a", summary: "刚被勾完" }],
      [{ guid: "a", summary: "刚被勾完" }],
    );

    assert.equal(items.length, 1);
    assert.equal(items[0].status, "done");
  });

  it("丢掉没有 guid 的条目而不是让整批失败", () => {
    const items = mergeTasks(
      [{ summary: "无主任务" }, { guid: "a", summary: "正常" }],
      [],
    );

    assert.deepEqual(
      items.map((item) => item.externalId),
      ["a"],
    );
  });

  it("空输入返回空数组", () => {
    assert.deepEqual(mergeTasks([], []), []);
  });
});
