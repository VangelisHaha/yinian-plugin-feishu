/**
 * 飞书通知投递。
 *
 * 两种方式，插件级配置里二选一：
 *
 * - `webhook`（默认）：群自定义机器人的 Webhook。零额外权限、零 OAuth，
 *   把 URL 填进来就能收消息。
 * - `botDm`：**应用身份**给你发单聊卡片（`tenant_access_token` +
 *   `POST /open-apis/im/v1/messages`，`msg_type=interactive`）。
 *
 * ## `botDm` 修掉了什么
 *
 * 上一版这个模式叫 `selfDm`，用的是 device flow 那份 `user_access_token` +
 * `im:message.send_as_user`——于是消息**以你自己的身份发给你自己**，飞书里看起来是
 * 自言自语，而不是应用在提醒你。现在换成应用身份：头像与名字都是那个自建应用的，
 * 权限也从「代表用户发言」降成「机器人发消息」（`im:message:send_as_bot`）。
 *
 * 它还带来一个好处：**通知不再需要用户 OAuth 授权**。tenant token 只认 appId +
 * appSecret，所以只想把提醒发到飞书的人不必把任务读写权限一并交出去
 * （见 `capability.mts`）。
 *
 * ## 为什么发卡片而不是纯文本
 *
 * 宿主下发的 `notification.detail`（契约 §8.2）带着截止时间、优先级、标签、地点这些
 * 明细。纯文本只能把它们拼成一坨，卡片能排成网格并给一个「在一念中打开」的按钮。
 * 卡片的构造在 `card.mts`，这里只负责送。
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
import { buildCard } from "./card.mjs";
import { openBase } from "./request.mjs";
import { ensureTenantToken } from "./tenant.mjs";

/** 最多记多少条已投递 id。 */
const SEEN_LIMIT = 200;
/** 飞书 uuid 的长度上限（超了会报参数错误）。 */
const UUID_MAX = 50;

const SEND_MESSAGE_PATH = "/open-apis/im/v1/messages";

export type DeliveryMode = "webhook" | "botDm";

export function deliveryMode(config: Record<string, unknown>): DeliveryMode {
  // 兼容 0.3.x 存下来的 `selfDm`：语义上是同一个「发单聊」，只是身份换了
  const raw = config["notifyMode"];
  return raw === "botDm" || raw === "selfDm" ? "botDm" : "webhook";
}

/**
 * 纯文本正文。
 *
 * Webhook 走的是群机器人，**它发不了 interactive 卡片**（自定义机器人只支持
 * text / post / image / share_chat / interactive 的简化形态，且不同版本差异大），
 * 所以那条路仍然是文本。明细拼成缩进的几行，比只有标题好读。
 */
export function renderText(notification: Notification): string {
  const lines = [`【一念】${notification.title}`];
  const body = notification.body?.trim();
  if (body) lines.push(body);
  for (const field of notification.detail?.fields ?? []) {
    if (!field.label.trim() || !field.value.trim()) continue;
    lines.push(`${field.label}：${field.value}`);
  }
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

/**
 * 应用身份给指定用户发单聊卡片。
 *
 * 用 `tenant_access_token`，所以消息来自机器人而不是用户自己。需要开放平台上的
 * `im:message:send_as_bot`，**且你本人要在这个自建应用的可用范围内**——不在范围里
 * 时飞书会拒收，报「机器人未与用户建立会话」之类的错误。
 */
export async function sendViaBotDm(
  credentials: Credentials,
  openId: string,
  notification: Notification,
): Promise<NotifyResult> {
  // 取 token 失败也要走返回值：这个函数的契约是「永远返回 NotifyResult」。
  // 靠调用方 catch 能兜住，但那让「不抛异常」这条纪律依赖于调用点写对，
  // 而抛出去的代价是被算进插件失败次数、五次烧开断路器、连同步一起停摆
  let token: string;
  try {
    token = await ensureTenantToken(credentials);
  } catch (error) {
    return {
      delivered: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const url = new URL(`${openBase(credentials)}${SEND_MESSAGE_PATH}`);
  url.searchParams.set("receive_id_type", "open_id");

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: openId,
        msg_type: "interactive",
        // content 必须是 JSON **字符串**，不是对象——传对象飞书会报参数错误
        content: JSON.stringify(buildCard(notification)),
        uuid: idempotencyKey(notification.id),
      }),
    });
  } catch (error) {
    return {
      delivered: false,
      detail: `连不上飞书：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const text = await response.text();
  let payload: { code?: number; msg?: string };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    return {
      delivered: false,
      detail: `飞书返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`,
    };
  }
  if (payload.code === 0) return { delivered: true };
  return {
    delivered: false,
    detail: `发送失败 ${payload.code ?? response.status}：${
      payload.msg ?? text.slice(0, 120)
    }`,
  };
}

/**
 * 取要发给谁的 open_id。
 *
 * 这里有个绕不开的地方：**应用身份发消息，但收件人是谁只有用户授权后才知道**。
 * `authen/v1/user_info` 要 user token。所以两条路：
 *
 * 1. 用户已经为同步授权过（`token.json` 在），顺手用它查一次 open_id 并缓存；
 * 2. 用户只想用通知、没走过任何授权，那就让他自己填 open_id。
 *
 * 第 2 条是「最小授权」的代价：不想授权就得自己提供收件人。填错的表现是飞书报
 * 「用户不存在」，比静默不发好。
 */
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
