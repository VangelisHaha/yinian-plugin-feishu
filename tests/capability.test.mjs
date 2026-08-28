/**
 * 按能力最小授权。
 *
 * 这块的错误全都是**静默的**，所以必须由测试守住：
 *
 * - scope 拼错 → 授权页少一项权限，同步不动且没有报错；
 * - 「已授权」判断用了我们请求的 scope 而不是飞书回传的 → 用户在同意页上取消勾选后，
 *   插件仍以为一切正常；
 * - 一项都没勾时还申请 scope → 只想用通知的人被迫交出任务读写权限，
 *   而这正是这次改动要消除的东西。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_CAPABILITIES,
  capabilitiesFrom,
  capabilityLabel,
  isAuthorized,
  missingScopes,
  scopesFor,
} from "../dist/feishu/capability.mjs";

describe("勾选解析", () => {
  it("认不出的值直接丢掉（配置文件是可能被手改的）", () => {
    assert.deepEqual(
      capabilitiesFrom({ capabilities: ["tasks", "什么", 42, null] }),
      ["tasks"],
    );
  });

  it("缺省是一个都不勾：最小授权的起点", () => {
    assert.deepEqual(capabilitiesFrom({}), []);
    assert.deepEqual(capabilitiesFrom({ capabilities: "tasks" }), []);
  });

  it("顺序归一化，同一组勾选产出稳定的 scope 串", () => {
    const a = scopesFor(capabilitiesFrom({ capabilities: ["meetings", "tasks"] }));
    const b = scopesFor(capabilitiesFrom({ capabilities: ["tasks", "meetings"] }));
    assert.equal(a, b);
  });

  it("去重", () => {
    assert.deepEqual(capabilitiesFrom({ capabilities: ["tasks", "tasks"] }), [
      "tasks",
    ]);
  });
});

describe("scope 拼装", () => {
  it("一项都没勾时不申请任何 scope", () => {
    assert.equal(scopesFor([]), "");
  });

  it("只勾任务时不含日历与会议权限", () => {
    const scopes = scopesFor(["tasks"]).split(" ");
    assert.ok(scopes.includes("task:task:read"));
    assert.ok(scopes.includes("task:task:write"));
    assert.equal(
      scopes.some((scope) => scope.startsWith("calendar:")),
      false,
    );
    assert.equal(
      scopes.some((scope) => scope.startsWith("vc:")),
      false,
    );
  });

  it("有任何能力就带 offline_access，否则每 2 小时要重新授权", () => {
    for (const capability of ALL_CAPABILITIES) {
      assert.ok(
        scopesFor([capability]).split(" ").includes("offline_access"),
        `${capability} 少了 offline_access`,
      );
    }
  });

  it("全勾时是三组的并集，不重复", () => {
    const scopes = scopesFor(ALL_CAPABILITIES).split(" ");
    assert.equal(new Set(scopes).size, scopes.length, "有重复 scope");
    assert.equal(scopes.length, 2 + 2 + 3 + 1);
  });
});

describe("授权判定", () => {
  it("判据是飞书回传的 scope，缺哪个说哪个", () => {
    assert.deepEqual(missingScopes("tasks", "task:task:read offline_access"), [
      "task:task:write",
    ]);
    assert.equal(isAuthorized("tasks", "task:task:read"), false);
    assert.equal(
      isAuthorized("tasks", "task:task:read task:task:write"),
      true,
    );
  });

  it("空 scope 串一律未授权", () => {
    for (const capability of ALL_CAPABILITIES) {
      assert.equal(isAuthorized(capability, ""), false);
    }
  });

  it("多余的 scope 不影响判定", () => {
    assert.equal(
      isAuthorized("calendar", scopesFor(ALL_CAPABILITIES)),
      true,
    );
  });

  it("每项能力都有中文名，错误信息里要用它", () => {
    for (const capability of ALL_CAPABILITIES) {
      assert.match(capabilityLabel(capability), /飞书/);
    }
  });
});
