## 上下文

`executeActions`（src/actions/executeActions.ts）三动作 reflectPriority（始终、幂等）/ markRead（仅 shouldMarkRead、幂等）/ notify（仅 shouldNotifyNow、非幂等但 `failed`=没发出，done-写入有意移出 try）当前重试是**进程内单封单轮** MAX_ATTEMPTS=3 + P6 ≤~1s 退避，耗尽落 `mail_actions` 终态 `failed`、**不抛**。`processEmail.ts:95-98` 在 executeActions 后**最后无条件** markProcessed。re-poll 兜底只覆盖 classifyEmail 抛出 / executeActions 向上传播（`ProviderReauthRequired`、repo I/O），**不覆盖瞬时发送失败**——后者落 `failed` 后 markProcessed 仍跑、邮件不再 re-poll、该动作永久丢失。`mail_actions={id,messageId,actionType:String,status:String=pending,error:String?,...}`，status 自由 String、无 retryCount/nextRetryAt。`mail_messages` 存 providerMessageId/subject/fromEmail/bodyText/receivedAt 等（可重建 `NormalizedEmail`）；`mail_classifications` 存 priority/category/confidence/reason 列 + `rawAiJson.finalDecision` 块（可重建完整 `FinalDecision`）。`scheduler.ts` 有 per-account isPolling 锁 + 全局信号量 + 5min 轮超时；poll 在该账号已建 provider 连接内执行动作。

## 目标 / 非目标

**目标：**
- 瞬时失败的动作（尤其 P0/P4 通知/标已读）**跨重启**被重试至成功或进死信，不再永久丢失。
- 重试**复用已存 `FinalDecision`**（绝不重新 LLM 分类改判）；保持 `markProcessed` 最后无条件、不重跑整条流水线。
- 不引入新并发面 / 不重建 provider 连接 / 不撑爆轮超时。

**非目标：**
- exactly-once 投递保证（notify 为 best-effort **at-least-once**——歧义传输失败下可能 >1 dup，见决策 3）。
- 多实例 / 分布式 sweep 与分布式锁（仍单实例，沿用 per-account 锁 + 全局信号量）。
- 独立 provider-构造 sweep job（见决策 1 选折叠进 poll）。
- 把 `ProviderReauthRequired` 致命通道改成可重试（账号级仍走 suspend）。
- durable 重试的告警接入 / GUI / 历史 `failed` 行批量回放。
- **`dead_letter` 的手动重试 / 重入队**：非目标。`dead_letter` 是终态、**禁止**自动再试；本期**不**提供手动 requeue 工具，且**不支持**直接 DB 改 status 把 `dead_letter`/`failed` 翻回 `retrying`（绕过 drain 的输入重建/裁定校验有安全风险）。若未来加 requeue 工具，**必须**先按存储/重建的 `FinalDecision` 校验该动作（尤其 `shouldMarkRead` 敏感护栏）再入队、不得裸回放 `actionType`。

## 决策

### 决策 1（核心 fork）：重试 drain 折叠进既有 poll，否决独立 sweep
标已读/优先级重试需要该账号 live provider 连接（IMAP/Gmail），通知重试账号无关。
- **(a) 独立 sweep job**：node-cron 定时、每账号重建 provider（IMAP 新连接 / Gmail client）重放失败动作。**否决**：重复连接生命周期 + 凭据构造成本（IMAP 每次重连昂贵）、新增并发面（须与 poll 抢同一 per-account 锁、自行协调）、与既有调度模型割裂。
- **(b) 折叠进 poll（选）**：在新邮件处理完、连接 teardown 前，用**同一 live provider 连接 + 已持有的 per-account 锁**排空该账号 `nextRetryAt ≤ now` 的可重试动作。**选它**：复用连接/锁/全局信号量、**零新并发面**、自然受 per-account 互斥与轮超时保护。代价：重试节奏 = `POLL_INTERVAL_SECONDS`——可接受（durable 重试本就长程、无需快于 poll）；账号 disabled/suspended 时其重试自然暂停（reauth 期间本不该重试）——可接受。
- **drain 的注入点与依赖（落点精确化）**：标已读/优先级的 connection-bound `provider` 在 **`pollOnce`（IMAP）/`gmailPoll`（Gmail）内部**构造（`makeProvider(connection)`），**不在 `pollAccount`**——故 drain **必须从 `pollOnce`/`gmailPoll` 体内**（新邮件循环之后、调用方 `logout` 之前）调用，以拿到 live `provider`；其抛出的 `ProviderReauthRequired` 沿 `pollOnce → pollAccount → guard` 既有传播路径隔离账号。drain 还需一个 **`Notifier`**（通知重试账号无关、非 connection-bound）：故 `PollDeps`/`GmailPollDeps` 与 `drainAccountRetries(accountId, { provider, notifier, repo, clock, deadline })` 的依赖**必须新增 `notifier`**，由 `main.ts` 接线透传（默认 `defaultNotifier`）。无此 notifier，drain 无法重试 notify 动作（即本变更的首要动机 P0/P4 通知丢失）。
- `// ponytail: 折叠进 poll 复用连接/锁；若未来要独立节奏再拆 sweep`。

### 决策 2：状态模型（retrying/dead_letter + retryCount/nextRetryAt）+ 长程退避
- `mail_actions` status 复用自由 String 新增 **`retrying`**、**`dead_letter`**；新增列 `retryCount Int @default(0)`、`nextRetryAt DateTime?`（无需 enum 迁移、既有行兼容）。
- **终态/中间态全集（精确化，含 `failed`）**：终态 = **`{done, skipped, failed, dead_letter}`**、中间态 = `{pending, retrying}`。`failed` **仍是合法终态**——保留给 reauth/repo-I/O 致命通道（非可重试、不被 drain 选中）；**禁止**把 `failed` 从终态枚举中丢掉（任何按"是否终态"门控的消费者只看 `{done,skipped,dead_letter}` 会误判 `failed` 行）。
- `executeActions` 瞬时耗尽分支：由落终态 `failed` 改为落 **`retrying`**（`retryCount=0`、`nextRetryAt = now + backoff(0)`、error=脱敏摘要）。reauth/repo-I/O 通道**不变**（仍 failed+re-throw / 向上传播）。
- **drain 一次重试**：选 `status='retrying' ∧ nextRetryAt ≤ now ∧ message.accountId=本账号`（按 nextRetryAt 升序、cap 见决策 6）；重建输入（决策 5）→ 试一次该 actionType：
  - 成功 → `done`。
  - 仍瞬时失败 → `retryCount += 1`、`nextRetryAt = now + backoff(retryCount)`、保持 `retrying`。
  - **死信触发（off-by-one 统一）**：增量后 **`retryCount ≥ MAX_DURABLE_ATTEMPTS`（默认 **6**）** 或超 staleness（决策 3）→ **`dead_letter`**（终态、记脱敏日志、绝不自动再试）。语义：初次入队 retryCount=0，drain 失败依次 1..6，`retryCount` 达 6 即死信 = 恰好 6 次 drain 重试、用尽 6 个退避槽 `backoff(0..5)`。决策 2 此处、`durable-retry` §需求3、tasks 3.2 **必须**统一写 `retryCount ≥ MAX`（禁止 `retryCount+1 ≥ MAX` 的早一次表述）。
  - reauth → 见决策 6（账号级、不推进 retryCount、不进死信）。
  - **瞬时 DB/连接错误 ≠ 重建失败**：见决策 5——drain 过程中抛出的 DB I/O 错误属瞬时，**保持 `retrying`、不推进 retryCount、向上传播**，绝不当永久死信。
- **长程指数退避**（区别于 P6 轮内 ≤~1s）：`backoff(n)` = 默认序列 ~1min/5min/30min/2h/6h/24h（指数 + 24h cap），**落 `nextRetryAt`、非轮内 sleep**（退避是时间维度，不阻塞 drain）。

### 决策 3：幂等性与 notify 重试语义（at-least-once）+ staleness 上界
- reflectPriority/markRead **幂等** → 放心重试（重复打标签/重复 \Seen 安全）。
- notify **非幂等**。`retrying`/`failed` 的 notify **大多**是"没发出"（done-写入在 try 外、已发未记会向上抛走 at-least-once），但**存在歧义传输失败**：telegram 的 `fetch` 在**服务端已受理后**超时/报错也会落 `failed`/抛出——此时**已发出却记为 failed**。故 durable 重试 notify 的契约**修正为 at-least-once、可能重复**（歧义传输失败下可 >1 次推送），**不再宣称严格 ≤1 dup**。telegram 层无法区分 definite-not-sent 与 ambiguous-sent，故按 at-least-once 处理；staleness 上界限制陈旧重发的数量上限。reflectPriority/markRead 幂等故重复无害；只有 notify 受此影响、且 best-effort 已接受。
- **notify staleness 上界**（默认 `NOTIFY_STALENESS=24h`）：基于 `mail_messages.receivedAt`；超界的 `retrying` notify 直接 `dead_letter`、**不补发**（数天前的 P0 补发无意义、甚至误导）。**markRead/reflectPriority 无 staleness 上界**（迟标已读/迟打标签仍正确，应一直试到成功或 attempts 耗尽）。
- 死信可观测：记脱敏日志（kind+actionType+retryCount，绝不正文/凭据）+ DB 可查（status=dead_letter）。**诚实边界**：可观测 = **DB 行 + 脱敏日志**；**主动告警**（如 dead_letter 时再推一条 telegram）属**非目标/后续 follow-up**——故高优先级 notify 耗尽进 dead_letter 时除 DB/日志外**无主动用户可见信号**（已知取舍，不宣称"绝不静默"的强保证）。

### 决策 4：与 markProcessed/re-poll 交互——行粒度互补 + 活跃行唯一性由 DB 强制
- `markProcessed` **保持最后且无条件**（瞬时失败仍置 processedAt）。理由：re-poll 重跑会**重新 LLM 分类**（成本 + 可能改判，违背"复用已存裁定"）+ **重发已成功的其它动作**（重复 notify/markRead）。
- durable 重试在 **`mail_actions` 行粒度**只重试那一条 `retrying` 动作，re-poll 兜底在 **email 粒度**（仅 reauth/抛出未 markProcessed 者）。
- **"同一 (messageId, actionType) 至多一条活跃行" 必须由机制强制，而非靠"recordAction 只建一次"的假设**：现 `recordAction` 是**无条件 INSERT**（`mailRepo.ts:448`），且 re-poll 在 `processedAt` 未置时会**整条重跑 executeActions → 再次 recordAction**。典型破坏路径：`reflectPriority` 耗尽落 `retrying`（行 R1）→ 同一 executeActions 内 `markRead` 抛 `ProviderReauthRequired` → executeActions re-throw → 跳过 markProcessed → re-poll 重跑 → `recordAction(reflectPriority)` **再建第二条活跃行 R2**；对 notify 而言更糟——re-poll 会**再发一次 notify** 同时 R1 仍在 drain 队列 → 超出 best-effort 重复预算。故"行粒度 vs email 粒度互补不重叠"**不能仅靠叙述**，**必须**：
  1. **DB partial unique index**：`mail_actions` 对 `(messageId, actionType)` **WHERE `status IN ('pending','retrying')`** 加**部分唯一索引**——同一 (邮件, 动作) 任意时刻至多一条**活跃**行（终态 `done`/`failed`/`skipped`/`dead_letter` 可多行、不受约束）。
  2. **recordAction 改为 upsert 活跃行，且按既有活跃态分流（精确化 retryCount/nextRetryAt 处置）**：
     - 命中活跃 **`retrying`** 行 → **保持 `retrying` 原样**（**不**重置为 `pending`、**不**清零 `retryCount`/`nextRetryAt`），并向 `executeActions` **返回"已在 durable 队列"信号 → 该动作本轮 re-poll 内联执行被 SKIP**（drain 拥有它）。理由：重置为 `pending` 会(a)让下次耗尽 `enqueueRetry(retryCount=0)` **清零 durable 进度**（re-poll 反复触发可使 `retryCount` 永钉近 0、绕过 `≥6` 死信上限），(b)若本轮 re-poll 在重新执行该动作前先抛出，会留下 drain 看不见的 **孤儿 `pending`**。SKIP 同时避免这两者。
     - 命中活跃 **`pending`** 行（崩溃残留：recordAction 落了 pending 但执行未完成）→ **复用同一行**继续执行（非 SKIP）。
     - 无活跃行 → INSERT `pending`。
- 以上使 drain（只选 `retrying`）与 re-poll 重跑**真正不重叠**：已 `retrying` 的动作只由 drain 服务、re-poll 内联跳过；唯一活跃行由 partial unique index 保证。**逐账号串行化前提**：drain 在 `pollOnce`/`gmailPoll` 体内、与下一轮 re-poll 同受 per-account `isPolling` 锁串行（`scheduler.ts`），故无 drain 与 re-poll 同时碰同一行的并发；单实例下 upsert 的 find-then-insert 无并发竞态（多实例属非目标；若未来引入须在 INSERT 分支捕 `P2002` 回退到 find）。notify 的歧义重复仍受决策 3 的 at-least-once 契约约束（已接受）。

### 决策 5：重试输入重建——复用已存裁定、绝不重新分类
- **`NormalizedEmail` 重建是 action-input-sufficient 投影、非字段完备**：`mail_messages` 只存
  providerMessageId/messageId/threadId/uid/subject/fromEmail/fromName/receivedAt/snippet/bodyText/hasAttachments，**不存** `to`/`cc`/`headers`/`htmlBody`/`provider`。但 `NormalizedEmail` 的 `to: string[]` 与 `headers: Record<string,string>` 是**必填**——故重建**合成** `to: []`、`headers: {}`；`provider`（'gmail'|'imap'）由该账号 `MailAccount.provider` 派生。这是安全的**当且仅当**三个被重试的动作 sink 不读这些缺失字段：notify 只投影 subject/fromName/fromEmail(+decision)（`notifier.ts:73`）、markRead/reflectPriority 只用 uid/providerMessageId——**tasks 必须加一条断言测试**：三动作 sink 不读 `to`/`headers`。任何未来动作若需 `to`/`headers`，须先持久化它们。
- `FinalDecision` ← `mail_classifications` **最新行**（priority/category/confidence/reason 列 + `rawAiJson.finalDecision` 的 shouldMarkRead/shouldNotifyNow/shouldIncludeDigest/riskFlags/appliedRules）；**多分类行取最新须用 `orderBy [{createdAt:'desc'},{id:'desc'}] take 1`**（与既有 `listDigestCandidates`（`mailRepo.ts:492`）一致）——`createdAt` 非唯一（re-poll 可 append 同毫秒行），**只按 createdAt 取最新会非确定性地选到另一条裁定**，可能在重试时 silently 改判 `shouldMarkRead`/priority（违背本变更核心"绝不改判"、甚至把原本敏感不标已读的邮件按另一行裁定标已读）。**必须**带 `id desc` tie-break。
- **绝不重新 LLM 分类**——复用已存 `FinalDecision`（守 CLAUDE.md「LLM 只建议、裁定已定」+ 省 token + 不改判；P4/敏感语义随原裁定保持）。
- **"最新分类" vs "动作原始分类"的诚实边界（cuid 非严格单调）**：`[{createdAt:'desc'},{id:'desc'}]` 给**确定性**而非保证"动作创建时所用的那条裁定"（`id`=cuid 非严格单调，主 spec `processing-pipeline:50` 已注 `id desc` 仅 best-effort）。多分类行**仅**在部分失败 re-poll 重分类追加 row2 时出现，且按 actionType **不产生安全/正确性改判**：① 重试 **`notify`** 不可能与更新分类行共存（notify 是末位动作 → 落 `retrying` 即 markProcessed → 无 re-poll → 无 row2）；② **`markRead`** drain = `provider.markRead(email)`，**不消费 decision**（动作存在性=门控、由原裁定定，更新分类无法凭空造出 markRead）→ 无不安全标已读；③ 仅 **`reflectPriority`** 消费 `priority`，多行时回放**最新** priority——可接受（最新优先级标签更正确）。故"最新分类"足够，**不**为此引入 `mail_actions.classificationId` 列（YAGNI；若未来 drain 对 decision 的消费扩大到需精确回放原裁定，再加该列 + recordAction 时落 `classificationId`）。
- repo 新增重建读取方法；**重建失败的两类必须分流——且分流的判别机制必须显式（两类都可能表现为"抛出"，不能靠笼统 try/catch）**：
  - **永久失败** → 该动作 `dead_letter`（记脱敏日志）、不崩 drain。判别：① DB 行查询**返回 `null`/空**（行确实缺失，非抛出）——**为使此路径可达，`selectDueRetries` 必须先选 retry 动作行、再 LEFT join/单独 fetch 重建输入（禁 INNER join）**，否则关联行缺失的动作会被 join 丢出选择集、永不进永久死信（见 tasks 1.2）；② `rawAiJson` 放在**独立 `JSON.parse`/zod 解析 `try`** 内，**该 try 内任何 throw（不可解析）或 `finalDecision` 块缺字段/类型不符（shape-invalid）= 永久**。
  - **瞬时失败**（**Prisma 行读取本身**抛出 I/O 错误，如 pool 超时、连接抖动、`PrismaClientKnownRequestError`）→ **绝不 `dead_letter`**：该行**保持 `retrying`、不推进 retryCount**、把错误**向上传播**（同 repo-I/O 通道，下轮再 drain）。否则一次 1 秒的 Postgres 抖动会把一封 P0/P4 notify 永久死信。
  - **判别边界一句话**：行读取（Prisma 查询）抛出 ⇒ 瞬时；行返回 null、或行存在但其 `rawAiJson` 解析/shape 校验失败 ⇒ 永久。**禁止**用包住整个重建的单一 `try{}catch{永久}`（会把瞬时 DB 抖动误死信）或 `catch{瞬时}`（会把损坏 JSON 永久卡 retrying）。

### 决策 6：drain 有界（条数 cap + 软 deadline）+ reauth 处理 + 索引
- **每轮有界（条数 + 时间双重）**：单账号每 poll 最多 drain `DRAIN_BATCH_CAP`（默认 **50**）条到期重试。**仅条数 cap 不足以界定时长**：50 次 live 网络重试（IMAP/Gmail markRead、telegram notify）顺序跑可远超轮预算，而 `scheduler` 的 5min 超时**只释放信号量名额、不中断在途 poll**（`scheduler.ts:164-204`）——在途 drain 会继续持连接/`isPolling` 锁直到 settle。故 drain **必须**额外接收一个**软 elapsed-budget/deadline**（由 poll 传入，预算来自轮超时的一个保守分额），**超预算即提前停止本轮 drain**（剩余到期项下轮继续）、不把每轮都拖到 5min 墙。spec 措辞由"受 5min 轮超时约束"改为 **"best-effort within poll budget、软 deadline 提前退出"**。整体仍 per-account 隔离、**不阻其它账号**。
- **drain 中遇 `ProviderReauthRequired`（与逐条隔离的优先级，精确化）**：drain 逐条 `try/catch` **只隔离普通瞬时异常**（一条坏不阻断同账号其余 drain）；但 `ProviderReauthRequired` **必须重新抛出**（穿过逐条 catch）**停止该账号本轮 drain**——当前 `retrying` 行**保持 retrying**（**不**推进 retryCount、**不**进死信），其余未试行不动，账号级失败沿 `pollOnce → pollAccount → guard` 传播触发 suspend，待重新授权后下轮继续。**禁止**让逐条 catch 吞掉 reauth 继续对着失效连接 drain 后续行。**判别依赖的不变量（须显式守住）**：`instanceof ProviderReauthRequired` 充分**当且仅当**各 sink **裸抛** reauth、不包进 `cause` 链（现 `provider.ts` 构造 `ProviderReauthRequired` 即无 cause、`notifier.notify` 不抛 reauth——本变更须保持此约定）；防御性地，逐条 catch 的判别**应同时 unwrap `.cause`** 再判 `instanceof`，以免未来 sink 包裹 reauth 致隔离失效。
- drain **不在轮内 sleep 退避**：退避是 `nextRetryAt` 时间维度，drain 只取 `nextRetryAt≤now` 的试一次、按结果更新 nextRetryAt。
- **索引（drain 查询的硬要求，迁移必须含）**：`selectDueRetries`（`status='retrying' ∧ nextRetryAt≤now ∧ message.accountId=acct`、按 nextRetryAt 升序）**每 poll 每账号**跑一次；`mail_actions` 现**零索引**。迁移**必须**加 `mail_actions(status, nextRetryAt)` 索引（优先 **partial `WHERE status='retrying'`** 经 raw SQL，使索引不随终态行膨胀），并加 `mail_classifications(messageId, createdAt desc)` 索引（FK 现无索引、重建"最新分类"否则每条 seq scan）。详见迁移计划。
- `// ponytail: 软 deadline 用单调 elapsed（传入起点时刻），不在 drain 内取 Date.now 以保可测；时钟回拨对 nextRetryAt≤now 自愈（回拨→暂缓、前拨→早试幂等）。`

## 风险 / 权衡

- **死信无主动告警** → 决策 3：DB 行 + 脱敏日志可查（status=dead_letter）；**主动告警是非目标**（不宣称"绝不静默"强保证）；后续可加查询 CLI / dead_letter 告警。
- **drain 撑爆轮超时** → 决策 6：条数 cap=50 **+ 软 deadline 提前退出** + per-account 隔离；超时本身只释放名额、属可用性界定（drain 只回放已存裁定、无不安全标已读）。
- **notify 重复推送** → 决策 3：契约修正为 **at-least-once、可能重复**（歧义传输失败：服务端已受理后客户端超时仍记 failed）；staleness 上界限制陈旧重发数量；reflect/markRead 幂等故无害。
- **活跃行重复入队（re-poll × drain）** → 决策 4：`(messageId, actionType)` 活跃态 **partial unique index** + `recordAction` upsert 活跃行，DB 强制至多一条活跃行。
- **瞬时 DB 抖动被永久死信** → 决策 5：重建失败分流——仅"行缺失 / JSON 不可解析"死信；DB 抛 I/O 错误保持 retrying 向上传播。
- **账号 disabled/suspended 期间重试停滞** → 可接受（重新 enable 后下轮继续）；超 staleness 的 notify 进死信、不无限滞留。
- **孤儿 `pending` 行** → notify 已发但 `done` 落库抛出会留一条 `pending` 行（既非终态亦非 `retrying`，drain 只选 `retrying` 故 drain 不碰它）。**与活跃态 partial unique index 的交互（精确化）**：该 `pending` 行占据 `(messageId, actionType)` 的活跃槽，故 re-poll 时 `recordAction` **命中并复用它**（决策 4(2) "命中活跃 `pending` → 复用同行"）→ 重新执行该动作；对 notify 即一次重发，**落在已接受的 at-least-once 预算内**（孤儿本就来自"已发但未记"的 notify）。即孤儿 `pending` **由 re-poll 复用清理、非永久滞留**；本期不额外清扫，accepted residue。
- **`mail_actions` 终态行无限增长** → `done`/`failed`/`skipped`/`dead_letter` 只增不减、无保留期清扫（后续 follow-up）；决策 6 的 **partial 索引**使 drain 索引不随终态行膨胀。
- **历史 `failed` 行被批量回放** → 决策见迁移：本期**不**自动把既有 `failed` 转 `retrying`（避免一次性重放海量旧失败）；只有本期之后新产生的瞬时失败入 `retrying`。

## 迁移计划

Prisma migration（**列 + 索引，同一迁移**）：
- **列**：`mail_actions` 加 `retryCount Int @default(0)`、`nextRetryAt DateTime?`。PG16 上：可空 `nextRetryAt` = 元数据级 ADD COLUMN，无重写；`retryCount Int @default(0) NOT NULL` 用常量默认 = PG11+ 元数据级、无全表回填——既有行兼容（retryCount=0、nextRetryAt=null；drain 只选 `status='retrying'`，旧行不会被选中）。
- **索引（必须、非可选）**：
  - `mail_actions` 活跃态 **partial unique index** on `(messageId, actionType)` `WHERE status IN ('pending','retrying')`（决策 4 的活跃行唯一性强制）。
  - `mail_actions` drain 查询索引 on `(status, nextRetryAt)`，**优先 partial `WHERE status='retrying'`**（决策 6；经 raw SQL，Prisma schema 无法表达 partial）。
  - `mail_classifications(messageId, createdAt desc)`（重建"最新分类"，现 FK 无索引）。
  - 注：`CREATE INDEX` 默认取 `SHARE` 锁阻塞写；表已大时用 `CREATE INDEX CONCURRENTLY`（须独立非事务迁移，不能在 Prisma 包裹事务内）。新表小则普通 `@@index` 可直接 ship。
- **历史 `failed` 行不自动转 retrying**（人工/后续工具按需，非本期）。
- 回滚：两列可空 + 新 status 取值不影响旧代码读 status（自由 String）；回退代码后 `retrying`/`dead_letter` 行只是不再被 drain、保持原状。**注**：partial unique index 回退时须一并 drop（否则旧 `recordAction` 的无条件 INSERT 命中活跃态唯一约束会报错）——回滚脚本 drop 新增索引 + 列。
**注**：主规范（`openspec/specs/`）同步在归档（`openspec-cn archive`）时落地，与变更本地 delta 一致——与既往各期一致。

## 待解决问题

无阻塞。`MAX_DURABLE_ATTEMPTS`(6) / `NOTIFY_STALENESS`(24h) / `DRAIN_BATCH_CAP`(50) / 退避序列均给默认、可后续调（env 或常量）。
