## 1. 数据模型 + 迁移

- [x] 1.1 `prisma/schema.prisma`：`MailAccount` 加 `processFrom DateTime?`（可空，**不**复用 `lastSyncCursor`/`createdAt`）
- [x] 1.2 生成迁移；**手工核对**迁移体只含 `mail_accounts` 的 `ADD COLUMN "processFrom" TIMESTAMP(3)`，**不含**对 `mail_actions` 两个部分索引（`mail_actions_active_uniq`/`mail_actions_due_retry_idx`）的 `DROP`（Prisma 表达不了、生成时会误判漂移，见 `schema.prisma:88-89`）。验证 `prisma migrate deploy` 幂等、存量库默认 `processFrom = NULL`

## 2. 数据路径穿透（`processFrom: Date | null` 从 DB 一路到 poller 内部）

- [x] 2.1 repo 读取：`StoredAccount`（`mailRepo.ts:109`）+ `listEnabledAccounts` select（`mailRepo.ts:502-505`，非 `:516` 的 `listAccounts`）带上 `processFrom`；`AccountWriteInput`（`mailRepo.ts:126`）加 `processFrom?`（播种载体）。注：`cmdList`（`account.ts:529`）的输出白名单保持 `{id,provider,email,enabled}` 不变——`StoredAccount` 多了 `processFrom` 不顺带泄进 list 输出
- [x] 2.2 注册表：`parseImap`/`parseGmail`（`accountRegistry.ts:96/106`）的 `ImapAccount`/`GmailAccount` **对象字面量是显式枚举字段、非 `...row` 展开**——必须**显式写** `processFrom: row.processFrom` 进这两个字面量（下游 `{provider, ...imap}` 展开才自动带；不会「凭空 spread 流转」）
- [x] 2.3 provider 类型：`ImapAccount`/`GmailAccount`（`provider.ts:57/71`）加 `processFrom: Date | null`
- [x] 2.4 **poller 内部载体（关键最后一跳，否则静默 no-op）**：
  - IMAP：`PollDeps`（`imapPoller.ts:58`）加 `processFrom`；`pollAccount`（`:379`）把 `account.processFrom` 转进 `pollOnce(accountId, deps)`（`:387`）的 deps——**不**改 `accountId` 位置参数
  - Gmail：`GmailPollDeps`（`gmailPoller.ts:51`）加 `processFrom`；`createGmailPoller`（`:406`）接收并传给 `gmailPoll`（`:88`）
  - **main.ts 接线**：`buildAccountPoll`（`main.ts:135`）构造 poller 时把 `account.processFrom` 传入——IMAP 经 `pollAccount(account,…)` 已带 `account`，Gmail 的 `createGmailPoller(account.accountId,{…})`（`main.ts:176-181`）当前**只**传 id，必须补 `processFrom` 进 deps

## 3. 播种 + 日期解析 + 运维命令（account-cli）

- [x] 3.1 **共享日期 parse+validate helper**：date-string → **UTC 零点**；解析失败 → `EXIT_USAGE`；**严格未来**（`parsedUtcMidnight > now`）→ `EXIT_USAGE`（near-now/今天判为过去、合法放行）。`--process-from` 与 `set-process-from` **都**用它
- [x] 3.2 **播种归 repo「行创建分支」、update 一律不动 `processFrom`**——使「seed-on-create / preserve-on-update / 只有 set-process-from 改既有」**结构成立**，CLI 无需区分首次 vs re-auth（解决「CLI 在 `:490` 无法分辨首次/re-auth」+「add --process-from 误改既有」）：
  - PrismaMailRepo `upsertAccount` 的 `create` 分支（`mailRepo.ts:545-551`）写 `processFrom: input.processFrom ?? new Date()`；`update` 分支（`:553`）**一律不含** `processFrom`（列不动 = 保留）
  - PrismaMailRepo `createAccount`（`mailRepo.ts:557-567`，IMAP 默认 add 的独立 `.create`）同样 `processFrom: input.processFrom ?? new Date()`
  - InMemoryMailRepo `upsertAccount`（`inMemoryMailRepo.ts:139`，当前无条件整行 `.set` **会 clobber**）：**先**读 `const existing = accountsById.get(input.id)`、**再** `.set`——`existing` 存在（update）⇒ `processFrom: existing.processFrom`（**一律保留、忽略 input**）；不存在（create）⇒ `processFrom: input.processFrom ?? new Date()`。读必须在 set 之前（顺序 load-bearing）
  - CLI 站点统一：`account add`（IMAP `:413` createAccount / `:406` `--update` upsert / Gmail `:490` upsert）一律把 `--process-from` 值或 `undefined` 经 `input.processFrom` 透传——**不**在 CLI 区分首次/re-auth；对**既有**账号 `add --process-from` 不改水位线（走 update 被忽略），改既有只能 `set-process-from`
- [x] 3.3 create 分支的默认 = **精确 `new Date()` 瞬时**（`?? new Date()`，非 UTC 零点）；UTC 零点**仅**用于显式 date-string（`--process-from`/`set-process-from` 经 3.1 helper）。摘要比较用 `receivedAt.getTime() >= processFrom.getTime()`，瞬时/零点都是 `Date`、可比
- [x] 3.4 `account add` 加 `--process-from <ISO date>`（经 3.1 helper）；`account set-process-from <id> <date>`（`account.ts` switch `:235` 新增 case，经 3.1 helper）；`<id>` 经 `JSON.stringify` 转义回显
- [x] 3.5 `MailRepo.setProcessFrom(id, date)`（接口 `mailRepo.ts:175-305` + Prisma + InMemory 三处）

## 4. 摄入层下界

- [x] 4.1 `ImapSearchCriteria`（`imapClient.ts:89`）退化轮 arm 改为 `{ seen: false; since?: Date }`——`since` 与 `seen:false` **合取**（`UNSEEN AND SINCE`），**禁止**替换 `seen`；`RealImapConnection.search`（`:122`）两键都传给 imapflow
- [x] 4.2 退化轮（`imapPoller.ts:119`）：`processFrom != NULL` 时传 `since`；NULL 全量 `UNSEEN`；增量轮（`:124`）不动
- [x] 4.3 退化轮空集安全游标：`SINCE` 过滤后空集时，`UIDNEXT` 有效写 `UIDNEXT-1`（现分支 ① 已是）；`UIDNEXT` **缺失**时**禁止**写 `:0`——改为取**现有最大 UID** 写 `uidValidity:<maxUid>`。**async 落点**：`computeCursorToWrite`（`imapPoller.ts:340-369`）是**纯同步**、无 `connection`，**不能**在此 `await`——必须在 `pollOnce`（`:142-155`，已 async）的写游标块里 `await connection.search({uid:'1:*'})` 取 max 再算游标（或让 compute 返回 `{kind:'need-max-uid'}` 哨兵、由 `pollOnce` 兑现）。邮箱本就空（`1:*` 也空）则保持退化轮（下轮仍空、无害）。**放弃** STATUS 备选（无 seam）。测试 6.2 必须驱动真实 `pollOnce` 异步路径
  - **已知接受（accepted-degraded）**：`1:*` 是空 SINCE 搜索**之后**的二次搜索，二者之间到达的新邮件（UID `maxUid+1`）会被 max 纳入游标却未处理 → 在下次 uidValidity 重置前**漏收**。窗口为单连接上两条 IMAP 命令间（亚秒级）、且只在**一次性**退化轮（首同步/uidValidity 变化）触发——以「一次性、亚秒窗、换旧 `:0` 全量重扫」为由**显式接受**，留待实现期以真 IMAP 验证
- [x] 4.4 Gmail（`gmailPoller.ts:102` `q='is:unread'`）：`processFrom != NULL` 时 `q += ' after:<floor(processFrom/1000)>'`；NULL 全量 `is:unread`

## 5. 摘要层下界（共享纯谓词，防两 repo 漂移 + 离线可测）

- [x] 5.1 **抽纯函数** `passesWatermark(receivedAt: Date, processFrom: Date | null | undefined): boolean` = `processFrom == null || receivedAt.getTime() >= processFrom.getTime()`（`== null` 同时覆盖 `null` **与** `undefined` ⇒ 都视为不设下界；含界）。两 repo **都**调它，作单一真源。**接受 `undefined`** 是为了挡 `map.get(accountId)` 对 map 中缺失账号返回 `undefined` 时**静默丢候选**（否则 `undefined.getTime()` 抛/NaN）
- [x] 5.2 PrismaMailRepo `listDigestCandidates`（`mailRepo.ts:847-905`）：select **加 `accountId`**（现 select `:857` 未取，无 join key）；一次 `findMany` 取**全部账号**（**非**仅 enabled，否则 disabled 账号的已处理邮件其 accountId 缺 map → 误丢）`processFrom` 建 `Map<accountId, Date|null>`（~3 账号、非 N+1）；候选经 `passesWatermark(receivedAt, map.get(accountId))` 过滤（缺失 accountId → undefined → 视为不设下界、放行）
- [x] 5.3 InMemoryMailRepo `listDigestCandidates`（`:467`）：`AccountRow`（`:76`）加 `processFrom`；查 `accountsById` 取每行账号 `processFrom`、同样经 `passesWatermark` 过滤

## 6. 测试

- [x] 6.1 摄入 IMAP：经**真实入口** `pollAccount`/`buildAccountPoll`（非手搓 deps）驱动；旧邮件（INTERNALDATE < processFrom）被退化轮排除；`{seen:false, since}` 合取断言；NULL 全量 UNSEEN
- [x] 6.2 退化轮空集游标：`SINCE` 空 + `UIDNEXT` 有效 → `UIDNEXT-1` 转增量不重扫；`UIDNEXT` 缺失 → 经 `search({uid:'1:*'})` 写 `maxUid`、**不**写 `:0`、**不**无界重扫
- [x] 6.3 摄入 Gmail：经**真实入口** `createGmailPoller`（main 构造路径）驱动，断言 `q` 含 `after:<epoch>`；NULL 无 `after:`
- [x] 6.4 摘要（**两 repo 同一组 fixtures**）：接入前积压排除；停机期间收到（receivedAt ≥ processFrom）仍入摘要；边界 `==processFrom` 含界纳入；缺 Date 头回落 receivedAt；**同一 `listDigestCandidates` 调用混入 NULL 账号 + 非 NULL 账号**，各自正确
- [x] 6.5 `passesWatermark` **纯函数单测**（`null` / **`undefined`** / `<` / `==` / `>` 五分支——`undefined` 须放行）；并在 6.4 的「混入」用例里加一例**候选 accountId 不在 processFrom map 中**（disabled 账号 / 两 findMany 间被删的并发窗），断言**不**被静默丢——闭合 design 决策 9 只覆盖分支逻辑、未覆盖 map-build/lookup 的残缺
- [x] 6.6 播种/re-auth：IMAP `add`（createAccount）+ Gmail 首次接入种 `new Date()`；**Gmail re-auth（upsert update）不重置 `processFrom`**——**Prisma 与 InMemory 两路径都断言**（InMemory 须经 get-before-set 保留）；IMAP `--update` 同理
- [x] 6.7 日期 helper：合法 / 解析失败 / 严格未来 → 各自结果；`--process-from 今天`（UTC 零点 ≤ now）放行、不误拒
- [x] 6.8 `pnpm exec tsc --noEmit` clean + 全量 `pnpm test` 绿

## 7. 运维落地

- [x] 7.1 `docs/DEPLOY.md` / runbook：迁移后对**存量 3 个账号**执行 `account set-process-from <id> <接入处理日之后，如今天>`（须晚于接入处理日，以连同缺 Date 头、receivedAt 回落到接入时刻的旧邮件一并排除）；默认 NULL 不自动盖戳
- [ ] 7.2 部署 mac-mini 后执行盖戳，验证下一次摘要不再含接入前旧邮件（端到端验收）
