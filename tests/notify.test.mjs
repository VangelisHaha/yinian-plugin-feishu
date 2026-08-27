/**
 * 飞书通知渠道。
 *
 * 覆盖三件真机上很难复现的事：
 *
 * - **幂等**：同一条提醒推迟复弹、宿主重启补发，都不该在飞书里刷第二条；
 * - **失败不抛异常**：抛出去会算进插件的失败次数，五次就把断路器烧开，
 *   连任务与日历同步一起停摆——一条通知发不出去不该让整个插件不可用；
 * - **Webhook 地址校验**：粘错成群分享链接时要在本地就说清楚，而不是发出去等 404。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  deliveryMode,
  idempotencyKey,
  loadNotified,
  rememberNotified,
  renderText,
  sendViaWebhook,
} from "../dist/feishu/notify.mjs";
import { isWebhookUrl, webhookUrlFrom } from "../dist/handlers/notify.mjs";

const HOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abc-123";
const originalFetch = globalThis.fetch;
const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "yinian-notify-"));
  dirs.push(dir);
  return dir;
}

function mockFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return response;
  };
  return calls;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("投递方式", () => {
  it("缺省走 Webhook", () => {
    assert.equal(deliveryMode({}), "webhook");
    assert.equal(deliveryMode({ notifyMode: "什么" }), "webhook");
    assert.equal(deliveryMode({ notifyMode: "selfDm" }), "selfDm");
  });

  it("只认自定义机器人的地址", () => {
    assert.equal(isWebhookUrl(HOOK), true);
    assert.equal(
      isWebhookUrl("https://open.larksuite.com/open-apis/bot/v2/hook/x"),
      true,
    );
    // 粘成群分享链接是最常见的误操作
    assert.equal(isWebhookUrl("https://applink.feishu.cn/client/chat/open"), false);
    assert.equal(isWebhookUrl("http://open.feishu.cn/open-apis/bot/v2/hook/x"), false);
  });

  it("地址两端的空白会被吃掉", () => {
    assert.equal(webhookUrlFrom({ notifyWebhookUrl: ` ${HOOK} ` }), HOOK);
    assert.equal(webhookUrlFrom({}), "");
  });
});

describe("正文", () => {
  it("带上一念前缀，标题与内容分行", () => {
    const text = renderText({
      id: "r1@1",
      kind: "task_due",
      title: "任务即将到期",
      body: "完成发布文档",
    });
    assert.equal(text, "【一念】任务即将到期\n完成发布文档");
  });

  it("没有内容时只有一行", () => {
    assert.equal(
      renderText({ id: "r1@1", kind: "custom", title: "只有标题" }),
      "【一念】只有标题",
    );
  });
});

describe("去重键", () => {
  it("压掉飞书 uuid 不接受的字符", () => {
    assert.match(idempotencyKey("rem_1@2026-08-21T10:00:00Z"), /^[a-zA-Z0-9-]+$/);
  });

  it("不超过 50 字符", () => {
    assert.ok(idempotencyKey("x".repeat(200)).length <= 50);
  });
});

describe("幂等记账", () => {
  it("记住之后能读出来", () => {
    const dir = tempDir();
    rememberNotified(dir, "rem_1@1");
    assert.deepEqual(loadNotified(dir), ["rem_1@1"]);
  });

  it("同一个 id 不会重复堆积", () => {
    const dir = tempDir();
    rememberNotified(dir, "rem_1@1");
    rememberNotified(dir, "rem_1@1");
    assert.deepEqual(loadNotified(dir), ["rem_1@1"]);
  });

  it("只留最近 200 条：通知是有时效的，翻旧账没意义", () => {
    const dir = tempDir();
    for (let index = 0; index < 210; index += 1) {
      rememberNotified(dir, `rem_${index}`);
    }
    const ids = loadNotified(dir);
    assert.equal(ids.length, 200);
    assert.equal(ids.at(-1), "rem_209");
    assert.equal(ids.includes("rem_0"), false);
  });

  it("目录不存在时会自己建，不抛错", () => {
    const dir = join(tempDir(), "nested", "deeper");
    rememberNotified(dir, "rem_1@1");
    assert.deepEqual(loadNotified(dir), ["rem_1@1"]);
  });
});

describe("Webhook 投递", () => {
  const NOTIFICATION = {
    id: "rem_1@1",
    kind: "task_due",
    title: "任务即将到期",
    body: "完成发布文档",
  };

  it("code 0 视为送达，载荷是文本消息", async () => {
    const calls = mockFetch(jsonResponse({ code: 0, msg: "success" }));
    const result = await sendViaWebhook(HOOK, NOTIFICATION);

    assert.equal(result.delivered, true);
    assert.equal(calls[0].url, HOOK);
    assert.equal(calls[0].body.msg_type, "text");
    assert.match(calls[0].body.content.text, /任务即将到期/);
  });

  it("业务错误码带回原因而不是抛异常", async () => {
    mockFetch(jsonResponse({ code: 19021, msg: "invalid webhook" }));
    const result = await sendViaWebhook(HOOK, NOTIFICATION);

    assert.equal(result.delivered, false);
    assert.match(result.detail, /19021/);
  });

  it("网关返回 HTML 时靠状态码判断", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      text: async () => "<html>bad gateway</html>",
    });
    const result = await sendViaWebhook(HOOK, NOTIFICATION);

    assert.equal(result.delivered, false);
    assert.match(result.detail, /502/);
  });

  it("网络不通也只是投递失败", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await sendViaWebhook(HOOK, NOTIFICATION);

    assert.equal(result.delivered, false);
    assert.match(result.detail, /ECONNREFUSED/);
  });
});
