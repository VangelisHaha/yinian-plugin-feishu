/**
 * 通知卡片。
 *
 * 卡片长什么样最终只能靠人眼验，但有几件事必须由测试守住——它们出错时人眼**看不出来**，
 * 或者要等到真机上才发现：
 *
 * - 标题栏的颜色优先级（逾期压过类型），错了只是「颜色不太对」，没人会去查；
 * - 短字段并排、长字段独占，错了在窄屏上才显形；
 * - 空值不占行，错了会留一片空白标签；
 * - `body.elements` 永远非空——空数组飞书直接拒收，那才是硬故障。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCard,
  cardSubtitle,
  cardTitle,
  detailElements,
  headerTemplate,
} from "../dist/feishu/card.mjs";

function notification(overrides = {}) {
  return {
    id: "rem_1@1",
    kind: "schedule_start",
    title: "发布中台服务 · 中台开发",
    body: "排期开始：15 分钟后",
    ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    subject: "发布中台服务",
    label: "中台开发",
    fields: [],
    ...overrides,
  };
}

describe("标题栏", () => {
  it("标题用不含段名的事项标题，段名去副标题", () => {
    const item = notification({ detail: detail() });
    assert.equal(cardTitle(item), "发布中台服务");
    assert.equal(cardSubtitle(item), "中台开发 · 排期开始：15 分钟后");
  });

  it("没有明细时退回通知标题", () => {
    assert.equal(cardTitle(notification()), "发布中台服务 · 中台开发");
  });

  it("没有段名时副标题只有那句话", () => {
    const item = notification({ detail: detail({ label: undefined }) });
    assert.equal(cardSubtitle(item), "排期开始：15 分钟后");
  });

  it("逾期压过一切：扫一眼列表时它比类型重要", () => {
    assert.equal(
      headerTemplate(notification({ detail: detail({ overdue: true }) })),
      "red",
    );
    // 高优先级也压过类型，但排在逾期后面
    assert.equal(
      headerTemplate(
        notification({ detail: detail({ overdue: true, priority: "high" }) }),
      ),
      "red",
    );
    assert.equal(
      headerTemplate(notification({ detail: detail({ priority: "high" }) })),
      "orange",
    );
  });

  it("没有紧急信号时按类型上色", () => {
    assert.equal(headerTemplate(notification({ kind: "task_due" })), "orange");
    assert.equal(
      headerTemplate(notification({ kind: "schedule_start" })),
      "turquoise",
    );
    assert.equal(headerTemplate(notification({ kind: "event_start" })), "indigo");
    assert.equal(headerTemplate(notification({ kind: "sync_failed" })), "grey");
    assert.equal(headerTemplate(notification({ kind: "custom" })), "blue");
  });
});

describe("明细网格", () => {
  it("两个短字段并排成一行", () => {
    const elements = detailElements(
      detail({
        fields: [
          { label: "优先级", value: "高" },
          { label: "预估", value: "2 小时" },
        ],
      }),
    );
    assert.equal(elements.length, 1);
    assert.equal(elements[0].tag, "column_set");
    assert.equal(elements[0].columns.length, 2);
    assert.match(elements[0].columns[0].elements[0].content, /优先级/);
    assert.match(elements[0].columns[1].elements[0].content, /预估/);
  });

  it("长值独占一行，不挤成窄条", () => {
    const elements = detailElements(
      detail({
        fields: [
          // 必须真的超过 16 字符，否则会被当成短字段并排
          { label: "备注", value: "这是一段挺长的备注，长到放不进半行里去" },
          { label: "优先级", value: "高" },
        ],
      }),
    );
    // 第一条独占（markdown），第二条落单（column_set 里补一个空列）
    assert.equal(elements[0].tag, "markdown");
    assert.equal(elements[1].tag, "column_set");
    assert.deepEqual(elements[1].columns[1].elements, []);
  });

  it("空标签或空值不占行：卡片上的空行比少一行更难看", () => {
    const elements = detailElements(
      detail({
        fields: [
          { label: "地点", value: "   " },
          { label: "  ", value: "值" },
        ],
      }),
    );
    assert.deepEqual(elements, []);
  });
});

describe("整张卡片", () => {
  it("有 deep link 时给一个按钮，并用分割线隔开", () => {
    const card = buildCard(
      notification({
        detail: detail({
          deepLink: "yinian://open/task/t-1",
          fields: [{ label: "优先级", value: "高" }],
        }),
      }),
    );
    const tags = card.body.elements.map((element) => element.tag);
    assert.deepEqual(tags, ["column_set", "hr", "action"]);

    const button = card.body.elements[2].actions[0];
    assert.equal(button.multi_url.url, "yinian://open/task/t-1");
    assert.equal(button.multi_url.pc_url, "yinian://open/task/t-1");
    // 移动端刻意留空：一念只有桌面端，跳一个打不开的 scheme 比没按钮更糟
    assert.equal(button.multi_url.android_url, undefined);
  });

  it("没有明细时降级成一段正文（测试通知就是这种）", () => {
    const card = buildCard(
      notification({ kind: "custom", detail: undefined, body: "只有一句话" }),
    );
    assert.equal(card.body.elements.length, 1);
    assert.equal(card.body.elements[0].tag, "markdown");
    assert.equal(card.body.elements[0].content, "只有一句话");
    // 没有明细就没有副标题，不要留一个空的
    assert.equal(card.header.subtitle, undefined);
  });

  it("什么都没有时也要有一个元素：空 elements 飞书直接拒收", () => {
    const card = buildCard({
      id: "x",
      kind: "custom",
      title: "空通知",
    });
    assert.equal(card.body.elements.length, 1);
  });

  it("schema 与宽度模式固定", () => {
    const card = buildCard(notification({ detail: detail() }));
    assert.equal(card.schema, "2.0");
    assert.equal(card.config.width_mode, "compact");
  });
});
