/**
 * 字段与时间映射的测试。
 *
 * 用例取自真实飞书任务的形态：所有时间都是**毫秒字符串**，`due` / `start` 是
 * `{ timestamp, is_all_day }`，列表接口不给 `start` 与 `completed_at`。
 *
 * 时间映射错了的表现是「任务出现在错误的一天」，用户无法自己判断问题在哪一层，
 * 所以这里的用例比其他部分密。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allDayEndIso,
  applyDetail,
  msToIso,
  needsDetail,
  parseMs,
  timeToIso,
  toExternalItem,
  toUpdatePayload,
} from "../dist/feishu/mapping.mjs";

/**
 * 2026-08-18T02:30:00Z（= 上海 10:30）。
 *
 * 用 `Date.UTC` 而不是手写毫秒数：手算的魔数一旦错了，测试会去断言一个错误的
 * 日期，而错误信息看起来只是「差了几天」，很难看出是常量本身错了。
 */
const AUG_18_0230_UTC = Date.UTC(2026, 7, 18, 2, 30);

describe("毫秒字符串解析", () => {
  it("接受字符串与数字", () => {
    assert.equal(parseMs("1786674600000"), 1_786_674_600_000);
    assert.equal(parseMs(1_786_674_600_000), 1_786_674_600_000);
  });

  it('把飞书的零值当作「没有」', () => {
    // 飞书用 "0" 表示未完成 / 无截止时间，不是 1970 年
    assert.equal(parseMs("0"), null);
    assert.equal(parseMs(0), null);
    assert.equal(parseMs(""), null);
    assert.equal(parseMs("   "), null);
    assert.equal(parseMs(undefined), null);
    assert.equal(parseMs(null), null);
    assert.equal(parseMs("not-a-number"), null);
  });

  it("负值也当作没有", () => {
    assert.equal(parseMs("-1"), null);
  });
});

describe("时间映射", () => {
  it("非全天直接转 RFC3339", () => {
    assert.equal(
      timeToIso({ timestamp: String(AUG_18_0230_UTC), is_all_day: false }),
      "2026-08-18T02:30:00.000Z",
    );
  });

  it("全天折成当地那一天结束", () => {
    // 一念的 dueAt 是 deadline。全天任务的 deadline 是那天结束，不是那天开始——
    // 映射成零点会让当天的任务一整天都显示为已逾期
    const iso = timeToIso(
      { timestamp: String(AUG_18_0230_UTC), is_all_day: true },
      "Asia/Shanghai",
    );
    // 上海 8-18 23:59:59.999 = UTC 8-18 15:59:59.999
    assert.equal(iso, "2026-08-18T15:59:59.999Z");
  });

  it("全天按指定时区决定是哪一天", () => {
    // UTC 17:00 在上海已经是次日 01:00，两个时区看到的「那一天」不同
    const utcEvening = Date.UTC(2026, 7, 18, 17, 0);
    const shanghai = allDayEndIso(utcEvening, "Asia/Shanghai");
    const utc = allDayEndIso(utcEvening, "UTC");

    assert.equal(shanghai, "2026-08-19T15:59:59.999Z", "上海视角是 8-19");
    assert.equal(utc, "2026-08-18T23:59:59.999Z", "UTC 视角是 8-18");
  });

  it("按目标时区折回 UTC，而不是按本机时区", () => {
    // 只取日期再用本机时区构造，跨时区时会差出几小时到一天
    const noon = Date.UTC(2026, 7, 18, 12, 0);
    assert.equal(
      allDayEndIso(noon, "UTC"),
      "2026-08-18T23:59:59.999Z",
      "UTC 的当日结束就是 23:59:59.999Z",
    );
    assert.equal(
      allDayEndIso(noon, "America/New_York"),
      // 纽约夏令时 UTC-4，当地 8-18 23:59:59.999 = UTC 8-19 03:59:59.999
      "2026-08-19T03:59:59.999Z",
    );
  });

  it("缺时间戳返回 undefined 而不是纪元零点", () => {
    assert.equal(timeToIso(undefined), undefined);
    assert.equal(timeToIso({}), undefined);
    assert.equal(timeToIso({ timestamp: "0" }), undefined);
    assert.equal(msToIso(null), undefined);
  });
});

describe("任务 → 外部条目", () => {
  const base = {
    guid: "guid-1",
    summary: "写发布文档",
    url: "https://example.feishu.cn/task/guid-1",
    created_at: "1786600000000",
    due: { timestamp: String(AUG_18_0230_UTC), is_all_day: false },
  };

  it("映射主字段", () => {
    const item = toExternalItem(base, "todo");
    assert.ok(item);
    assert.equal(item.externalId, "guid-1");
    assert.equal(item.title, "写发布文档");
    assert.equal(item.status, "todo");
    assert.equal(item.externalUrl, base.url);
    assert.equal(item.dueAt, "2026-08-18T02:30:00.000Z");
  });

  it("没有 guid 的条目直接丢掉", () => {
    assert.equal(toExternalItem({ summary: "无主任务" }, "todo"), null);
  });

  it("空标题给占位而不是空串", () => {
    assert.equal(toExternalItem({ guid: "g", summary: "   " }, "todo").title, "(无标题)");
    assert.equal(toExternalItem({ guid: "g" }, "todo").title, "(无标题)");
  });

  it("不知道完成时间就不传 completedAt", () => {
    // 传当前时间会让历史任务全堆在同一秒
    const item = toExternalItem({ ...base, completed_at: "0" }, "done");
    assert.equal(item.completedAt, undefined);
  });

  it("知道完成时间就带上", () => {
    const item = toExternalItem(
      { ...base, completed_at: String(AUG_18_0230_UTC) },
      "done",
    );
    assert.equal(item.completedAt, "2026-08-18T02:30:00.000Z");
  });

  it("原始数据全量保留", () => {
    const item = toExternalItem(
      { ...base, custom_field: { anything: 1 }, members: [{ id: "ou_x" }] },
      "todo",
    );
    assert.deepEqual(item.remoteData.custom_field, { anything: 1 });
    assert.deepEqual(item.remoteData.members, [{ id: "ou_x" }]);
  });

  it("给出 remoteUpdatedAt 供宿主做冲突判定", () => {
    const item = toExternalItem(
      { ...base, completed_at: String(AUG_18_0230_UTC) },
      "done",
    );
    // 飞书没有独立的 updated_at，取完成时间与创建时间里较晚的那个
    assert.equal(item.remoteUpdatedAt, "2026-08-18T02:30:00.000Z");
  });

  it("父任务关系带过去", () => {
    const item = toExternalItem({ ...base, parent_task_guid: "guid-parent" }, "todo");
    assert.equal(item.parentExternalId, "guid-parent");
  });
});

describe("详情补齐", () => {
  it("已完成且缺完成时间的要补", () => {
    assert.equal(needsDetail({ externalId: "g", title: "t", status: "done" }), true);
    assert.equal(
      needsDetail({
        externalId: "g",
        title: "t",
        status: "done",
        completedAt: "2026-08-18T02:30:00.000Z",
      }),
      false,
    );
  });

  it("未完成的一律要补：列表接口不给 start", () => {
    assert.equal(needsDetail({ externalId: "g", title: "t", status: "todo" }), true);
  });

  it("补上真实完成时间", () => {
    const item = { externalId: "g", title: "t", status: "done" };
    const merged = applyDetail(item, {
      guid: "g",
      completed_at: String(AUG_18_0230_UTC),
    });
    assert.equal(merged.completedAt, "2026-08-18T02:30:00.000Z");
  });

  it("有 start 与 due 时算出估时", () => {
    const start = AUG_18_0230_UTC;
    const merged = applyDetail(
      { externalId: "g", title: "t", status: "todo" },
      {
        guid: "g",
        start: { timestamp: String(start) },
        due: { timestamp: String(start + 90 * 60_000) },
      },
    );
    assert.equal(merged.estimateMinutes, 90);
  });

  it("跨天任务不算估时", () => {
    // 跨天的「start 到 due」是日历跨度而不是工作量，当估时会严重误导排期
    const start = AUG_18_0230_UTC;
    const merged = applyDetail(
      { externalId: "g", title: "t", status: "todo" },
      {
        guid: "g",
        start: { timestamp: String(start) },
        due: { timestamp: String(start + 3 * 24 * 60 * 60_000) },
      },
    );
    assert.equal(merged.estimateMinutes, undefined);
  });

  it("详情拿不到时原样返回", () => {
    const item = { externalId: "g", title: "t", status: "todo" };
    assert.deepEqual(applyDetail(item, null), item);
  });

  it("详情里的 remoteData 覆盖列表的", () => {
    const merged = applyDetail(
      { externalId: "g", title: "t", status: "todo", remoteData: { from: "list" } },
      { guid: "g", description: "详情里才有的描述" },
    );
    assert.equal(merged.notes, "详情里才有的描述");
    assert.equal(merged.remoteData.from, undefined);
    assert.equal(merged.remoteData.description, "详情里才有的描述");
  });
});

describe("回写载荷", () => {
  const item = {
    externalId: "guid-1",
    title: "新标题",
    notes: "新描述",
    status: "todo",
    dueAt: "2026-08-18T02:30:00.000Z",
  };

  it("按 changedFields 组装，并带上 update_fields", () => {
    const payload = toUpdatePayload(item, ["title"]);
    assert.deepEqual(payload, {
      fields: { summary: "新标题" },
      // 漏了 update_fields 飞书会接受请求但什么都不改
      updateFields: ["summary"],
    });
  });

  it("清空描述要显式传空串", () => {
    // 不传这个键飞书会保留原值，那样「清空」就静默失败了
    const payload = toUpdatePayload({ ...item, notes: undefined }, ["notes"]);
    assert.deepEqual(payload.fields, { description: "" });
  });

  it("截止时间转成毫秒字符串", () => {
    const payload = toUpdatePayload(item, ["due_at"]);
    assert.deepEqual(payload.fields.due, {
      timestamp: String(Date.parse(item.dueAt)),
      is_all_day: false,
    });
  });

  it("清空截止时间用零值", () => {
    const payload = toUpdatePayload({ ...item, dueAt: undefined }, ["due_at"]);
    assert.deepEqual(payload.fields.due, { timestamp: "0", is_all_day: false });
  });

  it("飞书没有的字段被忽略，全是这类时返回 null", () => {
    // 返回 null 让调用方跳过，而不是发一个空 PATCH
    assert.equal(toUpdatePayload(item, ["priority", "tags"]), null);
    assert.equal(toUpdatePayload(item, []), null);
  });

  it("混合字段只保留飞书认得的", () => {
    const payload = toUpdatePayload(item, ["title", "priority"]);
    assert.deepEqual(payload.updateFields, ["summary"]);
  });
});
