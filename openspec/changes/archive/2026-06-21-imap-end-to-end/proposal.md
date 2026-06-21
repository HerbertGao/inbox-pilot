## 为什么

P0–P2 已把「分类 → 规则兜底 → 落库 → 动作 → 通知」整条流水线用假 provider 跑通并离线可测，但至今没有任何真实邮箱接入。P3 接上第一个真实 provider（IMAP），让未读邮件能被实际拉取、分类、按裁定标已读、对 P0/P4 推送——这是项目从「离线可测内核」变为「能看到效果」的里程碑（ROADMAP P3）。

同时，一旦接上真实邮箱，「敏感邮件永不自动标已读」就从测试假设变成生产风险。当前规则引擎对敏感邮件的护栏主要依赖一份发件域名单（`SENSITIVE_DOMAINS`，目前仅 5 个占位域名），生产中要守住硬约束就得预先塞进几十个银行/医院/保险域名——维护负担大且永远不全。用户已决定：不强制要求维护域名白名单，改以「内容轴」（LLM 类别 + 关键词）为主防线。本变更顺带收口这一策略，使真实 IMAP 接入时敏感邮件保护不依赖白名单也能成立。

## 变更内容

- 新增 IMAP provider 端到端通道：从配置读取 IMAP 账号 → 轮询 INBOX 未读 → 拉 envelope + 文本正文 → 收敛为 `NormalizedEmail` → 经既有 `processEmail` 流水线 → 真实标 `\Seen`。
- 实现 `ProviderActions.markRead` 的真实 IMAP 版本（替换假 provider），并注入 `processEmail`。
- 新增 node-cron 轮询调度，按 `POLL_INTERVAL_SECONDS` 周期触发；单账号轮询不重入。
- 增量 UID 游标（`lastSyncCursor`）：只取 `UID>游标` 的新邮件，已处理的不再 FETCH——使 P0/P1/P4「不标已读」也不被重复扫描；游标为「连续已处理前缀」高水位，失败/崩溃的邮件下轮重取（dedup 安全），并顺带修复纯 UNSEEN 模型下「标已读后崩溃→永久跳过」的孤儿行。
- 轮询循环逐封 normalize + 单封 throw 隔离：单封解析/处理失败只跳过该封并记录，不中断整批。
- 新增依赖 `imapflow` + `node-cron`；新增 `IMAP_*` 配置项（可选，缺失则不启用 IMAP；`POLL_INTERVAL_SECONDS` 已存在）。
- 账号加载后按 `accountId` upsert 一个 `mail_accounts` 锚定行：`mail_messages.accountId` 有外键约束，无锚定行会使首次落库 FK 违约。
- 失败退化：移动文件夹不可用 / 不稳定时，仅标 `\Seen`（本变更默认即只标 Seen，不做文件夹移动）。
- **修改安全规则护栏**：敏感邮件「强制不标已读」主防线为「内容轴」——① 类别轴：最终 `category ∈ {finance, security, transaction}` 强制 `shouldMarkRead=false`（银行→finance、支付→transaction、安全→security）；② 关键词轴：在既有支付/安全关键词上**新增医院/保险类关键词**，使硬约束各类均由内容轴覆盖（关键词轴确定性兜底 支付/合同/安全/医院/保险/账单类 + 类别轴概率性广覆盖 finance/security/transaction，无需域名白名单；纯银行/医院/保险通知态为 best-effort，分层见 safety-rules 规范）。`SENSITIVE_DOMAINS` 降为可选补充但**默认非空**（保留示例项），不要求穷举维护。

## 功能 (Capabilities)

### 新增功能
- `imap-integration`: 真实 IMAP provider 端到端——账号加载、未读轮询、原始邮件→`NormalizedEmail` 收敛、真实标已读、cron 调度与单账号互斥、单封失败隔离、重启不重复处理。

### 修改功能
- `safety-rules`: 「强制不标已读护栏」需求增加「类别轴」（`category ∈ {finance, security, transaction}` 强制不标已读）并在关键词轴**新增医院/保险类关键词**；发件域名单从「主防线/需穷举」重新定位为「可选补充、默认非空」。硬约束「敏感邮件不自动标已读」由内容轴落地：关键词轴确定性兜底（支付/合同/安全/医院/保险/账单类）+ 类别轴概率性广覆盖（finance/security/transaction）；纯通知态残留 best-effort（分层见 safety-rules 规范）。

## 影响

- **新增依赖**：`imapflow` + `node-cron`（PROJECT_INIT §3.2 均已指定）；dev：`@types/node-cron`。
- **新增代码**：`src/accounts/accountService.ts`、`src/providers/imap/{imapClient,imapPoller,imapActions}.ts`、`src/jobs/scheduler.ts`；`src/main.ts` 接入调度。
- **修改代码**：`src/rules/applySafetyRules.ts` + `src/rules/lists.ts`（类别轴 + 医院/保险关键词；域名表保留非空）；`src/config/config.ts`（`IMAP_*`）；`src/logger.ts`（`IMAP_PASSWORD` 加入 redact）；`.env.example`。
- **安全行为变化**：敏感邮件保护不再要求维护域名白名单，改由内容轴落地——关键词轴确定性兜底（支付/合同/安全/医院/保险/账单类），类别轴概率性广覆盖（finance/security/transaction，堵住「高置信被判 P2/P3 的银行/金融营销邮件被自动标已读」的洞）。残留缺口=任何**未命中关键词、又被 LLM 判为非敏感类别**的邮件（含无账单词的纯银行通知、未列入关键词表措辞的医院/保险邮件），非零、best-effort；关键词表为有限集、完备性不可证，不引入 medical/insurance 类别（超范围）。
- **不触及**：分类内核、通知渠道、Gmail（P4）、每日摘要（P5）、YAML 可配化（P6）。

## 非目标（本变更不做）

- 不做 Gmail 接入（P4）、每日定时摘要（P5）、YAML 规则可配化（P6）。
- 不实现 IMAP IDLE / 推送，仅定时轮询。
- 不做文件夹创建/移动到 `AI-*`（默认仅标 `\Seen`，移动留作后续）。
- 不做附件深度解析、HTML 深度清洗、历史邮件全量回填。
- 不引入跨重启的 durable 重试预算 / 退避（属 P6 稳定性收尾）。
- 不做敏感域名白名单的穷举维护，也不引入医院/保险专用类别。
