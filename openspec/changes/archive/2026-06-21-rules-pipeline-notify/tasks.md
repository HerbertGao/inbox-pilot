## 0. 约束（贯穿全程）

- [x] 0.1 ESM/NodeNext：src/ 内相对 import 必须带 `.js` 扩展名（沿用 P0/P1）
- [x] 0.2 LLM 只给建议，动作只认规则引擎产出的 `FinalDecision`；密钥只从 `config` 读、不写死、不入日志；通知/日志不泄露完整正文
- [x] 0.3 本期不接真实 provider、不做 YAML 可配/摘要构建/cron 调度、不加互斥锁；**绝不发送/回复邮件**——越界即停

## 1. 类型与脚手架

- [x] 1.1 `FinalDecision` 类型（priority/category/confidence（透传，引擎不改写）/shouldNotifyNow/shouldMarkRead/shouldIncludeDigest/reason/riskFlags/appliedRules）+ 内置默认名单常量（验证码、支付/安全关键词、敏感域名）
- [x] 1.2 扩展 `config` schema 加 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` 为 `.optional()`（如缺）；确认 logger `redact` 覆盖这些凭据（bark 属后续可选渠道，本期不加 `BARK_ENDPOINT`）
- [x] 1.3 测试沿用 `node:test` + 已装 `tsx`；通知用全局 `fetch`（Node 24 内置）——**无新运行期/测试依赖**

## 2. 安全规则引擎 safety-rules

- [x] 2.1 `src/rules/applySafetyRules.ts`：纯函数 `(email: NormalizedEmail, classification: Classification) → FinalDecision`，无 I/O、无副作用；记 `appliedRules`（对应 spec「规则引擎为最终动作的唯一权威」）
- [x] 2.2 最终优先级裁定：**仅主题**命中验证码→强制 `P0`（对齐 §12 `subjectContainsVerificationCode`；正文验证码/安全关键词改走护栏、不强制 P0）；否则 `P4` 保持；否则 `confidence<0.65`→降级 `P1`；否则取建议 priority（对应 spec「优先级强制裁定」）
- [x] 2.3 强制不标已读护栏 + 单调趋安全：P0/P1/P4→不标已读；敏感域名（内置默认）/支付·安全关键词覆盖 P2/P3→`shouldMarkRead=false`；已置 false 不得翻回（对应 spec「强制不标已读护栏」）
- [x] 2.4 按 §5 派生动作：`shouldNotifyNow = priority∈{P0,P4}`；`shouldIncludeDigest = priority∈{P1,P2}`；P2/P3 默认标已读（受护栏约束）；P3 不入摘要（对应 spec「按最终优先级派生默认动作」）。名单用内置默认、不读 YAML（对应 spec「名单用内置默认」）

## 3. seam 与落库（MailRepo / ProviderActions）

- [x] 3.1 `MailRepo` 接口（`findByDedupKey`/`saveEmail`/`saveClassification`/`recordAction`/`updateAction`/`markProcessed`）+ prisma 实现（真身）+ 内存实现（测试用）——把 prisma 细节挡在流水线外（对应 spec「动作 I/O 经可注入 seam」「落库处理记录」）
- [x] 3.2 `ProviderActions` 接口（`markRead(email)` 等）+ **假 provider**（记录调用，不连真实邮箱）；真实 IMAP/Gmail 属 P3/P4
- [x] 3.3 `src/actions/actionTypes.ts`：动作类型（`mark_read`/`notify`）与状态（`pending`/`done`/`failed`/`skipped`）枚举/类型

## 4. 通知 notifications

- [x] 4.1 `src/notify/notifier.ts`：`Notifier`（`notify(decision, email)`）+ 渠道 seam；选渠道（`TELEGRAM_*` 全齐→telegram；否则记日志降级不崩）（对应 spec「渠道缺失时降级不崩」）
- [x] 4.2 telegram 渠道（全局 `fetch`）；§13 格式 P0/P4 模板（subject/发件人/原因/分类/置信度；P4 加风险 + 「不要点链接，请进官网核验」）；**只取必要字段、禁含完整正文**（对应 spec「通知不泄露完整正文」「仅推送通知，绝不发送邮件」）
- [x] 4.3 推送失败：不抛、记结构化日志（不含凭据/正文）；交由 executeActions 落 `mail_actions` 状态（对应 spec「通知密钥只从配置读、不入日志」）

## 5. 动作分发 executeActions

- [x] 5.1 `src/actions/executeActions.ts`：按 `FinalDecision` 分发——`shouldMarkRead`→经 `ProviderActions` 标已读；`shouldNotifyNow`→经 `Notifier` 推送；**只认 FinalDecision、不据原始 Classification 动作**；`shouldIncludeDigest` 只持久化标记不产生动作（对应 spec「executeActions 按 FinalDecision 分发并落 mail_actions」）
- [x] 5.2 每动作先 `recordAction(pending)`→执行后 `updateAction(done|failed|skipped,error?)`；失败**单次调用内**有界重试（内存计数器，小常数，禁无限；只把终态落 `mail_actions`，无 retryCount 列、不跨重启累计；durable 跨重启重试预算属 P6）；单动作失败不阻断其余动作与 `markProcessed`；无渠道降级时**直接**记 `skipped`、不进入重试循环、不计入重试预算（`{done,failed,skipped}` 为终态、`pending` 为唯一中间态）

## 6. 流水线 processEmail

- [x] 6.1 `src/pipeline/processEmail.ts`：`findByDedupKey`→命中且 `processedAt` 非空则跳过（不分类/不动作）→`saveEmail`→`classifyEmail`→`applySafetyRules`→`saveClassification`→`executeActions`→`markProcessed`（对应 spec「去重幂等、重启不重复」「流水线顺序与重启安全」）
- [x] 6.2 `markProcessed` 置于所有动作之后；动作中途崩溃（未置 processedAt）→ 下次重跑（at-least-once；标已读幂等）
- [x] 6.3 `processEmail(email, deps)` 的 deps（`repo`/`provider`/`notifier`/`classify`）可注入，默认接真身、测试注入假体（对应 spec「离线全链路可测」）

## 7. 离线验收

- [x] 7.1 `applySafetyRules` 纯函数单测（`node:test`）：验证码→P0/通知/不读；P4→通知/不读；confidence<0.65→P1/不读/digest；敏感域名 & 支付关键词覆盖 P2/P3→不读；§5 派生表（P2 读+摘要、P3 读+计数、notify=P0/P4、digest=P1/P2）；单调趋安全（force-no-read 不翻回）；边界：`confidence===0.65`（不降级）、`P4 + 低置信→保持 P4`、`P0(验证码) + 低置信→保持 P0`
- [x] 7.2 `processEmail` 离线全链路自检（内存 `MailRepo` + 假 `ProviderActions` + 假 `Notifier` + 注入假 `chat`/classify）：
  - P0/P4 → `Notifier` 推送（断言格式 + **不含完整正文**：结构断言——传给 `Notifier` 的入参只含白名单字段（subject/from/reason/category/confidence/riskFlags），`textBody`/`htmlBody` **不在** notifier 调用入参中）、不标已读、`mail_actions` 有 `notify(done)`
  - P2 普通 → `ProviderActions.markRead` 调用 + `mail_actions` `mark_read(done)`、不推送
  - 敏感域名 P2 → **不**调用 markRead（FinalDecision 护栏）
  - confidence<0.65 → 降级 P1、不标已读、digest 标记持久化
  - 验证码主题 → P0、推送、不标已读
  - 落库可恢复 → 处理后从 `rawAiJson` 读回 `appliedRules` 与 `shouldIncludeDigest` 标记，且原始 priority 与 final priority 都可恢复；`confidence` 也可恢复（final confidence === raw confidence，引擎透传不改写）
  - 重复邮件（已 `processedAt`）→ 跳过：classify **0 次调用**、无新 `mail_actions`
  - 已 saveEmail 但未 `processedAt` 的重跑路径（区别于已 `processedAt` 的跳过）→ 复用该行、不抛唯一键冲突
  - 动作失败 → `mail_actions(failed)` + **单次调用内** ≤N 次尝试（不声称跨重启累计），不阻断 `markProcessed`
  - 无渠道配置 → 降级记日志、不抛、流水线照常完成、对应 `notify` 动作记 `skipped`
  - 失败日志脱敏 → 推送失败时结构断言：log 入参不含 `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`，也不含 `textBody`/`htmlBody`（硬约束：密钥/正文不入日志）
- [x] 7.3 `pnpm test` 通过（含上述）且 `pnpm build`（tsc）通过；P0 `/health`、P1 分类器不受影响（本期未改其代码）
