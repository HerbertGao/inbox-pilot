## 为什么

接入账号时，流水线会把账号里**全部历史未读邮件**当作新邮件处理、推送并进摘要——摄入与摘要两处都没有任何「起算时间」下界。实测（live DB，2026-06-23 接入当天）：一次性处理 **1189** 封（最旧 2025-12-31，半年），594 条进单次摘要，43 封 P0 + 17 封 P4 旧邮件被实时推送。

根因是两处缺日期下界：摄入层（IMAP 退化轮 `SEARCH UNSEEN` 无 `SINCE`、Gmail `is:unread` **完全无游标**、每轮全量）+ 摘要层（`listDigestCandidates` 注释明言「无年龄窗」）。去重持久化于 Postgres、稳态重启不重刷，故这是**接入 / 首次同步**的暴露，而非稳态 bug。被刷屏的旧邮件为**真·未读**（Gmail `UNREAD` 标签已核），故按**日期**排除、不纠结读未读。

## 变更内容

- 新增 per-account「起算时间」水位线列 `MailAccount.processFrom`（可空 `DateTime`，**UTC** 语义）；账号接入时种 `now()`，可经 `--process-from <ISO date>`（解析为 **UTC 零点**）覆盖。
- **数据路径**：`processFrom` 必须从 DB 行一路穿透到 poller——`MailAccount`→repo select→`StoredAccount`→`AccountWriteInput`（写入/播种载体）→账号注册表 `parseImap`/`parseGmail`→`ImapAccount`/`GmailAccount`→poller `search`/`q`。这条链上每一跳现都**不带**该字段，必须补齐（否则摄入水位线无法实现）。
- **摄入层**按水位线设下界：IMAP 退化轮 `SEARCH … SINCE`（**日期粒度、按服务器 INTERNALDATE**，非精确 `receivedAt`）、Gmail 查询加 `after:<epoch>`（按 Gmail 内部收到时间）；`processFrom = NULL` ⇒ **省略**下界（保持现状）。摄入是**粗粒度、±1 天**的近似下界（design 决策 5），**不**加 post-fetch 精确过滤——精确下界由摘要层在 `receivedAt` 上落地。
- **播种点**：`processFrom` 在 repo 的**行创建分支**默认 `?? new Date()`——两条创建路径都覆盖：IMAP 默认 add 的 `createAccount`（独立 `.create`）与 Gmail/`--update` 的 `upsertAccount` `create` 分支。`upsertAccount` 的 `update`/re-auth 分支**一律不含** `processFrom`（列不动 = 保留）；故 CLI 无需区分首次/re-auth，对既有账号 `add --process-from` 也不改水位线——**只有 `set-process-from` 能改既有行**。
- **摘要层**按账号 `processFrom` 给 `listDigestCandidates` 加 **`receivedAt` 下界**（排除水位线之前**收到**的邮件）；`processFrom = NULL` ⇒ 不设下界。**不**用固定年龄窗——既有 daily-digest 需求明确「纳入范围不得带年龄上限，使**停机积压不被永久排除**」；按 `processFrom`（收到时间下界）恰好两全：停机期间**收到**的邮件在水位线之后、仍入摘要，只排除接入前的历史积压。
- 新增运维命令 `account set-process-from <id> <date>`：把存量账号盖到指定日期。存量账号迁移默认 `processFrom = NULL`（**不**回溯改写其半年历史，由运维显式 opt-in）。压住存量 1189 封积压 = 运维对这 3 个账号执行 `set-process-from <id> 今天`（用户已确认要压掉）。
- **两层都做、缺一不可**：摄入水位线挡未来旧邮件入库，摘要 `receivedAt` 下界压住**已入库**的旧货——二者解决不同集合（1189 封已 `processedAt!=null` 的存量靠摘要下界压住，前提是其 `processFrom` 被 `set-process-from` 盖到今天）。

## 功能 (Capabilities)

### 新增功能
- `onboarding-watermark`: per-account 起算日期水位线——数据模型（`processFrom` 列）、接入种值与 NULL 语义、IMAP / Gmail 摄入查询的日期下界、运维 `set-process-from` 命令与 `--process-from` 覆盖。

### 修改功能
- `daily-digest`: 摘要候选查询（`listDigestCandidates`，原显式「无年龄窗」）新增**按账号 `processFrom` 的 `receivedAt` 精确下界**（**不**用全局固定年龄窗——那会违反既有「停机积压不被永久排除」需求）；`processFrom = NULL` 不设下界。压住接入前的历史积压不再进摘要。

## 影响

- **DB 迁移**：`mail_accounts` 加 `processFrom`（可空，**无数据回填**、仅加列；live PG16 上为纯元数据 `ADD COLUMN`、不锁表）。生成迁移后须**手工核对**迁移体只含该 `ADD COLUMN`、**不含**对 `mail_actions` 两个部分索引的 `DROP`（Prisma 表达不了部分索引、生成时会误判漂移，见 `schema.prisma:88-89`）。
- **代码**：`prisma/schema.prisma`（`processFrom` 列）、`src/repo/mailRepo.ts`（`StoredAccount`/`AccountWriteInput`/`setProcessFrom`/`listDigestCandidates:847-905`）、`src/repo/inMemoryMailRepo.ts`（`AccountRow.processFrom` + 同款下界）、`src/accounts/accountRegistry.ts`（`parseImap`/`parseGmail` 穿透）、`src/providers/provider.ts`（`ImapAccount`/`GmailAccount` 加字段）、`src/providers/imap/imapPoller.ts:119`+`imapClient.ts:89`（`{seen:false, since?}` 合取）、`src/providers/gmail/gmailPoller.ts:102`（`after:`）、`src/cli/account.ts`（播种 + `--process-from` + `set-process-from`）。
- **配置**：无新增 env（不引入 `DIGEST_MAX_AGE`）。
- **索引**：摘要 `receivedAt` 下界骑在现有顺扫上（1189 行下亚毫秒级），**不**新增索引；`(accountId, receivedAt)` 复合索引为**后续**项、待行数增长再议（避免过早优化）。
- **不改**：去重键 `(accountId, providerMessageId)`、稳态轮询（增量轮仍按 UID 游标、不带日期下界）、读未读语义、`lastSyncCursor`（归 IMAP UID 游标，**不复用**）、daily-digest「停机积压仍入摘要」语义（按 `processFrom` 而非固定年龄窗，故保留）；存量账号历史不被回溯改写（默认 NULL）。
