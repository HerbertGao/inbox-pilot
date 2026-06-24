## 1. 数据模型 + repo（label 列）

- [x] 1.1 `prisma/schema.prisma`：`MailAccount` 新增 `label String?`（可空，注释:展示别名、允许 Unicode、区别于严格-ASCII 主键 `id`、NULL → 渲染回落账号 `email`）；生成 migration（仅加可空列、无回填）。
- [x] 1.2 `src/repo/mailRepo.ts`：`AccountWriteInput` 加 `label?: string`；`StoredAccount` 加 `label: string | null`；**行创建分支**（`createAccount` + `upsertAccount.create`）写 `label: input.label ?? null`；`upsertAccount` 的 `update` 分支**一律不含** `label`（保留=列不动；同 `processFrom`）；**三处 prisma select**（`listEnabledAccounts` :525、`listAccounts` :548、`getAccountById` :571）加 `label: true`。`src/repo/inMemoryMailRepo.ts`：`StoredAccount` 镜像 + `upsertAccount` get-before-set 保留 `existing.label`、create 用 `input.label ?? null`（与 `processFrom` 同一 preserve 路径）。

## 2. label/email 穿透链（5 跳，镜像 processFrom；漏一跳别名静默丢）

- [x] 2.1 `src/providers/provider.ts`：`ImapAccount`（:~57）与 `GmailAccount`（:~76）各加 `accountLabel?: string`（承载注册表解析出的「显示名 = label ?? email」；镜像既有 `processFrom`）。
- [x] 2.2 `src/accounts/accountRegistry.ts`：`parseImap`（:~86）/`parseGmail`（:~101）字面量**显式枚举** `accountLabel: row.label?.trim() || row.email`（**不显式写则 spread 凭空丢失**——见该文件既有注释）。`row` 即 `StoredAccount`（含 1.2 新增 `label`/既有 `email`）。
- [x] 2.3 `src/main.ts`：构造 poller deps 处（gmail :~183 / imap `pollAccount` 接线）把 `account.accountLabel` 放进 deps（同 `processFrom` 接线;`main.ts:182` 注释已示「漏此跳静默 no-op」之坑）。
- [x] 2.4 `src/normalizer/normalizeEmail.ts`：`NormalizedEmail` 与 `RawEmail` 加 `accountLabel?: string`；`normalizeEmail` 从 `raw.accountLabel` 透传（不改既有字段）。
- [x] 2.5 IMAP/Gmail poller（`imapPoller.ts` `toRawEmail` :~261 / `gmailPoller.ts` `toRawEmail` :~269）：`toRawEmail` 签名加 `accountLabel` 参,与既有 `accountId` **同处传入**:Gmail `toRawEmail(message, accountId)` 同参传入;IMAP `accountId` 是**位置参**串 `pollOnce(accountId)`→`processOne(…,accountId,…)`→`toRawEmail(fetched,uidValidity,accountId)`,须**同步加宽** `pollOnce`/`processOne`/`toRawEmail` 签名、一并位置传 `accountLabel`（非闭包捕获）。构造 `RawEmail` 时填 `accountLabel`。
- [x] 2.6 **retry/drain 路径**（`src/actions/retryQueue.ts` → `src/repo/mailRepo.ts` `rebuildNormalizedEmail` :~460,823）：rebuild 的 account select 补 `label`+`email`;`rebuildNormalizedEmail` 签名**加 `accountLabel` 参**(不折进 `MessageRebuildInput`/msg)——两调用点（`mailRepo.ts:~870`、`inMemoryMailRepo.ts:~458`）锁步同传 `accountLabel = label?.trim() || email`,使重试通知与首发一致指明邮箱。（若该改动超预期 → 退而接受 retry 走裸-accountId 回落、在此标注 accept-degraded。）

## 3. 通知投影 + 渲染

- [x] 3.1 `src/notify/notifier.ts`：`NotificationPayload` 加 `readonly accountId: string` 与 `readonly accountLabel?: string`（仍白名单、无正文）；`projectPayload` 投影 `email.accountId` / `email.accountLabel`。
- [x] 3.2 新 `src/notify/categoryLabels.ts`：`export const CATEGORY_LABELS: Record<Category, string>` 覆盖全 9 枚举（personal=个人 / work=工作 / finance=财务 / system_alert=系统告警 / security=安全 / newsletter=资讯 / marketing=营销 / transaction=交易 / unknown=未知）；`Record<Category,…>` 使新增枚举臂**编译失败**。
- [x] 3.3 `src/notify/telegram.ts` `renderTelegramText`：合并 P0/P4 为**单一模板**——`[优先级] 主题` / `邮箱:<mailboxLabel>` / `发件人` / `原因` / `分类:#${CATEGORY_LABELS[category]}` / `置信度`；**sanitize-then-fallback**:`const fromLabel = sanitizeSource(payload.accountLabel ?? '').trim(); mailboxLabel = fromLabel || payload.accountId`——先净化 label 候选、净化后空才回落**裸 accountId**（ASCII、`sanitizeSource` no-op、必非空）→ **绝不空**。**不可** `sanitizeSource(accountLabel || accountId)`（全-bidi/控制的 accountLabel〔经未校验 `--email`〕pre-sanitize 非空会被 `||` 选中、再净化成空 → 空「邮箱:」违反「绝不空」）。`sanitizeSource(s)` 带 `u`+`g` flag 剥除 `s` 中**所有** `\p{Cc}`/`\p{Cf}`/U+2028/U+2029/U+2066–U+2069（单点防御:`email` 是 IMAP `--email` 未按 denylist 校验的自由文本,统一净化、防 RTL-override 等经 email 伪装来源;`label` 已 add 校验、`accountId` 已 ASCII,为 no-op）；`riskFlags` **非空才**加风险行；`priority==='P4'` 才附安全提示。删原两分支。

## 4. CLI --label

- [x] 4.1 `src/cli/account.ts`：**`cmdAddImap` 与 `cmdAddGmail` 两处**解析可选 `--label <名>`。新增 `validateLabel`：① `flags.bools.has('label')`（值缺位、下 token 以 `-` 开头）→ `errln('--label 需要值参数 <名>')` + 退出码 2（同 `resolveProcessFromFlag` 守卫）；② `.trim()` 后非空，否则拒;③ **拒** `\p{Cc}`/`\p{Cf}`/U+2028/U+2029/U+2066-2069（带 `u` flag）;④ ≤ 64 码元。失败 → 退出码 2、**不**触达 repo 写。合法值经 `AccountWriteInput.label` 传入（仅 create 生效）。account-id 既有严格 ASCII 校验**不动**；CLI 成功/错误行回显 `label` 经 `JSON.stringify` 转义（双层防注入，同 `JSON.stringify(id)`）；`label`/`accountLabel` **不**进任何结构化日志字段。

## 5. 测试

- [x] 5.1 `src/notify/categoryLabels.test.ts`：运行期遍历 `ClassificationSchema` 全部 category 枚举臂断言都有中文映射（+ `Record` 编译期约束双保险）。
- [x] 5.2 **新建** `src/notify/telegram.test.ts`：P0 与 P4 同一字段模板;`mailboxLabel`——设了 `accountLabel`(label/email)用之、缺失回落裸 `accountId`、**绝不空**;分类中文 hashtag;`riskFlags` 空**不**出风险行、非空出（含 P0 非空出风险行的行为变更）;仅 P4 出安全提示;渲染文本与 payload **不含** `textBody`/`htmlBody`（结构断言）;**来源净化**:`accountLabel`/email-回落含 `\p{Cc}`/`\p{Cf}`/U+202E/U+2028 时,渲染文本已剥除这些码点（断言输出不含该类字符）;**净化后非空**:`accountLabel` 为纯 bidi/控制字符（净化后为空）→ 断言渲染回落裸 `accountId`、`邮箱:` 行**非空**（守 sanitize-then-fallback，防净化成空）。
- [x] 5.3 `src/cli/account.test.ts`：`--label 公司邮箱` → create 入参 `label='公司邮箱'`;**值缺位** `--label --gmail` → 退出码 2、不建账号;**非法** label（`\n`/`\t`/NUL/**U+202E**/**U+200B**/**U+2028**/超长）→ 退出码 2、不触达 repo 写;空白 `   ` → 拒;既有账号 `add --label`（update 分支）不改 label;中文 `--label` 下 account-id 仍经 ASCII 校验;`--label` 在 imap 与 gmail 两子命令均生效;回显经 `JSON.stringify`;**CLI 结构化日志记录亦不含** `label`/`accountLabel`（与 notify 侧 5.4 同守「label 不进结构化日志」）。
- [x] 5.4 `src/notify/notifier.test.ts`：`projectPayload` 含 `accountId`/`accountLabel`、不含正文;poller 填 `accountLabel`（驱动真实入口）;**retry/drain 路径**（`rebuildNormalizedEmail`）:seed 账号 `label` **非空且≠email**,断言重建 email 的 `accountLabel` = 该 **label**（非 email 回落、否则 label 掉出 rebuild select 也会经 email 回落**空过**）;**日志断言**:notify 日志记录字段仍 `{kind,priority,channel,error}`、**不含** `label`/`accountLabel`（守「label 不进结构化日志」、防回归）。
- [x] 5.5 确认 `account add --json` 输出白名单 `{id,provider,email,enabled}` **不变**（label 仅人类可读输出、不进 --json）。

## 6. 验收

- [x] 6.1 `pnpm exec tsc --noEmit` clean（含 `Record<Category,string>` 全枚举编译检查）+ 全量 `pnpm test` 绿（542/542）；migration `add_account_label` 已生成（`ALTER TABLE … ADD COLUMN "label" TEXT`，可空无回填；live-DB `migrate deploy` 在部署启动期由 Dockerfile 跑）;`account add … --label 公司邮箱` 后通知渲染该别名、未设账号渲染账号 `email`、retry 通知亦指明邮箱。
