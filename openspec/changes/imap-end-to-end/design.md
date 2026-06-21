## 上下文

（编号说明：本变更用 ROADMAP 的 P 编号，P3 = IMAP；对应 PROJECT_INIT §16 的「Phase 1 IMAP」——两套编号有偏移，以 ROADMAP 为准。）

P0–P2 已交付：分类内核、规则引擎、`processEmail` 流水线、`executeActions`、通知，全部用假 provider 离线可测。关键 seam 已就位：
- `ProviderActions.markRead(email)`（`src/actions/providerActions.ts`）——真实实现位空缺，processEmail 的 `provider` 依赖**无默认、必须注入**。
- `processEmail(email, deps)`（`src/pipeline/processEmail.ts`）——接收**单封已规范化** `NormalizedEmail`，内部完成去重→落库→分类→裁定→动作→`markProcessed`；明确把「批量 normalize + 单封 throw 隔离 + 轮询循环」列为 P3 义务。
- `MailRepo`（prisma 真身）——去重键 `(accountId, providerMessageId)` 幂等 upsert，`processedAt` 是真正的处理幂等标记。

P3 接上第一个真实 provider（IMAP），把这些 seam 连成端到端通道。`imapflow` 尚未安装；`src/accounts/`、`src/providers/`、`src/jobs/` 尚不存在。

## 目标 / 非目标

**目标：**
- 真实 IMAP 邮箱跑通：未读轮询 → 收敛 → 既有流水线 → 真实标 `\Seen`、P0/P4 推送、actions 落库、重启不重复。
- IMAP 为**可选** provider：缺配置不崩、不影响 P0–P2 既有行为。
- 收口敏感邮件「不标已读」策略：以类别 + 关键词为主防线，去掉「必须维护域名白名单」的负担。

**非目标：**
- Gmail（P4）、每日摘要（P5）、YAML 可配化（P6）、durable 跨重启重试预算（P6）。
- IMAP IDLE/推送（仅轮询）；文件夹创建/移动到 `AI-*`（仅标 `\Seen`）；附件深解析；历史回填。

## 决策

**1. 账号来源：env 单账号，DB 仅存一行锚定（MVP）。**
`accountService` 从 `IMAP_*` 读单账号（env 是配置真相源）；不引入 DB 账号表 CRUD/GUI。`accountId` 必须跨重启稳定（去重键依赖）：取 `IMAP_ACCOUNT_ID`（若配置），否则确定性派生 `imap:<user>@<host>`（含 user，会进日志——要干净 id 就设 `IMAP_ACCOUNT_ID`）。
**必须**在轮询前按 `accountId` upsert 一个 `mail_accounts` 锚定行：`mail_messages.accountId` 对 `mail_accounts.id` 有外键（`ON DELETE RESTRICT`），缺锚定行则首次 `saveEmail` FK 违约、被 poller 的 per-email catch 静默吞掉**每封**邮件——既有假 provider 测试走 InMemoryMailRepo（无 FK）从未暴露此路径。`lastSyncCursor` 等后续游标即挂此锚定行（解决「env 账号无 cursor 落点」的自相矛盾）。
- *备选*：完整 DB 账号表 CRUD——本期无 GUI/多账号需求，YAGNI；但锚定行是 FK 约束的硬性最小要求，**非可选**。

**2. `providerMessageId` 用 Message-ID 优先、UID 合成兜底。**
去重键必须跨重启稳定。IMAP UID 在 `UIDVALIDITY` 变化时会重排，单用 UID 不稳。故 `providerMessageId = 规范化的 Message-ID 头`（RFC 稳定；规范化=首尾去空白、保留尖括号内内容逐字、不大小写折叠，使同一邮件跨轮一致）；缺失时回退 `imap-uid:<uidValidity>-<uid>`。该回退在**同一 UIDVALIDITY 期与服务重启间稳定**（满足硬约束「服务重启不重复处理」——服务端 UIDVALIDITY 不因我方进程重启而变），仅**服务端 UIDVALIDITY 重置**时变：无 Message-ID 的邮件可能因此重处理一次（at-least-once，与流水线既有语义一致；spec R2.s2 已显式披露、不再断言绝对一致）。`NormalizedEmail.uid` 仍携带活动 UID 供 `markRead` 用。
- *备选*：纯 UID——UIDVALIDITY 重置即破去重，弃。

**3. `\Seen` 不作处理幂等标记；`processedAt` 才是；增量 UID 游标避免重复 FETCH。**
P0/P1/P4 **不**标已读（`shouldMarkRead=false`），正确性由流水线去重（`processedAt` 非空即跳过）保证、**不**依赖 `\Seen`。为避免不标已读邮件被每轮重复 FETCH，用**增量 UID 游标**（`mail_accounts.lastSyncCursor` = `<uidValidity>:<uid>`）只取 `UID > 游标` 的新邮件；游标是**取回 UID 序列上**「连续已处理前缀」的高水位（非 dense 整数区间——避 expunge 空洞卡死；dedup 早退的 UID 视同已处理；遇首个未成功即止，失败/崩溃的邮件因游标不越过而下轮重取，dedup 安全）。首轮/UIDVALIDITY 变化退化为 SEARCH UNSEEN（不取整箱历史），退化轮 floor 优先取 `UIDNEXT-1`（mailboxOpen 给出的 UID 上界）而非 prev-uid（跨命名空间漏新低位 UID）或 0（回扫整箱）。**精确推进规则与退化轮 floor 优先级（含 UIDNEXT 缺失的兜底）以 spec §增量 UID 游标 为准**，此处不重复以免漂移。如此「P0/P1/P4 不标已读」与「不重复扫描」二者兼得，并顺带修复纯 UNSEEN 模型下「P2/P3 标已读后崩溃→永久跳过」的退化（崩溃邮件 UID 在游标之上、被重取重跑）。
- *备选*：每轮 SEARCH UNSEEN 重 FETCH 全部未读（O(未读数)）——量大时浪费，且无法修复标已读后崩溃的孤儿行；故本期采用游标（用户明确要求纳入 P3）。
- `// ponytail: 游标=本轮**取回 UID 序列**上的连续已处理前缀高水位（非 dense 整数区间，避开 expunge 空洞卡死）；dedup 早退的 UID 视同已处理计入推进；durable 退避/死信仍属 P6。`

**4. 连接生命周期：每轮连接、用完即关。**
每次轮询新建 imapflow 连接、`mailboxOpen('INBOX')`（读 UIDVALIDITY + UIDNEXT）、**按增量游标 search**（有效游标→`UID 游标+1:*`，**不带 seen 过滤**以保留崩溃重取；首轮/UIDVALIDITY 变化→`search({seen:false})` 即 SEARCH UNSEEN 处理当前未读积压、不取整箱历史）、逐封 `fetchOne`（envelope + 文本 bodyPart）、按需 `messageFlagsAdd(uid, ['\\Seen'])`，结束 `logout`。简单、无长连状态。
- `// ponytail: 每轮重连，省去连接保活/重连状态机；高频或大量账号时改持久连接 + IDLE（后续阶段）。`

**5. 调度与不重入：node-cron + 进程内布尔锁（finally 释放）。**
`jobs/scheduler.ts` 按 `POLL_INTERVAL_SECONDS` 触发；cron 回调进入任何 await 前**同步**获取 `isPolling` 锁，未结束则跳过本次触发；锁**必须在 `finally` 释放**（含轮询抛异常路径），否则一次异常永久锁死该账号、再不轮询。定位：进程内锁只解决**单进程内**重入；跨实例的真正兜底是去重键（DB unique），且 `findByDedupKey`→`saveEmail` 窗口非事务、为 at-least-once（非 exactly-once）。
- `// ponytail: 单进程锁；多实例改 DB advisory lock / 把 unique 约束当唯一权威（后续阶段）。`

**6. 单封 throw 隔离在轮询循环里做（processEmail 的 P3 义务）。**
`imapPoller` 对每封 `normalizeEmail` + `processEmail` 包 try/catch，失败记录后 `continue`，不中断整批。

**7. 标已读错误脱敏在 provider 层做（固定 kind + 摘要）。**
`imapActions.markRead` 抛出的 error message 可能含服务器地址/账号片段，而 `executeActions` 的 `redactError` **只截断到 200 字**、不剥离前缀里的 host/user——故脱敏**必须**在 provider 层落地：捕获底层异常后只抛**固定 kind 串、零插值**（不得插入任何 host/IP/port/user/口令/mailbox/IMAP 命令文本）；测试断言重抛消息**等于**该固定 kind（不只是缺子串）。原始错误可在 debug 日志另记。

**8. 安全规则：类别轴 + 医院/保险关键词轴，域名表保留非空。**
`applySafetyRules` 增加类别轴：最终 `category ∈ {finance, security, transaction}` → `shouldMarkRead=false`（新增 `SENSITIVE_CATEGORIES`）；**关键词轴新增医院/保险类关键词**（医院/医疗/挂号/病历/诊断/保险/保单/理赔/hospital/clinic/medical/insurance）。诚实分层（禁止过度宣称）：**关键词轴=确定性兜底**（命中即守住）覆盖 支付/合同/安全/医院/保险/账单类；**类别轴=概率性广覆盖**（消费 LLM 透传 `category`、引擎不改写）叠加 finance(银行)/security/transaction。银行无专属确定性关键词（账单类除外），纯银行通知靠 finance 类别（概率性，实务召回高）。残留缺口=任何**未命中关键词、又被判非敏感类别**的邮件（含无账单词的纯银行通知、未列措辞的医院/保险邮件），非零、best-effort。`SENSITIVE_DOMAINS` 降为可选补充但**默认非空**（保留示例项；清空会使域名轴场景 vacuous 并破坏既有 6 个测试）。
- *备选*：为医院/保险加专用 category 枚举——会动 `ClassificationSchema` + prompt，超范围（非目标已列），故改用确定性关键词轴守硬约束。
- *设计取舍*：硬约束不可静默弱化，故对医院/保险补**确定性关键词轴**（而非依赖域名白名单或仅靠概率性类别）；彻底消除残留需引入 medical/insurance 类别枚举（超范围，留后续）。

## 风险 / 权衡

- **不标已读邮件的重复 FETCH** → 已由增量 UID 游标消除（只取 `UID>游标` 的新邮件，存 `lastSyncCursor`）；游标 vs per-message 失败的张力用「取回序列上的连续高水位」语义化解（失败邮件下轮重取、不被跳过）。
- **poison 邮件 head-of-line 阻塞（已知接受）** → 某 UID 持续失败 → 游标钉在其前一位，每轮 `UID 游标+1:*` 重取它 + 其后全部（其后已处理者经 dedup 跳过但仍 FETCH）→ 退化为 O(积压) 浪费、无死信/skip-after-N。本期接受（安全优先：绝不静默丢弃失败邮件）；死信 / durable 重试预算属 P6。
- **UIDVALIDITY 重置破 UID 去重** → 用 Message-ID 优先作 `providerMessageId` 规避；仅在 Message-ID 缺失时退化为 UID 合成串（极少见）。
- **类别轴扩大不标已读面** → 合法的 finance/transaction 类 P2 通讯（如「账单已生成」）也不再自动标已读，未读数增多。权衡：安全优先于整洁，可接受。
- **markRead 错误泄露连接信息** → provider 层抛固定 kind 串、零插值（截断不足以剥离前缀 host，须 provider 层落地 + 测试断言重抛消息等于固定 kind）。
- **IMAP 服务器差异（FETCH 正文形态/编码）** → 优先取 text/plain；缺失时取 snippet/空串，交由分类器与规则处理；不在 normalize 阶段因正文缺失丢弃邮件。
- **P2/P3 标 `\Seen` 后、`markProcessed` 前崩溃** → 已由增量游标修复：崩溃邮件 UID 在游标之上，下轮按 `UID 游标+1:*` 重取（不依赖 UNSEEN）→ dedup 见 `processedAt`=null → 重跑（标已读幂等）→ `markProcessed` → 游标推进。无孤儿行（不再需要 recovery sweep）。
- **markRead 调用本身失败（非崩溃）** → executeActions 不抛、落 `mail_actions=failed`，processEmail 仍 `markProcessed`、游标照常推进，该 P2/P3 **保持未读且不再重试**——这是既有 at-most-once-after-retry 语义（与 notify 一致），且「保持未读」是安全方向（保守不误标已读），接受。区别于上一条崩溃（崩溃不 markProcessed→重取；失败仍 markProcessed→不重取）。

## 迁移计划

纯增量，对 P0–P2 无破坏：
1. 加依赖 `imapflow`；新增 `IMAP_*` / `POLL_INTERVAL_SECONDS`（全部可选）到 config 与 `.env.example`。
2. 新增 accounts/providers/jobs 代码；`main.ts` 在 IMAP 配置存在时启动调度器。
3. 改 `applySafetyRules` + `lists.ts`（类别轴；域名表降级）。
- **回滚**：不设 `IMAP_HOST` → 轮询不启用，回到 P2 状态；规则改动可单独 revert——对银行/finance 类更安全，对医院/保险类与 P2 baseline（曾有 never_mark_read_domains 占位）持平到略强（新增确定性关键词），回滚非紧急。

## 未决问题

- 无阻塞项。文件夹移动到 `AI-*`、持久连接/IDLE、durable 重试 / 死信（poison 邮件 skip-after-N）明确推迟到后续阶段（**增量游标已纳入本期**，不再推迟）。
