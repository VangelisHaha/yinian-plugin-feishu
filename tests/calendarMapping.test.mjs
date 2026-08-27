/**
 * 日程实例 → ExternalEvent 的映射测试。
 *
 * 钉住的都是「真机上出错很隐蔽、错了用户也说不清是哪一层」的点：
 *
 * - 日历用**秒**级时间戳，任务用毫秒。混了会把会议排到 1970 年或几万年后。
 * - 全天日程的结束日飞书给的已经是**右开**，再加一天会让日程凭空多占一天。
 * - `instance_view` 会为重复日程返回多个实例，`externalId` 必须带实例开始时间。
 * - 全天与定时必须互斥，混着传宿主会直接跳过并记契约违规。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  eventExternalId,
  isMeeting,
  nextDay,
  parseDate,
  parseSeconds,
  toDetails,
  toExternalEvent,
} from "../dist/feishu/calendarMapping.mjs";

const TIMED = {
  event_id: "evt_1",
  summary: "周会",
  start_time: { timestamp: "1755000000" },
  end_time: { timestamp: "1755003600" },
  free_busy_status: "busy",
  self_rsvp_status: "accept",
  app_link: "https://applink.feishu.cn/client/calendar/event/detail?xxx",
};

describe("时间解析", () => {
  it("秒级时间戳转成毫秒", () => {
    assert.equal(parseSeconds("1755000000"), 1755000000000);
  });

  it("飞书用 \"0\" 表示没有，不是 1970 年", () => {
    assert.equal(parseSeconds("0"), null);
    assert.equal(parseSeconds(""), null);
    assert.equal(parseSeconds(undefined), null);
  });

  it("只认 YYYY-MM-DD", () => {
    assert.equal(parseDate("2026-08-21"), "2026-08-21");
    assert.equal(parseDate("2026/08/21"), null);
    assert.equal(parseDate(""), null);
  });

  it("跨月加一天", () => {
    assert.equal(nextDay("2026-08-31"), "2026-09-01");
    assert.equal(nextDay("2026-12-31"), "2027-01-01");
  });
});

describe("externalId", () => {
  it("带上实例开始时间，重复日程的每一次才不会互相覆盖", () => {
    const first = eventExternalId(TIMED);
    const second = eventExternalId({
      ...TIMED,
      start_time: { timestamp: "1755604800" },
    });

    assert.equal(first, "evt_1@1755000000");
    assert.notEqual(first, second);
  });

  it("全天日程用日期做后缀", () => {
    assert.equal(
      eventExternalId({ event_id: "evt_2", start_time: { date: "2026-08-21" } }),
      "evt_2@2026-08-21",
    );
  });
});

describe("定时日程", () => {
  it("映射成 startAt / endAt，且不带全天字段", () => {
    const event = toExternalEvent(TIMED, {
      calendarExternalId: "cal_1",
      calendarName: "我的日历",
    });

    assert.equal(event.allDay, false);
    assert.equal(event.startAt, new Date(1755000000000).toISOString());
    assert.equal(event.endAt, new Date(1755003600000).toISOString());
    assert.equal(event.startDate, undefined);
    assert.equal(event.endDate, undefined);
    assert.equal(event.calendarExternalId, "cal_1");
    assert.equal(event.status, "active");
    assert.equal(event.busyStatus, "busy");
    assert.equal(event.responseStatus, "accepted");
    assert.ok(event.externalUrl.startsWith("https://"));
  });

  it("结束不晚于开始的直接丢掉，而不是造一条负时长事件", () => {
    assert.equal(
      toExternalEvent({
        ...TIMED,
        end_time: { timestamp: "1755000000" },
      }),
      null,
    );
  });

  it("没有时间的丢掉", () => {
    assert.equal(toExternalEvent({ event_id: "evt_x" }), null);
  });

  it("忙闲与回复状态按飞书取值翻译", () => {
    const free = toExternalEvent({
      ...TIMED,
      free_busy_status: "free",
      self_rsvp_status: "decline",
    });
    assert.equal(free.busyStatus, "free");
    assert.equal(free.responseStatus, "declined");

    const pending = toExternalEvent({ ...TIMED, self_rsvp_status: "needs_action" });
    assert.equal(pending.responseStatus, "needs_action");
  });

  it("取消的日程映射成 canceled 而不是丢掉", () => {
    const event = toExternalEvent({ ...TIMED, status: "cancelled" });
    assert.equal(event.status, "canceled");
  });
});

describe("全天日程", () => {
  it("结束日原样用：飞书给的已经是右开区间", () => {
    const event = toExternalEvent({
      event_id: "evt_allday",
      summary: "年假",
      start_time: { date: "2026-08-20" },
      end_time: { date: "2026-08-22" },
    });

    assert.equal(event.allDay, true);
    assert.equal(event.startDate, "2026-08-20");
    assert.equal(event.endDate, "2026-08-22");
    // 全天与定时互斥，混着传宿主会跳过这条
    assert.equal(event.startAt, undefined);
    assert.equal(event.endAt, undefined);
  });

  it("缺结束日时按只占一天补右开边界", () => {
    const event = toExternalEvent({
      event_id: "evt_allday2",
      start_time: { date: "2026-08-20" },
    });
    assert.equal(event.endDate, "2026-08-21");
  });
});

describe("会议信息", () => {
  const MEETING = {
    ...TIMED,
    vchat: { vc_type: "vc", meeting_url: "https://vc.feishu.cn/j/123456" },
    location: { name: "线上" },
    attendees: [{}, {}, {}],
  };

  it("认得出视频会议", () => {
    assert.equal(isMeeting(MEETING), true);
    assert.equal(isMeeting({ ...TIMED, vchat: { vc_type: "no_meeting" } }), false);
    assert.equal(isMeeting(TIMED), false);
  });

  it("会议链接进 details 且是 link 类型", () => {
    const details = toDetails(MEETING, "我的日历");
    const link = details.find((item) => item.label === "会议链接");

    assert.equal(link.kind, "link");
    assert.equal(link.value, "https://vc.feishu.cn/j/123456");
    assert.ok(details.some((item) => item.label === "地点"));
    assert.ok(details.some((item) => item.value === "3 人"));
  });

  it("非 http 的会议链接不当链接传，避免宿主降级成纯文本", () => {
    const details = toDetails({
      ...MEETING,
      vchat: { vc_type: "third_party", meeting_url: "tel:+8610000" },
    });
    assert.equal(
      details.find((item) => item.label === "会议链接"),
      undefined,
    );
  });

  it("已接受不写进 details，待回复才写", () => {
    assert.equal(
      toDetails(TIMED).find((item) => item.label === "我的回复"),
      undefined,
    );
    assert.equal(
      toDetails({ ...TIMED, self_rsvp_status: "needs_action" }).find(
        (item) => item.label === "我的回复",
      ).value,
      "待回复",
    );
  });

  it("details 条数远低于宿主的 20 条上限", () => {
    assert.ok(toDetails(MEETING, "我的日历").length <= 20);
  });
});
