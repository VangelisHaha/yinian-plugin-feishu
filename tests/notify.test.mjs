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
  sendViaBotDm,
  sendViaWebhook,
} from "../dist/feishu/notify.mjs";
import { forgetTenantToken } from "../dist/feishu/tenant.mjs";
import {
  configuredOpenId,
  isWebhookUrl,
  webhookUrlFrom,
} from "../dist/handlers/notify.mjs";

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

/** 应用身份要先换 tenant token，再发消息，所以是两次请求。 */
function mockTenantThen(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes("tenant_access_token")) {
      return jsonResponse({
        code: 0,
        tenant_access_token: "t-abc",
        expire: 7200,
      });
    }
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
  // token 缓存在进程内，不清掉会让下一个用例拿到上一个用例的 mock token
  forgetTenantToken();
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe("投递方式", () => {
  it("缺省走 Webhook", () => {
    assert.equal(deliveryMode({}), "webhook");
    assert.equal(deliveryMode({ notifyMode: "什么" }), "webhook");
    assert.equal(deliveryMode({ notifyMode: "botDm" }), "botDm");
  });

  it("0.3.x 存下的 selfDm 按单聊处理：语义没变，只是身份换成了应用", () => {
    assert.equal(deliveryMode({ notifyMode: "selfDm" }), "botDm");
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

  it("手填的接收人 open_id 也去空白", () => {
    assert.equal(configuredOpenId({ notifyOpenId: " ou_1 " }), "ou_1");
    assert.equal(configuredOpenId({}), "");
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

  it("Webhook 发不了卡片，所以明细拼成文本行", () => {
    const text = renderText({
      id: "r1@1",
      kind: "schedule_start",
      title: "发布 · 中台开发",
      body: "排期开始：15 分钟后",
      detail: {
        subject: "发布",
        fields: [
          { label: "排期", value: "08-28 14:00–16:00" },
          // 空值不该占一行
          { label: "地点", value: "  " },
        ],
      },
    });
    assert.equal(
      text,
      "【一念】发布 · 中台开发\n排期开始：15 分钟后\n排期：08-28 14:00–16:00",
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

describe("应用身份单聊", () => {
  const CREDENTIALS = { appId: "cli_x", appSecret: "s", brand: "feishu" };
  const NOTIFICATION = {
    id: "rem_1@1",
    kind: "schedule_start",
    title: "发布中台服务 · 中台开发",
    body: "排期开始：15 分钟后",
    detail: {
      subject: "发布中台服务",
      label: "中台开发",
      priority: "high",
      deepLink: "yinian://open/task/t-1",
      fields: [{ label: "排期", value: "08-28 14:00–16:00" }],
    },
  };

  it("先换 tenant token，再以应用身份发 interactive 卡片", async () => {
    const calls = mockTenantThen(jsonResponse({ code: 0, msg: "success" }));
    const result = await sendViaBotDm(CREDENTIALS, "ou_1", NOTIFICATION);

    assert.equal(result.delivered, true);
    assert.equal(calls.length, 2);
    // 第一次必须是应用身份端点，不是 user token
    assert.match(calls[0].url, /auth\/v3\/tenant_access_token\/internal/);
    assert.deepEqual(calls[0].body, { app_id: "cli_x", app_secret: "s" });

    const send = calls[1];
    assert.match(send.url, /receive_id_type=open_id/);
    assert.equal(send.body.receive_id, "ou_1");
    // 这是整个改动的要点：卡片而不是文本，应用身份而不是用户身份
    assert.equal(send.body.msg_type, "interactive");
    assert.ok(send.body.uuid, "缺 uuid 会让飞书侧失去去重能力");

    // content 必须是 JSON 字符串，传对象飞书会报参数错误
    assert.equal(typeof send.body.content, "string");
    const card = JSON.parse(send.body.content);
    assert.equal(card.schema, "2.0");
    assert.equal(card.header.title.content, "发布中台服务");
  });

  it("token 只换一次：同一个 appId 后续复用缓存", async () => {
    const calls = mockTenantThen(jsonResponse({ code: 0 }));
    await sendViaBotDm(CREDENTIALS, "ou_1", NOTIFICATION);
    await sendViaBotDm(CREDENTIALS, "ou_1", { ...NOTIFICATION, id: "rem_2@1" });

    const tokenCalls = calls.filter((call) =>
      call.url.includes("tenant_access_token"),
    );
    assert.equal(tokenCalls.length, 1);
  });

  it("凭据不对时说清楚是 App ID / Secret 或版本的问题", async () => {
    globalThis.fetch = async () =>
      jsonResponse({ code: 10003, msg: "invalid app_id" });
    const result = await sendViaBotDm(CREDENTIALS, "ou_1", NOTIFICATION);

    assert.equal(result.delivered, false);
    assert.match(result.detail, /App ID/);
  });

  it("发送被拒时带回飞书的原因，不抛异常", async () => {
    mockTenantThen(jsonResponse({ code: 230013, msg: "bot not in chat" }));
    const result = await sendViaBotDm(CREDENTIALS, "ou_1", NOTIFICATION);

    assert.equal(result.delivered, false);
    assert.match(result.detail, /230013/);
  });
});
