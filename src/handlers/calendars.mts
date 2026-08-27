/**
 * 设置面板里「同步哪些日历」的选项来源（`optionsFrom: "rpc:feishu.listCalendars"`）。
 *
 * 独立成一个 handler 而不是塞进 `config.mts`：那里是授权三段式，混进来只会让
 * 两件不相关的事互相干扰。
 *
 * 超时只有 15 秒（契约 §4.5 的自定义方法），所以这里**只列日历、不碰日程**。
 */

import { context, logger } from "../sdk/index.mjs";
import type { OptionsResult } from "../sdk/index.mjs";
import { FeishuCalendarClient } from "../feishu/calendar.mjs";
import { configOf, credentialsFrom } from "../feishu/pluginConfig.mjs";

/** 日历类型的人话。资源日历（会议室）也会出现在列表里，得让人认出来别选。 */
const TYPE_LABEL: Record<string, string> = {
  primary: "我的日历",
  shared: "共享",
  google: "Google",
  resource: "会议室",
  exchange: "Exchange",
};

export async function listCalendars(params: {
  config?: Record<string, unknown>;
}): Promise<OptionsResult> {
  const config = params.config ?? configOf();
  const api = new FeishuCalendarClient(
    credentialsFrom(config),
    context().dataDir,
  );

  try {
    const [calendars, primaryId] = await Promise.all([
      api.listCalendars(),
      api.primaryCalendarId().catch(() => ""),
    ]);

    return {
      options: calendars.map((item) => {
        const kind =
          item.calendarId === primaryId
            ? TYPE_LABEL["primary"]
            : TYPE_LABEL[item.type];
        return {
          value: item.calendarId,
          label: kind ? `${item.name}（${kind}）` : item.name,
        };
      }),
    };
  } catch (error) {
    // 返回空列表而不是抛错：抛了面板上只会显示一句「加载失败」，
    // 用户不知道是没授权还是没权限，日志里才有真相
    logger.warn(
      `列日历失败：${error instanceof Error ? error.message : String(error)}`,
      { code: "FEISHU_CAL_LIST_FAILED" },
    );
    return { options: [] };
  }
}
