# P2 · 规则引擎 + 处理流水线 + 通知（rules-pipeline-notify）

## 为什么

P1 能把一封邮件稳定分类成**校验过的建议**（`Classification`），但建议还不是动作。本项目最硬的
安全边界是「LLM 只给建议，最终动作由规则引擎决定」——这一层必须先做成**离线可端到端验证**的，
再接真实邮箱（P3/P4）。P2 把建议变成**经规则引擎裁定的最终动作**，用一条**可重放、可审计、重启不
重复**的流水线串起「去重 → 落库 → 分类 → 规则兜底 → 落库 → 执行动作 → 标记处理完」，并对 P0/P4
即时推送。用**假 provider** 灌样例邮件即可全链路跑通，把整套分流逻辑的风险在接真实邮箱前清掉。

## 变更内容

- **安全规则引擎** `rules/applySafetyRules.ts`：`(NormalizedEmail, Classification) → FinalDecision`。
  在 LLM 建议之上施加 PROJECT_INIT §12 的**固定安全规则**（强制裁定，建议无权覆盖）：验证码主题强制 P0 +
  立即通知 + 不标已读；`priority=P4` 强制立即通知 + 不标已读；`confidence<0.65` 降级 P1 + 不标已读 + 入摘要；
  敏感域名（银行/医院/保险/支付/合同）与支付/安全关键词强制不标已读。名单用**内置默认**（YAML 可配是 P6）。
- **处理流水线** `processEmail`：去重键 `(accountId, providerMessageId)` 命中已处理则跳过 → 落库邮件 →
  `classifyEmail`（P1）→ `applySafetyRules` → 落库分类（`mail_classifications`）→ `executeActions` →
  标记 `processedAt`。`actions/executeActions.ts` + `actionTypes.ts` 按 `FinalDecision` 分发动作（标已读 /
  推送）并把每个动作的状态/重试落 `mail_actions`。引入**provider 动作 seam**（标已读等），本期用**假 provider**
  实现以离线跑通；真实 IMAP/Gmail 动作在 P3/P4。
- **通知** `notify/notifier.ts` + 一个渠道：telegram：P0/P4 即时推送，格式见 §13；**不泄露完整正文**。bark 作为后续可选渠道，不在本期范围。
- 无需新运行期依赖：通知走全局 `fetch`（Node 24 内置）；`node-cron` 调度属 P3/P4。
- **`processEmail(email: NormalizedEmail, deps)` 接收已规范化的单封邮件**：provider 在调用前完成 normalize + 单封 throw 隔离（那是 P3/P4 轮询循环的义务）；P2 的 `processEmail` 不承担批量 normalize 与隔离。

## 功能 (Capabilities)

### 新增功能
- `safety-rules`: 确定性安全规则引擎——`applySafetyRules` 在分类建议之上施加强制兜底规则，产出权威 `FinalDecision`；纯函数、离线可测。
- `processing-pipeline`: `processEmail` 主流水线——去重、落库、编排分类/规则、`executeActions` 动作分发与 `mail_actions` 落库/重试、`markProcessed`；含 provider 动作 seam（本期假 provider）。
- `notifications`: 通知器 + 一个推送渠道（telegram）——P0/P4 即时推送、固定格式、不泄露完整正文；**仅推送通知，绝不发送邮件**。bark 标为后续可选渠道。

### 修改功能
<!-- 无：本期消费 email-classification / email-model 规范但不改其需求；confidence<0.65 的强制裁定是 safety-rules 的新行为，分类器仍如实上报 confidence。 -->

## 影响

- 新增源码：`src/rules/applySafetyRules.ts`、`src/actions/{executeActions,actionTypes}.ts`、`src/notify/{notifier,telegram}.ts`、`processEmail` 流水线（如 `src/pipeline/processEmail.ts`）、假 provider（测试/离线用）。
- 新增 DB 写入：`mail_messages`（保存 + `processedAt`）、`mail_classifications`（保存）、`mail_actions`（动作状态/重试）。表结构 P0 已建，本期开始写入。
- 消费 P1（`classifyEmail`、`NormalizedEmail`、`Classification`）与 P0（`config`、`prisma`、`logger`）。
- 无新运行期依赖（通知用全局 `fetch`）；通知渠道密钥（本期 `TELEGRAM_*`）从 P0 `config` 读（如缺则补为 optional，落在 P0 已允许的后续阶段变量范围内）。
- 离线自检：假 provider + 样例邮件全链路跑通，断言 P0/P4 推送、P2/P3 标已读动作落 `mail_actions`、重复邮件不二次处理。

## 非目标

- **不接真实 provider**（IMAP=P3 / Gmail=P4）——本期用假 provider 跑通流水线；真实标已读/移动文件夹动作属 P3/P4。
- **不做 YAML 规则可配**（P6）——名单（VIP/重要域名/不标已读域名/关键词）本期用内置默认。
- **不做摘要的构建与发送**（P5）——规则引擎只置 `should_include_digest` 标记，本期不构建摘要、不写 `digest_items`、不发摘要。
- **不做 node-cron 轮询调度**（P3/P4 接 provider 时引入）——本期 `processEmail` 以单封为单位被调用。
- **绝不发送/回复邮件**——通知只推送到 telegram 等聊天渠道。
- 不做 GUI、规则学习、向量库、MCP、附件深解析、多账号并发互斥锁（互斥锁属 P6 稳定性）。
