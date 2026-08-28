/**
 * 能力与授权范围。
 *
 * ## 为什么要分能力
 *
 * 这个插件干三件事：同步飞书任务、同步日历与会议、把一念的提醒发到飞书。原来的做法
 * 是把三件事需要的 scope 拼成一个常量一次全要——只想用通知的人也得把任务读写权限
 * 一并交出去。**授权范围应该等于用户真的要用的功能**，所以改成用户勾选能力、
 * 按勾选拼 scope。
 *
 * ## 通知不在这里
 *
 * 通知走**应用身份**（`tenant_access_token`，见 `tenant.mts`），压根不需要用户 OAuth
 * 授权，所以它不是这里的一项。它需要的是开放平台上的 `im:message:send_as_bot`——
 * 那是应用配置，不是用户授权。这也顺带修掉了原来「机器人消息看起来是我自己发的」
 * 那个问题（`im:message.send_as_user` 是以用户身份发言）。
 *
 * ## 加勾选之后必须重新授权
 *
 * 飞书的 device flow 每次授权都按**这一次请求的 scope** 发 token，不做增量合并。
 * 所以用户新勾一项能力后，旧 token 里没有对应 scope，必须再走一次授权。
 * [`missingScopes`] 就是为了把这件事说清楚——不说的话，表现是「勾了但同步不动，
 * 也没有任何提示」。
 */

/** 一项可以单独勾选的能力。 */
export type Capability = "tasks" | "calendar" | "meetings";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "tasks",
  "calendar",
  "meetings",
];

/** 每项能力要的 scope。`offline_access` 不在这里，它是所有能力共用的前提。 */
const CAPABILITY_SCOPES: Record<Capability, readonly string[]> = {
  tasks: ["task:task:read", "task:task:write"],
  calendar: ["calendar:calendar:read", "calendar:calendar.event:read"],
  meetings: [
    "vc:meeting.search:read",
    "vc:meeting:readonly",
    "vc:meeting.meetingevent:read",
  ],
};

/**
 * 拿 `refresh_token` 的前提。缺了它每 2 小时就要重新授权一次。
 *
 * 只在真的要 user token 时才加：一项能力都没勾（只用通知）时不该申请任何 scope。
 */
const OFFLINE_ACCESS = "offline_access";

/** 界面上的名字。错误信息里也用它，用户看到的措辞要和勾选框一致。 */
const CAPABILITY_LABELS: Record<Capability, string> = {
  tasks: "飞书任务同步",
  calendar: "飞书日历同步",
  meetings: "飞书会议同步",
};

export function capabilityLabel(capability: Capability): string {
  return CAPABILITY_LABELS[capability];
}

function isCapability(value: unknown): value is Capability {
  return ALL_CAPABILITIES.includes(value as Capability);
}

/**
 * 从配置里读用户勾了哪些能力。
 *
 * 认不出的值直接丢掉（配置文件是可能被手改的），顺序按 [`ALL_CAPABILITIES`] 归一化，
 * 这样 scope 串对同一组勾选是稳定的——不稳定的话每次保存配置都像换了授权范围。
 */
export function capabilitiesFrom(
  config: Record<string, unknown>,
): Capability[] {
  const raw = config["capabilities"];
  const values = Array.isArray(raw) ? raw : [];
  const picked = new Set(values.filter(isCapability));
  return ALL_CAPABILITIES.filter((capability) => picked.has(capability));
}

/** 这组能力要申请的 scope 串（空格分隔）。一项都没勾时返回空串。 */
export function scopesFor(capabilities: readonly Capability[]): string {
  if (capabilities.length === 0) return "";
  const scopes = new Set<string>();
  for (const capability of capabilities) {
    for (const scope of CAPABILITY_SCOPES[capability]) scopes.add(scope);
  }
  scopes.add(OFFLINE_ACCESS);
  return [...scopes].join(" ");
}

/**
 * 已授权的 scope 串里缺哪些。
 *
 * `granted` 来自 `StoredToken.scope`——**飞书回传的是这次授权实际给到的范围**，
 * 不是我们请求的那份，所以它才是判据。用户在同意页上取消勾了某一项时，
 * 只有这里能发现。
 */
export function missingScopes(
  capability: Capability,
  granted: string,
): string[] {
  const owned = new Set(granted.split(/\s+/).filter(Boolean));
  return CAPABILITY_SCOPES[capability].filter((scope) => !owned.has(scope));
}

/** 这项能力是不是已经拿到全部所需 scope。 */
export function isAuthorized(capability: Capability, granted: string): boolean {
  return missingScopes(capability, granted).length === 0;
}
