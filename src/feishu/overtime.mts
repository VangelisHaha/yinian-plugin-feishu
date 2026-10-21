/**
 * 加班审批（「加班申请」）→ 每天的加班时段。
 *
 * 端点 `GET /open-apis/approval/v4/instances/initiated`（查本人发起的审批），**user_access_token**，
 * scope `approval:instance:read`——单独一项能力「飞书加班审批」，要勾选并重新授权。
 *
 * 规则与个人看板（nikou-screen `feishu-overtime.mjs`）一致：
 *
 * - 只认定义名等于配置值（默认「加班申请」）的实例；
 * - **审批中也算**（`1` 进行中 / `2` 已通过），被拒、撤回、终止（`3` / `4` / `5`）不算——
 *   提了申请就是要加班，日历上该提前看到「加」；
 * - 时段取摘要里的「开始时间」「结束时间」（`2026年10月11日 10:00`），跨天的申请不认；
 * - 同一天多条取时段最晚那条。
 *
 * 考勤接口那一侧的「休息日打了卡 = 加班」照旧；两者都算「加」。
 */
import { logger } from "../sdk/index.mjs";
import type { Credentials } from "./auth.mjs";
import { apiRequest } from "./request.mjs";

const INITIATED_PATH = "/open-apis/approval/v4/instances/initiated";

/** 一页 100 条。没有 definition_code 时最多翻 5 页（一页里混着各种审批），有了只翻 1 页。 */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

const EXCLUDED_STATUSES = new Set(["3", "4", "5", "REJECTED", "CANCELED", "DELETED", "TERMINATED"]);

export const DEFAULT_OVERTIME_APPROVAL_NAME = "加班申请";

export interface OvertimeApproval {
  date: string;
  /** 申请的开始 / 结束时刻 `HH:mm`。 */
  start: string;
  end: string;
  /** `1` 审批中 / `2` 已通过。 */
  status: string;
}

interface InitiatedInstance {
  definition_name?: string;
  definition_code?: string;
  instance_code?: string;
  instance_status?: string | number;
  summaries?: Array<{ key?: string; value?: string }>;
}

interface InitiatedResponse {
  instances?: InitiatedInstance[];
  has_more?: boolean;
  page_token?: string;
}

function pad(value: string | number): string {
  return String(value).padStart(2, "0");
}

/** `2026年10月11日 10:00` → 日期键 + 时刻。认不出返回 null。 */
export function parseChineseDateTime(value: string | undefined): { date: string; time: string } | null {
  const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  return {
    date: `${match[1]}-${pad(match[2]!)}-${pad(match[3]!)}`,
    time: `${pad(match[4]!)}:${match[5]}`,
  };
}

/** 审批列表 → 每天的加班时段。纯函数，单测直接喂摘要。 */
export function foldOvertimeApprovals(
  instances: InitiatedInstance[],
  approvalName: string = DEFAULT_OVERTIME_APPROVAL_NAME,
): Map<string, OvertimeApproval> {
  const byDate = new Map<string, OvertimeApproval>();
  for (const instance of instances) {
    if (instance.definition_name !== approvalName) continue;
    const status = String(instance.instance_status ?? "");
    if (EXCLUDED_STATUSES.has(status)) continue;
    const values: Record<string, string> = {};
    for (const field of instance.summaries ?? []) {
      if (field.key && field.value != null && values[field.key] == null) values[field.key] = field.value;
    }
    const start = parseChineseDateTime(values["开始时间"]);
    const end = parseChineseDateTime(values["结束时间"]);
    if (!start || !end || start.date !== end.date) continue;
    const candidate: OvertimeApproval = { date: start.date, start: start.time, end: end.time, status };
    const previous = byDate.get(start.date);
    if (!previous || `${candidate.start}-${candidate.end}` > `${previous.start}-${previous.end}`) {
      byDate.set(start.date, candidate);
    }
  }
  return byDate;
}

/**
 * 拉本人发起的审批并折成每天的加班时段。失败只记日志、返回空——加班审批是锦上添花，
 * 拉不到就退回「休息日打卡 = 加班」那条老判据，不该连带考勤一起失败。
 */
export interface OvertimeFetchResult {
  approvals: Map<string, OvertimeApproval>;
  /** 认到的「加班申请」审批定义 code。下次带上它翻页就很少，不用在所有审批里捞。 */
  definitionCode: string | undefined;
}

export async function fetchOvertimeApprovals(options: {
  credentials: Credentials;
  dataDir: string;
  approvalName?: string;
  /** 发起时间下界（秒）。申请总是先于加班发起，往回看一段就够。 */
  sinceSeconds: number;
  /** 发起时间上界（秒），缺省现在 + 1 天。 */
  untilSeconds?: number;
  /** 已知的审批定义 code：带上就只查这一种审批。 */
  definitionCode?: string;
}): Promise<OvertimeFetchResult | null> {
  const instances: InitiatedInstance[] = [];
  let pageToken = "";
  try {
    const maxPages = options.definitionCode ? 1 : MAX_PAGES;
    for (let page = 0; page < maxPages; page += 1) {
      const query: Record<string, string> = {
        page_size: String(PAGE_SIZE),
        locale: "zh-CN",
        // 飞书要求两个时间戳要么都给、要么都不给（只给起点会直接报 -500），2026-10-16 真实撞到
        start_timestamp: String(options.sinceSeconds),
        end_timestamp: String(options.untilSeconds ?? Math.floor(Date.now() / 1000) + 86_400),
      };
      if (pageToken) query["page_token"] = pageToken;
      if (options.definitionCode) query["definition_code"] = options.definitionCode;
      const data = await apiRequest<InitiatedResponse>({
        credentials: options.credentials,
        dataDir: options.dataDir,
        method: "GET",
        path: INITIATED_PATH,
        query,
      });
      instances.push(...(data.instances ?? []));
      pageToken = data.has_more && data.page_token ? data.page_token : "";
      if (!pageToken) break;
    }
  } catch (error) {
    logger.warn("加班审批拉取失败，退回按打卡判加班", {
      code: "FEISHU_OVERTIME_FETCH_FAILED",
      detail: {
        message: error instanceof Error ? error.message : String(error),
        hint: "要在开放平台申请 approval:instance:read，并在插件设置里勾「飞书加班审批」后重新授权",
      },
    });
    // 失败返回 null 而不是空表：调用方据此**保留**已有的「加」，不能把一次网络抖动当成「申请都没了」
    return null;
  }
  const name = options.approvalName || DEFAULT_OVERTIME_APPROVAL_NAME;
  return {
    approvals: foldOvertimeApprovals(instances, name),
    definitionCode:
      instances.find((item) => item.definition_name === name)?.definition_code ??
      options.definitionCode,
  };
}
