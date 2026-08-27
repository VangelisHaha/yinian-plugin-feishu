/** 飞书视频会议 API 与本机入会进程检测。 */

import type { Credentials } from "./auth.mjs";
import { apiRequest } from "./request.mjs";
import type { RequestOptions } from "./request.mjs";
import { listProcessCommands } from "../util/command.mjs";

const MAX_SEARCH_PAGES = 40;
const PAGE_SIZE = 30;

export interface VcMeeting {
  id: string;
  topic?: string;
  status?: number;
  start_time?: string;
  end_time?: string;
  meeting_no?: string;
  meeting_url?: string;
  [key: string]: unknown;
}

interface SearchResponse {
  meeting_list?: Array<{ id?: string } & Record<string, unknown>>;
  items?: Array<{ id?: string } & Record<string, unknown>>;
  page_token?: string;
  has_more?: boolean;
}

interface MeetingResponse {
  meeting?: VcMeeting;
}

export function processOutputHasVcMeeting(output: string): boolean {
  return output
    .split("\n")
    .some((line) => /(?:^|\/)iron_meeting_[^\s/]+/i.test(line));
}

export async function isLocalVcMeetingActive(): Promise<boolean> {
  return processOutputHasVcMeeting(await listProcessCommands());
}

export class FeishuVcClient {
  constructor(
    private readonly credentials: Credentials,
    private readonly dataDir: string,
    private readonly request: <T>(options: RequestOptions) => Promise<T> = apiRequest,
  ) {}

  async getMeeting(id: string): Promise<VcMeeting | null> {
    const data = await this.request<MeetingResponse>({
      credentials: this.credentials,
      dataDir: this.dataDir,
      method: "GET",
      path: `/open-apis/vc/v1/meetings/${encodeURIComponent(id)}`,
      query: { with_participants: "false", query_mode: "0" },
    });
    return data.meeting ?? null;
  }

  async searchMeetings(
    startAt: Date,
    endAt: Date,
  ): Promise<Array<Record<string, unknown> & { id: string }>> {
    const meetings: Array<Record<string, unknown> & { id: string }> = [];
    let pageToken = "";

    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const data = await this.request<SearchResponse>({
        credentials: this.credentials,
        dataDir: this.dataDir,
        method: "POST",
        path: "/open-apis/vc/v1/meetings/search",
        query: {
          page_size: String(PAGE_SIZE),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
        body: {
          meeting_filter: {
            start_time: {
              start_time: startAt.toISOString(),
              end_time: endAt.toISOString(),
            },
          },
        },
      });
      const items = data.meeting_list ?? data.items ?? [];
      for (const item of items) {
        if (typeof item.id === "string" && item.id !== "") {
          meetings.push({ ...item, id: item.id });
        }
      }
      if (!data.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return meetings;
  }
}
