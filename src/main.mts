import { handlers as agentTools } from "./handlers/tools.mjs";
/**
 * 飞书任务插件入口。
 *
 * 只做方法名到 handler 的映射。业务在 `handlers/`，飞书 API 细节在 `feishu/`。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { start } from "./sdk/index.mjs";
import * as calendarOverlay from "./handlers/calendarOverlay.mjs";
import * as calendars from "./handlers/calendars.mjs";
import * as config from "./handlers/config.mjs";
import * as notify from "./handlers/notify.mjs";
import * as sync from "./handlers/sync.mjs";

/** 版本只维护在 manifest 一处。 */
function readManifestVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "yinian-plugin.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}

start({
  version: readManifestVersion(),

  onInit: () => {
    // 进程重启后续上考勤的后台刷新。**只在缓存文件已存在时才动**——那说明用户
    // 此前显式启用过这个 provider；没有缓存就老实等第一次 calendarOverlay.list
    // （关着的时候宿主根本不会调它，那是唯一可靠的授权信号）
    calendarOverlay.resumeAttendance();
  },

  handlers: {
    ...agentTools,
    // sync.pull 按 request.resource 分派：task 走飞书任务，event 走飞书日历
    "sync.pull": sync.pull,
    "sync.push": sync.push,
    "notify.send": notify.send,
    "config.validate": config.validate,

    // 日历叠加层：把考勤画到日历上。默认关闭，用户在日历侧栏显式打开后才会被调到
    "calendarOverlay.list": calendarOverlay.list,

    // 授权三段式，见 handlers/config.mts 的说明
    "feishu.startAuthorization": config.startAuthorization,
    "feishu.checkAuthorization": config.checkAuthorization,
    "feishu.authorizationStatus": config.authorizationStatus,

    "feishu.listCalendars": calendars.listCalendars,
    "feishu.testNotification": notify.testNotification,
  },
});
