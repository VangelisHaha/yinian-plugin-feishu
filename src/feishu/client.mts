/**
 * 飞书任务 API v2 客户端。
 *
 * 端点与参数逐字段核对过飞书官方 CLI 的实现：
 * - 列表：`GET /open-apis/task/v2/tasks?type=my_tasks&user_id_type=open_id&page_size=50&completed=`
 * - 详情：`GET /open-apis/task/v2/tasks/{guid}?user_id_type=open_id`
 * - 回写：`PATCH /open-apis/task/v2/tasks/{guid}`，体是
 *   `{ task: { ... }, update_fields: [...] }`——**漏了 `update_fields` 那次修改不生效**
 */

import { logger } from "../sdk/index.mjs";
import {
  AuthError,
  ensureAccessToken,
  type Credentials,
} from "./auth.mjs";

const OPEN_BASE = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

/** 列表接口的单页上限。 */
const PAGE_SIZE = 50;

/** 飞书任务对象里我们会读的字段。其余字段原样塞进 remoteData。 */
export interface FeishuTask {
  guid: string;
  summary?: string;
  description?: string;
  url?: string;
  /** 毫秒时间戳**字符串**。飞书所有时间都是这个形态。 */
  created_at?: string;
  completed_at?: string;
  due?: FeishuTime;
  start?: FeishuTime;
  parent_task_guid?: string;
  [key: string]: unknown;
}

export interface FeishuTime {
  /** 毫秒时间戳字符串。 */
  timestamp?: string;
  is_all_day?: boolean;
}

export interface TaskPage {
  items: FeishuTask[];
  pageToken: string;
  hasMore: boolean;
}

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

export class FeishuClient {
  #credentials: Credentials;
  #dataDir: string;

  constructor(credentials: Credentials, dataDir: string) {
    this.#credentials = credentials;
    this.#dataDir = dataDir;
  }

  get #base(): string {
    return OPEN_BASE[this.#credentials.brand] ?? OPEN_BASE.feishu;
  }

  async #request<T>(
    method: "GET" | "PATCH",
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const token = await ensureAccessToken(this.#credentials, this.#dataDir);
    const url = new URL(`${this.#base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
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

    if (payload.code !== 0) {
      const code = payload.code ?? response.status;
      // 99991663 / 99991661 这类是 token 失效。走到这里说明刷新也没救回来，
      // 报成不可重试，让用户去重新授权——重试只会一直撞同一堵墙
      const tokenExpired = code === 99991663 || code === 99991661 || response.status === 401;
      if (tokenExpired) {
        throw new AuthError(
          `飞书授权已失效（code ${code}），请重新授权`,
          "expired",
        );
      }
      throw new FeishuApiError(
        `飞书接口报错 ${code}：${payload.msg ?? "未知错误"}`,
        code,
        // 限流与服务端错误可以重试
        code === 99991400 || response.status === 429 || response.status >= 500,
      );
    }

    return payload.data as T;
  }

  /** 列「我的任务」的一页。`completed` 分开拉：接口不会在一次结果里混两种状态。 */
  async listMyTasks(options: {
    completed: boolean;
    pageToken?: string;
  }): Promise<TaskPage> {
    const query: Record<string, string> = {
      type: "my_tasks",
      user_id_type: "open_id",
      page_size: String(PAGE_SIZE),
      completed: options.completed ? "true" : "false",
    };
    if (options.pageToken) query["page_token"] = options.pageToken;

    const data = await this.#request<{
      items?: FeishuTask[];
      page_token?: string;
      has_more?: boolean;
    }>("GET", "/open-apis/task/v2/tasks", { query });

    return {
      items: Array.isArray(data?.items) ? data.items : [],
      pageToken: data?.page_token ?? "",
      hasMore: data?.has_more === true,
    };
  }

  /**
   * 取单条详情。
   *
   * 列表接口**不给 `start` 与 `completed_at`**，跨天任务的开始时间与历史任务的
   * 真实完成时间只能从这里拿。
   */
  async getTask(guid: string): Promise<FeishuTask | null> {
    const data = await this.#request<{ task?: FeishuTask }>(
      "GET",
      `/open-apis/task/v2/tasks/${encodeURIComponent(guid)}`,
      { query: { user_id_type: "open_id" } },
    );
    return data?.task ?? null;
  }

  /** 标记完成。`completedAtMs` 传本地记录的真实完成时间，别用当前时间。 */
  async complete(guid: string, completedAtMs: number): Promise<FeishuTask | null> {
    return this.#patch(guid, { completed_at: String(completedAtMs) }, [
      "completed_at",
    ]);
  }

  /** 重开。飞书用 `completed_at = "0"` 表示未完成。 */
  async reopen(guid: string): Promise<FeishuTask | null> {
    return this.#patch(guid, { completed_at: "0" }, ["completed_at"]);
  }

  /** 改字段。`fields` 的键必须与 `updateFields` 一一对应。 */
  async update(
    guid: string,
    fields: Record<string, unknown>,
    updateFields: string[],
  ): Promise<FeishuTask | null> {
    if (updateFields.length === 0) return null;
    return this.#patch(guid, fields, updateFields);
  }

  async #patch(
    guid: string,
    task: Record<string, unknown>,
    updateFields: string[],
  ): Promise<FeishuTask | null> {
    logger.debug(`PATCH ${guid} ${updateFields.join(",")}`);
    const data = await this.#request<{ task?: FeishuTask }>(
      "PATCH",
      `/open-apis/task/v2/tasks/${encodeURIComponent(guid)}`,
      {
        query: { user_id_type: "open_id" },
        // update_fields 漏了的话飞书会接受请求但什么都不改
        body: { task, update_fields: updateFields },
      },
    );
    return data?.task ?? null;
  }
}
