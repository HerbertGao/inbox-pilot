## 为什么

动作发送态**瞬时失败**（如 Telegram 抖动、IMAP/Gmail 临时不可用）当前只在**进程内单封单轮**有界重试（`executeActions` MAX_ATTEMPTS=3 + P6 ≤~1s 退避），耗尽即落 `mail_actions` 终态 `failed`，而 `markProcessed` 仍照常置 `processedAt`（不以动作成功为前提）。`processEmail.ts` 文件头已明示这一取舍：「P0/P4 通知重试耗尽仍 failed 时 markProcessed 仍照常，该邮件不再重试（at-most-once-after-retry）」。后果：一次 ~1s 的网络抖动就能让一封 **P0/P4 邮件的即时推送/标已读永久丢失**——邮件不再被 re-poll（`processedAt` 已置），也没有任何机制重试那条 `failed` 动作。这是 P6 显式延后、生产不可接受的稳定性缺口。

## 变更内容

- **新增 `durable-retry` 能力**：`mail_actions` 的瞬时失败动作获得**跨重启**的持久化重试，直到成功或进**死信**。
  - 瞬时耗尽分支由落终态 `failed` 改为落 **`retrying`**（带 `retryCount` + `nextRetryAt`）。
  - **重试排空（drain）折叠进既有 poll**：每账号在其 poll 周期内、**复用已开的 provider 连接 + 已持有的 per-account 锁**，排空该账号 `nextRetryAt ≤ now` 的可重试动作（标已读/优先级需 live provider 连接；通知账号无关）。不引入独立 sweep job、不重建 provider、不新增并发面。
  - **长程指数退避**（分钟~小时级，区别于 P6 轮内 ≤~1s），`nextRetryAt` 落库；`retryCount` 达上限（如 5~7）→ **`dead_letter`**（终态、可查、记脱敏日志、绝不自动再试）。
  - **重试复用已存 `FinalDecision`**（从 `mail_classifications` 重建），**绝不重新 LLM 分类改判**；`NormalizedEmail` 从 `mail_messages` 重建（`providerMessageId` 等）。
  - **通知 staleness 上界**：超过时限的旧 `retrying` 通知动作直接进 `dead_letter`、不再补发（避免补发数天前已无意义的 P0）。
- **修改 `processing-pipeline`**：`executeActions` 三动作（reflectPriority/markRead/notify）的**发送态瞬时耗尽**由终态 `failed` 改为可重试 `retrying`（首次入队）；`markProcessed` **保持最后且无条件**（瞬时失败仍置 `processedAt`，避免 re-poll 重跑整条流水线/重分类/重发其它动作）——durable 重试在 **`mail_actions` 行粒度**操作，与 email 粒度的 re-poll 兜底**互补、不重叠**。`ProviderReauthRequired` 致命通道不变（账号级、走 suspend）。

## 功能 (Capabilities)

### 新增功能
- `durable-retry`: 动作的跨重启持久化重试与死信队列——`retrying`/`dead_letter` 状态模型（`retryCount`/`nextRetryAt`，活跃行唯一性由 partial unique index + `recordAction` upsert 强制）；每账号 poll 周期内（`pollOnce`/`gmailPoll` 体内）复用 live provider + 锁、注入 notifier 的有界 drain（条数 cap + 软 deadline）；长程指数退避 + 上限（retryCount≥6）+ notify staleness 上界 → 死信；从 `mail_messages`+`mail_classifications` 重建动作输入（action-input-sufficient 投影 + createdAt/id 取最新裁定、不重新分类；瞬时 DB 错误不死信）；幂等性（reflectPriority/markRead 幂等；notify **at-least-once**——歧义传输失败可能重复，best-effort）；死信 DB 可查 + 脱敏日志（主动告警非目标）。

### 修改功能
- `processing-pipeline`: `executeActions` 瞬时耗尽落 `retrying`（取代终态 `failed`、首次入队 `retryCount=0` + `nextRetryAt`）；`markProcessed` 仍最后无条件；durable 重试为 `mail_actions` 行粒度、与 re-poll 互补。固定动作顺序与 reauth 致命通道不变。

## 影响

- **Schema 迁移**：`mail_actions` 新增 `retryCount Int @default(0)`、`nextRetryAt DateTime?`；`status` 复用自由 String 新增取值 `retrying`、`dead_letter`（无 enum 迁移）。**同一迁移加索引（必须）**：`mail_actions` 活跃态 partial unique index `(messageId, actionType) WHERE status IN ('pending','retrying')`、`mail_actions(status, nextRetryAt)`（优先 partial `WHERE status='retrying'`）、`mail_classifications(messageId, createdAt desc)`。列为元数据级（PG16 无重写）；既有行兼容（默认 retryCount=0、nextRetryAt=null）。
- **新增**：`src/actions/retryQueue.ts`（选取到期可重试动作、重建输入、单动作重试、状态推进/死信、软 deadline 提前退出）+ 测试；`repo` 新增查询/更新方法（选 due 重试行、置 retrying/dead_letter、`recordAction` 改 upsert 活跃行）。
- **修改**：`src/actions/actionTypes.ts`（`ActionStatus` 联合 + const 新增 `retrying`/`dead_letter`，否则 `tsc` 不过）、`src/actions/executeActions.ts`（瞬时耗尽落 `retrying` 而非 `failed`；按 `recordAction` 信号 SKIP 已 `retrying` 动作）、`src/providers/imap/imapPoller.ts`（**在 `pollOnce` 体内**接 drain，复用 connection-bound provider/锁）与 `src/providers/gmail/gmailPoller.ts`（`gmailPoll` 体内接 drain）——**两者 poll deps 新增 `notifier` 字段**（drain 重试 notify 依赖）、`src/main.ts`（透传 notifier）、`src/repo/mailRepo.ts`（动作重试查询/更新 + `recordAction` upsert 分流 + 重建读取分流）、`prisma/schema.prisma`（列 + 索引迁移）。
- **硬约束不变**：绝不自动发送/回复；LLM 只建议、`applySafetyRules` 裁定（重试不重新分类、重建用 createdAt+id 取最新行不改判）；P4 永不自动标已读；通知不泄露完整正文；凭据/解析值/PII 绝不入日志；去重键 `(accountId, providerMessageId)` 重启不重复；notify 为 **at-least-once**（歧义传输失败下可能重复推送，best-effort——见 design 决策 3）。
- **数据**：一次 schema 迁移；无破坏性数据变更。
