## 上下文

P0 立了骨架（config/prisma/logger/5 表），P1 给出校验过的 `Classification`（LLM 建议）。P2 把建议变成
**经规则引擎裁定的最终动作**并端到端跑通：去重 → 落库 → 分类 → 规则兜底 → 落库 → 执行动作 → 标记处理完，
对 P0/P4 推送。本项目最硬的约束「LLM 只给建议、动作由 `applySafetyRules` 决定」就落在本期。技术栈沿用
（Node 24 + TS ESM + zod4 + prisma + 全局 fetch）。本期不接真实 provider、不做 YAML 可配、不做摘要/调度——
用**假 provider + 内存 repo + 假通知渠道**离线全链路验证。

## 目标 / 非目标

**目标：**
- `applySafetyRules(email, classification) → FinalDecision`：纯函数、确定性、只会让结果**更安全**（强制通知 / 强制不标已读 / 降级），离线可测。
- `processEmail`：去重键 `(accountId, providerMessageId)` 幂等、重启不重复；编排分类/规则/动作；落库 `mail_messages`/`mail_classifications`/`mail_actions`。
- `executeActions`：按 `FinalDecision` 分发标已读 / 推送动作，每个动作状态/重试落 `mail_actions`。
- 通知器 + 一个渠道（telegram）：P0/P4 即时推送、§13 格式、不泄露完整正文。
- **整条流水线离线可测**：repo / provider / notifier 三个 seam 可注入，测试用内存/假实现，无需真实 postgres 或网络。

**非目标：**
- 真实 IMAP/Gmail provider 与真实标已读/移动文件夹（P3/P4）；YAML 规则可配（P6）；摘要构建/发送 + `digest_items`（P5）；node-cron 轮询（P3/P4）；单账号互斥锁（P6）。
- 不发送/回复邮件——通知只推聊天渠道。

## 决策

- **`FinalDecision` 与 `Classification` 分离**。`Classification` 是 LLM 建议（P1）；`FinalDecision` 是规则引擎的**权威裁定**，下游动作只认 `FinalDecision`。字段：`priority`/`category`/`confidence`/`shouldNotifyNow`/`shouldMarkRead`/`shouldIncludeDigest`/`reason`/`riskFlags`/`appliedRules`（命中的规则名，便于审计）。

- **字段映射（`Classification` snake_case → `FinalDecision` camelCase）**：

  | `Classification`（建议，P1 schema） | `FinalDecision`（裁定） |
  | --- | --- |
  | `should_mark_read` | `shouldMarkRead`（**忽略建议值，重新派生**） |
  | `should_notify_now` | `shouldNotifyNow`（**忽略建议值，重新派生**） |
  | `should_include_digest` | `shouldIncludeDigest`（**忽略建议值，重新派生**） |
  | `risk_flags` | `riskFlags`（透传；规则可追加） |
  | `confidence` | `confidence`（透传，引擎不改写） |
  | —（规则产出） | `appliedRules`（命中的规则名） |

  `FinalDecision.riskFlags` = `classification.risk_flags` 透传（规则命中可追加）。`applySafetyRules` **忽略** `classification.should_*` 三个动作布尔，全部从「最终优先级 + 护栏」重新派生——建议无权直接驱动动作。

- **`applySafetyRules` 确定性裁定，单调趋安全**。从 classification 出发，按固定顺序施加 §12 规则；任一「强制不标已读」一旦置位即**粘住**（后续不得翻回 true）。最终优先级与动作由 PROJECT_INIT §5 优先级模型派生：
  - **最终优先级**：验证码主题 → `P0`；否则 classification 为 `P4` → 保持 `P4`；否则 `confidence<0.65` → 降级 `P1`；否则取 classification.priority。
  - **派生动作**（§5 表）：P0/P4 → 通知、不标已读；P1 → 入摘要、不标已读；P2 → 标已读、入摘要；P3 → 标已读、只计数。
  - **强制不标已读护栏**（覆盖 P2/P3 的标已读）：发件域命中敏感域名（内置默认：银行/医院/保险/支付/合同）或正文/主题命中支付/安全关键词 → `shouldMarkRead=false`。
  名单（验证码/支付/安全关键词、敏感域名）用**内置默认常量**；YAML 可配是 P6。`confidence<0.65` 的强制裁定本期落地（P1 只做了「彻底失败」默认；分类器仍如实上报 confidence）。
  <!-- ponytail: 决策表能从「最终优先级 + 护栏」纯函数派生，不需要规则 DSL/引擎框架；内置常量名单足够，YAML 留 P6。 -->

- **三个可注入 seam，让整条流水线离线可测**（沿用 P1 的 chat-seam 思路）：
  - `MailRepo`（`findByDedupKey` / `saveEmail` / `saveClassification` / `recordAction`+`updateAction` / `markProcessed`）：prisma 实现为真身，测试用内存实现。把 prisma 细节挡在 `processEmail` 外。
  - `ProviderActions`（`markRead(email)` 等）：本期**假 provider**（记录调用）；真实 IMAP/Gmail 在 P3/P4。
  - `Notifier`（`notify(decision, email)`）：内含渠道 seam；测试用假渠道断言「格式正确 + 不含完整正文」，不发真实 HTTP。
  `processEmail(email: NormalizedEmail, deps)` 与 `executeActions(email, decision, deps)` 都吃这些 deps，默认接真身、测试注入假体。`processEmail` 接收**已规范化**的单封邮件——provider 在调用前完成 normalize + 单封 throw 隔离（P3/P4 轮询循环的义务）；P2 的 `processEmail` 不承担批量 normalize 与隔离，关掉 P1→P2 悬空的隔离义务。

- **`processEmail` 流水线顺序与重启安全**（§10）：`findByDedupKey` → 命中且 `processedAt` 非空则**跳过**（不再分类/动作，幂等）→ `saveEmail`（先落库使去重键存在）→ `classifyEmail` → `applySafetyRules` → `saveClassification` → `executeActions` → `markProcessed`（最后置 `processedAt`）。`markProcessed` 放最后：崩在动作中途 → 下次重跑（at-least-once）。标已读幂等；推送 at-least-once 极端情况下可能重复一次——MVP 可接受，事务/精确一次留 P6。`saveEmail` 对去重键幂等（upsert / get-or-create on `(accountId, providerMessageId)`）：崩溃重跑时复用已存在的未处理行，不二次插入触发唯一键冲突。`saveClassification` 重跑可能追加一行；本期接受「append + 读取时按 `createdAt` 降序（`createdAt desc, id desc`）取最新行」，精确去重/supersede 标记属 P6。

- **落库映射（raw vs final 可恢复，无需迁移）**：`mail_classifications.confidence` 存**透传的 `Classification.confidence`**（引擎不改写置信度，仅作 <0.65 降级判断的输入）；`mail_classifications.priority/category/reason` 存 **`FinalDecision`（规则裁定后的最终值）**；`rawAiJson` 存 `{ aiClassification: <原始 Classification>, finalDecision: { appliedRules, shouldNotifyNow, shouldMarkRead, shouldIncludeDigest, riskFlags } }`，使原始建议 vs 最终裁定与审计可恢复。动作布尔另由 `mail_actions` 行佐证。复用现有 `rawAiJson` Json 列，**不需要 schema 迁移**。

- **`executeActions` + `mail_actions` 状态机**：按 `FinalDecision` 生成动作集——`shouldMarkRead` → `mark_read` 动作（调 `ProviderActions`）；`shouldNotifyNow` → `notify` 动作（调 `Notifier`）。每个动作先 `recordAction(pending)`，执行后 `updateAction(done|failed|skipped, error?)`（`{done,failed,skipped}` 为终态、`pending` 为唯一中间态）；失败有界重试（小常数，禁无限），无渠道凭据的 `notify` 动作**直接**落 `skipped`、不进入重试循环、不计入重试预算。`shouldIncludeDigest` 只作为标记持久化（随分类/决策落库），**不在本期产生动作**（摘要是 P5）。

- **通知渠道：telegram，走全局 `fetch`，无新依赖**。`Notifier` 选渠道：`TELEGRAM_*` 全齐 → telegram；否则记日志降级（不崩）。§13 格式：P0 `[P0 邮件] subject / 发件人 / 原因 / 分类 / 置信度`；P4 `[P4 风险邮件] subject / 发件人 / 风险 / 原因 + 「不要点链接，请进官网核验」`。**只取这些字段，绝不放完整正文**。本期 `TELEGRAM_*` 从 P0 `config` 读（缺则补为 optional）；bark 作为后续可选渠道，本期不引入 `BARK_*`（也消掉其 redact 隐患）。

- **ESM/.js 扩展名、密钥只从 config、zod4** 沿用 P0/P1。

## 风险 / 权衡

- [崩在 markProcessed 之前 → 重跑重复动作] → 标已读幂等；推送 at-least-once 可能极少重复。精确一次（事务包裹 / 动作幂等键）留 P6；本期宁可重复一次也不漏处理。
- [内存 repo 测试 ≠ 真实 prisma 行为] → 本期离线测证明编排/去重/动作记录逻辑；prisma 实现的唯一键/SQL 行为在 P3/P4 接真实 DB 时随真库验证（或单独一条薄测试）。已知不在 P2 离线可证范围。
- [通知 HTTP 失败] → 记 `mail_actions` failed + **单次 `executeActions` 调用内**有界重试（内存计数器，只把终态 `done`/`failed` 落 `mail_actions`；无 retryCount 列、不跨重启累计）；不阻断流水线（其余动作照常、`markProcessed` 照常）。P0/P4 通知在单次调用内重试耗尽仍失败 → 落 `failed`，`markProcessed` **仍照常执行**、该邮件不再重试——这是 P2 接受的 **at-most-once-after-retry** 丢失，`markProcessed` 不以通知成功为前提。**持久化跨重启重试预算 / 投递队列属 P6**（届时引入 retryCount 列或队列，不改本期 seam）。
- [无渠道凭据] → 通知器降级记日志，对应 `notify` 动作记 `skipped`（区别于 `done`/`failed`）含原因；不抛、不阻断 `markProcessed`。
- [敏感域名/关键词内置名单不全] → 本期默认名单覆盖 §12 示例；可配化与扩充是 P6，届时不改引擎只换数据源。
