# AGENTS.md — yinian-plugin-feishu

[安时（Nuncta）](https://github.com/VangelisHaha/nikou-agenda)飞书插件：任务同步（双向）、日历会议同步（pull-only）、考勤叠加层（只读）、通知渠道（出站）。

- 中文回复，中文注释与文档。改完必须 `npm run verify`（build + doctor + 测试）全绿。
- **零运行时依赖**，HTTP 用内置 `fetch`。`src/sdk/` 是官方模板副本，**不要在这里改**，去模板仓库改再同步。
- 契约（manifest、RPC、权限、错误码）以安时主仓库的《插件架构》文档为准，不以本仓库 SDK 为准。
- 四个扩展点各有边界：event 同步是 pull-only，**不要实现 push**；`calendarOverlay.list` **一行网络请求都不许有**，只读缓存；`notify.send` 载荷里没有 `config`，通知配置必须放插件级。
- 配置一律走 `feishu/pluginConfig.mts` 的 `configOf`，不要直接读 `context().config`。
- 时间：任务用毫秒、日历用秒；删除判定、`update_fields`、`completed_at` 的细节见代码注释。
- 考勤角标是「环」不是文字；`tone` 是语义档位不是颜色；`scheduled` 与 `absent` 必须分开。
- 发布：`yinian-plugin.json` 与 `package.json` 的 `version` 同步 → `npm run pack:zip` → Git tag 必须与 manifest `version` 完全一致 → 索引仓库 `yinian-plugins` 加/留一条。
