## 新增需求

### 需求:去重幂等、重启不重复
`processEmail` 必须以 `(accountId, providerMessageId)` 为去重键保证幂等：处理前查库，命中且 `processedAt` 非空则**必须跳过**（不再分类、不再执行任何动作），使服务重启或重复投递都**禁止**二次处理同一封邮件。

#### 场景:已处理邮件再次进入被跳过
- **当** 一封 `(accountId, providerMessageId)` 已存在且 `processedAt` 非空的邮件再次调用 `processEmail`
- **那么** 必须直接跳过——不调用分类器、不执行任何标已读/通知动作、不新增 `mail_actions`

#### 场景:新邮件走完整链路并标记处理完
- **当** 一封去重键未处理过的邮件进入 `processEmail`
- **那么** 必须走完整链路并在最后置 `processedAt`，使其后续不再被处理

### 需求:流水线顺序与重启安全
`processEmail` 必须按固定顺序执行：查去重键 → 落库邮件（先落库使去重键存在）→ `classifyEmail` → `applySafetyRules` → 落库分类 → `executeActions` → 最后 `markProcessed`（置 `processedAt`）。`saveEmail` **必须**对去重键 `(accountId, providerMessageId)` 幂等（upsert / get-or-create）——崩溃重跑时若已存在未处理行须复用而非二次插入触发唯一键冲突。`markProcessed` **必须**放在所有动作之后——若在动作中途崩溃（未置 `processedAt`），下次必须重跑该邮件（at-least-once，宁可重复也不漏处理）。若 `classifyEmail` 抛出（耗尽 P1 重试），`processEmail` **必须不吞异常、不置 `processedAt`**，留待下次重跑（at-least-once；P1 的「彻底失败默认」已尽量返回降级 `Classification` 而非抛出）。`saveClassification` 在重跑时可能追加一行；本期接受「append + 读取时按 `createdAt` 降序（`createdAt desc, id desc`）取最新行」，精确去重/supersede 标记属 P6。

#### 场景:动作中途崩溃后可重跑
- **当** 处理在 `executeActions` 中途中断、`processedAt` 未被置位
- **那么** 该邮件去重键仍视为未处理，下次 `processEmail` 必须重新处理它（标已读幂等；推送 at-least-once 可接受）

### 需求:executeActions 按 FinalDecision 分发并落 mail_actions
`executeActions` 必须只执行 `FinalDecision` 指定的动作——这是「涉及标已读动作」的规则引擎兜底：标已读动作**仅当** `FinalDecision.shouldMarkRead` 为 true 时发起（该值已由规则引擎裁定，P4/敏感/低置信邮件为 false），通知动作仅当 `shouldNotifyNow` 为 true 时发起；**禁止**依据原始 `Classification` 直接动作。每个动作必须先以 `pending` 落 `mail_actions`，执行后更新为 `done`/`failed`（含 error）；失败必须有界重试（小常数，**禁止**无限重试），且单个动作失败**禁止**阻断其余动作与 `markProcessed`。重试是**单次 `executeActions` 调用内有界**——内存计数器，只把终态 `done`/`failed` 落 `mail_actions`（无 retryCount 列、不跨重启累计）。无渠道凭据时 `notify` 动作必须**直接**落 `skipped`、**不进入重试循环**、不计入重试预算。`{done, failed, skipped}` 为终态、`pending` 为唯一中间态。P0/P4 通知在单次调用内重试耗尽仍失败时，必须以 `failed` 落 `mail_actions` 且 `markProcessed` **仍然照常执行**（该邮件不再重试）；这是 P2 接受的 **at-most-once-after-retry** 丢失，`markProcessed` **不**以通知成功为前提；持久化跨重启重试/投递队列属 P6。`shouldIncludeDigest` 本期只作标记持久化，不产生动作（摘要属 P5）。

#### 场景:标已读动作只认 FinalDecision
- **当** 一封邮件 `Classification` 建议标已读，但 `FinalDecision.shouldMarkRead` 为 false（如 P4/敏感域名）
- **那么** `executeActions` 必须不发起标已读动作

#### 场景:动作成功落库
- **当** `FinalDecision.shouldMarkRead` 为 true，`executeActions` 经 `ProviderActions` 标已读成功
- **那么** `mail_actions` 必须有一条该动作记录、状态为 `done`

#### 场景:动作失败有界重试且不阻断
- **当** 某个动作（如通知）执行失败
- **那么** 必须以 `failed`（含 error）落 `mail_actions` 并有界重试，且不得阻断其余动作与最终 `markProcessed`

#### 场景:无渠道降级时通知动作记 skipped
- **当** `shouldNotifyNow` 为 true 但无任何通知渠道凭据（通知器降级）
- **那么** 对应 `notify` 动作必须以 `skipped`（区别于 `done`/`failed`）落 `mail_actions` 并含原因，不阻断 `markProcessed`

### 需求:落库处理记录
`processEmail` 必须把处理记录落库（表结构 P0 已建，本期开始写入）：`mail_messages`（邮件 + `processedAt`）、`mail_classifications`（分类/裁定）、`mail_actions`（动作状态/重试），使全过程可查询、可审计。`mail_classifications.confidence` **必须**存**透传的 `Classification.confidence`**（引擎不改写置信度）；`mail_classifications.priority/category/reason` **必须**存 `FinalDecision`（规则裁定后的最终值）；`rawAiJson` **必须**存 `{ aiClassification: <原始 Classification>, finalDecision: { appliedRules, shouldNotifyNow, shouldMarkRead, shouldIncludeDigest, riskFlags } }`，使原始建议 vs 最终裁定与审计可恢复（复用现有 `rawAiJson` Json 列，无需迁移）。动作布尔另由 `mail_actions` 行佐证。`finalDecision` 块**不含** final `priority`/`category`/`reason`/`confidence`——它们在专列、不重复存储；完整 FinalDecision = 专列 + `finalDecision` 块。崩溃重跑时 `saveClassification` 可能追加一行，本期按 `createdAt` 降序（`createdAt desc, id desc`）取最新行（注：`id desc` 仅**尽力**——`cuid()` 非严格单调，P2 离线/单封足够；精确 latest-wins 由 P6 的单调键 / `supersede` 标记保证）。

#### 场景:一次处理写出可查询记录
- **当** 一封新邮件被 `processEmail` 处理完
- **那么** `mail_messages`/`mail_classifications`/`mail_actions` 必须有对应记录可供查询

### 需求:动作 I/O 经可注入 seam（本期假 provider）
真正的标已读/通知 I/O 必须经可注入 seam（`MailRepo` / `ProviderActions` / `Notifier`）执行，使整条流水线离线可测；本期 `ProviderActions` 用**假 provider**（记录调用，不连真实邮箱），真实 IMAP/Gmail 动作属 P3/P4。分类器与规则引擎只产建议与裁定，**禁止**自行执行任何 provider I/O。

#### 场景:离线全链路可测
- **当** 注入内存 `MailRepo` + 假 `ProviderActions` + 假 `Notifier` 并灌入样例邮件
- **那么** 必须无需真实 postgres 或网络即可跑通流水线，并可断言去重跳过、动作记录与推送内容
