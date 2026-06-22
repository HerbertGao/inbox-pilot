## 上下文

P0/P4 已经过 `notifier` 即时推送；P1/P2/P3 分类落库后无出口。本期接上「定时摘要」这条出口。
现成可复用件：`notify/notifier.ts` + `notify/telegram.ts`（渠道选择 + 脱敏 + 超时 + 不泄露正文）、
`jobs/scheduler.ts` 的 node-cron + `ScheduledTask[]` 优雅关闭模式 + per-account `isPolling` 锁、`repo/mailRepo.ts`
注入式 seam（prisma 真身 + 内存测试实现；**`MailMessage.id` 在该 repo 里一律叫 `messageRowId`**，区别于 RFC 头 `messageId`）、
既有 `digest_items` 表（`id/messageId/digestType/sentAt/createdAt`，`messageId` 是 **FK → MailMessage.id**，
**无 `@@unique([messageId,digestType])`**——见决策 3）。`mail_classifications.priority` 已是规则引擎裁定后的
`FinalDecision.priority`；规则引擎 `shouldIncludeDigest = priority ∈ {P1,P2}`，P3 是「标已读、**不入摘要**、只计数」。
node-cron `noOverlap` 仅**单任务内**不重入（每 `cron.schedule` 一个独立 Runner/lastExecution，**不跨任务**），
故多时刻互斥不能靠它——用进程内共享锁（见决策 7）。`timezone` 选项仍用（决策 6）。

约束：不泄露完整正文、绝不发邮件、凭据不入日志、同封不重复进摘要（硬约束 + spec）。

## 目标 / 非目标

**目标：**
- 每天定点把**自上次摘要以来未进过摘要**的邮件汇总推送（P1/P2 逐条、P3 计数），**逐段提交**保证收敛。
- 去重经 `digest_items` 落地、发送失败/停机/文案超长/单行超长均**不丢件、不死循环**。
- 最大化复用既有 notifier/渠道/scheduler，零新依赖、零 schema 迁移。

**非目标：**
- P2 按发件人/类别分组计数（§13.2 示例）；本期逐条，分组留后续。
- 空摘要推送、错过补发、超出「下次定点 + 逐段重试」的重试退避、多渠道/可配置模板（见 proposal 非目标）。
- `digest_items` 唯一约束 / exactly-once、候选扫描索引（均需 schema 迁移，**out-of-scope**；本期 at-least-once +
  读侧存在性去重 + 个人邮箱规模下未索引扫描可接受）。

## 决策

### 决策 1：增量去重（since-last），唯一机制是 `digest_items` 行的**存在性**
摘要纳入「**尚未进过摘要**的已处理邮件」——经 `digest_items` 是否有 `(messageRowId, 'daily')` 行判定
（`messageRowId` = `MailMessage.id`，**非** RFC 头 `messageId`）。**去重唯一真相源是「≥1 行即排除」读侧谓词**
（不依赖唯一约束）：有 ≥1 行即不再进摘要，重复行无害（决策 3）。时间不再作边界（决策 4 去掉年龄窗）。

### 决策 2：build / send / persist 分离，**逐段提交**
`buildDigest(repo, now) → { segments: Array<{ text: string; messageRowIds: string[] }> } | null`：查候选 +
组装文案并按渠道上限**分段**，每段携带**该段所含邮件的 `messageRowIds`**（含 P3 计数段所计 P3 的 row-ids），
**不发送、不写库**（null = 无可入摘要邮件，见决策 4 的「null 条件」）。`digestScheduler` 一轮编排（**逐段提交**）：
```
const d = await buildDigest(repo, now); if (!d) return;
for (const seg of d.segments) {
  if ((await notifier.notifyDigest(seg.text)).outcome !== 'sent') return; // 停在第一处失败
  await repo.markDigested(seg.messageRowIds, DIGEST_TYPE_DAILY, now);      // 该段发成功即提交
}
```
即**每段发送成功后立刻 markDigested 该段的 row-ids**（不是全发完才一次性 mark）。理由：逐段提交使
**已发段不会在下一轮重发**（消除「重复段」+ 大积压下「全有或全无」永不收敛的 livelock）；失败段及其后段不 mark、
下轮重试，仍**不丢件**。`buildDigest` 纯粹（注入内存 repo + 固定 now）→ 离线断言文案/分段/去重/排序。

### 决策 3：先发送、该段成功才 mark；at-least-once，重复行容忍
逐段：某段全部发送成功后才 `markDigested(seg.messageRowIds)`。代价：某段发成功后、mark 前崩溃 → 下轮该段
**重含一次**（at-least-once）。`digest_items` **无唯一约束**，故 `markDigested` 用 `createMany` 直插、**重复
`(messageRowId,'daily')` 行可容忍**（决策 1 读侧只看存在性）。并发重复由决策 7 的进程内共享锁挡住。
- **`// ponytail`**：唯一约束 / outbox 可消重复行 + exactly-once，但需 schema 迁移（**out-of-scope**）；本期读侧
  存在性去重 + 容忍重复行，正确且零迁移。`markDigested` **不**用 `skipDuplicates`（无唯一索引时它是 no-op、徒增误解）。

### 决策 4：候选查询 `listDigestCandidates(digestType)`——无年龄窗、显式 select、确定性排序、单行可截断
- **谓词**：`processedAt != null` 且**无** `digestType` 对应 `digest_items` 行（**无 `createdAt >= now-24h` 年龄窗**——
  年龄窗会把停机 >24h 期间未发邮件永久排除、与「不丢件」矛盾）。
- **确定性排序**（决策 2 分段稳定 + 进度合理的前提）：`orderBy [优先级档(P1<P2<P3), receivedAt asc, id asc]`——
  优先级聚合、同档老邮件优先，跨轮 build 段边界稳定。**`// ponytail`**：`processedAt` / `digest_items` 反存在查询
  **未建索引**，个人邮箱规模（万级行、每日两次）顺序扫描成本可忽略；建索引需迁移（out-of-scope），量级变大再加。
- **最新分类**：嵌套 `classifications: { select:{priority,category,reason}, orderBy:[{createdAt:'desc'},{id:'desc'}], take:1 }`
  （`id desc` 与既有 repo 约定 mailRepo.ts:162 一致；cuid `id` 非严格单调，同毫秒并列罕见，沿用既有约定不另造）。
- **显式 `select` 白名单**（**非 `include`**，否则把整行 `MailMessage` 含 `bodyText` 拉进结果）：只 select
  `{ id, subject, fromEmail, fromName, receivedAt, classifications:{...} }`。投影为 `DigestCandidate
  { messageRowId(=MailMessage.id), priority, category, subject, fromEmail, fromName?, reason }`（**无 bodyText**）。
- **缺分类行的已处理邮件**（`classifications` 为空数组）：**排除**，记一条 **debug** 级日志（非 error、非每轮刷屏）。
- **P0/P4 / 缺分类行不入结果**：query 取 `processedAt!=null` 会带出 P0/P4，JS 取最新分类后**只保留 `priority ∈ {P1,P2,P3}`**
  （P0/P4 丢弃）。P0/P4 不落 `digest_items`（它们出口是即时推送）、会被每轮重扫——个人邮箱规模可忽略（同上 ponytail）。
- **itemized vs counted 两子集**：`buildDigest` 把 `{P1,P2}` **逐条**渲染（= `shouldIncludeDigest`），`P3` **只计数**；
  **两子集的 row-ids 都进所在段的 `messageRowIds`、都被 mark**，故 P3 计数语义是「**自上次摘要以来新增的 P3 条数**」
  （增量、非当日总计；§13.2「26 封」按增量解读、且**不照搬其「已静默标记已读」字样**——见决策 5）。

### 决策 5：渠道/notifier 增「发预组装文本」+ 按 UTF-16 上限分段 + 单行截断
给 `NotificationChannel` 加 `sendText(text)`（telegram 把 sendMessage POST 抽成共用 helper，与 per-email 共用超时 +
脱敏 + 无 `parse_mode`）；给 `Notifier` 加 `notifyDigest(text)`（无渠道 → skipped 降级）。
- **长度单位**：Telegram `sendMessage` 上限是 **4096 个 UTF-16 code unit**——以 JS `text.length`（正是 UTF-16 单位、
  emoji 代理对计 2）度量，**禁止**用 `[...text].length`（码点、emoji 计 1）会低估致超限 400。段预算常量 `SEGMENT_MAX = 4000`
  （留余量），`text.length <= SEGMENT_MAX`。
- **分段**：按**整条 P1/P2 行**切（不切断单行）；P3 计数行短、并入末段。
- **单行有界渲染（防单行 > 段预算永久 400）**：渲染 `发件人 - 主题 - 原因` 时，**发件人（fromName/fromEmail，均来自不可信
  邮件头、无长度上限）、主题、原因每个字段各自截断**到字段级上限 `FIELD_CAP`（如 200 UTF-16 单位、超出加 `…`），分隔符 ` - `
  保留、**发件人两者皆空 → 填占位（复用既有 `（未知发件人）`）**；并以**整行最终无条件再截断到 `SEGMENT_MAX-ε`** 作硬兜底
  （不依赖 `FIELD_CAP` 取值——须满足 `3*FIELD_CAP + 分隔符 + 前缀 ≤ SEGMENT_MAX`，但整行兜底始终执行+被测）。截断统一走
  **一个 `truncateUtf16(s, max)` helper**，**字段级与整行级两处都用**；helper 须**代理对安全**（slice 后丢弃末尾落单的高代理
  0xD800–0xDBFF，避免裂出孤代理）。
- **P3 计数行不写「已静默标记已读」**：markRead 可能因敏感规则未执行或发送态失败（`executeActions` 不抛、`markProcessed`
  照常），摘要不核验 `mail_actions`，故只输出条数、**不断言已读**（与 §13.2 模板字样有意不同）。
- telegram 不设 `parse_mode`——subject/fromName 攻击者可影响，按字面发（沿用既有 security 决策）。

### 决策 6：`DIGEST_TIMES` 解析 + cron + 时区
- config 加 `DIGEST_TIMES`：**裸 `z.string().optional()`——禁止 `z.preprocess(emptyToUndefined, …)` 包裹**
  （`emptyToUndefined` 会把显式 `''` 归一为 `undefined`、再被默认复活成排程，与 spec「显式空 → 不调度」相反）。
  config.ts 该字段须加**显式行内注释**说明「此键有意不走 emptyToUndefined / 不用 zod default」（防实现者照搬全文件惯例改回）。
  默认在 digestScheduler 层兜底：**`undefined`（env 缺省）→ 默认 `12:30,21:30`；`''`（显式空）→ 空列表 → 不调度**。
- **token 解析 + 去重**：按 `,` 切，每 token 解析为两个整数 `H:M`（**接受 `9:5` 与 `09:05`**，不强制零补；范围 `0–23`:`0–59`），
  空/越界/非两段数字 → **在 `cron.schedule` 之前**记错跳过。**去重**：对合法时刻按规范化 `M H` 去重（`12:30,12:30` → 一个任务），
  否则同分钟两任务各自触发 → 重复推送 + 重复 `digest_items` 行（noOverlap 跨不了任务）。合法（去重后）者各 cron `M H * * *`。
- **时区 + 构造期错误隔离**：`cron.schedule(expr, fn, { timezone })`——`timezone` 取容器 `TZ`（`docker-compose.yml` +
  `.env.example` 落 `TZ`，本期交付、非仅文档；显式传使代码层可见可测）。**每个 `cron.schedule(...)` 的构造须各自 try/catch**：
  非法 `timezone`（非 IANA 串）或表达式会在 **schedule 构造期同步抛**（在运行期回调 try/catch 之外）——若不接住，按 main 既有
  setup 抛错路径会 `process.exit(1)`、**拖垮整个服务**（含轮询）。故构造抛错 → 记脱敏 kind、跳过该 digest 任务、**保轮询 + /health 存活**
  （与「非法 token 跳过」同等对待）。`// ponytail: 个人部署单时区；per-digest 可配置时区留后续`。

### 决策 7：跨任务互斥用**进程内共享锁**，不靠 node-cron `noOverlap`
`noOverlap` 是**单任务内**不重入（每 `cron.schedule` 独立 Runner/lastExecution）——**多时刻是多任务**，相邻时刻
（`12:30,12:31`）或慢 digest（大积压多段发送跨过下一触发）会**跨任务并发** → 重复推送 + 重复行，noOverlap 挡不住（经 node-cron
源码确认）。故用**一个进程内共享 `digestRunning` 布尔**（**单一实例、由 `startDigestSchedulers` 一次构造、所有 digest cron
任务闭包共用**——切勿每任务/每工厂调用各起一个，否则跨任务互斥失效）：回调
`if (digestRunning) return; digestRunning = true; try { … } finally { digestRunning = false }`。
- **同步置位先于首个 await**（JS run-to-completion 下，回调顶端同步 `if/set` 无 TOCTOU）；**置位语句须紧邻 `try`**——
  `digestRunning = true` 与 `try {` 之间**不得插入任何可能同步抛的语句**（否则抛出会绕过 `finally`、永久泄漏锁；有测试钉住
  「保护体首行同步抛仍释放锁」）。**`finally` 释放**（digest 无「挂死 poll 保持锁」需求，故与 scheduler 的「锁绑真实 settle」
  语义**有意不同**——一次挂死的 send 经渠道 10s 超时后释放、不永久 wedge）。
- **运行期错误隔离（必须）**：回调体 `try { const d = await buildDigest(repo, now); if (!d) { log kind:'digest-empty'; return; }
  逐段 send+mark } catch { 记**脱敏**错误（只 kind+code，**绝不**记原始 error/cause/正文/收件人 PII/凭据，见 logger 纪律） }
  finally { digestRunning = false }`。回调内部已 catch+finally，**不依赖** node-cron 是否 await 返回值，故注册成
  `() => void run()` 或 `async () => { await run() }` 均不漏 rejected promise、均不破坏互斥（锁在回调内、与 node-cron 生命周期解耦）。

## 风险 / 权衡

- **某段发成功后、mark 前崩溃 → 下轮该段重发** → 已 mark 的段不重排队；**唯当前「已发未 mark」的段**会重发，直至其 mark
  提交（反复同点崩溃可重发多次，非严格「最多一次」）；优于丢件。重复 `digest_items` 行被读侧存在性去重容忍（决策 1）。
- **markDigested 重复插入安全性绑定于「无唯一约束」** → 现 schema 下 `createMany` 重插不抛；若后续加唯一约束（非目标），
  重插会抛、须同步改 `skipDuplicates`/upsert——有测试钉住「重复插入不抛」。
- **某段持续失败** → 逐段提交下，已发段已 mark、不再重发；失败段及其后段下轮重试——收敛、不丢件。
- **未索引候选扫描 + P0/P4/缺分类行每轮重扫** → 个人邮箱规模可忽略（决策 4 ponytail）；建索引 / 标记位需迁移（out-of-scope）。
- **正文泄露** → 显式 `select` 白名单 + `DigestCandidate` 无 bodyText 字段 + 文案断言测试（决策 4/5）。
- **服务器时区错配 / 非法 TZ** → `TZ` 落进 compose + `.env.example` + 显式传 `timezone`；非法 TZ 在构造期被各任务 try/catch 接住、
  跳过该任务保服务存活（决策 6）。
- **停机 >24h 的未发邮件** → 无年龄窗（决策 4），靠 `processedAt + 未 digest` 谓词，**不丢件**（「最终必达」现成立、逐段收敛）。

## 迁移计划

无 schema 迁移（复用 `digest_items`、不加唯一约束/索引）。部署：设 `DIGEST_TIMES` + `TZ`（或用默认）→ 重启生效。
digest task 与轮询 task **concat 进 main 同一个被 `shutdown()` 迭代的 `schedulerTasks` 数组**（main.ts 现状是 `=` 覆盖赋值，
须改为 concat；否则 digest task 不被 `stop()`、`$disconnect()` 后仍触发）。回滚：置 `DIGEST_TIMES=`（显式空）即停摘要。

## 待解决问题

无阻塞项。P2 分组计数（§13.2）、`digest_items` 唯一约束/索引、exactly-once 均记入 proposal 非目标（后续 + 需迁移）。
