/**
 * `tenant_access_token`：**应用自己的**身份。
 *
 * 与 `auth.mts` 里那套 device flow 的 `user_access_token` 是两回事：
 *
 * | | user_access_token | tenant_access_token |
 * |---|---|---|
 * | 代表谁 | 授权的那个用户 | 应用（机器人） |
 * | 怎么拿 | device flow，用户点同意 | appId + appSecret，直接换 |
 * | 用在哪 | 任务 / 日历 / 会议同步 | 发通知 |
 *
 * 通知必须用它。原来的「给自己发单聊」用的是 user token（`im:message.send_as_user`），
 * 于是飞书里显示成**我自己给自己发的消息**——那不是提醒，是自言自语。换成应用身份后
 * 消息来自机器人，头像与名字都是应用的。
 *
 * 端点与请求体照飞书官方 CLI 核对过
 * （`internal/credential/default_provider.go` 的 `doResolveTAT`）：
 * `POST /open-apis/auth/v3/tenant_access_token/internal`，JSON body `{app_id, app_secret}`。
 *
 * ## 为什么只缓存在内存里
 *
 * 有效期 2 小时，而它随时可以用 appId + appSecret 再换一个，丢了没有任何损失。
 * 落盘反而多一份要考虑权限、要跟着卸载清理的凭据文件。user token 不一样——那个
 * 丢了就得让用户重新点一次同意，所以它必须落盘。
 */

import type { Credentials } from "./auth.mjs";
import { openBase } from "./request.mjs";

const TENANT_TOKEN_PATH = "/open-apis/auth/v3/tenant_access_token/internal";

/** 剩余不到这个时长就提前换，避免正好卡在过期边界上。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** 飞书没给 expire 时按 2 小时算（这是它的默认值）。 */
const DEFAULT_TTL_SECONDS = 7200;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** 进程内缓存，按 appId 分开——同一个进程理论上只服务一个插件，但别赌这个。 */
const cache = new Map<string, CachedToken>();

/** 应用身份取 token 失败。与 `AuthError` 分开：这个和用户授权无关，重新授权也没用。 */
export class TenantTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantTokenError";
  }
}

/** 清掉缓存。配置变更（换了应用）时要调，否则会拿旧应用的 token 去发消息。 */
export function forgetTenantToken(appId?: string): void {
  if (appId) cache.delete(appId);
  else cache.clear();
}

export async function ensureTenantToken(
  credentials: Credentials,
): Promise<string> {
  if (!credentials.appId || !credentials.appSecret) {
    throw new TenantTokenError("还没填 App ID 与 App Secret");
  }

  const cached = cache.get(credentials.appId);
  if (cached && Date.now() < cached.expiresAt - REFRESH_SKEW_MS) {
    return cached.token;
  }

  let response: Response;
  try {
    response = await fetch(`${openBase(credentials)}${TENANT_TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: credentials.appId,
        app_secret: credentials.appSecret,
      }),
    });
  } catch (error) {
    throw new TenantTokenError(
      `连不上飞书：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let payload: {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new TenantTokenError(
      `飞书返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`,
    );
  }

  if (payload.code !== 0 || !payload.tenant_access_token) {
    // 这一步失败几乎只有两个原因：appId / appSecret 不对，或者选错了版本
    // （中国版 / 国际版账号体系是分开的）
    throw new TenantTokenError(
      `取应用身份失败 ${payload.code ?? response.status}：${
        payload.msg ?? text.slice(0, 120)
      }。检查 App ID / App Secret 与「版本」是否选对`,
    );
  }

  const ttl =
    typeof payload.expire === "number" && payload.expire > 0
      ? payload.expire
      : DEFAULT_TTL_SECONDS;
  cache.set(credentials.appId, {
    token: payload.tenant_access_token,
    expiresAt: Date.now() + ttl * 1000,
  });
  return payload.tenant_access_token;
}
