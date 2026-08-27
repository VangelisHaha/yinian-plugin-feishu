/**
 * 配置解析。
 *
 * 任务同步、日历同步、通知渠道三个 handler 都要读配置，放在任何一个 handler 里
 * 都会让另外两个反向依赖它。
 */

import { context } from "../sdk/index.mjs";
import type { Brand, Credentials } from "./auth.mjs";

export function credentialsFrom(config: Record<string, unknown>): Credentials {
  const appId = String(config["appId"] ?? "").trim();
  const appSecret = String(config["appSecret"] ?? "").trim();
  const brand = (config["brand"] === "lark" ? "lark" : "feishu") as Brand;
  return { appId, appSecret, brand };
}

/**
 * 取这次调用该用的配置。
 *
 * **请求里那份优先**：宿主已经把插件级与实例级合并好了（同名键以实例级为准），
 * 而 `plugin.init` 里那份只有插件级——一个进程服务该插件下的所有实例，init 时
 * 给不出「哪一个实例」的配置。用错了的表现是实例设置怎么改都不生效。
 *
 * `notify.send` 是唯一没有请求级配置的扩展点（契约 §8.2 的载荷里没有 `config`），
 * 它只能落到 `plugin.init` 那份——所以**通知渠道的配置必须放在插件级**。
 */
export function configOf(
  request?: { config?: Record<string, unknown> } | undefined,
): Record<string, unknown> {
  const fromRequest = request?.config;
  if (fromRequest && Object.keys(fromRequest).length > 0) return fromRequest;
  return context().config;
}
