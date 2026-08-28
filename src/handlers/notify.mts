/**
 * 通知渠道 handler。
 *
 * 渠道**只负责投递**：静默时段、按类型订阅、渠道开关全在宿主
 * （`docs/12-reminder-notification-design.md`），这里再判一次只会出现「宿主说该发、
 * 插件自己不发」的对不上账。
 *
 * `supportsActions` 声明的是 `false`，所以不会收到 `actions`。飞书卡片的交互按钮要
 * 回调公网地址，插件收不到——声明 true 就是给用户一排点不动的按钮。卡片上唯一的
 * 按钮是「在一念中打开」，那是个链接（deep link），不需要回调。
 *
 * ## 通知不需要用户授权
 *
 * 单聊走**应用身份**（`tenant_access_token`），只认 appId + appSecret。所以只想把
 * 提醒发到飞书的人不必为此走一遍 device flow，也不必交出任务读写权限。
 * 唯一的例外是收件人 open_id：查它要 user token，所以没授权过的用户得自己填
 * （见 [`resolveOpenId`]）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { context, logger } from "../sdk/index.mjs";
import type {
  ActionResult,
  Notification,
  NotifyRequest,
  NotifyResult,
} from "../sdk/index.mjs";
import { ensureAccessToken, loadToken } from "../feishu/auth.mjs";
import { configOf, credentialsFrom } from "../feishu/pluginConfig.mjs";
import {
  deliveryMode,
  fetchOpenId,
  loadNotified,
  rememberNotified,
  sendViaBotDm,
  sendViaWebhook,
} from "../feishu/notify.mjs";

/** 自定义机器人的 Webhook 前缀。填错域名（比如粘了个群分享链接）先在这里拦住。 */
const WEBHOOK_PREFIXES = [
  "https://open.feishu.cn/open-apis/bot/v2/hook/",
  "https://open.larksuite.com/open-apis/bot/v2/hook/",
];

export function isWebhookUrl(value: string): boolean {
  return WEBHOOK_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function webhookUrlFrom(config: Record<string, unknown>): string {
  return String(config["notifyWebhookUrl"] ?? "").trim();
}

/** 用户手填的收件人 open_id。没授权过时这是唯一来源。 */
export function configuredOpenId(config: Record<string, unknown>): string {
  return String(config["notifyOpenId"] ?? "").trim();
}

/** open_id 一个账号一辈子不变，取到就缓存，别每条通知都去问一次。 */
function openIdPath(dataDir: string): string {
  return join(dataDir, "open-id.txt");
}

/**
 * 定位收件人。三级回退：
 *
 * 1. 用户在设置里手填的 —— 明确指定优先，他可能想发给别人（比如共享账号）；
 * 2. 缓存文件；
 * 3. 授权过的话用 user token 查一次并缓存。
 *
 * 三条都没有就报错说清楚怎么办。**不要在这里替用户走授权**：通知渠道要的是
 * 应用身份，为了查一个 open_id 去要一整套用户授权正好违背最小授权。
 */
async function resolveOpenId(
  config: Record<string, unknown>,
  credentials: ReturnType<typeof credentialsFrom>,
  dataDir: string,
): Promise<string> {
  const configured = configuredOpenId(config);
  if (configured) return configured;

  const path = openIdPath(dataDir);
  if (existsSync(path)) {
    const cached = readFileSync(path, "utf8").trim();
    if (cached) return cached;
  }

  if (!loadToken(dataDir)) {
    throw new Error(
      "不知道该发给谁。在插件设置里填「接收人 Open ID」，或者先完成一次授权（授权后会自动识别）",
    );
  }

  const token = await ensureAccessToken(credentials, dataDir);
  const openId = await fetchOpenId(credentials, token);
  if (!openId) {
    throw new Error("拿不到你的 open_id，请重新授权或手填「接收人 Open ID」");
  }

  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${openId}\n`, { mode: 0o600 });
  } catch {
    // 缓存不上只是多几次请求
  }
  return openId;
}

/** `notify.send`。 */
export async function send(request: NotifyRequest): Promise<NotifyResult> {
  const notification = request.notification;
  const ctx = context();
  const config = configOf();

  if (notification.id && loadNotified(ctx.dataDir).includes(notification.id)) {
    // 同一次提醒重发（推迟复弹、宿主重启补发）不该在群里刷第二条
    logger.debug(`通知 ${notification.id} 已发过，跳过`, {
      traceId: request.traceId,
    });
    return { delivered: true, detail: "已发送过，按 id 幂等跳过" };
  }

  const result = await deliver(notification, config, ctx.dataDir);
  if (result.delivered && notification.id) {
    rememberNotified(ctx.dataDir, notification.id);
  }
  if (!result.delivered) {
    // 失败原因要进插件日志：宿主只把它记进 channel_results，日志才是排查入口
    logger.warn(`飞书通知投递失败：${result.detail ?? "未知原因"}`, {
      traceId: request.traceId,
      code: "FEISHU_NOTIFY_FAILED",
    });
  }
  return result;
}

async function deliver(
  notification: Notification,
  config: Record<string, unknown>,
  dataDir: string,
): Promise<NotifyResult> {
  const mode = deliveryMode(config);

  if (mode === "webhook") {
    const url = webhookUrlFrom(config);
    if (!url) {
      return { delivered: false, detail: "还没填飞书机器人 Webhook 地址" };
    }
    if (!isWebhookUrl(url)) {
      return { delivered: false, detail: "Webhook 地址不是飞书自定义机器人的地址" };
    }
    return sendViaWebhook(url, notification);
  }

  try {
    const credentials = credentialsFrom(config);
    const openId = await resolveOpenId(config, credentials, dataDir);
    return await sendViaBotDm(credentials, openId, notification);
  } catch (error) {
    // 通知失败绝不能抛出去：抛了会算进插件的失败次数，五次就把断路器烧开，
    // 连任务与日历同步一起停摆——一条通知发不出去不该让整个插件不可用
    return {
      delivered: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 设置面板上的「发送测试通知」。
 *
 * 明细按真实提醒的形状造一份，否则用户看到的是降级后的简单卡片，会以为排版没生效。
 * **刻意不给 `deepLink`**：这条通知没有对应的真实事项，放一个点了打不开的按钮
 * 比没有按钮更糟。
 */
export async function testNotification(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const config = params.config ?? configOf();
  const notification: Notification = {
    // 带上时间戳，连点两次要能连收两条——固定 id 会被幂等挡掉，看起来像没生效
    id: `test@${Date.now()}`,
    kind: "schedule_start",
    title: "一念测试通知 · 示例排期",
    body: "这是一条示例，真实提醒长这样",
    detail: {
      subject: "一念测试通知",
      label: "示例排期",
      priority: "high",
      overdue: false,
      fields: [
        { label: "排期", value: "示例 14:00–16:00" },
        { label: "优先级", value: "高" },
        { label: "标签", value: "示例" },
        {
          label: "说明",
          value: "收到这条说明飞书通知渠道通了。真实提醒会多一个「在一念中打开」按钮。",
        },
      ],
    },
  };
  const result = await deliver(notification, config, context().dataDir);
  return {
    message: result.delivered
      ? "已发出，去飞书里看看收到没"
      : `发送失败：${result.detail ?? "未知原因"}`,
  };
}
