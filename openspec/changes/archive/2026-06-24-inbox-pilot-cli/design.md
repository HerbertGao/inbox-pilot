## 上下文

inbox-pilot 是无 GUI 的后台服务，运维分散在两个入口：服务进程经 `node dist/main.js` 启动，账号接入经 `pnpm account`（= `tsx src/cli/account.ts`）。账号 CLI 已加固——子命令式（`add --imap|--gmail`、`list`、`disable <id>`）、语义化退出码（0 成功 / 1 失败 / 2 用法）、顶层脱敏 catch、`FORBIDDEN_SECRET_FLAGS` 守卫（拒绝 argv 中出现 `--password`/`--token` 等）、隐藏口令提示（`promptHidden`）。

当前没有统一的 `inbox-pilot` 二进制，账号接入缺少短别名 / 交互回退 / 预检 / 机器可读输出 / 非交互安全口令通道。`deriveAccountId(explicitId, user, host)` 实为 `explicitId ?? \`imap:${user}@${host}\``——显式给定的 `--account-id` 被**原样**用作 `MailAccount.id` 主键、不做任何校验（派生仅在缺省时发生）。因此一个畸形 / 非 ASCII / 含空白或控制字符的 `--account-id`（含空串 `""`，`??` 视 `''` 为已定义、当前会通过）会被逐字接受为主键。派生路径同样不设防：派生值 `imap:<user>@<host>` 由 `--email`（充当 user，账号 CLI 仅查非空、无邮箱格式校验）与 `--host` 拼成，含换行 / 控制字符的 `--host` / `--email` 可经派生伪造 `accountId`，故校验须落在**最终** accountId 值（派生或显式）上、而非仅显式 `--account-id`。

另有一处导入图陷阱：`config.ts` 本身是**有副作用**的模块——`export const config = loadConfig()` 在该模块被**任何** import 时即跑，对非法配置 `process.exit(1)`。因此即便只从 `config.ts` import `configSchema` / `isGmailOnboardingAvailable` 也会令 `doctor` 在报告前崩溃；且 `account.ts` 顶层急切 import `config`，故分发器若静态 import 账号入口也会被牵连崩溃。

硬约束：账号密钥绝不进 argv（会泄露到 shell history / ps / /proc/<pid>/cmdline）。`accountId` 是结构化日志字段，含换行 / 控制字符的 id 会造成日志注入（伪造日志行），故校验须锚定 + 拒控制字符。本变更不改变标已读 / 发送语义。

## 目标 / 非目标

**目标：**
- 单一 `inbox-pilot` 二进制分发账号子命令与 `doctor` 预检。
- 顺手的 IMAP 接入：短别名、默认值、无参交互菜单。
- 非交互安全口令来源（stdin / file），密钥仍不进 argv。
- 非法 `--account-id` 显式拒绝而非逐字接受为主键。
- 只读 `doctor` 预检 + 机器可读 `--json` 输出。
- 保留 `pnpm account` 入口与全部既有加固。

**非目标：**
- 顶层 `-A` 巨型参数。
- 经 argv 传递密钥值。
- `--yes` / stdin 写确认门（唯一变更操作 `disable` 可逆非破坏）。
- EUID==0 拒绝守卫（接入不以 root 写 host 文件）。
- 远程接入隧道自动化。

## 决策

**配置模块拆分（无副作用 schema）**：把 `configSchema` + `isValidGmailRedirectUri` + `isGmailOnboardingAvailable`（纯 schema 定义 + 纯校验器，**无任何副作用**）抽到一个新的无副作用模块（如 `src/config/configSchema.ts`）；`config.ts` 保留 `loadConfig()` + `export const config = loadConfig()` 并从该纯模块 import schema。这样需要 schema 的纯路径（doctor）可只 import 纯模块，不被 `loadConfig()` 的导入期 `process.exit(1)` 牵连。
- 替代方案：让 `doctor` 从 `config.ts` import `configSchema`（如先前「doctor 用 safeParse」的决定）—— 拒绝：`config.ts` 是有副作用模块（`export const config = loadConfig()` 在任何 import 时即跑、对非法配置 `process.exit(1)`），故 import 其任何导出都会令 doctor 崩溃。本决定以**模块拆分 + 动态 import** 取代之。

**统一二进制 + 分发器**：在 `package.json` 加 `"bin": { "inbox-pilot": "dist/cli/inbox-pilot.js" }`；新增 `src/cli/inbox-pilot.ts` —— 薄分发器，把 `account` 路由到既有账号入口、`doctor` 路由到新增 `runDoctor`。日志走 stderr、数据走 stdout。
- **顶层 `import 'dotenv/config'`（dotenv bootstrap）**：分发器必须在顶层、在任何路由 / 任何 `safeParse` 之前做 `import 'dotenv/config'`。`config.ts` 拆分后正确地把 `import 'dotenv/config'`（config.ts:1）留在有副作用的模块里，但 `doctor` **有意**避开该模块（只 `configSchema.safeParse(process.env)`）——于是在经 `.env` **文件**供给 `DATABASE_URL` 的部署上（本项目约定，dotenv 为硬依赖），doctor 路径上无任何代码加载 `.env` → doctor 误报 `DATABASE_URL` 缺失 / 退出 1。在分发器顶层做 `import 'dotenv/config'`（先于路由 / `safeParse`）使 doctor 与 account 两路径都看见 `.env` 文件供给的 env。该 import 是纯副作用（填充 `process.env`、幂等、不 `loadConfig` / 不 `process.exit`），故对 doctor 路径安全、且**不**重新引入急切 `loadConfig` 崩溃。
- **顶层不静态 import account.ts / config.ts**：分发器顶层既不静态 import `account.ts`（其急切 import `config` → `loadConfig()` → 对非法配置 `process.exit(1)`，会令 `inbox-pilot doctor` 在路由前崩溃），也不静态 import `config.ts`。改用**动态 import** 按子命令惰性加载：`doctor` 经 `await import('./doctor.js')`（纯路径，只触达无副作用 schema 模块）、`account` 经 `await import('./account.js')`（账号命令本就需要 `config`，惰性加载它无妨）。
- **公开生产入口**：分发器不能直接 `runAccountCli`（它要求注入 `CliDeps`，而 `defaultDeps()` 是私有的）。故暴露一个公开的生产 deps 工厂或 `runAccountCliMain(argv)` 包装（内部构造生产 deps），由 `inbox-pilot.ts` 分发器（经动态 import）与既有 `pnpm account` 自跑路径**共用**——不重复构造 deps，`pnpm account` 保持可用。
- **顶层脱敏 + 退出码透传 + 主模块守卫**：分发器顶层把**全部**分发（account + doctor，含 setup 期抛错——如 `new PrismaMailRepo()` / 动态 import 失败 / 读 env 抛出可内嵌连接串的 Prisma 错误）包进与 `runAccountCli` 相同的固定文案脱敏 catch。setup 期抛错由该 catch 映射为**固定的 `EXIT_FAILURE`**；唯有 `account` 分支**已由 `runAccountCli` 返回**的退出码被**原样透传**（不二次包裹）。
  - **入口返回退出码、不内部 `process.exit`**：公开生产入口 `runAccountCliMain` 必须**返回**退出码，**不**在内部调用 `process.exit`；分发器仅在其**自身** `import.meta.url` 主模块守卫下调用 `process.exit`，使退出码不被重复触发。`inbox-pilot.ts` 须复刻 `import.meta.url` 主模块守卫，否则被 import 时即自跑。
  - **`account` 分支的 `config` 导入期 fail-fast 不经分发器 catch**（有意，非缺口）：`account` 分支动态 import 账号入口 → 其 import `config.ts` → `loadConfig()` 在模块求值期对非法配置 `process.exit`。这是**有意行为**：打印 `config.ts` 既有的、仅含 `path` + `message` 的脱敏信息并退出，**不**经分发器 catch（模块求值期的进程退出**不可捕获**）；因 `config.ts` 本就对该信息脱敏，故 leak-safe。
- **无参 / 未知子命令边界**：交互式 provider 选择菜单**仅**在 `account add` 不带任何 provider 标志时触发（「无参运行 = 交互菜单」仅限于此处）。裸 `inbox-pilot`、裸 `inbox-pilot account`、未知子命令仍打印 USAGE 并退出 2。

**account-id 校验**：在 IMAP add 路径中，对 `deriveAccountId(...)` 返回的**最终**值（即实际 `MailAccount.id` 主键，无论显式 `--account-id` 还是派生 `imap:<user>@<host>`）校验——在**所有**情形下都对该最终返回值校验，这是**唯一**的规范性规则。**不**采用「派生前校验各组成部分」作为等价替代：它**并非**等价——拼接的 `imap:<email>@<host>` 可能超过 255 字符、或以预校验各部分所漏掉的方式组合。允许值须匹配**完全锚定、定长**模式 `^[A-Za-z0-9:._@+=-]{1,255}$`——纳入 `+`（plus-tagged 邮箱）、`=`（合法派生 id 可含 `=`，如 `--email=a=b` 派生出 `imap:a=b@h`；`=` 不构成日志注入，不在此处拒绝）与既有 id 形态（`imap:user@host`、`gmail:email`）；拒控制字符 / 换行 / 空白（未锚定的检查会放过 `id="evil\nINJECTED"` → 日志注入，因 `accountId` 是结构化日志字段）；拒空串 `""`（`??` 视 `''` 为已定义，故 `--account-id ""` 当前会通过）。该正则**不得**带 `i` / `u` 标志（会改变 ASCII 字符类语义）。`{1,255}` 上界是 **CLI 级合理性边界**：`MailAccount.id` DB 列为无界文本（不截断），故该上界**不是** DB 对齐要求，仅是 CLI 级防呆。非法 → `EXIT_USAGE`；**错误信息须用违规值的转义 / 净化表示（如 JSON 转义）或固定的「含非法字符」文案，绝不原样回显违规值**——否则原始控制字符会经错误信息再次注入 stdout / 日志。绝不逐字接受为主键。字符集须**不**误拒合法的 legacy / 自定义命名空间。
- 替代方案：逐字接受未校验的显式 id —— 拒绝，会污染命名空间并经 `accountId` 日志字段注入。
- 替代方案：仅校验显式 `--account-id`、不校验派生路径 —— 拒绝，派生值由不设防的 `--email` / `--host` 拼成，含换行 / 控制字符者同样可注入日志。
- 替代方案：在派生前校验 `--email` / `--host` 各组成部分（而非最终值）—— 拒绝，并非等价：拼接的 `imap:<email>@<host>` 可超 255 字符或以漏检的方式组合，故必须校验派生函数的最终返回值。

**doctor（`runDoctor`）**：独立模块（如 `src/cli/doctor.ts`），只读检查 —— `configSchema.safeParse(process.env)` 整体校验、`DATABASE_URL` 可达（一次 `SELECT 1`）、`OPENROUTER_API_KEY` 设置与否、Gmail 接入可用性经既有 `isGmailOnboardingAvailable`、`TZ` 读 `process.env.TZ`（TZ **不在** `configSchema` 内，故直接读 env；缺省时注明默认）、host-port **本地占用探测**、`openssl` 存在。
- **只 import 无副作用 schema 模块、绝不触达 `loadConfig()`**：`config.ts` 是有副作用模块（`export const config = loadConfig()` 在任何 import 时即跑、对非法配置 `process.exit(1)`），故 doctor **绝不** import `config.ts` / `account.ts` 或任何传递求值 `loadConfig()` 的模块；而是从无副作用的纯 schema 模块 import `configSchema` + `isGmailOnboardingAvailable`，用 `configSchema.safeParse(process.env)` **先校验**再连接 DB。规范级不变式：凡 `inbox-pilot doctor` 可达的 import 都不得求值 `loadConfig()`。
- **关键 vs 告警检查模型（覆盖全部致命 schema 失败）**：**任何**会使 `loadConfig()` 在启动期终止进程的 `configSchema` 校验失败均为**关键**检查 → 退出 1，不止 `DATABASE_URL`：包括非法 `DATABASE_URL`、指向 openai.com 的 `OPENROUTER_BASE_URL`（config.ts 显式 refine 拒绝）、任意 required / refine 失败。即 doctor 跑 `configSchema.safeParse(process.env)`，**任一** parse error = 关键；加上 DB 可达性 = 关键。可选凭据缺失（`OPENROUTER_API_KEY` 缺失、Gmail onboarding 不可用、`openssl` 缺失）为**告警 / 提示**检查 → 报告但**不**影响退出码。doctor 退出码只反映关键检查。
- **脱敏边界（不泄露 `issue.input`）**：`runDoctor` 继承脱敏边界——**绝不**回显任何捕获的原始错误。处理 `safeParse` 失败时只取 `issue.path` + `issue.message`（镜像 config.ts 既有 fail-fast 做法），**绝不**取 `issue.input`（= 含口令的非法 `DATABASE_URL` 等原始值）、原始 `error.issues` 对象、或 `process.env`；禁止 `JSON.stringify(parsed.error)` 这类会带出 `issue.input` 的写法。
  - **schema message 不内插不变式（future-proofing）**：`issue.message` 直通今天 leak-safe，靠的是每个关键字段的自定义 message 恰为**无值内插的静态串**。为令该直通**按构造** leak-safe（而非偶然），`configSchema` 的自定义 `message` 串**必须绝不内插被解析的值**；一个未来形如 `` `bad value: ${v}` `` 的承载密钥字段 message 会令 doctor 的 `issue.message` 直通悄然开始泄露。该不变式落在 schema 定义侧，与 doctor 的直通策略配套。DB 可达性（`SELECT 1`）失败报固定标签（如 `unreachable`），绝不打印 Prisma 错误信息或 `DATABASE_URL` 连接串。凭据 / 密钥检查的 `--json` `detail` 字段与人类表格只承载非密钥标签集（`set`/`missing`/`unreachable`）——显式禁止回显密钥值的任何部分（前缀、长度、掩码尾巴）。
- **host-port 检查语义**：探测的是服务**自身** `HOST` / `PORT`（config.ts 中带默认的 `HOST` / `PORT`）的本地 bind 占用（仅本地 bind / `EADDRINUSE` 探测），**非**外发主机；无任何外发带凭据连接、无底层错误透传。该检查的 `detail` 必须是**固定标签**（如 `free` / `in-use` / `skipped`），**绝不**回显原始 `HOST` 值。
- 输出：默认人类可读表格；`--json` → `{ checks: [{ name, ok, detail }], ok }`，其中 `ok` 由关键检查决定。不做任何写操作。

**--json 输出**：`--json` 标志由 `doctor`、`list` 与新增结果路径处理；向 stdout 发出一个 JSON 对象；人类可读 / 日志行保持在 stderr，使 stdout 保持可解析。账号新增 `--json` 结果走字段**白名单** `{id, provider, email, enabled}`（镜像既有 `list` 已证实的行形态——`list` 只产出 id/provider/email/enabled；不含 `status`，因该字段在账号行上无来源）——显式禁止 `authJson` / 口令 / token 字段。

**别名 + 默认值 + 交互菜单**：扩展参数解析器的别名映射（`-e`→email、`-H`→host、`-p`→port）；新增 `--no-tls` 布尔 → tls=false（默认 tls=true，端口默认 993）。既有 `account.ts` 已解析 `--tls <true|false>` 值标志（`flags.values.get('tls')?.toLowerCase() !== 'false'`），该值标志**保留**以向后兼容；`--no-tls` 是 `--tls false` 的便捷等价写法。无 provider 标志的 `account add` 打开**交互式 provider 选择菜单**（「无参运行 = 交互菜单」约定），而非报错——这**反转**了现有 `add` 无 / 欠参 → 打印 USAGE 退出 2 的契约，既有「缺 provider」测试须相应更新、不可静默破坏。
- **`--tls` / `--no-tls` 冲突解析（不依赖解析桶、消除静默忽略）**：解析器把值缺位的 `--tls`（下一 token 以 `--` 开头，如 `--tls --no-tls`）解析为 BOOL → 落入 `bools`，而值形式 `--tls true|false` → 落入 `values`。因此「`tls` token 是否存在」必须同时查 `values` 与 `bools` 两桶，**不**能只查「`tls` 值是否存在」——后者会漏掉 `--tls --no-tls`，并令既有回退（`flags.values.get('tls')?.toLowerCase() !== 'false'` 在 `--tls` 缺值时回退到 TLS 启用）**静默忽略** `--no-tls`、错误保留 TLS。规则：`--no-tls` 与**任意** `tls` token 共存时，`--no-tls` 以**优先级**置 tls=false；**仅**当存在真实值分歧（`--tls true` + `--no-tls`，语义相反）才 `EXIT_USAGE`；**一致对** `--tls false` + `--no-tls`（都意指 tls=false）被接受、不报错。此规则消除静默忽略与实现自由裁量。
  - 替代方案：仅检查「`tls` value 存在」的字面冲突 —— 拒绝：漏掉值缺位的 `--tls --no-tls`（解析进 `bools` 而非 `values`），令解析器静默忽略 `--no-tls`、错误保留 TLS。
- 替代方案：顶层 `-A` 巨型参数 —— 拒绝，因为它把 provider 选择压成歧义，与 `add --imap|--gmail` 结构冲突。

**口令来源**：在 IMAP add 路径中按优先级解析密钥 —— `--password-stdin`（从非 TTY 管道 stdin 读取）、`--password-file <path>`（读文件内容）、否则交互式隐藏提示（默认）。三种来源**互斥**：同时给多于一个 → `EXIT_USAGE`。`--password-stdin` / `--password-file` 是不携带密钥值的标志名，因此不加入 `FORBIDDEN_SECRET_FLAGS`。
- **`--password-file` 权限强制**（非仅文档）：**先 `open` 该路径再对打开的 fd `fstat`**（open-then-fstat，而非先 stat 路径再 open——后者有 TOCTOU 窗口：校验与读取间路径可被替换）；若 group / other 可读（`mode & 0o077 !== 0`）→ 拒绝（`EXIT_USAGE`），固定错误**指明路径**（绝不含文件内容）。错误指明路径时须用与 account-id 拒绝**一致**的转义 / 净化表示（如 JSON 转义）渲染该 path 参数、**绝不**原样回显——否则嵌入 path 的控制字符会经该错误信息注入伪造的 stderr / 日志行（与 account-id 错误同源的注入面，须同等处理）。
- **trim 语义**：`--password-file` / `--password-stdin` 只剥**单个**尾随换行（`content.replace(/\r?\n$/, '')`），**不**做整体 `.trim()`（否则会破坏带合法首尾空格的口令 → 静默认证失败）；即「逐字节，仅减一个尾换行」。
- **`--password-stdin` TTY 守卫**：给了 `--password-stdin` 却无管道（`process.stdin.isTTY`）→ `EXIT_USAGE` 固定文案，而非静默永久阻塞。
- **反模式警示**：`--password-stdin` 应从文件 / 变量喂入（`< secret.txt` 或 `$VAR`），而非内联 `echo "literal" |`（那会把密钥放进 echo 进程的 argv → shell history / ps）。此为规范级要求（见 spec），而非仅 design 散文。

## 风险 / 权衡

- [密钥经 argv 泄露] → `FORBIDDEN_SECRET_FLAGS` 守卫保留并拒绝 `--password` 等带值标志；新增的 stdin / file 通道只接受不含密钥值的标志名；规范级警示 `echo "literal" |` 反模式。
- [account-id 校验过严误拒合法值] → 锚定字符集 `^[A-Za-z0-9:._@+=-]{1,255}$` 覆盖既有 id 形态（`imap:user@host`、`gmail:email`）、plus-tagged 邮箱与含 `=` 的合法派生 id，且不误拒 legacy / 自定义命名空间；错误信息指明违规值便于运维修正。
- [account-id 日志注入（含派生路径）] → 未锚定检查会放过含 `\n` / 控制字符的 id 经 `accountId` 日志字段伪造行；派生值由不设防的 `--email` / `--host` 拼成同样可被注入。校验**最终**主键值（派生或显式）+ 锚定 + 拒控制字符 / 空白 + 拒空串封堵。
- [`--json` 被日志污染破坏可解析性] → 严格区分流：数据走 stdout、日志 / 人类可读行走 stderr。
- [doctor 误报为「就绪」] → 任一会令 `loadConfig()` 启动期终止的 `configSchema` 校验失败（含非法 `DATABASE_URL`、指向 openai.com 的 `OPENROUTER_BASE_URL`、任意 required/refine）加 DB 可达性失败即退出非 0；可选凭据缺失仅告警、不误判就绪；只读，不因检查产生副作用。
- [doctor 因急切 `config` 崩溃] → 抽出无副作用 schema 模块；doctor 只 import 该纯模块、绝不 import `config.ts` / `account.ts` 或任何传递求值 `loadConfig()` 的模块（其导入期对非法配置会 `process.exit(1)`）；分发器顶层亦不静态 import account.ts / config.ts，改用动态 import 按子命令惰性加载。
- [doctor `safeParse` 泄露 `issue.input`] → 处理 parse 失败只取 `issue.path` + `issue.message`，绝不取 `issue.input`（含口令的非法 `DATABASE_URL` 等）/ 原始 `error.issues` / `process.env`；禁 `JSON.stringify(parsed.error)`。
- [doctor / 分发器泄露连接串] → `runDoctor` 与分发器顶层均固定文案脱敏 catch，DB 失败报 `unreachable` 固定标签、凭据检查只回 `set`/`missing`，新增 `--json` 走字段白名单。
- [双入口认知负担] → 统一 `inbox-pilot` 二进制为主入口，`pnpm account` 仅作向后兼容保留（经共用的生产入口，不重复构造 deps）。

## 验证

- `inbox-pilot doctor` 打印健康表格；`--json` 发出可解析对象，关键检查失败时非 0 退出、可选凭据缺失仍 0。
- 仅经 `.env` **文件**供给 `DATABASE_URL` 时 `inbox-pilot doctor` 把它报告为存在、不假失败（分发器顶层 `import 'dotenv/config'` 已加载 `.env`）。
- host-port 检查的 `detail` 只为固定标签（`free` / `in-use` / `skipped`），不含原始 `HOST` 值。
- 同时给 `--tls true` 与 `--no-tls`（真实值分歧）→ 退出 2（互斥）；`--tls false` + `--no-tls`（一致对）被接受；值缺位的 `--tls --no-tls` 由 `--no-tls` 优先置 tls=false、不被静默忽略；`--no-tls` 单独给 = `--tls false`。
- 非法 `DATABASE_URL` 下 `inbox-pilot doctor` 仍出报告（该项标失败）、不崩溃、退出 1，且报告不含连接串（无 `DATABASE_URL` 值的任何子串）、不在 import 期 `process.exit`。
- 指向 openai.com 的 `OPENROUTER_BASE_URL` 下 `inbox-pilot doctor` 退出 1（关键 schema 失败），而非 0。
- 含换行 / 控制字符的 `--host`（或 `--email`）→ 对派生函数的最终返回值校验、在任何写 / 日志前被拒绝（退出 2），错误信息用转义 / 净化表示或固定文案、不回显原始控制字符；含 `=` 的合法派生 id（如 `--email=a=b` → `imap:a=b@h`）被接受。
- 裸 `inbox-pilot account`（无 add / list / disable）→ 打印 USAGE、退出 2。
- `inbox-pilot account add --imap -e me@ex.com -H imap.ex.com` 隐藏提示输入口令。
- `... --password-stdin < pw.txt` 无 TTY 完成接入；含合法首尾空格的口令逐字保留（仅减一个尾换行）。
- `--password-stdin` 无管道（TTY）→ 退出 2 固定文案，不阻塞。
- group/other 可读的 `--password-file` → 退出 2，错误指明路径、不含内容。
- 含换行 / 控制字符或空串的 `--account-id` 被拒绝（退出 2），不被逐字接受为主键。
- `--password yyy` 仍被拒绝（退出 2）。
- 账号新增 `--json` 输出不含任何凭据字段（无 `authJson` / 口令 / token）。
