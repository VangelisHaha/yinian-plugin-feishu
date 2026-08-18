# yinian-plugin-feishu

把飞书「我的任务」同步进 [一念（Yinian）](https://github.com/VangelisHaha/nikou-agenda)，完成与重开双向回写。

**不依赖 `lark-cli`**，也不需要回调地址：填 App ID 与 App Secret，在浏览器点一次同意就好（OAuth 2.0 Device Flow）。

## 准备

1. 去[飞书开放平台](https://open.feishu.cn/app)建一个**自建应用**。
2. 开启**设备码流程**（Device Flow）。
3. 申请权限：`task:task:read`、`task:task:write`、`offline_access`。

   `offline_access` 不能省——没有它拿不到 `refresh_token`，每 2 小时就要重新授权一次。

国际版（Lark）也支持，在设置里把「版本」切成 Lark 即可。两个版本的账号体系是分开的，选错会一直报「应用不存在」。

## 安装

```bash
npm install
npm run verify     # build + doctor + 测试
npm run pack:zip   # 产出 release/yinian-feishu-v<版本>.zip
```

在一念里：设置 → 插件 → 打开总开关 → 从 zip 安装 → 启用。

启用时会走一次授权：填好凭据后点「开始授权」，浏览器打开飞书授权页，确认用户码并同意，然后点「检查授权」或直接点启用（会自动等一会儿）。

## 同步范围与语义

| 项 | 行为 |
|---|---|
| 拉什么 | 飞书里**指派给你的任务**（「我负责的」），未完成与已完成各拉一遍 |
| 状态 | 在未完成列表里 → `todo`；在已完成列表里 → `done`。同时出现时**以已完成为准** |
| 截止时间 | 飞书的 `due`。全天任务折成当地那一天的 23:59:59（一念的 `dueAt` 是 deadline，映射成零点会让当天任务整天显示逾期） |
| 完成时间 | 从任务详情取真实 `completed_at`。**取不到就不填**，绝不用当前时间——那会把历史任务的完成时间全改成今天 |
| 估时 | 详情里有 `start` 且与 `due` 同日时，按两者间隔估。跨天不估：那是日历跨度不是工作量 |
| 回写 | 完成、重开、改标题/描述/截止时间 |
| 飞书没有的概念 | 优先级、标签、取消状态。宿主不会下发这些字段；真收到 `cancel` 会按完成处理 |
| 删除 | **不上报**。飞书列表不区分「任务被删」与「任务被移出我的名下」，误报会让一念标记一堆假的「外部已删除」 |

## 为什么要补详情

列表接口不给两个关键字段：

- `completed_at` —— 已完成任务的真实完成时间；
- `start` —— 跨天任务的开始时间。

所以每条任务要多发一次详情请求。这件事有节制地做：并发 4，单轮最多 80 条，剩下的下一轮补。首次同步（尤其历史已完成任务多的账号）会分几轮逐步补齐，期间插件状态里的 `detailBacklog` 会显示还差多少。

嫌慢可以在实例设置里关掉「补齐开始时间与完成时间」，代价是跨天任务只剩截止那天、历史完成时间缺失。

## 凭据存哪

- **App ID / App Secret**：一念的加密配置文件（`secrets.json`，0600），界面永不回显，日志自动脱敏。
- **access / refresh token**：插件自己的 `dataDir/token.json`（0600）。这是运行时产物，插件负责，不占用宿主的配置存储。

`access_token` 过期前 5 分钟自动刷新。`refresh_token` 约 7 天有效，过期后需要重新点「开始授权」。

## 出问题时

先看插件卡片上的「查看日志」，日志带 `traceId`，能把一次同步从宿主贯穿到插件。

| 现象 | 通常是 |
|---|---|
| 「申请设备码失败」 | App ID / Secret 填错，或应用没开设备码流程 |
| 「应用不存在」 | 版本选错了（飞书 ↔ Lark） |
| 「飞书授权已失效，请重新授权」 | `refresh_token` 过期（约 7 天），或在飞书后台撤销了授权 |
| 拿不到 `refresh_token` | 权限里漏了 `offline_access` |
| 完成时间都是今天 | 详情补齐被关掉了 |
| 任务差一天 | 全天任务按本机时区解释日期，检查系统时区 |

## 开发

```bash
npm run typecheck
npm run doctor      # 契约自检：manifest、设置面板、权限声明与实际调用
npm test            # 54 个测试，不发真实请求
```

测试用替换 `globalThis.fetch` 的方式驱动，覆盖时间映射、Device Flow 的各个轮询分支、token 刷新与 API 错误分类。**真机验收仍然必要**——单测替代不了「凭据真的能换出 token」。

契约见一念仓库的 [`docs/11-plugin-architecture.md`](https://github.com/VangelisHaha/nikou-agenda/blob/main/docs/11-plugin-architecture.md)，SDK 与工具来自[官方模板](https://github.com/VangelisHaha/yinian-plugin-template)。
