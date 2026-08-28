/**
 * 授权与配置校验。
 *
 * ## 授权的三段式
 *
 * 契约（`docs/11-plugin-architecture.md` §7.3.1）推荐的 device flow 范式：
 *
 * 1. 「开始授权」action → 申请设备码，返回 `openUrl`，宿主用系统浏览器打开；
 * 2. 「检查授权」action → 轮询几秒给即时反馈（**只有 15 秒超时**，不能久等）；
 * 3. `config.validate` 里再兜一次（30 秒）——用户在浏览器点完同意后直接点「启用」
 *    也要能成功，不该强迫他先点一次「检查授权」。
 *
 * 三段之间**没有共享内存**：启用之前每个 action 都跑在一个用完就回收的临时进程里，
 * 所以设备码只能靠 `dataDir` 传递，见 `feishu/auth.mts` 的 `rememberPendingDevice`。
 *
 * ## 按能力最小授权
 *
 * 申请的 scope 由用户勾选的能力拼（`capability.mts`）。三条推论：
 *
 * - **一项都没勾也能启用。** 只想把提醒发到飞书的人不需要任何用户授权——通知走
 *   应用身份。所以 `validate` 在没勾能力时不能因为「没授权」而拦住启用。
 * - **新勾一项能力必须重新授权。** 飞书的 device flow 不做增量合并，每次按这一次
 *   请求的 scope 发 token。所以要按 `StoredToken.scope` 逐项比对，缺了就明确说出来，
 *   否则表现是「勾了但同步不动、也没有任何提示」。
 * - **判据是飞书回传的 scope，不是我们请求的那份。** 用户在同意页上可以取消勾选。
 */

import { context, logger } from "../sdk/index.mjs";
import type {
  ActionResult,
  ConfigValidateRequest,
  ConfigValidateResult,
  FieldError,
} from "../sdk/index.mjs";
import {
  AuthError,
  fetchUserName,
  forgetPendingDevice,
  loadToken,
  pollDeviceToken,
  rememberPendingDevice,
  requestDeviceCode,
  saveToken,
  takePendingDevice,
  type StoredToken,
} from "../feishu/auth.mjs";
import {
  capabilitiesFrom,
  capabilityLabel,
  isAuthorized,
  scopesFor,
  type Capability,
} from "../feishu/capability.mjs";
import { credentialsFrom } from "../feishu/pluginConfig.mjs";

/** 「检查授权」能等多久。action 的超时是 15 秒，留 3 秒余量。 */
const CHECK_BUDGET_MS = 12_000;
/** `config.validate` 能等多久。它的超时是 30 秒，留 5 秒余量。 */
const VALIDATE_BUDGET_MS = 25_000;

function requireCredentials(config: Record<string, unknown>) {
  const credentials = credentialsFrom(config);
  const errors: FieldError[] = [];
  if (!credentials.appId) {
    errors.push({ field: "appId", message: "请填飞书应用的 App ID" });
  }
  if (!credentials.appSecret) {
    errors.push({ field: "appSecret", message: "请填 App Secret" });
  }
  return { credentials, errors };
}

/** 勾了但还没拿到 scope 的能力。 */
function unauthorizedCapabilities(
  capabilities: readonly Capability[],
  token: StoredToken | null,
): Capability[] {
  const granted = token?.scope ?? "";
  return capabilities.filter((capability) => !isAuthorized(capability, granted));
}

/** 第一步：申请设备码并把授权链接递给用户。 */
export async function startAuthorization(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const config = params.config ?? context().config;
  const { credentials, errors } = requireCredentials(config);
  if (errors.length > 0) {
    return { message: errors.map((item) => item.message).join("；") };
  }

  const capabilities = capabilitiesFrom(config);
  if (capabilities.length === 0) {
    return {
      message:
        "先勾选要用的能力再授权。只用「把提醒发到飞书」的话不需要授权——那走应用身份。",
    };
  }

  try {
    // 一次把已勾选的全部能力要齐：device flow 不做增量合并，分两次授权
    // 第二次会把第一次的 scope 覆盖掉
    const device = await requestDeviceCode(credentials, scopesFor(capabilities));
    // 落盘而不是存内存：下一次「检查授权」是另一个临时进程
    rememberPendingDevice(context().dataDir, device);
    logger.info("已申请设备码，等待用户在浏览器里授权", {
      code: "FEISHU_DEVICE_CODE",
      detail: { capabilities },
    });

    const names = capabilities.map(capabilityLabel).join("、");
    return {
      message:
        `已打开浏览器，请确认用户码 ${device.userCode} 并点同意（本次申请：${names}）。` +
        `完成后点「检查授权」，或者直接点启用也会自动等一会儿。`,
      // 宿主校验过是 http/https 才会打开
      openUrl: device.verificationUri,
    };
  } catch (error) {
    return { message: describe(error) };
  }
}

/** 第二步：轮询几秒，给用户即时反馈。 */
export async function checkAuthorization(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const config = params.config ?? context().config;
  const { credentials, errors } = requireCredentials(config);
  if (errors.length > 0) {
    return { message: errors.map((item) => item.message).join("；") };
  }

  const dataDir = context().dataDir;
  const capabilities = capabilitiesFrom(config);
  const existing = loadToken(dataDir);
  const pending = takePendingDevice(dataDir);
  if (!pending) {
    return existing && Date.now() < existing.refreshExpiresAt
      ? { message: statusMessage(capabilities, existing) }
      : { message: "请先点「开始授权」" };
  }

  try {
    const token = await finishAuthorization(
      credentials,
      dataDir,
      pending,
      CHECK_BUDGET_MS,
    );
    return { message: statusMessage(capabilities, token) };
  } catch (error) {
    return { message: describe(error) };
  }
}

/**
 * 语义校验。
 *
 * 形状校验（必填、格式）宿主已经按 schema 做过了，这里只做它做不了的事：
 * 凭据到底能不能换出 token。
 */
export async function validate(
  request: ConfigValidateRequest,
): Promise<ConfigValidateResult> {
  // 实例级配置没有凭据，凭据在插件级。别在这里重复要求
  if (request.scope === "integration") {
    return { ok: true };
  }

  const { credentials, errors } = requireCredentials(request.config);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const dataDir = context().dataDir;
  const capabilities = capabilitiesFrom(request.config);
  const existing = loadToken(dataDir);
  // 用户可能刚在浏览器点完同意就直接点了启用，这里替他把最后一步走完
  const pending = takePendingDevice(dataDir);

  if (pending) {
    try {
      const token = await finishAuthorization(
        credentials,
        dataDir,
        pending,
        VALIDATE_BUDGET_MS,
      );
      return capabilityGate(capabilities, token);
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            field:
              error instanceof AuthError && error.kind === "config"
                ? "appSecret"
                : "startAuthorization",
            message: describe(error),
          },
        ],
      };
    }
  }

  const usable = existing && Date.now() < existing.refreshExpiresAt;
  return capabilityGate(capabilities, usable ? existing : null);
}

/**
 * 勾了的能力是不是都授权了。
 *
 * **一项都没勾时直接放行**：只用通知的人不需要任何用户授权（走应用身份），
 * 在这里拦住他等于把最小授权的路堵死。
 */
function capabilityGate(
  capabilities: readonly Capability[],
  token: StoredToken | null,
): ConfigValidateResult {
  if (capabilities.length === 0) return { ok: true };

  const missing = unauthorizedCapabilities(capabilities, token);
  if (missing.length === 0) return { ok: true };

  const names = missing.map(capabilityLabel).join("、");
  return {
    ok: false,
    errors: [
      {
        field: "startAuthorization",
        message: token
          ? `${names} 还没有授权。已勾选的能力变了就要重新授权一次——点「开始授权」，在浏览器里同意后再启用`
          : `${names} 需要授权。点「开始授权」，在浏览器里同意后再启用`,
      },
    ],
  };
}

async function finishAuthorization(
  credentials: Parameters<typeof pollDeviceToken>[0],
  dataDir: string,
  pending: Parameters<typeof pollDeviceToken>[1],
  budgetMs: number,
): Promise<StoredToken> {
  const token = await pollDeviceToken(
    credentials,
    pending,
    Date.now() + budgetMs,
  );
  const userName = await fetchUserName(credentials, token.accessToken);
  if (userName) token.userName = userName;
  saveToken(dataDir, token);
  // 设备码是一次性的，用掉就清，别让下一次判断以为还有待授权的流程
  forgetPendingDevice(dataDir);
  logger.info(`授权成功${userName ? `：${userName}` : ""}`, {
    code: "FEISHU_AUTHORIZED",
  });
  return token;
}

function authorizedMessage(token: StoredToken): string {
  const who = token.userName ? `（${token.userName}）` : "";
  const days = Math.max(
    0,
    Math.round((token.refreshExpiresAt - Date.now()) / 86_400_000),
  );
  return `已授权${who}，凭据约 ${days} 天后需要重新授权`;
}

/**
 * 逐项报告：哪些能力已授权、哪些还差。
 *
 * 只说「已授权」是不够的——用户新勾一项能力后 token 还在、身份也对，但那一项的
 * scope 没有。不点出来的话他会以为已经好了，然后等一个永远不来的同步。
 */
function statusMessage(
  capabilities: readonly Capability[],
  token: StoredToken | null,
): string {
  if (!token) {
    return capabilities.length === 0
      ? "未授权（当前没有勾选需要授权的能力；通知走应用身份，不需要授权）"
      : "未授权";
  }
  if (Date.now() >= token.refreshExpiresAt) {
    return "授权已过期，请重新点「开始授权」";
  }

  const base = authorizedMessage(token);
  if (capabilities.length === 0) {
    return `${base}。当前没有勾选需要授权的能力`;
  }

  const missing = unauthorizedCapabilities(capabilities, token);
  const ready = capabilities.filter((item) => !missing.includes(item));
  const parts = [base];
  if (ready.length > 0) {
    parts.push(`已生效：${ready.map(capabilityLabel).join("、")}`);
  }
  if (missing.length > 0) {
    parts.push(`待授权：${missing.map(capabilityLabel).join("、")}（重新点「开始授权」）`);
  }
  return parts.join("。");
}

function describe(error: unknown): string {
  if (error instanceof AuthError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 当前授权状态。设置面板上的 note 字段没法调 RPC，所以做成一个 action。 */
export async function authorizationStatus(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const config = params.config ?? context().config;
  const token = loadToken(context().dataDir);
  return { message: statusMessage(capabilitiesFrom(config), token) };
}
