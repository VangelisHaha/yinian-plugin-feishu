/**
 * 通知卡片（飞书消息卡片 schema 2.0）。
 *
 * ## 一套骨架，三种形态
 *
 * 任务、排期块、日程在卡片上**不是三种布局**，是同一套骨架填不同内容：
 * 彩色标题栏（事项标题 + 一句话说明什么时候）→ 明细网格 → 「在一念中打开」。
 * 分成三套模板的话，「哪个字段放哪」「空值怎么处理」这些规则要写三遍，
 * 而它们本来只该有一份。类型差异只体现在两处：标题栏颜色与副标题措辞。
 *
 * ## 内容全部来自宿主
 *
 * `notification.detail`（契约 §8.2）里的 `fields` 已经是格式化好的字符串，
 * **这里不解析、不换算、不判断全天与跨天**。宿主已经在四个视图和 AI 清单里处理过
 * 那些边界，插件再算一遍必然会分叉，而分叉的表现是飞书卡片上的时间和一念里
 * 对不上——用户没有任何办法知道哪个是对的。
 *
 * ## 排版规则
 *
 * 短字段两两并排（`column_set` 等分双列），长字段独占一行。全部塞成单列会让
 * 「优先级：高」这种两个字的值后面拖一条长空白；全部并排又会把备注挤成两个窄条。
 *
 * ## 为什么不放动作按钮
 *
 * manifest 里 `supportsActions: false`，所以宿主不会下发 `actions`，卡片上也就没有
 * 「完成」「推迟」。飞书卡片的交互按钮要回调一个公网地址，插件跑在用户本机、
 * 收不到——声明支持等于给用户一排点不动的按钮。唯一的按钮是打开一念，
 * 那是个链接，不需要回调。
 */

import type { Notification, NotificationDetail } from "../sdk/index.mjs";

/** 值超过这个长度就独占一行。约等于两列布局里一列放得下的字数。 */
const INLINE_VALUE_LIMIT = 16;

/** 标题栏配色。飞书的 `template` 枚举，不是任意色值。 */
type HeaderTemplate =
  | "red"
  | "orange"
  | "turquoise"
  | "indigo"
  | "blue"
  | "grey";

interface CardElement {
  tag: string;
  [key: string]: unknown;
}

/**
 * 标题栏颜色：**先看紧急度，再看类型**。
 *
 * 逾期与高优先级压过类型——用户扫一眼消息列表时，「这条已经过点了」比
 * 「这是个日程还是任务」重要得多。
 */
export function headerTemplate(notification: Notification): HeaderTemplate {
  const detail = notification.detail;
  if (detail?.overdue) return "red";
  if (detail?.priority === "high") return "orange";
  switch (notification.kind) {
    case "task_due":
      return "orange";
    case "schedule_start":
      return "turquoise";
    case "event_start":
      return "indigo";
    case "sync_failed":
      return "grey";
    default:
      return "blue";
  }
}

/**
 * 副标题：段名 + 「还有多久」。
 *
 * `body` 就是宿主算好的那句「排期开始：15 分钟后」，直接用。段名（「中台开发」）
 * 放在它前面：同一个任务的三段排期只有段名能区分，少了它三条通知长得一模一样。
 */
export function cardSubtitle(notification: Notification): string {
  const parts: string[] = [];
  const label = notification.detail?.label?.trim();
  if (label) parts.push(label);
  const body = notification.body?.trim();
  if (body) parts.push(body);
  return parts.join(" · ");
}

/** 标题：优先用明细里的事项本体标题，它不含段名（段名已经在副标题里）。 */
export function cardTitle(notification: Notification): string {
  return notification.detail?.subject?.trim() || notification.title;
}

function markdown(content: string): CardElement {
  return { tag: "markdown", content };
}

/** 一格：小灰标签在上，值在下。 */
function cell(label: string, value: string): CardElement {
  return markdown(`<font color='grey'>${label}</font>\n${value}`);
}

function column(elements: CardElement[]): Record<string, unknown> {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    vertical_align: "top",
    elements,
  };
}

/**
 * 明细网格。短字段两两并排，长字段独占整行。
 *
 * 奇数个短字段时最后一格会留空——这是对的，补一个空占位比让它拉满整行更整齐。
 */
export function detailElements(detail: NotificationDetail): CardElement[] {
  const fields = (detail.fields ?? []).filter(
    (field) => field.label.trim() && field.value.trim(),
  );
  if (fields.length === 0) return [];

  const elements: CardElement[] = [];
  let pending: { label: string; value: string } | null = null;

  const flushPending = () => {
    if (!pending) return;
    // 落单的短字段：单独一格而不是拉满，视觉上与上面的双列对齐
    elements.push({
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "default",
      columns: [column([cell(pending.label, pending.value)]), column([])],
    });
    pending = null;
  };

  for (const field of fields) {
    const long = field.value.length > INLINE_VALUE_LIMIT;
    if (long) {
      flushPending();
      elements.push(cell(field.label, field.value));
      continue;
    }
    if (!pending) {
      pending = field;
      continue;
    }
    elements.push({
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "default",
      columns: [
        column([cell(pending.label, pending.value)]),
        column([cell(field.label, field.value)]),
      ],
    });
    pending = null;
  }
  flushPending();
  return elements;
}

/**
 * 「在一念中打开」按钮。
 *
 * 移动端 url 刻意留空：一念目前只有桌面端，让手机上点了跳一个打不开的 scheme
 * 比没有按钮更糟。飞书会回退到 `url`，所以 `pc_url` 与 `url` 都填。
 */
function openButton(deepLink: string): CardElement {
  return {
    tag: "action",
    layout: "default",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "在一念中打开" },
        type: "default",
        size: "small",
        multi_url: { url: deepLink, pc_url: deepLink },
      },
    ],
  };
}

/**
 * 把一条通知渲染成卡片。
 *
 * 没有 `detail` 时（`kind: custom`，比如设置页的测试通知）降级成标题 + 一段正文：
 * 那种通知没有宿主实体，硬凑出明细区只会留一片空白。
 */
export function buildCard(notification: Notification): Record<string, unknown> {
  const detail = notification.detail;
  const elements: CardElement[] = [];

  if (detail) {
    const grid = detailElements(detail);
    elements.push(...grid);
    if (detail.deepLink) {
      if (grid.length > 0) elements.push({ tag: "hr" });
      elements.push(openButton(detail.deepLink));
    }
  } else if (notification.body?.trim()) {
    elements.push(markdown(notification.body.trim()));
  }

  // 一个元素都没有时飞书会拒收（body.elements 不能为空）
  if (elements.length === 0) {
    elements.push(markdown("（没有更多信息）"));
  }

  const subtitle = detail ? cardSubtitle(notification) : "";

  return {
    schema: "2.0",
    config: {
      // compact 让卡片在 PC 上不铺满整个会话宽度，一条提醒不需要那么大版面
      width_mode: "compact",
      update_multi: true,
    },
    header: {
      title: { tag: "plain_text", content: cardTitle(notification) },
      ...(subtitle
        ? { subtitle: { tag: "plain_text", content: subtitle } }
        : {}),
      template: headerTemplate(notification),
    },
    body: { elements },
  };
}
