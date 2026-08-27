import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { FeishuVcClient, processOutputHasVcMeeting } from "../dist/feishu/vc.mjs";
import {
  loadVcState,
  sameMeeting,
  syncVcMeetings,
} from "../dist/handlers/vcSync.mjs";

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "yinian-vc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function deps({ now, active, meetings = [], fail = false }) {
  return {
    now: () => new Date(now),
    isActive: async () => active,
    search: async () => {
      if (fail) throw new Error("缺少 vc scope");
      return meetings.map(({ id }) => ({ id }));
    },
    get: async (id) => meetings.find((item) => item.id === id) ?? null,
  };
}

async function sync(dir, dependencies, regularEvents = []) {
  return syncVcMeetings({
    client: {},
    dataDir: dir,
    integrationId: "int-1",
    traceId: "trace",
    regularEvents,
    dependencies,
  });
}

describe("VC 本机进程检测", () => {
  it("只识别飞书会议子进程", () => {
    assert.equal(processOutputHasVcMeeting("/Applications/Feishu.app/iron_meeting_123 --x"), true);
    assert.equal(processOutputHasVcMeeting("node meeting-live.mjs\n/Applications/Feishu.app/main"), false);
  });
});

describe("VC 搜索分页", () => {
  it("按 page_token 拉完并保持查询窗口", async () => {
    const calls = [];
    const client = new FeishuVcClient(
      { appId: "a", appSecret: "s", brand: "feishu" },
      "/tmp",
      async (options) => {
        calls.push(options);
        return calls.length === 1
          ? { meeting_list: [{ id: "m1" }], has_more: true, page_token: "next" }
          : { meeting_list: [{ id: "m2" }], has_more: false };
      },
    );
    const result = await client.searchMeetings(
      new Date("2026-08-27T00:00:00Z"),
      new Date("2026-08-27T02:00:00Z"),
    );
    assert.deepEqual(result.map(({ id }) => id), ["m1", "m2"]);
    assert.equal(calls[0].query.page_size, "30");
    assert.equal(calls[1].query.page_token, "next");
    assert.equal(
      calls[0].body.meeting_filter.start_time.end_time,
      "2026-08-27T02:00:00.000Z",
    );
  });
});

describe("VC 短租约与恢复", () => {
  it("索引延迟时先建 local 稳定键，每轮续期", async () => {
    const dir = tempDir();
    const first = await sync(dir, deps({ now: "2026-08-27T01:00:00Z", active: true }));
    assert.equal(first.events.length, 1);
    assert.match(first.events[0].externalId, /^vc:local:/);
    assert.equal(first.events[0].endAt, "2026-08-27T01:02:00.000Z");

    const second = await sync(dir, deps({ now: "2026-08-27T01:01:00Z", active: true }));
    assert.equal(second.events[0].externalId, first.events[0].externalId);
    assert.equal(second.events[0].endAt, "2026-08-27T01:03:00.000Z");
  });

  it("后续拿到 meetingId 仍沿用 local 键，重启读状态也不重复", async () => {
    const dir = tempDir();
    const first = await sync(dir, deps({ now: "2026-08-27T01:00:00Z", active: true }));
    const meeting = {
      id: "m-1",
      topic: "临时评审",
      status: 2,
      start_time: "2026-08-27T01:00:10Z",
    };
    const second = await sync(
      dir,
      deps({ now: "2026-08-27T01:01:00Z", active: true, meetings: [meeting] }),
    );
    assert.equal(second.events[0].externalId, first.events[0].externalId);
    assert.equal(loadVcState(dir, "int-1").meetingKeys["m-1"], first.events[0].externalId);
  });

  it("离会优先写飞书真实结束时间，没有时用最后检测时间", async () => {
    const dir = tempDir();
    await sync(dir, deps({ now: "2026-08-27T01:00:00Z", active: true }));
    const ended = await sync(
      dir,
      deps({
        now: "2026-08-27T01:10:00Z",
        active: false,
        meetings: [{
          id: "m-2",
          topic: "临时会",
          status: 3,
          start_time: "2026-08-27T01:00:00Z",
          end_time: "2026-08-27T01:08:30Z",
        }],
      }),
    );
    assert.equal(ended.events[0].endAt, "2026-08-27T01:08:30.000Z");
    assert.equal(loadVcState(dir, "int-1").session, undefined);
  });

  it("VC 查询失败保留上次成功快照且不报删除", async () => {
    const dir = tempDir();
    const good = await sync(dir, deps({ now: "2026-08-27T01:00:00Z", active: true }));
    const degraded = await sync(
      dir,
      deps({ now: "2026-08-27T01:01:00Z", active: true, fail: true }),
    );
    assert.equal(degraded.degraded, true);
    assert.deepEqual(degraded.deletedExternalIds, []);
    assert.equal(degraded.events[0].externalId, good.events[0].externalId);
  });
});

describe("VC 与排期日历三层去重", () => {
  const vc = {
    externalId: "vc:m-1",
    title: "项目周会",
    startAt: "2026-08-27T01:00:00Z",
    endAt: "2026-08-27T02:00:00Z",
    remoteData: { vcMeetingId: "m-1", meeting_no: "123456789" },
  };

  it("优先按 meetingId，其次会议号", () => {
    assert.equal(sameMeeting({ ...vc, externalId: "cal", remoteData: { meeting_id: "m-1" } }, vc), true);
    assert.equal(sameMeeting({ ...vc, externalId: "cal", notes: "会议号 123456789" }, vc), true);
  });

  it("无关系字段时按同标题与时间重叠", () => {
    assert.equal(sameMeeting({ ...vc, externalId: "cal", remoteData: {} }, vc), true);
    assert.equal(sameMeeting({ ...vc, externalId: "cal", title: "别的会", remoteData: {} }, vc), false);
  });
});
