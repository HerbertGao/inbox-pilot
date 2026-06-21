## 1. 依赖与配置

- [x] 1.1 `pnpm add imapflow node-cron` + `pnpm add -D @types/node-cron`（node-cron 无内置类型）；确认锁文件与 `pnpm install` 通过
- [x] 1.2 在 `src/config/config.ts` 增加可选项：`IMAP_HOST` / `IMAP_PORT`(默认 993) / `IMAP_USER` / `IMAP_PASSWORD` / `IMAP_TLS`(默认 true) / `IMAP_ACCOUNT_ID`(可选) / `POLL_INTERVAL_SECONDS`(默认 180)；全部 optional，**每键经 `z.preprocess(emptyToUndefined, ...)`** 使空串归一为 undefined（参照既有 OPENROUTER_* 键——`emptyToUndefined` 不自动全局生效）
- [x] 1.3 在 `src/logger.ts` redact paths **新增** `IMAP_PASSWORD` 与 `*.IMAP_PASSWORD`（pino 不支持 key 后缀通配，须逐键枚举，参照既有 `OPENROUTER_API_KEY` 等）；并确保账号对象的口令字段命名为 `password`（被既有 `*.password` 兜底）
- [x] 1.4 在 `.env.example` **仅新增** `IMAP_HOST/IMAP_PORT/IMAP_USER/IMAP_PASSWORD/IMAP_TLS/IMAP_ACCOUNT_ID`（`POLL_INTERVAL_SECONDS=180` 已存在于第 32 行，**勿重复**）
- [x] 1.5 config 单测：齐全→解析出 IMAP 配置（每键空串→undefined/默认）；缺 `IMAP_HOST`→IMAP 视为禁用且不报错。（注：「host 有而凭据缺→报错」是 **accountService 层**行为，断言见 3.3，**不在 config 层**——config 仅解析 optional，不做 IMAP 跨字段校验）

## 2. 安全规则：类别轴 + 医院/保险关键词轴 + 域名表保留

- [x] 2.1 `src/rules/lists.ts`：新增 `SENSITIVE_CATEGORIES = {finance, security, transaction}`；在关键词轴**新增医院/保险类关键词**（`医院`/`医疗`/`挂号`/`病历`/`诊断`/`保险`/`保单`/`理赔`/`hospital`/`clinic`/`medical`/`insurance`，小写归一）——这是医院/保险硬约束的**唯一确定性兜底**（类别枚举无对应项），注释须标注「承载硬约束、非示例列表，增删需对照硬约束」；`SENSITIVE_DOMAINS` **保持非空**（保留 bank.com/hospital.com/insurance.com 等示例），注释改为「可选补充、默认非空、非穷举」——**禁止清空**（清空会使域名轴场景 vacuous 并破坏既有测试）
- [x] 2.2 `src/rules/applySafetyRules.ts`：在「强制不标已读护栏」段新增类别轴——最终 `category ∈ SENSITIVE_CATEGORIES` → `shouldMarkRead=false`、追加 appliedRule；保持单调趋安全（医院/保险经 2.1 的关键词命中既有关键词轴，无需改 applySafetyRules 的关键词分支逻辑）
- [x] 2.3 扩充 `applySafetyRules.test.ts`：P3 银行营销邮件(category=finance)→不标已读（无需域名表）；transaction/security 类别同理；**医院/保险关键词邮件(category=personal/work 等非敏感、conf≥0.65、P2/P3)→不标已读**（含对代表性医院/保险关键词的覆盖断言，防漏词静默破坏硬约束）；既有域名轴/关键词轴用例仍通过（SENSITIVE_DOMAINS 非空，`[0]`/`[1]` 仍可索引）

## 3. 账号加载与 DB 锚定

- [x] 3.1 `src/accounts/accountService.ts`：从 config 读单 IMAP 账号，产出 `{accountId, host, port, user, password, tls}`；`accountId` 取 `IMAP_ACCOUNT_ID` 否则确定性派生 `imap:<user>@<host>`；`IMAP_HOST` 缺→返回 null（禁用）；`IMAP_HOST` 有而凭据缺→抛配置错误（不返回残缺账号）
- [x] 3.2 **DB 锚定**：账号加载后、**调度器启动前**（await 完成）`upsert({ where:{ id: accountId }, create:{ id: accountId, provider:'imap', email:user, authJson:{}, enabled:true }, update:{} })`，使 `mail_messages.accountId` 外键约束成立——否则首次 `saveEmail` 触发 FK 违约、被 poller per-email catch 静默吞掉每封邮件。**两处必须钉死**：(a) `create.id` 显式 `= accountId`（覆盖 `@default(cuid())`，否则 id≠accountId、FK 仍违约）；(b) `authJson:{}` **非空空对象**（列为非空 `Json`、无默认，置 `null` 触发 NOT NULL 违约——口令仍只在 env、绝不入此行）。`email=user` 为 best-effort（IMAP_USER 可能是登录名而非邮箱），仅 denormalization、非真相源。并给 `prisma/schema.prisma` 的 `MailMessage.account @relation` 显式加 `onDelete: Restrict`（迁移 SQL 已是 RESTRICT，此为字面对齐 spec、不产生新迁移）
- [x] 3.3 单测：派生 accountId 稳定且跨调用一致；缺 host→null；缺凭据→抛配置错误；锚定 upsert 幂等（重复启动不报错）；**断言 upsert 调用参数 `where.id === create.id === accountId`（call-shape spy，无需真库即在 CI 捕获 id≠accountId 回归）**。FK 列约束的真测属真实 DB 范畴，随既有 prisma 真测在 T7.2 验证（对齐项目「prisma 真测在接真实 DB 时」的既有延后策略）
- [x] 3.4 扩展 `MailRepo` + `InMemoryMailRepo` + `PrismaMailRepo`：`getCursor(accountId)` / `setCursor(accountId, cursor)` 读写 `mail_accounts.lastSyncCursor`（供增量游标持久化；InMemory 版供 4.5 离线测试）。注释标明：MailRepo 由此**有意跨两个聚合**（mail_messages 行 + mail_accounts 同步游标）——MVP 单 seam 省事（YAGNI），后续可拆 `AccountSyncRepo`

## 4. IMAP 拉取、增量游标与收敛

- [x] 4.1 `src/providers/imap/imapClient.ts`：封装 imapflow 连接/打开 INBOX（读取当前 UIDVALIDITY 与 UIDNEXT）/logout（每轮连接、用完即关）
- [x] 4.2 `src/providers/imap/imapPoller.ts`（取邮件）：读 `getCursor(accountId)`——首轮（无游标）或当前 UIDVALIDITY 与游标内不一致 → SEARCH UNSEEN（处理当前未读积压，**禁** FETCH 整箱历史）；否则 SEARCH `UID 游标+1:*`（不带 seen 过滤，以保留崩溃重取；空结果集 no-op）。逐封 FETCH envelope+文本正文 → 映射为 RawEmail（`fromEmail`=**裸地址** mailbox@host、`fromName`=显示名；`providerMessageId`=Message-ID 优先【规范化：首尾去空白、保留尖括号内逐字、不大小写折叠】，缺失回退 `imap-uid:<uidValidity>-<uid>`；携带活动 `uid`）→ `normalizeEmail` → `processEmail`
- [x] 4.3 **按 UID 升序处理**；游标推进=**取回序列上**「连续已处理前缀」高水位（**非 dense 整数区间**，避 expunge 空洞卡死；**dedup 早退跳过的 UID 视同已处理、计入推进**）：推到取回序列中其及之前全已处理的最高 UID，遇首个失败/跳过即停、**不越过**；轮末 `setCursor`——增量轮写 `<当前uidValidity>:<取回高水位>`；**退化轮（首轮/UIDVALIDITY 变化）** floor 优先级：全成功/空集且 UIDNEXT 为正整数→`<当前uidValidity>:<UIDNEXT-1>`（mailboxOpen 给出；**禁** prev-uid、**禁**写 NaN）；有失败→取回连续高水位；**UIDNEXT 缺失/非正（RFC 3501 rev1 可省略）→ 退化取回连续高水位，空集且无 UIDNEXT → 写 `:0`（下轮 `UID 1:*` 一次性重扫、dedup 兜底）**；退化轮含空集也必须写当前 uidValidity（否则反复 UNSEEN）；增量分支「空集 no-op」仅 uidValidity 已匹配时适用
- [x] 4.4 轮询循环逐封 try/catch+skip+log，单封失败不中断整批（失败封不推进游标→下轮重取重试）
- [x] 4.5 单测（注入假 imap fetch + InMemoryMailRepo + FakeProvider）：未读邮件进流水线；含 Message-ID 稳定去重；**显示名形态发件人 `客服 <u@bank.com>` 映射出裸 `u@bank.com` 并触发敏感域护栏**；单封 normalize 抛出被跳过、其余照常；**已处理邮件下轮不再被 FETCH（游标推过）**；**失败邮件下轮被重取（游标未越过、其后已处理者 dedup 跳过）**；**UIDVALIDITY 变化→退化 SEARCH UNSEEN 并重写当前 uidValidity（下轮回增量分支）**；**UIDVALIDITY 重置 + UNSEEN 取回空集→游标重写为 `当前uidValidity:UIDNEXT-1`、下轮进增量分支（不永久 UNSEEN）；新命名空间低位未读不被跳过、且不回扫整箱已读**；**mailboxOpen 不返回 UIDNEXT（rev1 省略）→ 游标不写 NaN、退化为取回高水位或 `:0`、不卡死**；**expunge 空洞（取回区间缺某 UID）→ 高水位按取回序列推进、不卡死**；**poison 邮件（某 UID 持续失败）→ 游标钉住、下轮重取它+其后、不静默丢弃**；**P2/P3 标已读后崩溃（markProcessed 未跑）→ 下轮经游标重取重跑、无孤儿行**

## 5. 真实标已读

- [x] 5.1 `src/providers/imap/imapActions.ts` 实现 `ProviderActions.markRead`：消费 `email.uid`（poller 必须填充）按活动 uid `messageFlagsAdd(['\\Seen'])`，幂等；**uid 缺失→抛结构化错误 fail-loud，禁静默 no-op**；异常**脱敏为固定 kind 串、零插值**（不得含 host/IP/port/user/口令/mailbox/命令文本；原始错误仅 debug 日志）
- [x] 5.2 单测：注入会抛「含 host:port、user」消息的假 imap，断言 `markRead` 重抛消息**等于固定 kind 串**（零插值、非仅缺子串）；**uid 缺失→markRead 抛错（不 no-op）**；经 `executeActions` 仅 `shouldMarkRead=true` 才标 Seen，P0/P1/P4/敏感保持未读；**markRead 失败耗尽→落 mail_actions=failed、processEmail 仍 markProcessed、邮件保持未读且不重试（at-most-once-after-retry、安全方向）**

## 6. 调度与接入

- [x] 6.1 `src/jobs/scheduler.ts`：node-cron 按 `POLL_INTERVAL_SECONDS` 触发轮询；cron 回调进入任何 await 前**同步**获取进程内 `isPolling` 锁，未结束则跳过本次触发；锁在 `finally` 释放（含轮询抛异常路径）
- [x] 6.2 单测：上一轮未结束时再次触发被跳过（不并发）；**一轮轮询抛异常后，下一次触发仍能正常发起**（锁未被永久占用）
- [x] 6.3 `src/main.ts`：账号存在时启动调度器并注入真实 IMAP provider；缺配置则只记日志、不启用；优雅关闭时停止调度

## 7. 端到端验证

- [x] 7.1 `pnpm test` 全绿、`pnpm build` 通过
- [ ] 7.2 配真实 IMAP 账号手测：未读邮件被分类；P2/P3 标已读、P0/P1/P4 保持未读；**一封医院/保险类邮件（命中关键词）保持未读**；P0/P4 推送；`mail_actions` 有日志；重启不重复处理（对照 ROADMAP P3 验收）
