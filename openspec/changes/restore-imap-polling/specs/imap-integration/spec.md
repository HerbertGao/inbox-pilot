## 新增需求

### 需求:轮询由 hangar poll 触发器驱动
IMAP 轮询必须与 Gmail 轮询同处一次 `run(ctx)`，由 `app.yaml` 的 `poll` cron 触发器驱动；pilot **禁止**自建定时器、**禁止**从 env 读取轮询周期。一次 run 内任一账号的连接 / 解析 / 处理异常必须被 catch+记错，不得中断其余账号的轮询，run 终态仍为 `completed`。

「增量 UID 游标避免重复 FETCH」需求中「轮末 `setCursor`」「下一轮」的语义**以同一账号的轮次串行为前提**——两轮重叠时慢轮的 `setCursor` 会覆盖快轮的高水位，退化轮 floor ④ 还会写 `:0` 触发整箱重扫。该前提由 hangar daemon 的 **per-app in-flight 闸**持有：上一轮未 settle 时新的 cron tick 被跳过。作为交换，`run()` **必须自限时长**——挂死的 run 会永久占住该闸，该 app 此后不再被调度。本需求不重复约束 hangar 侧的实现，只钉住 pilot 侧的这一条义务。

#### 场景:poll 触发时 imap 与 gmail 同轮处理
- **当** `poll` 触发器到点、注册表中同时存在 enabled 的 `provider='imap'` 与 `provider='gmail'` 账号
- **那么** 两类账号必须在同一次 `run(ctx)` 内都被轮询，**禁止**任何一类被静默过滤掉

#### 场景:上一轮未结束时新 tick 被跳过
- **当** 某次 `run(ctx)` 尚未结束、下一次 `poll` 触发到来
- **那么** 该 tick 必须被跳过（不并发两个 run），使同账号的 `setCursor` 不会乱序

#### 场景:run 必须自限时长
- **当** 某一轮轮询因外部原因长时间不返回
- **那么** `run()` 必须由自身的墙钟兜底结束，**禁止**无界等待

#### 场景:单账号异常不影响其余账号
- **当** 某 IMAP 账号本轮连接失败或解析异常
- **那么** 该异常必须被 catch+记错、其余账号照常轮询，run 终态仍为 `completed`
