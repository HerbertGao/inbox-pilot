## 为什么

P3 把流水线在**单个 env 配置的 IMAP 账号**上跑通了；数据层/流水线早已按 `accountId` 键化（去重键、游标、锚定、`processEmail`），但账号加载层仍是单账号、凭据只从 env 读。P4 同时做两件**本应一次建好的事**：

1. **接入 Gmail**（第二个真实 provider）。Gmail 用 OAuth，access/refresh token 是**动态的、必须持久化并刷新** → 只能存 DB（`MailAccount.authJson`），无法放静态 env/YAML。这迫使账号注册表走 DB。
2. **统一多账号**。既然 Gmail 迫使 DB 注册表，就把 IMAP 也并入同一张 `MailAccount` 注册表，避免「先为 IMAP 建一套 env 账号层、Gmail 来了再重做」。

用户已决定凭据模型为**统一**：全部凭据（IMAP host/user/password + Gmail OAuth token）入 `MailAccount.authJson`，`MailAccount` 表成为**唯一账号真相源**。这放宽了 CLAUDE.md「密钥只从环境变量读」——凭据改存 DB authJson（用户已确认接受）。

## 变更内容

- **Gmail provider**：OAuth2 授权流程（`googleapis` + `google-auth-library`，loopback 回调 + `access_type=offline` + PKCE + `state`，scope 恰为 `gmail.modify`、**绝不发送由代码保证**；refresh token 存 authJson、自动 refresh）；`gmailClient`、`gmailPoller`（list unread → 预去重 → messages.get(full) → `NormalizedEmail`）、`gmailActions`（按 P0–P4 映射打 PROJECT_INIT §6.1 权威标签 + `AI/Processed` / remove `UNREAD`；标签 create-or-get）；接入 scheduler。
- **统一账号注册表**：账号来源从 env 单账号改为 `MailAccount` 表（N 个、每个 `provider=imap|gmail`、`enabled`）。`accountService` 改为「从 DB 加载所有 enabled 账号 + 解密 authJson 凭据」；移除 env 单账号 `loadImapAccount`。
- **凭据模型（统一 authJson）**：IMAP 凭据从 env 迁入 `authJson`；Gmail OAuth token 存 `authJson`。**放宽硬约束**「密钥只从环境变量读」→ 凭据存 DB authJson（同步改写 CLAUDE.md / config.yaml）。authJson 仍**禁止入日志**（logger redact + 不打印账号对象）。
- **Provider 抽象（两层 seam）**：scheduler 面向 poller（per-poll 连接、poll→processEmail）；`executeActions` 持有 `ProviderActions`（`markRead` + 新增 `reflectPriority`，由 pollOnce 本轮连接构造注入；IMAP 连接共享）。scheduler 对账号多态迭代（imap|gmail 同一循环）。复用 P3 的 imapPoller/imapActions 收敛到此接口。
- **per-account 调度 + 隔离 + 并发上限**：scheduler 为每个 enabled 账号起独立轮询（各自 `isPolling` 锁、各自游标）；一个账号 IMAP/OAuth 故障**不拖累**其他账号；**共享信号量**全局并发上限 + 单轮 poll 超时，避免同时打爆所有账号/挂死饿死队列。
- **账号 onboarding**：CLI 子命令——`account add --imap`（输入 host/user/password → 写 authJson）/`account add --gmail`（跑 OAuth authorize → 存 token）/`account list`/`account disable`。
- **迁移 P3 env-IMAP**：一次性把现有 env `IMAP_*` 账号迁入一条 `MailAccount` 行（迁移脚本或 `account add` 重配）；之后停止读 env `IMAP_*`。
- **SOT 同步**：CLAUDE.md「密钥」硬约束改述（env 或 DB authJson、authJson 不入日志）；config 移除 env 单 IMAP、新增 Gmail OAuth client 配置（`GMAIL_CLIENT_ID/SECRET/REDIRECT_URI` 仍从 env——这些是 app 凭据非账号凭据）；ROADMAP P4 勾掉。

## 功能 (Capabilities)

### 新增功能
- `gmail-integration`: Gmail provider 端到端——OAuth 授权 + token 存/刷新（authJson）、gmailClient、gmailPoller（unread→NormalizedEmail）、gmailActions（AI/* 标签 + 去 UNREAD 的 P0–P4 映射）、接入统一调度。
- `account-registry`: 统一多账号注册表——从 `MailAccount` 表加载 N 个 enabled 账号（provider=imap|gmail）、统一 authJson 凭据模型、Provider 抽象、per-account 调度/故障隔离/并发上限、账号 onboarding CLI。

### 修改功能
- `imap-integration`: 账号加载从「env 单账号 + 锚定行」改为「注册表行 + 凭据存 authJson」——`需求:IMAP 账号加载与持久化锚定` 重写（不再 env-single、不再 authJson:{} 空、凭据从 authJson 读）；IMAP 收敛到统一 `Provider` 接口。轮询/游标/收敛/markRead 的其余需求不变（已 accountId 键化）。

## 影响

- **新增依赖**：`googleapis` + `google-auth-library`（Gmail OAuth；PROJECT_INIT §3.2 已指定）。
- **新增代码**：`src/providers/gmail/{gmailClient,gmailPoller,gmailActions,oauth}.ts`；`src/providers/provider.ts`（统一接口）；`src/accounts/accountRegistry.ts`（从 DB 加载）；`src/cli/account.ts`（onboarding）；scheduler 改为多账号。
- **修改代码**：`src/accounts/accountService.ts`（env-single → DB registry）、`src/jobs/scheduler.ts`（单账号 → per-account）、`src/main.ts`（启动 N 账号轮询）、`src/config/config.ts`（移除 env IMAP_*、加 GMAIL OAuth client）、`src/logger.ts`（authJson redact）、`prisma/schema.prisma`（authJson 结构约定、provider 取值）。
- **凭据/安全变化**：凭据从 env 迁入 DB authJson（放宽硬约束，用户已确认）；authJson 绝不入日志；Gmail token 自动 refresh。
- **迁移**：P3 env-IMAP 账号 → MailAccount 行（一次性）；env IMAP_* 停用。
- **不触及**：分类内核、规则引擎（safety-rules）、每日摘要（P5）、YAML 可配化 / durable 重试（P6）。

## 非目标（本变更不做）

- 不做 GUI / 账号管理面板（onboarding 仅 CLI）。
- 不做每日定时摘要（P5）、YAML 规则可配化 / durable 跨重启重试预算 / 死信（P6）。
- 不做 authJson 静态加密 / 外部 secrets manager / vault（凭据明文存 DB authJson；at-rest 加密留后续）。
- 不做 Outlook / Microsoft Graph、附件深解析、历史邮件全量回填。
- 不做 Gmail Push / watch（仍定时轮询，与 IMAP 一致）。
- 不引入规则学习、向量库、MCP。
