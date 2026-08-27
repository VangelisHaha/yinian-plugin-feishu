# AGENTS.md — yinian-plugin-feishu

[一念（Yinian）](https://github.com/VangelisHaha/nikou-agenda)的飞书插件：任务同步（双向）、日历与会议同步（pull-only）、通知渠道（出站）。基于[官方模板](https://github.com/VangelisHaha/yinian-plugin-template)，SDK 与 `doctor` 是从那里复制的。

## 三个扩展点的边界

| 扩展点 | 入口 | 配置在哪 | 不要做的事 |
|---|---|---|---|
| `sync.pull` / `sync.push`（task） | `handlers/sync.mts` | 实例级（`request.config`） | — |
| `sync.pull`（event） | `handlers/syncEvent.mts` | 实例级（`request.config`） | 不要实现 push：event 是 pull-only，宿主不会调 |
| `notify.send` | `handlers/notify.mts` | **插件级**（`plugin.init` 的 config） | 不要在这里判静默/订阅，那是宿主的事 |

`sync.pull` 是**一个方法两种资源**，按 `request.resource` 分派。宿主按 manifest 的
`contributes.sync.resources` 逐个调用，task 与 event 是两次独立的 pull。

**配置一律走 `feishu/pluginConfig.mts` 的 `configOf`**：请求里那份优先（宿主已合并
插件级 + 实例级），退回 `plugin.init` 那份。直接读 `context().config` 的话，
实例设置怎么改都不生效——一个进程服务该插件下的所有实例，init 时给不出「哪一个实例」。
唯一例外是 `notify.send`，它的载荷里没有 `config`（契约 §8.2），所以**通知配置必须放插件级**。

## 必须遵守

- 中文回复，中文编写文档与注释。
- 改完必须 `npm run verify`（build + doctor + 测试）全绿。
- **零运行时依赖。** `dependencies` 永远为空，HTTP 用 Node 内置 `fetch`。
- `src/sdk/` 是模板的副本，**不要在这里改它**。SDK 要改就去模板仓库改，再同步过来，否则两边会各自演化。
- 飞书 API 的字段与端点以本机 `~/ops/my/cli-main`（飞书官方 CLI 源码）为准。**不要凭记忆写字段名**——文档站是 SPA，抓不到内容，猜错的代价是白写一个功能。

## 四处容易写错的地方

### 时间：任务用毫秒，日历用秒

**同一个飞书，两套单位。** 任务的 `due` / `start` / `completed_at` 是**毫秒**时间戳字符串
（`mapping.mts` 的 `parseMs`）；日历的 `start_time.timestamp` 是**秒**
（`calendarMapping.mts` 的 `parseSeconds`）。串用了会把会议排到 1970 年或几万年后。

全天日程还有一条：**飞书返回的 `end_time.date` 已经是右开区间**（官方 CLI 展示给人看
之前会先减 1 秒再取日期），一念契约要的也是右开，所以**原样传，不要加减一天**。
这与全天**任务**的处理刚好相反——任务要折成当地 23:59:59，见下。

### 日历的删除判定

不能开 `eventsComplete`。我们拉的是滚动窗口，不是「这些日历的完整集合」，开了它
第 8 天时滑出窗口的历史会议会被宿主全部标成「已取消」。删除靠两条显式信号：飞书自己返回
`status: cancelled`，以及插件在 `dataDir` 记账（上轮窗口内见过、这轮没见到）。
**记账比较只对落在当前窗口内的 id 生效**，否则每轮都会误报一批。

### 时间

飞书任务的时间都是**毫秒时间戳的字符串**，不是数字也不是 ISO。`"0"` 表示「没有」，不是 1970 年——`parseMs` 已经处理，别绕过它。

全天任务的日期必须按**本机时区**解释（`nikou-screen` 上实测按 UTC 会偏一天），并且折回 UTC 时要用**同一时区的偏移**。只取日期再用 `new Date(y, m, d, 23, 59)` 构造会用本机时区解释目标时区的日期，跨时区就错——这个 bug 写测试时才发现，`mapping.mts` 里的 `zoneOffsetMs` 就是为它存在的。

### `update_fields`

PATCH 的请求体是 `{ task: {...}, update_fields: [...] }`。**漏了 `update_fields`，飞书会返回成功但什么都不改**——这是最难发现的一类错误，因为没有任何报错。`client.mts` 的 `#patch` 强制要求它，不要绕开。

清空字段要显式传值（描述传 `""`，截止时间传 `{ timestamp: "0" }`）。不传那个键等于「保持原值」，清空会静默失败。

### `completed_at`

补历史任务时必须用一念记录的真实完成时间。用 `Date.now()` 会把所有历史任务的完成时间改成今天，用户的完成记录就毁了，而且**不可逆**。

## 授权的时间预算

| 位置 | 超时 | 能等多久 |
|---|---|---|
| `action`（开始/检查授权） | 15s | 12s |
| `config.validate` | 30s | 25s |

**不要在 action 里长轮询**：超时之外，启用前的临时进程还会被宿主回收，后台任务活不下来。要等就等在 `config.validate` 里。

## 为什么没有 mock host

模板里的 `mock-host.mjs` 会真的调 `sync.pull`，而那需要有效凭据。留一个必然失败的命令比没有更糟，所以删掉了。协议层由 `doctor` 检查，业务逻辑由单测覆盖（替换 `globalThis.fetch`），凭据链路只能真机验。

## 真机验收清单

单测替代不了这些：

**日历与通知**

1. 实例设置里「同步哪些日历」能拉出日历列表（走 `feishu.listCalendars`，超时只有 15 秒）；
2. 首次同步后飞书日程出现在一念日历，**重复日程的每一次都在**，全天日程占的天数正确；
3. 带视频会议的日程，详情「来源」区有可点的会议链接；
4. 外部日历在一念里改不动（只读），飞书侧改时间后下一轮同步跟着变；
5. 在飞书里取消一个已同步的日程 → 一念侧变成「已取消」而不是消失；
6. 插件设置里点「发送测试通知」能收到；关掉一念的「飞书」渠道开关后真实提醒不再发到飞书；
7. 同一条提醒推迟后复弹，飞书里**只有一条**消息。

**任务**

1. 填凭据 → 开始授权 → 浏览器同意 → 检查授权显示「已授权为 XXX」；
2. 首次同步后飞书任务出现在一念，跨天任务的时间轴跨度正确；
3. 在一念里勾完一个任务 → 飞书侧变成已完成，且 60 秒内的轮询没有把它拍回未完成；
4. 在飞书里勾完一个任务 → 下一轮同步后一念侧变成已完成，完成时间是飞书的真实时间；
5. 改标题 → 飞书侧标题同步变化；
6. 把 App Secret 改错 → 报「申请设备码失败」而不是静默不同步。
