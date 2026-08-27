/**
 * 飞书 OAuth 2.0 Device Authorization Grant。
 *
 * 为什么用 device flow：插件不能起本地回调服务，也不该要求用户配置回调地址。
 * 用户只需在设置面板填 appId 与 appSecret，然后在浏览器里点一次同意。
 *
 * 端点与错误码取自飞书官方 CLI（`lark-cli`）的实现，逐字段核对过：
 * - 设备码：`POST {accounts}/oauth/v1/device_authorization`，
 *   `Authorization: Basic base64(appId:appSecret)`，表单 `client_id` + `scope`
 * - 换 / 刷 token：`POST {open}/open-apis/authen/v2/oauth/token`
 *
 * ## token 存在哪
 *
 * 存 `dataDir/token.json`（0600），**不放宿主的 secrets.json**——那是用户填的配置，
 * 由宿主管理；这是运行时产物，插件自己负责。
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { logger } from "../sdk/index.mjs";

/** 国内版与国际版的端点。选错了会一直报「应用不存在」。 */
const ENDPOINTS = {
  feishu: {
    accounts: "https://accounts.feishu.cn",
    open: "https://open.feishu.cn",
  },
  lark: {
    accounts: "https://accounts.larksuite.com",
    open: "https://open.larksuite.com",
  },
} as const;

export type Brand = keyof typeof ENDPOINTS;

/**
 * 需要的权限。
 *
 * `offline_access` 是拿 `refresh_token` 的前提，缺了它每 2 小时就要重新授权一次。
 */
export const SCOPES = "task:task:read task:task:write offline_access";

const DEVICE_AUTH_PATH = "/oauth/v1/device_authorization";
const TOKEN_PATH = "/open-apis/authen/v2/oauth/token";
const USER_INFO_PATH = "/open-apis/authen/v1/user_info";

/** access_token 剩余不到这个时长就提前刷新，避免正好卡在过期边界上。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export interface Credentials {
  appId: string;
  appSecret: string;
  brand: Brand;
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** 毫秒时间戳。 */
  expiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  /** 授权的是谁，展示给用户确认没授错账号。 */
  userName?: string;
}

export interface PendingDevice {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** 毫秒时间戳。 */
  expiresAt: number;
  intervalMs: number;
}

/** 授权流程里可能出现的、需要区别对待的失败。 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "pending" // 用户还没点同意
      | "denied" // 用户拒绝了
      | "expired" // 设备码或 refresh_token 过期，要重新走一遍
      | "config" // appId / appSecret 不对
      | "network",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function endpoints(brand: Brand) {
  return ENDPOINTS[brand] ?? ENDPOINTS.feishu;
}

async function postForm(
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (error) {
    throw new AuthError(
      `连不上飞书（${url}）：${error instanceof Error ? error.message : String(error)}`,
      "network",
    );
  }

  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AuthError(
      `飞书返回了非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 200)}`,
      "network",
    );
  }
  return data;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 第一步：申请设备码。 */
export async function requestDeviceCode(
  credentials: Credentials,
): Promise<PendingDevice> {
  const { accounts } = endpoints(credentials.brand);
  const basic = Buffer.from(
    `${credentials.appId}:${credentials.appSecret}`,
    "utf8",
  ).toString("base64");

  const data = await postForm(
    `${accounts}${DEVICE_AUTH_PATH}`,
    { client_id: credentials.appId, scope: SCOPES },
    { Authorization: `Basic ${basic}` },
  );

  const error = asString(data["error"]);
  if (error) {
    const detail = asString(data["error_description"]) || error;
    // 这一步失败几乎只有一个原因：appId / appSecret 填错，或者应用没开 device flow
    throw new AuthError(`申请设备码失败：${detail}`, "config");
  }

  const deviceCode = asString(data["device_code"]);
  if (!deviceCode) {
    throw new AuthError("飞书没有返回 device_code", "config");
  }

  const expiresIn = asNumber(data["expires_in"], 240);
  const interval = asNumber(data["interval"], 5);
  const verificationUri =
    asString(data["verification_uri_complete"]) ||
    asString(data["verification_uri"]);

  return {
    deviceCode,
    userCode: asString(data["user_code"]),
    verificationUri,
    expiresAt: Date.now() + expiresIn * 1000,
    intervalMs: interval * 1000,
  };
}

/**
 * 第二步：拿设备码换 token。
 *
 * 只轮询到 `deadline`，**不要在这里无限等**：`action` 只有 15 秒超时，
 * `config.validate` 有 30 秒，超了宿主会杀掉调用。
 */
export async function pollDeviceToken(
  credentials: Credentials,
  pending: PendingDevice,
  deadline: number,
): Promise<StoredToken> {
  const { open } = endpoints(credentials.brand);
  let intervalMs = pending.intervalMs;

  for (;;) {
    if (Date.now() >= Math.min(deadline, pending.expiresAt)) {
      throw new AuthError(
        Date.now() >= pending.expiresAt
          ? "设备码已过期，请重新点「开始授权」"
          : "还没等到授权完成。在浏览器里点完同意后，再点一次「检查授权」",
        Date.now() >= pending.expiresAt ? "expired" : "pending",
      );
    }

    const data = await postForm(`${open}${TOKEN_PATH}`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: pending.deviceCode,
      client_id: credentials.appId,
      client_secret: credentials.appSecret,
    });

    const error = asString(data["error"]);
    if (!error && asString(data["access_token"])) {
      return toStoredToken(data);
    }

    switch (error) {
      case "authorization_pending":
        break;
      case "slow_down":
        // 服务端明确要求放慢，照做——继续按原速会被拒
        intervalMs += 5_000;
        break;
      case "access_denied":
        throw new AuthError(
          asString(data["error_description"]) || "授权被拒绝",
          "denied",
        );
      case "expired_token":
      case "invalid_grant":
        throw new AuthError(
          asString(data["error_description"]) || "设备码已过期，请重新授权",
          "expired",
        );
      default:
        throw new AuthError(
          asString(data["error_description"]) || `未知错误：${error}`,
          "config",
        );
    }

    const wait = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
    if (wait <= 0) continue;
    await sleep(wait);
  }
}

function toStoredToken(data: Record<string, unknown>): StoredToken {
  const now = Date.now();
  const expiresIn = asNumber(data["expires_in"], 7200);
  const refreshToken = asString(data["refresh_token"]);
  // 没拿到 refresh_token 通常是 scope 里漏了 offline_access
  const refreshExpiresIn = refreshToken
    ? asNumber(data["refresh_token_expires_in"], 604_800)
    : expiresIn;

  return {
    accessToken: asString(data["access_token"]),
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    refreshExpiresAt: now + refreshExpiresIn * 1000,
    scope: asString(data["scope"]),
  };
}

/** 用 refresh_token 换新的 access_token。 */
export async function refreshToken(
  credentials: Credentials,
  stored: StoredToken,
): Promise<StoredToken> {
  if (!stored.refreshToken) {
    throw new AuthError("没有 refresh_token，需要重新授权", "expired");
  }
  if (Date.now() >= stored.refreshExpiresAt) {
    throw new AuthError("授权已过期，请重新点「开始授权」", "expired");
  }

  const { open } = endpoints(credentials.brand);
  const data = await postForm(`${open}${TOKEN_PATH}`, {
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: credentials.appId,
    client_secret: credentials.appSecret,
  });

  const error = asString(data["error"]);
  if (error || !asString(data["access_token"])) {
    throw new AuthError(
      asString(data["error_description"]) || `刷新 token 失败：${error}`,
      "expired",
    );
  }

  const next = toStoredToken(data);
  // 飞书不一定每次都下发新的 refresh_token，没给就沿用旧的
  if (!next.refreshToken) {
    next.refreshToken = stored.refreshToken;
    next.refreshExpiresAt = stored.refreshExpiresAt;
  }
  if (stored.userName) next.userName = stored.userName;
  return next;
}

/** 查授权身份，用来在设置面板上显示「已授权为 XXX」。 */
export async function fetchUserName(
  credentials: Credentials,
  accessToken: string,
): Promise<string> {
  const { open } = endpoints(credentials.brand);
  try {
    const response = await fetch(`${open}${USER_INFO_PATH}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await response.json()) as {
      data?: { name?: string; en_name?: string };
    };
    return data.data?.name ?? data.data?.en_name ?? "";
  } catch {
    // 拿不到名字不影响同步，别因此让授权失败
    return "";
  }
}

// ── token 持久化 ─────────────────────────────────────────────────────────

export function tokenPath(dataDir: string): string {
  return join(dataDir, "token.json");
}

export function loadToken(dataDir: string): StoredToken | null {
  try {
    const raw = readFileSync(tokenPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as StoredToken;
    if (!parsed.accessToken) return null;
    return parsed;
  } catch {
    // 文件不存在或坏了都当「没授权」，让用户重新走一遍
    return null;
  }
}

export function saveToken(dataDir: string, token: StoredToken): void {
  const path = tokenPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync 的 mode 只在新建文件时生效，已存在的文件要显式改
  chmodSync(path, 0o600);
}

/**
 * 设备码要落盘，**不能只存内存**。
 *
 * 「开始授权」与「检查授权」是两个独立的 `action`，插件启用之前它们各自跑在一个
 * 用完就回收的临时进程里（宿主契约 §7.3.1）。存模块级变量的话，「开始授权」返回
 * 的瞬间进程就没了，「检查授权」永远只会说「请先点开始授权」，用户根本走不完授权。
 */
export function pendingDevicePath(dataDir: string): string {
  return join(dataDir, "pending-device.json");
}

export function rememberPendingDevice(
  dataDir: string,
  device: PendingDevice,
): void {
  const path = pendingDevicePath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(device, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync 的 mode 只在新建文件时生效，已存在的文件要显式改
  chmodSync(path, 0o600);
}

/** 读出待授权的设备码。已过期的直接清掉——拿它去轮询只会拿到 expired。 */
export function takePendingDevice(dataDir: string): PendingDevice | null {
  let parsed: PendingDevice;
  try {
    parsed = JSON.parse(
      readFileSync(pendingDevicePath(dataDir), "utf8"),
    ) as PendingDevice;
  } catch {
    return null;
  }
  if (!parsed.deviceCode) return null;
  if (Date.now() >= parsed.expiresAt) {
    forgetPendingDevice(dataDir);
    return null;
  }
  return parsed;
}

/** 授权拿到 token 之后要清掉：设备码是一次性的，留着只会误导下一次判断。 */
export function forgetPendingDevice(dataDir: string): void {
  try {
    rmSync(pendingDevicePath(dataDir));
  } catch {
    // 本来就不存在，无事可做
  }
}

/**
 * 拿一个可用的 access_token，必要时自动刷新并落盘。
 *
 * 所有 API 调用都应该走它，不要自己读 token 文件。
 */
export async function ensureAccessToken(
  credentials: Credentials,
  dataDir: string,
): Promise<string> {
  const stored = loadToken(dataDir);
  if (!stored) {
    throw new AuthError("还没有授权，请在插件设置里点「开始授权」", "expired");
  }
  if (Date.now() < stored.expiresAt - REFRESH_SKEW_MS) {
    return stored.accessToken;
  }

  logger.info("access_token 即将过期，自动刷新", { code: "FEISHU_TOKEN_REFRESH" });
  const next = await refreshToken(credentials, stored);
  saveToken(dataDir, next);
  return next.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
