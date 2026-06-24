## 上下文

接入账号时无任何「起算时间」下界：摄入层（IMAP 退化轮 `SEARCH UNSEEN`、Gmail 每轮全量 `is:unread` 且**无游标**）与摘要层（`listDigestCandidates` 显式「无年龄窗」）都不限日期。实测接入当天处理 1189 封（最旧半年前）、594 条进单次摘要。去重持久化于 Postgres、稳态重启不重刷，故为**接入/首同步**暴露。旧邮件为真·未读，按**日期**而非读未读处理。

代码现状（已核）：`MailAccount` 有 `lastSyncCursor`（IMAP UID 游标占用）+ `createdAt`，无可复用的水位线列；`bodyHash` 是死列（与本提案无关，属提案 4）。

## 目标 / 非目标

**目标：**
- 新账号接入**不再**把历史未读积压当新邮件处理/推送/进摘要。
- 既能压住**未来摄入**（水位线挡 ingest），又能压住**已入库**的存量积压（摘要按收到时间下界）。
- 存量 3 账号可由运维一条命令盖戳到今天、立即止血，且**不**回溯改写其历史。

**非目标：**
- 不改去重键、稳态轮询、读未读语义、`lastSyncCursor`。
- 不引入按「处理时间」或「固定天数」的年龄窗（见决策 2）。
- 不做自动复发/相似度降级（提案 4）、不做评级校准（提案 3）。

## 决策

**决策 1：新增独立列 `MailAccount.processFrom DateTime?`，不复用任何现有列。**
`lastSyncCursor` 归 IMAP UID 游标解析（`imapPoller.ts:277`），复用会两义；`createdAt` 是审计语义且运维需要可调水位线而不污染「创建时间」。故新增可空列。NULL = 不设下界（保持现状）。迁移**仅加列、无数据回填**。

**决策 2（最关键）：摘要下界用「按账号 `processFrom` 的 `receivedAt` 下界」，而非全局固定年龄窗 `DIGEST_MAX_AGE`。**
既有 daily-digest 规范明确要求「纳入范围不得带年龄上限，使**停机期间积压的旧邮件不被永久排除**」（含一条专门场景）。全局 `DIGEST_MAX_AGE`（如 7 天）会在停机 > 该窗时**永久丢弃**恢复后处理的邮件，**违反**该需求。而 `processFrom` 是**收到时间**下界：停机期间**收到**的邮件 `receivedAt` 在水位线之后 → 仍入摘要；只有接入前**收到**的历史积压被排除。一个机制达成「排除接入前历史」+「保留停机积压」两全。**注意**：ingest 与 digest 并非落在同一时间戳上（见决策 5），不可声称「同一语义」——它们用不同时间戳逼近同一意图。架构师初版提的 `DIGEST_MAX_AGE` 在本阶段读到该既有需求后弃用。

**决策 3：两层都做，解决不同集合。**
- 摄入水位线挡**未来**：新账号或游标重置时不再摄入旧邮件（连 LLM 调用都省）。
- 摘要 `receivedAt` 下界压**已入库**：那 1189 封已 `processedAt != null` 的存量，摄入水位线管不到，只能靠摘要下界（前提是其 `processFrom` 被盖戳）。

**决策 4：存量账号迁移默认 NULL + 运维显式 `set-process-from` opt-in。**
迁移自动盖戳所有存量账号 = 回溯改写半年历史、且可能误伤运维真想要的旧邮件。故默认 NULL（行为不变），运维对这 3 个账号执行 `set-process-from <id> 今天` 显式止血（用户已确认要压掉）。

**决策 5：三个不同时间戳，粗摄入 + 精确摘要，不强行对齐。**
水位线在三处比较的其实是**三个不同时间戳**：
- 摄入 IMAP `SEARCH SINCE` → 服务器 **INTERNALDATE**，**日期粒度、含当日、服务器时区**（±1 天模糊）。
- 摄入 Gmail `after:<epoch 秒>` → Gmail **内部收到时间**，秒粒度。
- 摘要 `receivedAt` → 邮件 **`Date:` 头**（`new Date(email.date)`，缺失/不可解析回落摄入 `now()`）。

故 ingest 是**粗粒度**近似、digest 是**精确**下界。**有意不加** post-fetch 精确过滤去对齐摄入与 `receivedAt`（ponytail：为消除水位线附近 ≤1 天的边界差异而加一层 fetch-后过滤，不值——积压是数月旧、不是 1 天旧；边界邮件多收/少收一天无害）。

**两种 seed 粒度，别混**：默认接入 seed = **精确 `new Date()` 瞬时**（含时分秒）；UTC 零点解析**仅**作用于显式 date-string（`--process-from`/`set-process-from`）。**不可**把默认 seed 也抹成 UTC 零点——那会把水位线凭空提前到当天 00:00 UTC（最多早 24h），多收一段本该排除的旧邮件。±1 天的粗模糊由「接入即起算」吸收即可，不靠把 seed 抹到零点。

**决策 6：`processFrom` 必须从 DB 全链路穿透到 poller 内部决策点（载体是 deps 对象，不是位置参数）。**
逐跳：`MailAccount`→repo select→`StoredAccount`→`AccountWriteInput`→`parseImap`/`parseGmail`→`ImapAccount`/`GmailAccount`→**poller 内部 deps**。关键最后一跳易漏：`pollOnce`/`gmailPoll` 收的是 `accountId: string` 位置参，决策点在内部——故字段必须进 **`PollDeps`**（`pollAccount`→`pollOnce` 转发）与 **`GmailPollDeps`**（`createGmailPoller`→`gmailPoll`），且 **`main.ts buildAccountPoll`** 接线要把 `account.processFrom` 放进 deps（Gmail 的 `createGmailPoller(accountId,{…})` 当前只传 id）。漏任一跳 → poller 拿不到 → **静默退化为不设下界、不报错**。测试必须经真实入口驱动、不手搓 deps（否则漏的接线测不出）。

**决策 7：种值归 repo「行创建分支」、`update` 一律不动该列——CLI 无需分辨首次/re-auth。**
行创建两条路径（IMAP 默认 add 的 `createAccount`、Gmail/`--update` 的 `upsertAccount.create`）都写 `input.processFrom ?? new Date()`（默认精确瞬时）。`upsertAccount.update` 分支**一律不含** `processFrom`（Prisma = 列不动；InMemory 须 get-before-set：existing 存在则保留、**忽略 input**，读先于 set）。如此「seed-on-create / preserve-on-update / 只有 set-process-from 改既有」**结构成立**：CLI 一律透传 `--process-from`-or-undefined、不需分辨首次 vs re-auth（解决 `cmdAddGmail:490` 无法分辨的死结），且对**既有**账号 `add --process-from` 也不改水位线（走 update 被忽略）。

**决策 8：退化轮空集安全推进游标；async 搜索落在 `pollOnce` 而非纯 `computeCursorToWrite`；`1:*` 竞态显式接受。**
`UIDNEXT` 有效写 `UIDNEXT-1`（现分支 ① 已是）；缺失时取**现有最大 UID** 写 `uidValidity:<maxUid>`（用既有 `search({uid:'1:*'})` seam、不新增方法）。**async 落点**：`computeCursorToWrite` 是纯同步、无 `connection`，不能在此 `await`——须由 `pollOnce`（已 async）在写游标块里执行 `await connection.search({uid:'1:*'})`（或 compute 返哨兵、pollOnce 兑现）。**放弃**「保持带 SINCE 退化轮」（永不推进游标）与「STATUS 查询」（无 seam）。**显式接受的竞态**：空 SINCE 搜索与 `1:*` 之间到达的新邮件（UID `maxUid+1`）会被纳入游标却未处理 → 下次 uidValidity 重置前漏收；窗口亚秒、仅一次性退化轮触发、且换掉旧 `:0` 全量重扫——以此为由接受，实现期以真 IMAP 验证。

**决策 9：摘要下界抽纯共享谓词、`undefined`-safe、map 取全量账号；离线可测、防两 repo 漂移。**
`passesWatermark(receivedAt, processFrom?: Date|null|undefined)` = `processFrom == null || receivedAt >= processFrom`（`== null` 覆盖 null **与** undefined ⇒ 都不设下界），作单一真源两 repo 都调。接受 `undefined` 是为挡「`map.get(accountId)` 对 map 中缺失账号返回 undefined」→ 否则 `undefined.getTime()` 抛/NaN 静默丢候选；map 须取**全量**账号（非仅 enabled，否则 disabled 账号已处理邮件被误丢）。离线闭合范围：纯函数单测覆盖**分支逻辑**；map-build/缺失-accountId 的残缺另由 6.4「混入缺失 accountId」用例覆盖（决策 9 不声称纯函数单测独力闭合全部 prisma 路径）。

## 风险 / 权衡

- **`SINCE`/`after:` 语义与意图偏差（时区/粒度）**：以决策 5 的种值兜底；并以 per-provider 集成测试钉死——喂一封 `receivedAt < processFrom` 的旧 fixture（必须被排除）+ 一封 `>= processFrom` 的（必须纳入）。
- **存量账号止血依赖运维手动 `set-process-from`**：默认 NULL 意味着不跑该命令则存量积压仍会进下次摘要。权衡：宁可显式、不回溯改写历史。runbook/输出需提示这一步。
- **Gmail 无游标本质未变**：本提案只给 `is:unread` 加 `after:` 下界、不引入 historyId 游标（超范围）；稳态仍每轮全量 `is:unread after:`，靠 dedup 去重——可接受，且查询集已被下界显著收窄。
- **迁移在 live 库执行**：仅加可空列，对运行中服务安全（无锁表回填）；随真库验证 `prisma migrate deploy` 幂等。
