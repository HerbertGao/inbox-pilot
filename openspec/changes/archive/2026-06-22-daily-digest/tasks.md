## 1. 配置：DIGEST_TIMES

- [x] 1.1 `config.ts` 加 `DIGEST_TIMES`：**裸 `z.string().optional()`**——**禁止** `z.preprocess(emptyToUndefined,…)` 包裹、**禁止** zod `.default()`（否则显式 `''→undefined→默认` 复活，毁掉「显式空→不调度」）；该字段加**显式行内注释**写明「有意不走 emptyToUndefined / 不用 default，区分 undefined(缺省→默认) vs ''(显式空→不调度)」
- [x] 1.2 `config.test.ts` 在 **config 层**断言：env 缺省 → `undefined`；**显式 `''` → `''`（不被归一为 undefined、不落成默认）**；显式值 → 透传

## 2. Repo seam：候选查询 + 去重落库

- [x] 2.1 `mailRepo.ts` 加 `DigestCandidate { messageRowId, priority, category, subject, fromEmail, fromName?, reason }`（**字段名 `messageRowId` = `MailMessage.id`，非 RFC `messageId`；无 bodyText**）+ 方法 `listDigestCandidates(digestType): Promise<DigestCandidate[]>`（**无年龄窗参数**）与 `markDigested(messageRowIds, digestType, sentAt): Promise<void>`；加 `export const DIGEST_TYPE_DAILY = 'daily'`
- [x] 2.2 `PrismaMailRepo.listDigestCandidates`：`processedAt != null` 且**无**对应 `digest_items` 行（**无 `createdAt>=now-24h`**）；**显式 `select` 白名单**（**非 `include`**）含 `classifications:{ select:{priority,category,reason}, orderBy:[{createdAt:'desc'},{id:'desc'}], take:1 }`；**确定性排序 `orderBy [优先级档, receivedAt asc, id asc]`**；JS 取最新分类，**缺分类行（classifications 空）→ 排除 + 记 debug 日志（非 error/非每轮刷屏）**；只保留 `priority ∈ {P1,P2,P3}`（P0/P4 丢弃）；投影 `messageRowId = MailMessage.id`
- [x] 2.3 `PrismaMailRepo.markDigested`：`createMany` 批量插（messageId=messageRowId/digestType/sentAt）；**不用 `skipDuplicates`**（无唯一索引时为 no-op）；重复行容忍
- [x] 2.4 `inMemoryMailRepo.ts` 实现两方法（latest-classification 用既有 `createdAt desc, seq desc`；排序与谓词同 prisma）
- [x] 2.5 内存自测：候选过滤（未 mark / 排除未 processed / **缺分类行排除** / **P0 与 P4 候选被排除** / 不受邮件年龄影响）+ 确定性排序（fixture 用**各异 `receivedAt`**，避同刻并列时 in-memory(`seq`) vs prisma(cuid `id`) 排序差异）+ markDigested 后不返回 + **重复 markDigested 同 (rowId,'daily') 不抛**（钉住「无唯一约束下 createMany 重插安全」假设；若后续加唯一约束须改 skipDuplicates）+ 不破坏读侧去重

## 3. 渠道 / notifier：发预组装文本

- [x] 3.1 `telegram.ts` 把 sendMessage POST 抽成共用 helper；加 `sendText(text): Promise<ChannelSendResult>`（共用超时 + 脱敏 + 无 parse_mode），`NotificationChannel` 接口加 `sendText`
- [x] 3.2 `notifier.ts` 加 `notifyDigest(text): Promise<NotifyResult>`（无渠道 → skipped 降级）
- [x] 3.3 测试：假渠道断言 `notifyDigest` 透传文本返回 sent；无渠道 → skipped

## 4. buildDigest（组装 + 分段 + 单行截断，纯函数）

- [x] 4.1 `digest/buildDigest.ts`：`buildDigest(repo, now) → { segments: Array<{ text, messageRowIds }> } | null`——查候选；{P1,P2} 逐条 `发件人 - 主题 - 原因`、{P3} **仅计数**（条数、**不**写「已标记已读」）；**无 P1/P2 且 P3 计数为 0 → null**
- [x] 4.2 长度按 **`text.length`（UTF-16 单位，禁码点计数）**；常量 `SEGMENT_MAX=4000`、`FIELD_CAP`（满足 `3*FIELD_CAP+分隔符+前缀 ≤ SEGMENT_MAX`）；**单一 `truncateUtf16(s,max)` helper（代理对安全：丢末尾孤高代理 0xD800–0xDBFF）**，**字段级与整行级两处都用**；**有界渲染器**：`发件人 - 主题 - 原因` 中发件人(fromName/fromEmail)/主题/原因每字段各截到 `FIELD_CAP`（加 `…`、保留分隔符、**发件人两者皆空 → 填 `（未知发件人）`**）+ **整行最终无条件再截到 < SEGMENT_MAX**（不依赖字段上限取值、始终执行）；按整条行分段，P3 计数行并入末段；**每段携带其 `messageRowIds`（含 P3 段的 P3 row-ids）**
- [x] 4.3 测试：P1/P2 逐条含发件人/主题/原因；P3 仅计数、文案不含「已读」字样；无 P1P2 且 P3=0 → null；P3>0 但无 P1P2 → 非 null；超长 → 多段、每段 ≤ SEGMENT_MAX、不断行；**超长发件人 / 超长主题 / 超长原因各自及组合 → 单行仍 < SEGMENT_MAX 且保 `^.+ - .+ - .+$` 结构**；emoji 主题按 UTF-16 计数不超限、截断不裂代理对
- [x] 4.4 测试（安全）：断言所有 segment.text **不含** bodyText（候选无该字段，结构保证）

## 5. digestScheduler（解析时刻 + 共享锁互斥 + 逐段提交 + 错误隔离）

- [x] 5.1 `digest/digestScheduler.ts`：env `undefined` → 默认 `12:30,21:30`、显式 `''` → `[]`；每 token **先 trim** 再解析两整数（接受 `9:5`/`09:05`，范围 0–23:0–59）**在 `cron.schedule` 之前**校验；非法/空 token 记错跳过；合法时刻**去重键由解析出的整数 `${H} ${M}` 派生**（故 `"12:30"` 与 `" 12:30 "` 视同一）；去重后各 cron `M H * * *`；全空/全非法 → `[]`
- [x] 5.2 **进程内共享 `digestRunning` 锁**——**`startDigestSchedulers` 内一次构造的单一实例、全部 digest 任务闭包共用**（**不**用 node-cron `noOverlap`——它跨不了任务；切勿每任务各起一个）：回调顶端**同步** `if(digestRunning) return; digestRunning=true;`（先于首个 await、**紧邻 `try`、其间无可同步抛语句**），`finally` 释放。`cron.schedule(expr, fn, { timezone })`——`timezone` 显式传（容器 TZ 兜底）；**`cron.schedule(...)` 构造的 try/catch 必须落在 `startDigestSchedulers` 内**（使非法 timezone/表达式的构造期同步抛被本地接住、记脱敏 kind、跳过该任务，**不冒泡到 main setup → `process.exit(1)`**；保轮询 + /health 存活）
- [x] 5.3 一轮编排（**逐段提交 + 共享锁 + try/catch/finally**）：`if(digestRunning) return; digestRunning=true; try { const d=await buildDigest(repo,now); if(!d){ log digest-empty; return;} for(seg of d.segments){ if((await notifier.notifyDigest(seg.text)).outcome!=='sent') return; await repo.markDigested(seg.messageRowIds, DIGEST_TYPE_DAILY, now);} } catch(e){ 记脱敏 kind/code、不记原始 error/PII/正文 } finally { digestRunning=false }` —— **每段发成功即 mark 该段**；遇首个非 sent 即停
- [x] 5.4 `startDigestSchedulers(...) → ScheduledTask[]`（注入 repo + notifier + 时刻字符串 + timezone，可测）
- [x] 5.5 测试：合法多时刻各起一 cron；**重复时刻 `12:30,12:30` 及含空格 `"12:30, 12:30 "` → 一个任务**；非法/空 token 跳过；显式空 → []；缺省 → 默认两时刻；**共享锁跨任务互斥**（任务 A 运行中、任务 B 触发被跳过）；**保护体首行同步抛 → finally 仍释放锁**（不泄漏）；**非法 timezone → 构造 try/catch 跳过该任务、不崩、轮询/health 存活**；**逐段提交**（seg1 sent→mark seg1、seg2 failed→不 mark seg2 及其后、seg1 不重发）；无候选不调用 notify、记 digest-empty；回调抛错被 catch、`finally` 释放锁、不漏 promise

## 6. main 接线 + 时区 + 优雅关闭

- [x] 6.1 `main.ts` 构造 digest scheduler，其 `ScheduledTask[]` 与轮询 task 合进 `shutdown()` 迭代的 `schedulerTasks`——**用单一合并赋值** `schedulerTasks = [...pollingTasks, ...digestTasks]`（现状是 `schedulerTasks = startAccountSchedulers(...)` 覆盖赋值；**禁止**再来一次 `=` 覆盖或另起未被 stop 的变量）；测试/断言 shutdown 同时 stop 轮询与 digest task
- [x] 6.2 `docker-compose.yml` 给 inbox-pilot 服务设 `TZ`（随 `.env`）；`.env.example` 加 `TZ=Asia/Shanghai`（注释：定点依赖时区）+ 确认 `DIGEST_TIMES=12:30,21:30` 占位；digestScheduler 的 `timezone` 取该 TZ

## 7. 收尾验证

- [x] 7.1 `pnpm exec tsc --noEmit` 干净 + `pnpm test` 全过
- [x] 7.2 对照 spec 场景逐条核验：定点推送 / 无新邮件不推送 / 停机>24h 积压仍入 / 确定性排序 + 行主键标识 / P1P2 逐条 P3 计数不断言已读 / 显式 select 不泄露正文 / 缺分类排除 / UTF-16 分段 + 单行截断 + **逐段提交** / digest_items 存在性去重 / 发送失败不丢件 / 显式空串 vs 缺省默认 / 非法项调度前跳过 + 时刻去重 / **共享锁跨任务互斥 + 构造期/运行期错误隔离（非法 TZ 不崩）** / 优雅关闭同列表
