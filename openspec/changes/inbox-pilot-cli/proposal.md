## 为什么

运维 inbox-pilot 目前需要两个入口（服务用 `node dist/main.js`，账号管理用 `pnpm account`），且账号接入存在多处毛刺：

- 没有统一二进制，运维者必须记住该用哪个入口。
- `account add --imap` 需要记住若干长参数（`--email` / `--host` / `--port` / `--tls`），既无短别名也无交互回退。
- 显式传入的 `--account-id` 被**原样**当作 `MailAccount.id` 主键写入、不做任何校验（派生只在缺省时发生）；因此一个畸形 / 非 ASCII / 含空白或控制字符的 `--account-id` 会被逐字接受为主键，污染命名空间并可经结构化日志字段 `accountId` 注入伪造行。派生路径同样不设防——派生 id `imap:<email>@<host>` 由未经格式校验的 `--email` / `--host`（账号 CLI 仅查非空）拼成，含换行 / 控制字符的 `--host` / `--email` 可经派生伪造 `accountId` 日志字段。
- 没有 `doctor` 预检命令，无法在运行前确认环境就绪。
- 没有机器可读（`--json`）输出供自动化 / Agent 消费。
- 脚本化接入没有非交互的安全口令通道（密钥只能来自交互式 TTY 提示）。

## 变更内容

引入统一的 `inbox-pilot` CLI，提供更顺手、更安全的账号接入与一个只读预检，同时保留全部既有硬约束（密钥绝不进 argv、脱敏边界、语义化退出码）：

- 统一 `inbox-pilot` 二进制 + 分发器：`inbox-pilot account <add|list|disable>`（经一个公开的生产入口包装既有已加固的账号 CLI）以及 `inbox-pilot doctor`。分发器在任何路由 / 任何 schema 解析之前先做顶层 `import 'dotenv/config'`（纯副作用、幂等、不调用 `loadConfig` / 不终止进程），使 `doctor` 与 `account` 两条路径都能看到经 `.env` 文件提供的环境变量（本项目约定经 `.env` 文件供给 `DATABASE_URL`，dotenv 为硬依赖）。分发器顶层把全部分发（含 setup 期抛错）包进与账号 CLI 相同的固定文案脱敏 catch：setup 期抛错（如 `new PrismaMailRepo()` / 动态 import 失败）映射为固定的 `EXIT_FAILURE`，唯有账号分支已返回的退出码被原样透传。公开生产入口 `runAccountCliMain` **返回**退出码而非自调用进程退出；分发器只在其自身主模块守卫下调用进程退出，避免退出码重复触发。分发器在顶层既不静态 import 账号入口、也不静态 import `config`（其导入期对非法配置会终止进程）；`doctor` 经动态 `import` 纯路径模块路由，`account` 经动态 `import` 账号入口（账号命令本就需要 `config`）。`account` 分支的 `config` 导入期 fail-fast 是有意行为：打印 `config.ts` 既有的、仅含 `path` + `message` 的脱敏信息并直接退出，**不**经分发器 catch（模块求值期退出不可捕获），因 `config.ts` 已脱敏故不泄露。
- account-id 校验：对派生函数返回、**最终**用作 `MailAccount.id` 主键的 accountId 值（无论显式给定还是派生而来）按锚定、定长的字符集校验——在所有情形下都对该最终值校验（仅预校验各组成部分不充分：拼接的 `imap:<email>@<host>` 可能超 255 字符或以漏检的方式组合）。非法（畸形 / 非 ASCII / 空白 / 含换行或控制字符 / 空串）返回用法错误，而非被逐字接受为主键。派生路径同样受约束——含换行 / 控制字符的 `--host` / `--email` 不得经派生伪造 `accountId` 日志字段。拒绝时的错误信息使用违规值的转义 / 净化表示（如 JSON 转义）或固定的「含非法字符」文案，绝不原样回显违规值（否则原始控制字符会经错误信息再次注入 stdout / 日志）。`{1,255}` 上界是 CLI 级合理性边界（`MailAccount.id` DB 列无界、不截断），非 DB 对齐要求。
- `doctor` 预检：只读环境健康检查（DB 可达、app 凭据存在与否、Gmail 接入可用性、TZ 已设置、host-port 本地占用探测、openssl 存在）；默认人类可读表格，`--json` 输出结构化结果。host-port 检查的 `detail` 为固定标签（`free` / `in-use` / `skipped`），绝不回显原始 `HOST` 值。`doctor` 须从一个**无副作用**的纯 schema 模块（与 `config.ts` 分离，不触发 `loadConfig()`）取用 `configSchema` / `isGmailOnboardingAvailable`，并经 `configSchema.safeParse(process.env)` 先校验再连接 DB；`doctor` 绝不（直接或传递地）导入会求值 `loadConfig()` 的模块（其在导入期对非法配置会 `process.exit(1)`，会令 doctor 在报告前崩溃）。退出码由**关键**检查决定：任何会使 `loadConfig()` 在启动期终止进程的 `configSchema` 校验失败（非法 `DATABASE_URL`、指向 openai.com 的 `OPENROUTER_BASE_URL`、任意 required/refine 失败）加上 DB 可达性均为关键检查 → 退出 1；可选凭据缺失（OpenRouter API key 缺失、Gmail 接入不可用、openssl 缺失）仅作告警 / 提示、不影响退出码。`doctor` 处理 `safeParse` 失败时只取 `issue.path` + `issue.message`（镜像 `config.ts` 既有做法），绝不取 `issue.input` / 原始 `error.issues` 对象 / `process.env`，以免泄露含口令的非法环境值。
- 为 `doctor`、`list` 及账号新增结果提供 `--json` 输出（数据走 stdout，日志走 stderr）。`doctor` 与账号新增结果均不泄露任何密钥：凭据检查只回固定标签集（`set`/`missing`/`unreachable`），账号新增 `--json` 字段走白名单（`{id, provider, email, enabled}`，镜像 `list` 已证实的行形态），绝不含 `authJson`/口令/token。
- 顺手的接入参数：短别名 `-e/--email`、`-H/--host`、`-p/--port`（默认 993）、`--no-tls`（= `--tls false` 的便捷写法；既有 `--tls <true|false>` 值标志保留向后兼容）。`--no-tls` 与任意 `tls` token（无论解析进 `values` 还是 `bools`——值缺位的 `--tls --no-tls` 会落入 `bools`）共存时，`--no-tls` 以优先级置 tls=false；仅真实值分歧（`--tls true` + `--no-tls`）→ `EXIT_USAGE`，一致对（`--tls false` + `--no-tls`）被接受；这消除了对值缺位形式的静默忽略。交互式 provider 选择菜单仅在 `account add` 不带任何 provider 标志时触发；裸 `inbox-pilot`、裸 `inbox-pilot account`、未知子命令仍打印 USAGE 并退出 2。
- 安全的非交互口令来源：`--password-stdin`（从管道 stdin 读取密钥）与 `--password-file <path>`（从文件读取，并强制文件权限 group/other 不可读）。密钥值仍然绝不出现在 argv 中；交互式隐藏提示仍是默认方式；三种口令来源互斥。

## 功能 (Capabilities)

### 新增功能
- `account-cli`: 统一的 `inbox-pilot` 命令行入口——账号接入子命令（add/list/disable）与只读 `doctor` 预检；涵盖密钥输入安全、account-id 校验、`--json` 机器可读输出与语义化退出码。

### 修改功能
<!-- 本变更不修改既有功能的规范级行为。 -->

## 非目标 (Non-goals)

- **不**做顶层 `-A` 巨型参数——它把 provider 选择压成歧义，与清晰的 `account add --imap|--gmail` 结构相冲突。顺手由别名 + 默认值 + 交互回退提供。
- **不**支持经 argv 传递密钥值——显式拒绝（会泄露到 shell history / ps / /proc/<pid>/cmdline）；既有的 `FORBIDDEN_SECRET_FLAGS` 守卫保留。
- **不**加 `--yes` / stdin 写确认门——唯一的变更操作（`disable`）可逆且非破坏；若未来加入破坏性动词（delete/purge）再重新评估。
- **不**加 EUID==0 拒绝守卫——账号接入不以 root 身份写任何 host 文件；若未来某操作会写再重新评估。
- **不**做远程接入隧道自动化——账号接入是每账号一次性成本；desktop-loopback 的 Gmail OAuth 是 Google 的约束，不是本项目的约束。

## 影响

- 拆分配置模块：把 `configSchema` + `isValidGmailRedirectUri` + `isGmailOnboardingAvailable`（纯 schema + 校验器，无副作用）抽到一个新的无副作用模块（如 `src/config/configSchema.ts`）；`config.ts` 保留 `loadConfig()` + `export const config` 并从该纯模块 import schema。这样 `doctor` 只 import 纯模块即可，不被 `loadConfig()` 的 `process.exit(1)` 牵连。
- 新增 `src/cli/inbox-pilot.ts` 分发器（含 `import.meta.url` 主模块守卫，否则 import 即自跑）；顶层先 `import 'dotenv/config'`（先于任何路由 / `safeParse`，使 doctor 与 account 两路径都看见 `.env` 文件供给的 env）；顶层既不静态 import `account.ts`、也不静态 import `config.ts`，而是经动态 `await import('./doctor.js')`（纯路径）路由 `doctor`、经动态 `await import('./account.js')`（账号命令本就需要 `config`）路由 `account`；顶层脱敏 catch 把 setup 期抛错映射为固定 `EXIT_FAILURE`、原样透传账号分支已返回的退出码；分发器只在主模块守卫下调用 `process.exit`，`runAccountCliMain` 仅返回退出码；`package.json` 新增 `bin` 字段 `{ "inbox-pilot": "dist/cli/inbox-pilot.js" }`。
- 扩展既有账号 CLI（`src/cli/account.ts`）：account-id 字符集校验（校验最终主键值，含派生路径）、参数别名与默认值、无 provider 标志的交互菜单（**反转**现有 `add` 无/欠参 → 打印 USAGE 退出 2 的契约，既有缺 provider 测试需相应更新）、口令来源解析（stdin / file / 隐藏提示，三者互斥）、`list` 与新增结果的 `--json`。
- 暴露一个公开的生产 deps 工厂 / `runAccountCliMain()` 包装（构造生产 deps），供新的 `inbox-pilot.ts` 分发器与既有 `pnpm account` 自跑路径共用——不重复构造 deps，`pnpm account` 保持可用。
- 新增 `doctor` 实现于独立模块（`src/cli/doctor.ts` 内的 `runDoctor`），只 import 无副作用的纯 schema 模块（`configSchema.safeParse(process.env)` + `isGmailOnboardingAvailable`）；绝不 import `config.ts` / `account.ts` 或任何传递求值 `loadConfig()` 的模块；绝不回显任何原始错误、`issue.input` 或连接串。
- 保留 `pnpm account` 既有入口（向后兼容）；不改变标已读 / 发送语义。
