/**
 * 飞书开放平台的请求层。
 *
 * 任务、日历、消息三块 API 的差别只在路径与载荷，**鉴权、错误码归类、重试判定
 * 完全一样**，所以统一收在这里。加新 API 时不要再抄一份 fetch。
 *
 * 两个不能改的判定：
 *
 * - `99991663` / `99991661` / HTTP 401 是 token 失效。走到这里说明自动刷新也没救回来，
 *   必须报成 `AuthError`（不可重试）——重试只会一直撞同一堵墙，还会把断路器烧开。
 * - 限流（`99991400`）、429 与 5xx 是时机问题，报成可重试。
 */

import { AuthError, ensureAccessToken, type Credentials } from "./auth.mjs";

/** 国内版与国际版的开放平台域名。选错会一直报「应用不存在」。 */
export const OPEN_BASE = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

/** API 调用失败。`retryable` 决定宿主要不要重试。 */
export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

export function openBase(credentials: Credentials): string {
  return OPEN_BASE[credentials.brand] ?? OPEN_BASE.feishu;
}

export interface RequestOptions {
  credentials: Credentials;
  dataDir: string;
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /**
   * `true` 时不把业务错误码抛成异常，而是把整个响应体交回调用方。
   *
   * 给日历的 `instance_view` 用：它的 `193103`（超 40 天）与 `193104`（超 1000 实例）
   * 不是失败，是「请求拆小一点再来」的信号，调用方要能看到 code 自己决定怎么拆。
   */
  rawErrors?: boolean;
}

export interface RawResponse<T> {
  code: number;
  msg: string;
  data: T | null;
}

/** 发一个已鉴权的请求，返回 `data` 部分。 */
export async function apiRequest<T>(options: RequestOptions): Promise<T> {
  const raw = await apiRequestRaw<T>(options);
  if (raw.code !== 0) {
    throw toApiError(raw.code, raw.msg);
  }
  return raw.data as T;
}

/** 同上，但把 `code` / `msg` 一起交回。业务错误由调用方判断。 */
export async function apiRequestRaw<T>(
  options: RequestOptions,
): Promise<RawResponse<T>> {
  const token = await ensureAccessToken(options.credentials, options.dataDir);
  const url = new URL(`${openBase(options.credentials)}${options.path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    // 网络问题是时机问题，值得重试
    throw new FeishuApiError(
      `请求飞书失败：${error instanceof Error ? error.message : String(error)}`,
      -1,
      true,
    );
  }

  const text = await response.text();
  let payload: { code?: number; msg?: string; data?: T };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new FeishuApiError(
      `飞书返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`,
      response.status,
      // 5xx 大概是临时故障，4xx 不是
      response.status >= 500,
    );
  }

  const code = payload.code ?? (response.ok ? 0 : response.status);
  // token 失效无论调用方要不要 rawErrors 都得抛：让它继续拆分/重试毫无意义
  if (isTokenExpired(code, response.status)) {
    throw new AuthError(`飞书授权已失效（code ${code}），请重新授权`, "expired");
  }
  if (code !== 0 && !options.rawErrors) {
    throw toApiError(code, payload.msg ?? "未知错误", response.status);
  }

  return {
    code,
    msg: payload.msg ?? "",
    data: payload.data ?? null,
  };
}

function isTokenExpired(code: number, httpStatus: number): boolean {
  return code === 99991663 || code === 99991661 || httpStatus === 401;
}

export function toApiError(
  code: number,
  msg: string,
  httpStatus = 0,
): FeishuApiError {
  return new FeishuApiError(
    `飞书接口报错 ${code}：${msg || "未知错误"}`,
    code,
    // 限流与服务端错误可以重试
    code === 99991400 || httpStatus === 429 || httpStatus >= 500,
  );
}
