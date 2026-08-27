/**
 * 通知渠道 handler。
 *
 * 渠道**只负责投递**：静默时段、按类型订阅、渠道开关全在宿主
 * （`docs/12-reminder-notification-design.md`），这里再判一次只会出现「宿主说该发、
 * 插件自己不发」的对不上账。
 *
 * `supportsActions` 声明的是 `false`，所以不会收到 `actions`。飞书卡片按钮要回调
 * 公网地址，插件收不到——声明 true 就是给用户一排点不动的按钮。
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
import { ensureAccessToken } from "../feishu/auth.mjs";
import { configOf, credentialsFrom } from "../feishu/pluginConfig.mjs";
import {
  deliveryMode,
  fetchOpenId,
  loadNotified,
  rememberNotified,
  sendViaSelfDm,
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

/** open_id 一个账号一辈子不变，取到就缓存，别每条通知都去问一次。 */
function openIdPath(dataDir: string): string {
  return join(dataDir, "open-id.txt");
}

async function resolveOpenId(
  credentials: ReturnType<typeof credentialsFrom>,
  dataDir: string,
): Promise<string> {
  const path = openIdPath(dataDir);
  if (existsSync(path)) {
    const cached = readFileSync(path, "utf8").trim();
    if (cached) return cached;
  }

  const token = await ensureAccessToken(credentials, dataDir);
  const openId = await fetchOpenId(credentials, token);
  if (!openId) throw new Error("拿不到自己的 open_id，请重新授权");

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
    const openId = await resolveOpenId(credentials, dataDir);
    return await sendViaSelfDm(credentials, dataDir, openId, notification);
  } catch (error) {
    // 通知失败绝不能抛出去：抛了会算进插件的失败次数，五次就把断路器烧开，
    // 连任务与日历同步一起停摆——一条通知发不出去不该让整个插件不可用
    return {
      delivered: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 设置面板上的「发送测试通知」。 */
export async function testNotification(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const config = params.config ?? configOf();
  const notification: Notification = {
    // 带上时间戳，连点两次要能连收两条——固定 id 会被幂等挡掉，看起来像没生效
    id: `test@${Date.now()}`,
    kind: "custom",
    title: "一念测试通知",
    body: "如果你收到了这条消息，飞书通知渠道就通了。",
  };
  const result = await deliver(notification, config, context().dataDir);
  return {
    message: result.delivered
      ? "已发出，去飞书里看看收到没"
      : `发送失败：${result.detail ?? "未知原因"}`,
  };
}
