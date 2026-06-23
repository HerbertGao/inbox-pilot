# durable-retry 规范

## 目的
待定 - 由归档变更 durable-action-retry 创建。归档后请更新目的。
## 需求
### 需求:瞬时失败动作落 retrying 入队（取代终态 failed）
`executeActions` 的某个动作（reflectPriority/markRead/notify）在单次调用内有界重试**发送态瞬时失败**耗尽时，系统**必须**把该 `mail_actions` 行落为 **`retrying`**（带 `retryCount`、`nextRetryAt`、脱敏 error）**而非终态 `failed`**，使其进入跨重启的持久化重试。**禁止**让瞬时失败的动作落终态而被永久丢弃。`ProviderReauthRequired`（账号级致命）与终态落库（repo I/O）的**向上传播通道不变**（仍以 `failed`/re-throw、由 re-poll 兜底）——只有**发送态瞬时失败**改走 `retrying`。

**状态全集**：终态 = **`{done, skipped, failed, dead_letter}`**、中间态 = `{pending, retrying}`。`failed` **仍是合法终态**（reauth/repo-I/O 致命通道、不可重试、不被 drain 选中）；**禁止**把 `failed` 从终态集中丢掉。

**活跃行唯一性（DB 强制、非仅约定）**：同一 `(messageId, actionType)` 任意时刻**至多一条活跃行**（活跃 = `status ∈ {pending, retrying}`）。这**必须**由 **`mail_actions` 对 `(messageId, actionType)` 的 partial unique index（`WHERE status IN ('pending','retrying')`）+ `recordAction` 改为 upsert 活跃行**共同强制——因为 re-poll 在 `processedAt` 未置时会整条重跑 `executeActions → recordAction`，无此强制会产生第二条活跃行并重复入队/重发。**upsert 按既有活跃态分流（明确 retryCount/nextRetryAt 处置）**：命中活跃 **`retrying`** 行 → **保持 `retrying` 原样、不清零 `retryCount`/`nextRetryAt`**，并令 `executeActions` **SKIP 本轮该动作的内联执行**（drain 拥有它）——否则重置 `pending` 会让下次 `enqueueRetry(retryCount=0)` 清零 durable 进度（re-poll 反复触发可绕过 `≥6` 死信上限）、并可能留下 drain 看不见的孤儿 `pending`；命中活跃 **`pending`** 行（崩溃残留）→ 复用同行继续执行；无活跃行 → INSERT `pending`。终态行（`done`/`failed`/`skipped`/`dead_letter`）可多条、不受约束。

#### 场景:P0/P4 通知瞬时耗尽落 retrying 而非丢失
- **当** 一封 P0/P4 邮件的 `notify` 在单次调用内有界重试因网络瞬时失败耗尽
- **那么** 该 `mail_actions` 行**必须**落 `retrying`（含 `retryCount`、`nextRetryAt`）、**禁止**落终态 `failed`，且 `markProcessed` 仍照常（邮件不再 re-poll，但该动作由 durable 重试兜底）

#### 场景:reauth 致命通道不入 retrying
- **当** 动作执行抛 `ProviderReauthRequired`
- **那么** 该行**必须**仍落 `failed`(reauth kind) 并 re-throw（账号级、由 scheduler 隔离 + re-poll 兜底），**禁止**入 `retrying`

#### 场景:re-poll 重跑不产生第二条活跃行、不清零 durable 进度
- **当** `reflectPriority` 耗尽落 `retrying`（行 R1，`retryCount`=3），同一 `executeActions` 内随后 `markRead` 抛 `ProviderReauthRequired` → 跳过 `markProcessed` → 该邮件被 re-poll 整条重跑 → 再次 `recordAction(reflectPriority)`
- **那么** partial unique index（活跃态）+ `recordAction` upsert **必须**命中 R1：因 R1 是 `retrying` → **保持 `retrying`、`retryCount` 仍为 3（不清零）**、`executeActions` **SKIP 内联重执行**（交给 drain）；任意时刻该 `(messageId, reflectPriority)` **至多一条活跃行**，drain 与 re-poll 不重复入队/重发、durable 进度不被 re-poll 清零。**SKIP 对三动作一致**：若 R1 是 `retrying` 的 **`notify`**（非幂等），re-poll **同样 SKIP 内联重发**（不在 re-poll 内联再发一次）、仅由 drain 服务——这正是不依赖 notify 幂等也不超额重发的关键

#### 场景:终态枚举含 failed
- **当** 判断某 `mail_actions` 行是否终态
- **那么** 终态集**必须**为 `{done, skipped, failed, dead_letter}`（`failed` 不可遗漏）；`{pending, retrying}` 为中间态

### 需求:重试 drain 折叠进 poll、复用连接与锁、每轮有界（条数 + 软 deadline）
系统**必须**把可重试动作的排空（drain）折叠进**既有 per-account poll 周期**——在新邮件处理完、provider 连接 teardown 前，用**同一 live provider 连接 + 已持有的 per-account 锁**排空该账号 `status='retrying' ∧ nextRetryAt ≤ now` 的动作。**禁止**引入独立 sweep job 重建 provider 连接、**禁止**新增绕过 per-account 锁的并发面。

**注入点与依赖**：connection-bound `provider` 在 `pollOnce`（IMAP）/`gmailPoll`（Gmail）**内部**构造（非 `pollAccount`），故 drain **必须从 `pollOnce`/`gmailPoll` 体内**调用以拿到 live `provider`。drain 还需一个 **`Notifier`** 重试 notify 动作（账号无关、非 connection-bound）——`PollDeps`/`GmailPollDeps` 与 `drainAccountRetries` 的依赖**必须含 `notifier`**（`main.ts` 接线透传）；无 notifier 则 drain 无法重试 notify（本变更首要动机）。

每轮 drain **必须有界（条数 + 时间双重）**：单账号每 poll 至多 `DRAIN_BATCH_CAP`（默认 50）条、按 `nextRetryAt` 升序；**且必须接收一个软 elapsed-budget/deadline，超预算即提前停止本轮 drain**（剩余下轮续）——因为 `scheduler` 的 5min 轮超时**只释放信号量名额、不中断在途 poll**，仅条数 cap 不能界定 50 次 live 网络重试的总时长。整体 **best-effort within poll budget**、per-account 隔离、**不得阻断其它账号**。

drain 内逐条动作 **try/catch 只隔离普通瞬时异常**（一条失败/异常**禁止**阻断同账号其余 drain）；但 `ProviderReauthRequired` **必须重新抛出**（穿过逐条 catch）停止本账号本轮 drain（见下「reauth」场景）——**禁止**让逐条 catch 吞掉 reauth 后继续对失效连接 drain。

#### 场景:重试在该账号下一轮 poll 内被排空
- **当** 一条 `retrying` 动作的 `nextRetryAt ≤ now`，该账号触发下一轮 poll
- **那么** drain **必须**在该 poll 的 provider 连接 + per-account 锁内重试它（标已读/优先级用同一连接，通知用账号无关 notifier）

#### 场景:drain 有界、不阻其它账号
- **当** 某账号有远多于 `DRAIN_BATCH_CAP` 条到期重试
- **那么** 本轮**必须**至多处理 `DRAIN_BATCH_CAP` 条、其余下轮续；整体仍受轮超时约束、**不得**阻塞其它账号的调度

#### 场景:drain 超软 deadline 提前退出
- **当** 一轮 drain 在处理到期重试时累计 elapsed 超过传入的软 deadline（未达条数 cap）
- **那么** **必须**提前停止本轮 drain、剩余到期项下轮续（**禁止**把本轮拖到 5min 轮超时墙）；已处理项的状态更新照常落库

#### 场景:drain 中遇 reauth 停止本轮、穿过逐条 catch、不推进不进死信
- **当** drain 第 k 条动作抛 `ProviderReauthRequired`（账号级不可用），其后还有未试行
- **那么** 逐条 try/catch **必须**对 `ProviderReauthRequired` **重新抛出**（不被隔离吞掉）→ 停止该账号本轮 drain；当前 `retrying` 行**保持 retrying**（**禁止**推进 `retryCount`、**禁止**进 `dead_letter`）、其后未试行**不动**，账号级失败传播触发 suspend，待重新授权后下轮继续。**判别不变量**：`instanceof` 判别充分依赖 sink **裸抛** reauth（现 `provider.ts` 无 cause、`notifier` 不抛 reauth，本变更须守此约定）；逐条 catch **应同时 unwrap `.cause`** 再判 `instanceof`，防未来 sink 包裹 reauth 致隔离失效

#### 场景:普通瞬时异常逐条隔离、不停整轮
- **当** drain 某条动作抛**非 reauth** 的瞬时异常（如单次网络错误）
- **那么** 逐条 try/catch **必须**隔离它（该行按瞬时失败推进 `retryCount`/`nextRetryAt`）、**不得**阻断同账号其余 drain

### 需求:长程指数退避、重试上限耗尽进死信
系统**必须**对 `retrying` 动作施加**长程指数退避**（分钟~小时级，区别于轮内 ≤~1s 的发送态退避）：每次 drain 重试仍瞬时失败时，`retryCount` 加一、`nextRetryAt` 置为 `now + backoff(retryCount)`（默认序列 ~1min/5min/30min/2h/6h/24h、指数 + 24h 封顶），退避**必须**落 `nextRetryAt`（时间维度）、**禁止**在 drain 内 sleep 阻塞。**死信触发统一为：增量后 `retryCount ≥ MAX_DURABLE_ATTEMPTS`（默认 6）时**必须**落 `dead_letter`**（终态、**禁止**自动再试）——初次入队 retryCount=0、drain 失败依次 1..6、达 6 即死信 = 恰好 6 次 drain 重试用尽 6 个退避槽；**禁止**用 `retryCount+1 ≥ MAX` 的早一次表述（与 design 决策 2、tasks 3.2 统一）。终态 = **`{done, skipped, failed, dead_letter}`**、中间态 = `{pending, retrying}`（`failed` 仍是 reauth/repo-I/O 致命通道的合法终态）。

#### 场景:重试间长程退避、不轮内阻塞
- **当** 一条 `retrying` 动作本轮 drain 仍失败
- **那么** **必须** `retryCount+1` 且 `nextRetryAt = now + backoff(retryCount)`（长程）、本轮 drain **不得** sleep 等待该退避（下次到期下轮再试）

#### 场景:重试上限耗尽进死信
- **当** 一条动作的 `retryCount` 达 `MAX_DURABLE_ATTEMPTS`（默认 6）仍未成功
- **那么** **必须**落 `dead_letter`（终态）、记脱敏日志、**禁止**再被 drain 选中

### 需求:重试复用已存裁定、绝不重新分类、从 DB 重建输入
drain 重试某动作时，系统**必须**从已存数据**重建输入**。系统**绝不**重新调用 LLM 分类（守「LLM 只建议、裁定已定」、不改判、不耗 token）；重试只对该 `mail_actions` 行的 `actionType` 复发原动作。

- **`NormalizedEmail`（action-input-sufficient 投影、非字段完备）**：取自 `mail_messages` 行（providerMessageId/messageId/threadId/uid/subject/fromEmail/fromName/snippet/bodyText/receivedAt/hasAttachments）。`mail_messages` **不存** `to`/`cc`/`headers`/`htmlBody`/`provider`，而 `NormalizedEmail.to`/`headers` 为必填——故重建**合成** `to: []`、`headers: {}`，`provider` 由 `MailAccount.provider` 派生。系统**必须**有一条断言测试证明三个被重试动作 sink（notify 仅投影 subject/fromName/fromEmail+decision；markRead/reflectPriority 仅用 uid/providerMessageId）**不读** `to`/`headers`；未来动作若需这些字段须先持久化。
- **`FinalDecision`**：取自该邮件**最新** `mail_classifications` 行，**必须用 `orderBy [{createdAt:'desc'},{id:'desc'}] take 1`**（与既有 `listDigestCandidates` 一致）——`createdAt` 非唯一，**只按 createdAt 取最新会非确定性地选到另一条裁定、在重试时 silently 改判**（priority/`shouldMarkRead`），违背"绝不改判"、甚至把敏感邮件按另一行裁定标已读。取列 priority/category/confidence/reason + `rawAiJson.finalDecision` 块。
- **重建失败必须分两类，且判别机制必须显式（两类都可能"抛出"，不能靠笼统 try/catch）**：① **永久** → 落 `dead_letter`（记脱敏日志）、**禁止**崩 drain。判别：DB 行查询**返回 `null`/空**（行缺失），**或** `rawAiJson` 在**独立解析 `try`** 内 throw（不可解析）/解析成功但 `finalDecision` 块缺字段/类型不符（shape-invalid）。② **瞬时**（**Prisma 行读取本身**抛出 I/O 错误，如 pool 超时/连接抖动/`PrismaClientKnownRequestError`）→ **绝不** `dead_letter`：该行**保持 `retrying`、不推进 `retryCount`**、错误**向上传播**（同 repo-I/O 通道、下轮再 drain）。**判别边界**：行读取抛出 ⇒ 瞬时；行返回 null / `rawAiJson` 解析或 shape 校验失败 ⇒ 永久。**禁止**用包住整个重建的单一 `try{}catch{永久}`（误死信瞬时抖动）或 `catch{瞬时}`（损坏 JSON 永久卡 retrying）。

#### 场景:重试复用已存 FinalDecision 不重新分类
- **当** drain 重试一条 `retrying` 的标已读/通知动作
- **那么** **必须**复用 `mail_classifications` 已存的 `FinalDecision`（P4/敏感语义随原裁定保持）、**禁止**重新 LLM 分类

#### 场景:永久重建失败（行缺失/JSON 损坏/shape 不符）进死信不崩
- **当** 某 `retrying` 动作对应的 `mail_messages`/`mail_classifications` 行确实缺失（查询返回 null）、或 `rawAiJson` JSON 不可解析、或解析成功但 `finalDecision` 块缺字段/类型不符
- **那么** **必须**把该动作落 `dead_letter`、记脱敏日志、**禁止**抛出崩溃 drain

#### 场景:瞬时 DB 错误不进死信、保持 retrying
- **当** 重建读取过程中 DB/连接抛出瞬时 I/O 错误（如 pool 超时、连接抖动），而非行缺失/JSON 损坏
- **那么** 该行**必须**保持 `retrying`、**禁止**推进 `retryCount`、**禁止**落 `dead_letter`；错误向上传播由下轮 drain 重试（防一次 DB 抖动永久死信一封 P0/P4 notify）

#### 场景:重建取最新分类用 createdAt+id tie-break
- **当** 某邮件有多条 `mail_classifications` 行（含同 `createdAt`）
- **那么** 重建 `FinalDecision` **必须**用 `[{createdAt:'desc'},{id:'desc'}]` 取最新一条（确定性、不在并列时改判 priority/`shouldMarkRead`）

### 需求:notify 重试幂等安全 + staleness 上界、死信可观测
`retrying` 的 `notify` 重试语义为 **at-least-once、可能重复**：`failed`/抛出态的 notify **大多**是"没发出"（`done` 写入有意在重试 try 之外，已发未记会向上传播走 at-least-once），但**歧义传输失败**——telegram `fetch` 在**服务端已受理后**超时/报错也落 `failed`——会使"已发"被重试再发。telegram 层无法区分 definite-not-sent 与 ambiguous-sent，故契约**修正为 at-least-once（可能 >1 次推送）**，**不再宣称严格 ≤1 dup**；reflectPriority/markRead 幂等故重复无害，仅 notify 受影响、best-effort 已接受。系统**必须**对 notify 施加 **staleness 上界**（默认 `NOTIFY_STALENESS=24h`，基于 `mail_messages.receivedAt`）：超界的 `retrying` notify **必须**直接落 `dead_letter`、**禁止**补发（数天前的 P0 补发无意义；同时限制陈旧重发的数量上限）。**注**：`receivedAt` 对缺/坏日期的邮件回落为摄入时刻（`normalizeEmail` date 缺省），故 staleness **低估**真实年龄——方向良性（宁可重发一封可能已陈旧的 notify，也不误死信一封新鲜的）、且受 `MAX_DURABLE_ATTEMPTS` 兜底，不改行为。标已读/优先级动作**无** staleness 上界（迟标仍正确，应试到成功或 attempts 耗尽）。所有 `dead_letter` **必须**可观测——记脱敏日志（kind+actionType+retryCount，**禁止**正文/凭据/PII）且 DB 可查（status=`dead_letter`）。**诚实边界**：可观测 = DB 行 + 脱敏日志；**主动告警**（dead_letter 时再推一条通知）属**非目标/后续**——故高优先级 notify 进 `dead_letter` 时除 DB/日志外**无主动用户可见信号**（已知取舍）。

#### 场景:超 staleness 的旧通知进死信不补发
- **当** 一条 `retrying` 的 notify 对应邮件 `receivedAt` 距今超过 `NOTIFY_STALENESS`（默认 24h）
- **那么** **必须**直接落 `dead_letter`、**禁止**补发该通知

#### 场景:标已读无 staleness 上界
- **当** 一条 `retrying` 的 markRead 对应邮件已过 24h 但 `retryCount` 未达上限
- **那么** **必须**继续重试（标已读迟到仍正确）、**禁止**因 staleness 进死信

#### 场景:死信可查不静默
- **当** 任一动作进 `dead_letter`
- **那么** **必须**记脱敏结构化日志（kind+actionType+retryCount，无正文/凭据）且 `mail_actions` 可按 status=`dead_letter` 查询

