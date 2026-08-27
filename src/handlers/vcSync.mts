/**
 * 临时 VC 会议同步。
 *
 * 本机进程只回答「此刻是否在会中」，飞书 VC API 提供会议 id 与真实起止时间。两者
 * 组合后使用 120 秒短租约：插件崩溃时占位不会永久显示为进行中，正常轮询则不断续期。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { logger } from "../sdk/index.mjs";
import type { ExternalEvent } from "../sdk/index.mjs";
import { FeishuVcClient, isLocalVcMeetingActive, type VcMeeting } from "../feishu/vc.mjs";

export const VC_CALENDAR_ID = "__feishu_vc__";
const LEASE_MS = 120_000;
const HOURLY_MS = 60 * 60_000;
const HISTORY_MS = 7 * 86_400_000;
const ACTIVE_LOOKBACK_MS = 8 * 60 * 60_000;

interface VcSession {
  externalId: string;
  sessionStart: string;
  lastDetectedAt: string;
  meetingId?: string;
  title?: string;
}

interface VcState {
  session?: VcSession;
  lastEndedSearchAt?: string;
  events: ExternalEvent[];
  meetingKeys: Record<string, string>;
}

export interface VcSyncDependencies {
  now?: () => Date;
  isActive?: () => Promise<boolean>;
  search?: (start: Date, end: Date) => Promise<Array<Record<string, unknown> & { id: string }>>;
  get?: (id: string) => Promise<VcMeeting | null>;
}

function statePath(dataDir: string, integrationId: string): string {
  const safe = integrationId.replace(/[^a-zA-Z0-9_-]/g, "") || "default";
  return join(dataDir, `vc-state-${safe}.json`);
}

function emptyState(): VcState {
  return { events: [], meetingKeys: {} };
}

export function loadVcState(dataDir: string, integrationId: string): VcState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(dataDir, integrationId), "utf8")) as Partial<VcState>;
    return {
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.lastEndedSearchAt ? { lastEndedSearchAt: parsed.lastEndedSearchAt } : {}),
      events: Array.isArray(parsed.events) ? parsed.events : [],
      meetingKeys:
        parsed.meetingKeys && typeof parsed.meetingKeys === "object"
          ? parsed.meetingKeys
          : {},
    };
  } catch {
    return emptyState();
  }
}

function saveVcState(dataDir: string, integrationId: string, state: VcState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath(dataDir, integrationId), `${JSON.stringify(state)}\n`, {
    mode: 0o600,
  });
}

export function meetingTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function meetingTitle(meeting: VcMeeting): string {
  return meeting.topic?.trim() || "临时视频会议";
}

function eventFromMeeting(
  meeting: VcMeeting,
  externalId: string,
  fallbackStart: number,
  fallbackEnd: number,
): ExternalEvent {
  const start = meetingTime(meeting.start_time) ?? fallbackStart;
  const rawEnd = meetingTime(meeting.end_time) ?? fallbackEnd;
  const end = Math.max(start + 1_000, rawEnd);
  return {
    externalId,
    calendarExternalId: VC_CALENDAR_ID,
    title: meetingTitle(meeting),
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    busyStatus: "busy",
    responseStatus: "accepted",
    remoteUpdatedAt: new Date(end).toISOString(),
    remoteData: { ...meeting, vcMeetingId: meeting.id },
    details: [{ label: "来源", value: "飞书临时会议" }],
  };
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function textOf(event: ExternalEvent): string {
  return `${event.externalUrl ?? ""} ${event.notes ?? ""} ${JSON.stringify(event.remoteData ?? {})}`;
}

/** 日历实例优先，按 meetingId → URL/会议号 → 标题与时间重叠去重。 */
export function sameMeeting(calendarEvent: ExternalEvent, vcEvent: ExternalEvent): boolean {
  const vcRaw = (vcEvent.remoteData ?? {}) as Record<string, unknown>;
  const meetingId = String(vcRaw["vcMeetingId"] ?? vcRaw["id"] ?? "").trim();
  const meetingNo = String(vcRaw["meeting_no"] ?? "").trim();
  const meetingUrl = String(vcRaw["meeting_url"] ?? "").trim();
  const calendarText = textOf(calendarEvent);
  if (meetingId && calendarText.includes(meetingId)) return true;
  if (meetingUrl && calendarText.includes(meetingUrl)) return true;
  if (meetingNo && calendarText.includes(meetingNo)) return true;

  const aStart = meetingTime(calendarEvent.startAt);
  const aEnd = meetingTime(calendarEvent.endAt);
  const bStart = meetingTime(vcEvent.startAt);
  const bEnd = meetingTime(vcEvent.endAt);
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  const titlesMatch = normalizeTitle(calendarEvent.title) === normalizeTitle(vcEvent.title);
  return titlesMatch && intervalsOverlap(aStart, aEnd, bStart, bEnd);
}

function chooseCurrentMeeting(meetings: VcMeeting[], session: VcSession, now: number): VcMeeting | null {
  if (session.meetingId) {
    const exact = meetings.find((meeting) => meeting.id === session.meetingId);
    if (exact) return exact;
  }
  const start = Date.parse(session.sessionStart);
  return (
    meetings
      .filter((meeting) => {
        const meetingStart = meetingTime(meeting.start_time) ?? start;
        const meetingEnd = meetingTime(meeting.end_time) ?? now + LEASE_MS;
        return intervalsOverlap(start - 10 * 60_000, now + LEASE_MS, meetingStart, meetingEnd);
      })
      .sort((a, b) => (meetingTime(b.start_time) ?? 0) - (meetingTime(a.start_time) ?? 0))[0] ?? null
  );
}

async function fetchMeetingDetails(
  summaries: Array<Record<string, unknown> & { id: string }>,
  get: (id: string) => Promise<VcMeeting | null>,
): Promise<VcMeeting[]> {
  const result: VcMeeting[] = [];
  for (const summary of summaries) {
    const detail = await get(summary.id);
    if (detail) result.push(detail);
  }
  return result;
}

export async function syncVcMeetings(options: {
  client: FeishuVcClient;
  dataDir: string;
  integrationId: string;
  traceId: string;
  regularEvents: ExternalEvent[];
  dependencies?: VcSyncDependencies;
}): Promise<{ events: ExternalEvent[]; deletedExternalIds: string[]; degraded: boolean }> {
  const { client, dataDir, integrationId, traceId, regularEvents } = options;
  const nowDate = options.dependencies?.now?.() ?? new Date();
  const now = nowDate.getTime();
  const isActive = options.dependencies?.isActive ?? isLocalVcMeetingActive;
  const search = options.dependencies?.search ?? ((start, end) => client.searchMeetings(start, end));
  const get = options.dependencies?.get ?? ((id) => client.getMeeting(id));
  const state = loadVcState(dataDir, integrationId);

  try {
    const active = await isActive();
    const wasActive = state.session !== undefined;
    if (active && !state.session) {
      const sessionStart = nowDate.toISOString();
      state.session = {
        externalId: `vc:local:${sessionStart}`,
        sessionStart,
        lastDetectedAt: sessionStart,
      };
    }

    const lastSearch = state.lastEndedSearchAt ? Date.parse(state.lastEndedSearchAt) : 0;
    const shouldSearch = active || wasActive !== active || !Number.isFinite(lastSearch) || now - lastSearch >= HOURLY_MS;
    let details: VcMeeting[] = [];
    if (shouldSearch) {
      const from = state.session
        ? Math.min(Date.parse(state.session.sessionStart) - 10 * 60_000, now - ACTIVE_LOOKBACK_MS)
        : now - HISTORY_MS;
      details = await fetchMeetingDetails(
        await search(new Date(from), new Date(now + LEASE_MS)),
        get,
      );
      state.lastEndedSearchAt = nowDate.toISOString();
    }

    if (state.session) {
      const session = state.session;
      const current = chooseCurrentMeeting(details, session, now);
      if (current) {
        session.meetingId = current.id;
        session.title = meetingTitle(current);
        state.meetingKeys[current.id] = session.externalId;
      }
      if (active) {
        session.lastDetectedAt = nowDate.toISOString();
        const meeting: VcMeeting = current ?? {
          id: session.meetingId ?? session.externalId,
          topic: session.title ?? "正在开会 · 临时",
          start_time: session.sessionStart,
          status: 2,
        };
        const event = eventFromMeeting(
          meeting,
          session.externalId,
          Date.parse(session.sessionStart),
          now + LEASE_MS,
        );
        event.endAt = new Date(now + LEASE_MS).toISOString();
        state.events = upsertEvent(state.events, event);
      } else {
        const fallbackEnd = Date.parse(session.lastDetectedAt);
        const ended = current ?? {
          id: session.meetingId ?? session.externalId,
          topic: session.title ?? "临时视频会议",
          start_time: session.sessionStart,
          end_time: new Date(fallbackEnd).toISOString(),
          status: 3,
        };
        state.events = upsertEvent(
          state.events,
          eventFromMeeting(ended, session.externalId, Date.parse(session.sessionStart), fallbackEnd),
        );
        delete state.session;
      }
    }

    for (const meeting of details) {
      if (meeting.status !== 3 && meetingTime(meeting.end_time) === null) continue;
      const start = meetingTime(meeting.start_time);
      const end = meetingTime(meeting.end_time);
      if (start === null || end === null) continue;
      const externalId = state.meetingKeys[meeting.id] ?? `vc:${meeting.id}`;
      state.meetingKeys[meeting.id] = externalId;
      state.events = upsertEvent(state.events, eventFromMeeting(meeting, externalId, start, end));
    }

    // 只保留同步窗口内历史，避免状态文件无限增长。
    state.events = state.events.filter((event) => (meetingTime(event.endAt) ?? now) >= now - HISTORY_MS);
    const deletedExternalIds: string[] = [];
    const visible = state.events.filter((vcEvent) => {
      if (regularEvents.some((calendarEvent) => sameMeeting(calendarEvent, vcEvent))) {
        deletedExternalIds.push(vcEvent.externalId);
        return false;
      }
      return true;
    });
    saveVcState(dataDir, integrationId, state);
    logger.info(`VC 同步完成：${visible.length} 条临时会议${active ? "，本机正在会中" : ""}`, {
      traceId,
      code: "FEISHU_VC_PULL_DONE",
    });
    return { events: visible, deletedExternalIds, degraded: false };
  } catch (error) {
    // VC 是附加能力：失败时保留最近一次成功快照，绝不把普通日历一起拖挂或误删。
    logger.warn(`VC 同步降级：${error instanceof Error ? error.message : String(error)}`, {
      traceId,
      code: "FEISHU_VC_DEGRADED",
    });
    return { events: state.events, deletedExternalIds: [], degraded: true };
  }
}

function upsertEvent(events: ExternalEvent[], event: ExternalEvent): ExternalEvent[] {
  return [...events.filter((item) => item.externalId !== event.externalId), event];
}
