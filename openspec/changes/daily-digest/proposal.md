## 为什么

P0/P4 已即时推送，但 P1（待处理）/P2（订阅通知）/P3（广告营销）邮件**至今无任何出口**——
分类落库后用户看不到汇总。notifications spec 早已声明这些邮件「去向是摘要/计数，属后续阶段」。
本期补上这条出口：每天定点把**自上次摘要以来未汇总的新邮件**汇总成一条（或分段）推送，
让用户一眼看完不必逐封翻。

## 变更内容

- 新增 `digest/buildDigest.ts`：查**自上次摘要以来未进过摘要**的已处理邮件（确定性排序、行主键 `messageRowId`），
  组装 §13.2 文案——P1/P2 逐条（发件人 - 主题 - 原因）、P3 仅计数（条数，**不**断言已读）。
  **只用显式 `select` 白名单字段**，绝不读 `bodyText`。按 Telegram 4096（UTF-16 单位）**分段**、**单行先截断**，
  杜绝超长文案/超长单行永久发送失败；每段携带其 `messageRowIds`。
- 新增 `digest/digestScheduler.ts`：node-cron 按 `DIGEST_TIMES`（默认 `12:30,21:30`，去重）每天定点触发，
  复用 `ScheduledTask[]` 优雅关闭模式 + **进程内共享锁跨任务互斥**（`noOverlap` 仅单任务、不够）+ `timezone`
  + cron 构造期/运行期错误隔离（非法 TZ 不拖垮服务）。
- **去重**：经 `digest_items` 表的**存在性**落地——一封邮件有 ≥1 行即排除。**逐段提交：每段发送成功即落该段
  `digest_items`**（失败段及其后段不落、下次重含，不丢件、大积压不死循环）。无唯一约束（不迁移），重复行容忍。
- **复用发送**：digest 文案经既有通知渠道（telegram）发送——为渠道/notifier 增「发预组装文本」路径
  （不经 per-email payload），仍走同一超时 + 脱敏 + 无 parse_mode，**不泄露完整正文**、绝不发邮件。
- 新增 `DIGEST_TIMES` 到 config（`z.string().optional()`，默认值在 scheduler 层兜底，使**显式空串 → 不调度**、
  缺省 → 默认）：strict 校验 `HH:MM`、非法项调度前记错跳过、全空/全非法则不调度（服务照常启动）。
- 设置容器时区 `TZ`（`docker-compose.yml` + `.env.example`）——定点依赖服务器本地时区。
- `main.ts` 接线：digest scheduler 的 task **concat 进同一个被 `shutdown()` 迭代的列表**。

## 功能 (Capabilities)

### 新增功能
- `daily-digest`: 每日定点摘要——自上次摘要以来的新邮件按优先级汇总（P1/P2 逐条、P3 计数）经既有渠道分段推送，
  `digest_items` 存在性去重保证同封不重复，发送失败/停机/文案超长均不丢件，不泄露正文、绝不发邮件。

### 修改功能
<!-- per-email notifier 行为不变（仍仅 P0/P4 即时推送）；digest 是独立出口，不改 notifications 既有需求。 -->

## 非目标（不纳入本期 MVP）

- **P2 按发件人/类别分组计数**（§13.2 示例的「GitHub 3 封 / Newsletter 5 封」）：本期 P2 逐条，分组留后续。
- **`digest_items` 唯一约束 / exactly-once / 候选扫描索引**：均需 schema 迁移（out-of-scope）；本期 at-least-once +
  读侧存在性去重 + 个人邮箱规模下未索引扫描可接受（量级变大再加索引）。
- **空摘要也推送**「今日无新邮件」：本期无新邮件则**不发**。
- 错过的定点补发（进程在 12:30 宕机则该次不补，漏的件因未落 `digest_items` 滚入下一次摘要、不丢）。
- 超出「下次定点 + 文案分段」的重试退避；多渠道/可配置模板/per-digest 时区。

## 影响

- **新增**：`src/digest/buildDigest.ts`、`src/digest/digestScheduler.ts`（+ 各自 `.test.ts`）。
- **修改**：`src/config/config.ts`（+`DIGEST_TIMES`，optional + scheduler 层兜底）、`src/notify/notifier.ts` +
  `src/notify/telegram.ts`（+ 发预组装文本路径）、`src/repo/mailRepo.ts` + `src/repo/inMemoryMailRepo.ts`
  （+ `listDigestCandidates` / `markDigested`）、`src/main.ts`（接线 + 关闭列表 concat）、
  `docker-compose.yml` + `.env.example`（+`TZ`）。
- **数据**：复用既有 `digest_items` 表（**无 schema 迁移**、不加唯一约束）。
- **依赖**：无新增（node-cron / 既有渠道 / fetch 均已在用）。
