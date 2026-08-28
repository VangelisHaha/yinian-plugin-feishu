/**
 * 能力守卫：没勾选或没授权的能力，一律明确报错。
 *
 * ## 为什么要报错而不是静默跳过
 *
 * 「勾了同步实例但没授权」是一种配置矛盾，静默返回空结果的后果是**同步看起来一直在
 * 跑、但永远拉不到东西**，而实例卡片上一切正常。用户唯一能看到的线索是数据没变，
 * 这种问题排查起来毫无头绪。抛出来的话，实例卡片会显示错误原因，一句话就说清了。
 *
 * 反过来，实例设置里那些「只同步日历 / 不同步已完成」的开关是**用户明确表达的意图**，
 * 那种才该静默跳过（`sync.mts` 里的 `syncTasks === false`）。
 *
 * ## 与断路器的关系
 *
 * 这里抛的是普通 `Error`，宿主会按失败计数。这是有意的：授权缺失不会自己好转，
 * 让它把断路器烧开、停下无谓的轮询，比每分钟撞一次强。用户补完授权后重新启用实例
 * 即可，`docs/11` §4.5。
 */

import { loadToken } from "./auth.mjs";
import {
  capabilitiesFrom,
  capabilityLabel,
  isAuthorized,
  type Capability,
} from "./capability.mjs";

/**
 * 确认某项能力可用，不可用就抛。
 *
 * 两种不可用分开说：没勾选要引导去勾，勾了没授权要引导去授权。混成一句
 * 「未授权」会让刚勾完的用户反复点「开始授权」——而那时真正缺的是保存配置。
 */
export function requireCapability(
  config: Record<string, unknown>,
  capability: Capability,
  dataDir: string,
): void {
  const name = capabilityLabel(capability);
  if (!capabilitiesFrom(config).includes(capability)) {
    throw new Error(
      `没有启用「${name}」。请在插件设置的「要用哪些能力」里勾上它，然后点「开始授权」`,
    );
  }

  const token = loadToken(dataDir);
  if (!token || Date.now() >= token.refreshExpiresAt) {
    throw new Error(`「${name}」还没有授权。请在插件设置里点「开始授权」`);
  }
  if (!isAuthorized(capability, token.scope)) {
    // 有 token 但缺这一项的 scope：几乎总是「新勾了能力却没重新授权」
    throw new Error(
      `「${name}」缺少授权范围。勾选的能力变了要重新授权一次——请点「开始授权」`,
    );
  }
}

/**
 * 某项能力是不是现在就能用。**不抛**，给「有就多拉一点、没有就算了」的场景用。
 *
 * 当前只有会议：它是日历同步的补充，不是独立的同步实例。没授权时把日历同步一起
 * 拖失败是不成比例的。
 */
export function hasCapability(
  config: Record<string, unknown>,
  capability: Capability,
  dataDir: string,
): boolean {
  if (!capabilitiesFrom(config).includes(capability)) return false;
  const token = loadToken(dataDir);
  if (!token || Date.now() >= token.refreshExpiresAt) return false;
  return isAuthorized(capability, token.scope);
}
