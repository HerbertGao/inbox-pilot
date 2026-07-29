## 为什么

`imap-integration` 有四条 MUST 自 `586dc62`（迁移为 hangar pilot，#35）起无任何实现：

- 「IMAP 轮询**必须** SELECT INBOX、按增量 UID 游标取新邮件…经 `normalizeEmail` 收敛为 `NormalizedEmail` 后才交给分类流水线」
- 「轮询**必须**用持久化的增量游标（`mail_accounts.lastSyncCursor`，形如 `<uidValidity>:<uid>`）只取新邮件」
- 「poller **必须**为每封转交 `processEmail` 的邮件填充 `uid`」（`markRead` 消费它）
- 「轮询循环**必须**逐封 normalize + 处理，并对**单封**异常 catch+skip」

那次迁移删掉了 `src/providers/imap/imapPoller.ts`（475 行）与 `MailRepo` 的 `getCursor`/`setCursor`（注释：「已剥离（不搬，破脊柱 #3/#8）」），`src/pipeline.ts` 的 poll 分支则以 `accounts.filter(a => a.provider === 'gmail')` 只留 Gmail。删除是有意的——durable 重试状态机确实该归 hangar——但**轮询本身没有被搬到任何地方，只是消失了**。

后果是一个静默失效：`provider='imap'` 的账号 `enabled=true`、被 `loadEnabledAccounts` 正常加载、在 `account list` 里显示为启用，然后在 `run()` 里被过滤掉。不报错、不记日志、`doctor` 无对应检查项。生产实测：该账号 39 封邮件全部早于迁移日，之后零处理。

这不是新功能，是**代码不满足现行规范**。

## 变更内容

- **恢复 `src/providers/imap/imapPoller.ts`**：openInbox → 读游标 → 增量轮 / 退化轮判定 → SEARCH → 按 UID 升序逐封 fetch/map/normalize → 交共享处理链 → 算连续已处理前缀高水位 → 写游标。IMAP 专属算法（游标解析、`advanceHighWater`、`computeCursorToWrite` 的退化轮 floor 四级优先、expunge 空洞不卡死、`N:*` 总返回最高 UID 的 dedup 安全性）从 `586dc62^` 取回，语义不变。
- **恢复 `MailRepo` 的 `getCursor` / `setCursor`**：`mail_accounts.lastSyncCursor` 列在 schema 与生产库中均完好、且存有迁移前的游标值，只是访问方法被移除。
- **抽出与 provider 无关的单封处理链**：现有 `processOneEmail` 自己做 `gmail.get`、与 Gmail 耦合。把「分类（复用/LLM）→ 规则 → `executeActions` → emit → `markProcessed`」抽成取 `NormalizedEmail` 的共享函数，Gmail 与 IMAP 各自提供取件端。规范原文即「**收敛为 `NormalizedEmail` 后才交给分类流水线**」，此为其自然落点。
- **`run()` 的 poll 分支同时处理 imap 账号**：与 Gmail 账号同处一次 run，复用既有 per-email 超时 / fence / per-run 墙钟 / 账号级异常隔离。
- **新增一条需求**承接被 `retire-http-and-dead-config` 删掉的触发语义：IMAP 轮询由 `app.yaml` 的 `poll` cron 触发器驱动，轮次串行由 hangar 的 per-app in-flight 闸保证。

## 功能 (Capabilities)

- `imap-integration`：新增「轮询由 hangar poll 触发器驱动」需求。其余四条需求**不改**——本变更是让实现满足它们，不是改它们。

## 影响

- **行为**：`provider='imap'` 且 `enabled=true` 的账号恢复轮询。游标从库中既存值继续（生产该账号为 `1:1321162911`），走增量分支 `SEARCH UID <游标+1>:*`——**不重扫整箱、也不依赖 UNSEEN**，故不会因迁移期间被别的客户端读过而漏。
- **每轮时长**：多一个账号的连接与 FETCH。hangar 的 in-flight 闸要求 `run()` 自限时长，既有 per-run 墙钟兜底不变。
- **`\Seen` 写入**：恢复轮询即恢复对该邮箱的标已读写操作（仅 `shouldMarkRead` 为 true 时；P0/P1/P4 与敏感邮件由 `applySafetyRules` 挡住）。这是规范既定行为，但对该邮箱是三周以来第一次。
- **无 schema 变更、无迁移**：列与数据都在。

## 非目标

- **不接 IMAP 的 `reflectPriority`**：`createImapProvider` 现为有意 no-op（规范原文「IMAP 本期 no-op」），本变更不动。
- **不恢复 durable `mail_actions` 状态机**：那是 `586dc62` 有意剥离的，重试归 hangar。`MailAction` 模型的残留（`status`/`retryCount`/`nextRetryAt` 三列 + 两条 partial index + schema 里那条「绝不接受生成迁移里的 DROP INDEX」警告）是另一笔债，另开变更收。
- **不调和 `account-registry`「per-account 调度与故障隔离」**：该需求描述的是一个带信号量与 `isPolling` 锁的进程内 scheduler，迁移后已由 hangar 承接，措辞已不符实际。「增量 UID 游标」需求里指向它的那个前提指针也因此需要重定向——两者是同一笔待办，不在本变更范围（改它要 MODIFIED 逐字复现 65 行，与本变更的实现工作无关）。
- **不改 `POLL_INTERVAL_SECONDS` 之类的节奏旋钮**：该字段已退役，节奏在 `app.yaml`。
