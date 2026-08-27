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

/** 第一步：申请设备码并把授权链接递给用户。 */
export async function startAuthorization(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  const config = params.config ?? context().config;
  const { credentials, errors } = requireCredentials(config);
  if (errors.length > 0) {
    return { message: errors.map((item) => item.message).join("；") };
  }

  try {
    const device = await requestDeviceCode(credentials);
    // 落盘而不是存内存：下一次「检查授权」是另一个临时进程
    rememberPendingDevice(context().dataDir, device);
    logger.info("已申请设备码，等待用户在浏览器里授权", {
      code: "FEISHU_DEVICE_CODE",
    });

    return {
      message:
        `已打开浏览器，请确认用户码 ${device.userCode} 并点同意。` +
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
  const existing = loadToken(dataDir);
  const pending = takePendingDevice(dataDir);
  if (!pending) {
    return existing && Date.now() < existing.refreshExpiresAt
      ? { message: authorizedMessage(existing) }
      : { message: "请先点「开始授权」" };
  }

  try {
    const token = await finishAuthorization(credentials, dataDir, pending, CHECK_BUDGET_MS);
    return { message: authorizedMessage(token) };
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
  const existing = loadToken(dataDir);
  // 用户可能刚在浏览器点完同意就直接点了启用，这里替他把最后一步走完
  const pending = takePendingDevice(dataDir);
  if (!pending) {
    if (existing && Date.now() < existing.refreshExpiresAt) return { ok: true };
    return {
      ok: false,
      errors: [
        {
          field: "startAuthorization",
          message: "还没有授权。点「开始授权」，在浏览器里同意后再启用",
        },
      ],
    };
  }

  try {
    await finishAuthorization(credentials, dataDir, pending, VALIDATE_BUDGET_MS);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          field: error instanceof AuthError && error.kind === "config"
            ? "appSecret"
            : "startAuthorization",
          message: describe(error),
        },
      ],
    };
  }
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

function describe(error: unknown): string {
  if (error instanceof AuthError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** 当前授权状态。设置面板上的 note 字段没法调 RPC，所以做成一个 action。 */
export async function authorizationStatus(): Promise<ActionResult> {
  const token = loadToken(context().dataDir);
  if (!token) return { message: "未授权" };
  if (Date.now() >= token.refreshExpiresAt) {
    return { message: "授权已过期，请重新点「开始授权」" };
  }
  return { message: authorizedMessage(token) };
}
