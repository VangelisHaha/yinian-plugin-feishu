/**
 * 飞书通知投递。
 *
 * 两种方式，插件级配置里二选一：
 *
 * - `webhook`（默认）：群自定义机器人的 Webhook。零额外权限、零 OAuth，
 *   把 URL 填进来就能收消息。
 * - `selfDm`：用已有的 device flow 用户凭据，给自己发单聊消息
 *   （`POST /open-apis/im/v1/messages`，`receive_id_type=open_id`）。
 *   需要在开放平台补 `im:message.send_as_user`，并重新授权一次。
 *
 * ## 为什么配置在插件级
 *
 * `notify.send` 的载荷里**没有 `config`**（契约 §8.2），渠道只能读 `plugin.init`
 * 那份，也就是插件级配置。这不是将就：通知渠道本身是插件级的（一个插件一个渠道），
 * 和「挂了几个同步实例」没有关系。改了配置宿主会换进程重新 init，所以读到的一定是新值。
 *
 * ## 幂等
 *
 * `notification.id` 形如 `<reminderId>@<触发时刻>`，同一次提醒重发（推迟后复弹、
 * 宿主重启后补发）不该产生两条消息。两道保险：
 *
 * 1. 本地在 `dataDir` 记最近发过的 id，命中直接返回；
 * 2. 发消息时带 `uuid`（飞书自己的去重键），本地记账丢了也不会重出。
 *
 * 记账文件会被裁剪到最近 200 条——通知是有时效的东西，翻旧账没有意义。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { logger } from "../sdk/index.mjs";
import type { Notification, NotifyResult } from "../sdk/index.mjs";
import { type Credentials } from "./auth.mjs";
import { apiRequest, openBase } from "./request.mjs";

/** 最多记多少条已投递 id。 */
const SEEN_LIMIT = 200;
/** 飞书 uuid 的长度上限（超了会报参数错误）。 */
const UUID_MAX = 50;

export type DeliveryMode = "webhook" | "selfDm";

export function deliveryMode(config: Record<string, unknown>): DeliveryMode {
  return config["notifyMode"] === "selfDm" ? "selfDm" : "webhook";
}

/** 通知正文。渠道不做静默/订阅判断——那是宿主的事，这里只负责好好排版。 */
export function renderText(notification: Notification): string {
  const lines = [`【一念】${notification.title}`];
  const body = notification.body?.trim();
  if (body) lines.push(body);
  return lines.join("\n");
}

/**
 * 飞书 uuid 的去重键。
 *
 * `notification.id` 里有 `@` 和 `:`，飞书对 uuid 的字符集要求不明确，
 * 统一压成 `[a-zA-Z0-9-]` 最安全。
 */
export function idempotencyKey(notificationId: string): string {
  const safe = notificationId.replace(/[^a-zA-Z0-9-]/g, "-");
  return safe.slice(0, UUID_MAX) || "yinian";
}

function seenPath(dataDir: string): string {
  return join(dataDir, "notified.json");
}

export function loadNotified(dataDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(seenPath(dataDir), "utf8")) as {
      ids?: unknown;
    };
    if (!Array.isArray(parsed?.ids)) return [];
    return parsed.ids.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function rememberNotified(dataDir: string, id: string): void {
  const next = [...loadNotified(dataDir).filter((item) => item !== id), id].slice(
    -SEEN_LIMIT,
  );
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(seenPath(dataDir), `${JSON.stringify({ ids: next })}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    // 记不住只会导致极端情况下重复一条通知，不该让投递失败
    logger.debug(
      `通知记账写入失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 群自定义机器人。URL 里自带 token，不需要 access_token。 */
export async function sendViaWebhook(
  webhookUrl: string,
  notification: Notification,
): Promise<NotifyResult> {
  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msg_type: "text",
        content: { text: renderText(notification) },
      }),
    });
  } catch (error) {
    return {
      delivered: false,
      detail: `连不上飞书 Webhook：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const text = await response.text();
  let payload: { code?: number; msg?: string; StatusCode?: number } = {};
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    // 自定义机器人在网关层出错时会返回 HTML，此时状态码才是唯一线索
    return response.ok
      ? { delivered: true }
      : { delivered: false, detail: `Webhook HTTP ${response.status}` };
  }

  // 自定义机器人成功时 code 为 0（老接口用 StatusCode）
  const code = payload.code ?? payload.StatusCode ?? (response.ok ? 0 : -1);
  if (code === 0) return { delivered: true };
  return {
    delivered: false,
    detail: `Webhook 报错 ${code}：${payload.msg ?? text.slice(0, 120)}`,
  };
}

/** 给自己发单聊。需要 `im:message.send_as_user`。 */
export async function sendViaSelfDm(
  credentials: Credentials,
  dataDir: string,
  openId: string,
  notification: Notification,
): Promise<NotifyResult> {
  await apiRequest<{ message_id?: string }>({
    credentials,
    dataDir,
    method: "POST",
    path: "/open-apis/im/v1/messages",
    query: { receive_id_type: "open_id" },
    body: {
      receive_id: openId,
      msg_type: "text",
      // content 必须是 JSON 字符串，不是对象
      content: JSON.stringify({ text: renderText(notification) }),
      uuid: idempotencyKey(notification.id),
    },
  });
  return { delivered: true };
}

/** 取当前授权用户的 open_id。`authen/v1/user_info` 不需要额外 scope。 */
export async function fetchOpenId(
  credentials: Credentials,
  accessToken: string,
): Promise<string> {
  const response = await fetch(
    `${openBase(credentials)}/open-apis/authen/v1/user_info`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = (await response.json()) as {
    data?: { open_id?: string };
  };
  return data.data?.open_id ?? "";
}
