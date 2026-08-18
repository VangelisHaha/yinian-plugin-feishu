/**
 * 扩展点的业务类型。
 *
 * 与一念仓库 `docs/11-plugin-architecture.md` §5（同步）、§7（设置面板）、
 * §8（出站事件）逐字段对应。字段名就是线格式，**不要在这里改驼峰/下划线**——
 * 宿主按线格式反序列化，改了名就是契约违规（`PLUGIN_CONTRACT_VIOLATION`）。
 */

import type { ConfigScope } from "./protocol.mjs";

// ── 同步 ─────────────────────────────────────────────────────────────────

export type SyncResource = "task" | "event";

export type SyncActionKind =
  | "list"
  | "get"
  | "create"
  | "update"
  | "complete"
  | "reopen"
  | "cancel"
  | "delete";

export type SyncField =
  | "title"
  | "notes"
  | "due_at"
  | "priority"
  | "schedule"
  | "subtasks"
  | "tags"
  | "recurrence";

export type ExternalStatus = "todo" | "doing" | "done" | "canceled";

export type ExternalPriority = "none" | "low" | "medium" | "high";

/**
 * 外部系统的一条记录。
 *
 * 两个容易踩的点：
 *
 * - `completedAt` **不知道就不要传**。传当前时间会让历史任务全部堆在同一秒，
 *   一念的「今日完成」会瞬间多出几百条（`nikou-screen` 踩过）。
 * - `remoteUpdatedAt` 尽量给。宿主的字段级冲突判定靠它，缺了就只能保守处理。
 */
export interface ExternalItem {
  /** 外部系统主键，同一 Integration 内必须唯一且稳定。 */
  externalId: string;
  externalUrl?: string;
  title: string;
  notes?: string;
  status?: ExternalStatus;
  priority?: ExternalPriority;
  /** RFC3339。Deadline 语义：最晚什么时候完成。 */
  dueAt?: string;
  dueTimezone?: string;
  estimateMinutes?: number;
  /** 真实完成时间。不知道就别传。 */
  completedAt?: string;
  recurrenceRule?: string;
  parentExternalId?: string;
  tags?: string[];
  /** 外部最后更新时间，RFC3339。 */
  remoteUpdatedAt?: string;
  /** 外部原始 JSON 全量。宿主会原样存下来，界面可以不展示。 */
  remoteData?: unknown;
}

export interface PullRequest {
  integrationId: string;
  traceId: string;
  resource: SyncResource;
  cursor?: string;
  /** RFC3339，增量下界。 */
  since?: string;
  /** 忽略游标做全量拉取。 */
  full: boolean;
}

export interface PullResult {
  items: ExternalItem[];
  cursor?: string;
  hasMore: boolean;
  /**
   * 外部已删除的 id。
   *
   * 宿主**不会**删本地任务，只把关联标成 `remote_deleted` 等人处理——
   * 外部删除不该静默带走本地数据。
   */
  deletedExternalIds?: string[];
}

export interface PushRequest {
  integrationId: string;
  traceId: string;
  resource: SyncResource;
  action: SyncActionKind;
  /** `create` 时为空。 */
  externalId?: string;
  item: ExternalItem;
  /** 本次变更涉及的字段，供你做最小化更新。状态类动作为空数组。 */
  changedFields?: SyncField[];
}

export interface PushResult {
  /**
   * `false` 表示你有意跳过（外部已经是目标状态）。
   *
   * 宿主视为成功且不重试，也不会开 ack 窗口——毕竟外部没被改动。
   */
  applied: boolean;
  externalId?: string;
  externalUrl?: string;
  remoteUpdatedAt?: string;
  remoteData?: unknown;
}

// ── 生命周期钩子 ─────────────────────────────────────────────────────────

export type HookTopic =
  | "task.created"
  | "task.updated"
  | "task.completed"
  | "task.reopened"
  | "task.canceled"
  | "task.deleted"
  | "event.created"
  | "event.updated"
  | "event.canceled"
  | "event.deleted"
  | "schedule_block.created"
  | "schedule_block.updated"
  | "schedule_block.deleted";

export type EntityKind = "task" | "event" | "schedule_block";

export interface EntityRef {
  type: EntityKind;
  id: string;
}

export interface HookEvent {
  /**
   * 发件箱记录 id。
   *
   * **必须按它做幂等**：投递保证是「至少一次」，重试与宿主重启都会让同一条事件
   * 再来一遍。把处理过的 id 存进 `host.setState`，别只放内存——进程随时会被重启。
   */
  outboxId: string;
  traceId: string;
  topic: HookTopic;
  /** 业务实际发生时间，不是派发时间。 */
  occurredAt: string;
  entity: EntityRef;
  payload: {
    /** 变更后的实体全量快照（线格式）。 */
    snapshot?: Record<string, unknown>;
    changedFields?: string[];
  };
}

export interface HookResult {
  ok: boolean;
  detail?: string;
}

// ── 通知渠道 ─────────────────────────────────────────────────────────────

export type NotificationKind =
  | "task_due"
  | "task_completed"
  | "schedule_start"
  | "event_start"
  | "sync_failed"
  | "custom";

export interface NotificationAction {
  id: string;
  label: string;
}

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  entity?: EntityRef;
  /** 只有 manifest 里声明了 `supportsActions` 的渠道才会收到。 */
  actions?: NotificationAction[];
}

export interface NotifyRequest {
  traceId: string;
  notification: Notification;
}

export interface NotifyResult {
  delivered: boolean;
  detail?: string;
}

// ── 设置面板 ─────────────────────────────────────────────────────────────

export type SettingsFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "duration"
  | "enum"
  | "multi-enum"
  | "action"
  | "group"
  | "note";

export interface SettingsFieldOption {
  value: unknown;
  label: string;
}

export interface SettingsField {
  /** `^[a-zA-Z][a-zA-Z0-9_]*$` */
  key: string;
  type: SettingsFieldType;
  label: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  /** 只支持一层判断。隐藏的字段不参与必填校验，也不提交。 */
  visibleWhen?: { field: string; equals: unknown };
  /** `secret` 落加密存储且永不回显。 */
  format?: "text" | "url" | "path" | "secret";
  placeholder?: string;
  maxLength?: number;
  pattern?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: "seconds" | "minutes";
  options?: SettingsFieldOption[];
  /** `host:tags` / `host:calendars` / `rpc:<自定义方法>` */
  optionsFrom?: string;
  maxItems?: number;
  /** `action` 必填：点按钮时调的自定义方法。 */
  rpc?: string;
  confirm?: string;
  /** `group` 必填。 */
  fields?: SettingsField[];
  /** `note` 必填。 */
  text?: string;
}

export interface SettingsSchema {
  scope: ConfigScope;
  fields: SettingsField[];
}

export interface ConfigValidateRequest {
  scope: ConfigScope;
  config: Record<string, unknown>;
}

export interface FieldError {
  /** 对应 schema 里的 `key`。省略则降级成整体错误提示。 */
  field?: string;
  message: string;
}

export interface ConfigValidateResult {
  ok: boolean;
  errors?: FieldError[];
}

/**
 * `action` 按钮的返回值，三个字段都可选。
 *
 * `openUrl` 只接受 http/https，宿主用系统浏览器打开——这是 OAuth 类插件把授权
 * 链接递到用户面前的唯一方式，插件自己画不了界面。
 */
export interface ActionResult {
  message?: string;
  openUrl?: string;
  /** 按 key 合并回表单。 */
  patch?: Record<string, unknown>;
}

/** `optionsFrom: "rpc:*"` 的返回值。 */
export interface OptionsResult {
  options: SettingsFieldOption[];
}
