/**
 * Device Flow 与 API 错误映射的测试。
 *
 * 用替换 `globalThis.fetch` 的方式驱动，不发真实请求。重点覆盖那些「真机上很难
 * 复现、出错又很隐蔽」的分支：轮询中的 `authorization_pending` / `slow_down`、
 * token 失效与可重试判定。
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  AuthError,
  loadToken,
  pollDeviceToken,
  refreshToken,
  requestDeviceCode,
  saveToken,
} from "../dist/feishu/auth.mjs";
import { FeishuApiError, FeishuClient } from "../dist/feishu/client.mjs";

const CREDENTIALS = { appId: "cli_test", appSecret: "secret", brand: "feishu" };
const originalFetch = globalThis.fetch;
const dirs = [];

/** 按调用顺序依次返回预设响应。 */
function mockFetch(responses) {
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === "function") return next();
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body ?? {}),
      json: async () => next.body ?? {},
    };
  };
  return calls;
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "yinian-feishu-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("申请设备码", () => {
  it("带 Basic 认证与 offline_access", async () => {
    const calls = mockFetch([
      {
        body: {
          device_code: "dc-1",
          user_code: "ABCD-1234",
          verification_uri_complete: "https://accounts.feishu.cn/x?code=ABCD",
          expires_in: 300,
          interval: 5,
        },
      },
    ]);

    const device = await requestDeviceCode(CREDENTIALS);

    assert.equal(device.deviceCode, "dc-1");
    assert.equal(device.userCode, "ABCD-1234");
    assert.equal(device.intervalMs, 5000);
    assert.ok(device.expiresAt > Date.now());

    const [call] = calls;
    assert.match(call.url, /accounts\.feishu\.cn\/oauth\/v1\/device_authorization/);
    const basic = Buffer.from("cli_test:secret").toString("base64");
    assert.equal(call.init.headers.Authorization, `Basic ${basic}`);
    // 没有 offline_access 就拿不到 refresh_token，每 2 小时都要重新授权
    assert.match(call.init.body, /offline_access/);
    assert.match(call.init.body, /client_id=cli_test/);
  });

  it("国际版走 larksuite 端点", async () => {
    const calls = mockFetch([{ body: { device_code: "dc-1" } }]);
    await requestDeviceCode({ ...CREDENTIALS, brand: "lark" });
    assert.match(calls[0].url, /accounts\.larksuite\.com/);
  });

  it("凭据错误归类为配置问题", async () => {
    mockFetch([
      { status: 400, body: { error: "invalid_client", error_description: "app not found" } },
    ]);
    await assert.rejects(
      () => requestDeviceCode(CREDENTIALS),
      (error) => error instanceof AuthError && error.kind === "config",
    );
  });

  it("网络故障归类为网络问题", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await assert.rejects(
      () => requestDeviceCode(CREDENTIALS),
      (error) => error instanceof AuthError && error.kind === "network",
    );
  });
});

describe("轮询换 token", () => {
  const pending = {
    deviceCode: "dc-1",
    userCode: "ABCD",
    verificationUri: "https://example.com",
    expiresAt: Date.now() + 300_000,
    intervalMs: 10,
  };

  it("pending 之后拿到 token", async () => {
    mockFetch([
      { body: { error: "authorization_pending" } },
      { body: { error: "authorization_pending" } },
      {
        body: {
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: "task:task:read",
        },
      },
    ]);

    const token = await pollDeviceToken(CREDENTIALS, pending, Date.now() + 5_000);

    assert.equal(token.accessToken, "at-1");
    assert.equal(token.refreshToken, "rt-1");
    assert.ok(token.expiresAt > Date.now());
    assert.ok(token.refreshExpiresAt > token.expiresAt);
  });

  it("slow_down 会放慢而不是失败", async () => {
    const calls = mockFetch([
      { body: { error: "slow_down" } },
      { body: { access_token: "at-1", refresh_token: "rt-1" } },
    ]);

    const token = await pollDeviceToken(CREDENTIALS, pending, Date.now() + 20_000);
    assert.equal(token.accessToken, "at-1");
    assert.equal(calls.length, 2, "收到 slow_down 要继续轮询");
  });

  it("用户拒绝时明确报出来", async () => {
    mockFetch([{ body: { error: "access_denied", error_description: "用户拒绝" } }]);
    await assert.rejects(
      () => pollDeviceToken(CREDENTIALS, pending, Date.now() + 5_000),
      (error) => error instanceof AuthError && error.kind === "denied",
    );
  });

  it("设备码过期要求重新授权", async () => {
    mockFetch([{ body: { error: "expired_token" } }]);
    await assert.rejects(
      () => pollDeviceToken(CREDENTIALS, pending, Date.now() + 5_000),
      (error) => error instanceof AuthError && error.kind === "expired",
    );
  });

  it("预算用完时报「还没等到」而不是报错", async () => {
    // action 只有 15 秒，等不到是常态，不该当成失败
    mockFetch([{ body: { error: "authorization_pending" } }]);
    await assert.rejects(
      () => pollDeviceToken(CREDENTIALS, pending, Date.now() - 1),
      (error) => error instanceof AuthError && error.kind === "pending",
    );
  });

  it("没有 offline_access 时也能用，只是没有 refresh_token", async () => {
    mockFetch([{ body: { access_token: "at-1", expires_in: 7200 } }]);
    const token = await pollDeviceToken(CREDENTIALS, pending, Date.now() + 5_000);
    assert.equal(token.refreshToken, "");
    assert.equal(
      token.refreshExpiresAt,
      token.expiresAt,
      "没有 refresh_token 时，凭据寿命就等于 access_token 的寿命",
    );
  });
});

describe("刷新 token", () => {
  it("飞书没下发新 refresh_token 时沿用旧的", async () => {
    mockFetch([{ body: { access_token: "at-2", expires_in: 7200 } }]);
    const stored = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 600_000,
      scope: "",
      userName: "张三",
    };

    const next = await refreshToken(CREDENTIALS, stored);

    assert.equal(next.accessToken, "at-2");
    assert.equal(next.refreshToken, "rt-1", "丢掉旧的会导致下次刷新失败");
    assert.equal(next.refreshExpiresAt, stored.refreshExpiresAt);
    assert.equal(next.userName, "张三", "授权身份要保留");
  });

  it("refresh_token 过期直接要求重新授权", async () => {
    mockFetch([{ body: { access_token: "at-2" } }]);
    await assert.rejects(
      () =>
        refreshToken(CREDENTIALS, {
          accessToken: "at-1",
          refreshToken: "rt-1",
          expiresAt: 0,
          refreshExpiresAt: Date.now() - 1,
          scope: "",
        }),
      (error) => error instanceof AuthError && error.kind === "expired",
    );
  });
});

describe("token 持久化", () => {
  it("以 0600 落盘并可读回", () => {
    const dir = tempDir();
    const token = {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 7200_000,
      refreshExpiresAt: Date.now() + 604800_000,
      scope: "task:task:read",
    };

    saveToken(dir, token);

    const mode = statSync(join(dir, "token.json")).mode & 0o777;
    assert.equal(mode, 0o600, "凭据文件不能让同机其他用户读到");
    assert.deepEqual(loadToken(dir), token);
  });

  it("文件坏了当作没授权", () => {
    const dir = tempDir();
    saveToken(dir, { accessToken: "at-1" });
    // 手工截断成非法 JSON
    const path = join(dir, "token.json");
    writeFileSync(path, readFileSync(path, "utf8").slice(0, 5));
    assert.equal(loadToken(dir), null);
  });
});

describe("API 错误映射", () => {
  function client(dir) {
    saveToken(dir, {
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 604800_000,
      scope: "",
    });
    return new FeishuClient(CREDENTIALS, dir);
  }

  it("token 失效报成需要重新授权", async () => {
    const dir = tempDir();
    const api = client(dir);
    mockFetch([{ body: { code: 99991663, msg: "invalid access token" } }]);

    await assert.rejects(
      () => api.listMyTasks({ completed: false }),
      // 报成可重试会让宿主一直撞同一堵墙
      (error) => error instanceof AuthError && error.kind === "expired",
    );
  });

  it("限流与 5xx 判为可重试", async () => {
    const dir = tempDir();
    const api = client(dir);
    mockFetch([{ status: 500, body: { code: 1, msg: "internal" } }]);

    await assert.rejects(
      () => api.listMyTasks({ completed: false }),
      (error) => error instanceof FeishuApiError && error.retryable === true,
    );
  });

  it("业务错误判为不可重试", async () => {
    const dir = tempDir();
    const api = client(dir);
    mockFetch([{ body: { code: 1470403, msg: "no permission" } }]);

    await assert.rejects(
      () => api.listMyTasks({ completed: false }),
      (error) => error instanceof FeishuApiError && error.retryable === false,
    );
  });

  it("列表请求带上契约要求的参数", async () => {
    const dir = tempDir();
    const api = client(dir);
    const calls = mockFetch([
      { body: { code: 0, data: { items: [{ guid: "g1" }], has_more: false } } },
    ]);

    const page = await api.listMyTasks({ completed: true });

    assert.equal(page.items.length, 1);
    assert.equal(page.hasMore, false);
    const url = calls[0].url;
    assert.match(url, /type=my_tasks/);
    assert.match(url, /user_id_type=open_id/);
    assert.match(url, /completed=true/);
    assert.equal(calls[0].init.headers.Authorization, "Bearer at-1");
  });

  it("回写必须带 update_fields", async () => {
    const dir = tempDir();
    const api = client(dir);
    const calls = mockFetch([{ body: { code: 0, data: { task: { guid: "g1" } } } }]);

    await api.complete("g1", 1_786_674_600_000);

    const body = JSON.parse(calls[0].init.body);
    // 漏了 update_fields 飞书会接受请求但什么都不改
    assert.deepEqual(body.update_fields, ["completed_at"]);
    assert.equal(body.task.completed_at, "1786674600000");
    assert.equal(calls[0].init.method, "PATCH");
  });

  it("重开用零值表示未完成", async () => {
    const dir = tempDir();
    const api = client(dir);
    const calls = mockFetch([{ body: { code: 0, data: { task: { guid: "g1" } } } }]);

    await api.reopen("g1");

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.task.completed_at, "0");
  });

  it("没有可改字段时不发请求", async () => {
    const dir = tempDir();
    const api = client(dir);
    const calls = mockFetch([{ body: { code: 0 } }]);

    assert.equal(await api.update("g1", {}, []), null);
    assert.equal(calls.length, 0, "空 PATCH 是无谓的往返");
  });
});
