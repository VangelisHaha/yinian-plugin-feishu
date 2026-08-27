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
import { type Credentials } from "./auth.mjs";
import { apiRequest, FeishuApiError } from "./request.mjs";

// 鉴权、错误码归类与重试判定统一在 request.mts，这里只管任务 API 的路径与载荷。
// 老代码从 client.mjs import 过 FeishuApiError，继续导出，别让调用方跟着改
export { FeishuApiError };

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

/** API 调用失败的类型定义在 `request.mts`，这里只做任务 API 的薄封装。 */
export class FeishuClient {
  #credentials: Credentials;
  #dataDir: string;

  constructor(credentials: Credentials, dataDir: string) {
    this.#credentials = credentials;
    this.#dataDir = dataDir;
  }

  #request<T>(
    method: "GET" | "PATCH",
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    return apiRequest<T>({
      credentials: this.#credentials,
      dataDir: this.#dataDir,
      method,
      path,
      ...(options.query ? { query: options.query } : {}),
      ...(options.body === undefined ? {} : { body: options.body }),
    });
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
