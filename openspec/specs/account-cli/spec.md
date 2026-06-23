# account-cli 规范

## 目的
定义 inbox-pilot 统一 CLI（`inbox-pilot` 二进制）的运维入口约束：单一分发器（dispatcher）按子命令惰性加载 `account <add|list|disable>` 与只读 `doctor`，并贯穿日志/数据流分离、语义化退出码、固定文案脱敏边界、`.env` 先加载、无副作用 schema 与启动期配置加载分离等结构约束。覆盖账号接入的安全输入面：account-id 最终主键校验（含派生路径与日志注入防护）、密钥来源安全（隐藏提示 / `--password-stdin` / `--password-file`，密钥绝不进 argv）、口令文件权限强制（open-then-fstat 防 TOCTOU）、`doctor` 只读预检（关键 vs 告警检查、脱敏直通）、`--json` 机器可读输出（字段白名单、不泄露凭据）、以及顺手的 IMAP 接入参数（短别名 / `--no-tls` / 交互菜单）。只约束 CLI 入口与接入命令的行为与安全边界，不涉及分类 / 规则 / 动作行为。

## 需求

### 需求:统一 CLI 入口

系统必须提供单一的 `inbox-pilot` 二进制，分发 `account <add|list|disable>` 子命令与 `doctor` 命令。该 CLI 必须把日志输出到 stderr、数据输出到 stdout，并使用语义化退出码（0 成功 / 1 失败 / 2 用法错误）。账号子命令必须经一个公开的生产入口运行，且该入口与既有 `pnpm account` 自跑路径共用同一份生产依赖构造逻辑（不重复构造）。

配置 schema 必须存在于一个**无副作用**的模块中（`configSchema` 与其纯校验器，包括 Gmail 接入可用性判定，不在被 import 时求值或终止进程）；启动期配置加载（`loadConfig` + 进程级 `config` 单例）必须位于一个独立的、被 import 时会对非法配置终止进程的模块中，且仅从无副作用模块取用 schema。分发器入口必须既不在顶层静态 import 账号入口、也不静态 import 启动期配置加载模块；它必须经**动态 import** 按子命令惰性加载——`doctor` 经动态 import 的纯路径模块路由（该模块不触达配置加载），`account` 经动态 import 的账号入口路由（账号命令本就需要配置）。这样 `inbox-pilot doctor` 才不会因任何在 import 期终止进程的配置加载而在产出报告前崩溃。

分发器入口必须在任何路由 / 任何 schema 解析之前先加载 `.env` 文件（顶层 `import 'dotenv/config'`，先于任何子命令分发），使 `doctor` 路径与 `account` 路径都能看到经 `.env` 文件提供的环境变量。该加载是纯副作用（仅填充 `process.env`，幂等，不调用启动期配置加载、不终止进程），故对 `doctor` 路径安全、且不重新引入启动期配置加载的急切崩溃。

分发器的顶层入口必须把全部分发（account 与 doctor，含分发 setup 期抛出的错误）包进与账号 CLI 相同的固定文案脱敏边界——任何捕获的错误绝不以原始形式打印（含连接串 / Prisma 错误）。分发器顶层脱敏 catch 必须把 setup 期抛出的错误（如构造仓储 / 动态 import 失败）映射为固定的失败退出码（`EXIT_FAILURE`）；唯有 `account` 分支已由账号 CLI 返回的退出码必须被原样透传、不二次包裹。该公开生产入口（`runAccountCliMain`）必须**返回**退出码而非自行调用进程退出；分发器只在其自身主模块守卫下调用进程退出，使退出码不被重复触发。

`account` 分支的配置加载模块在 import 期对非法 / 缺失配置的 fail-fast 是**有意行为**：它打印配置加载模块既有的、仅含 `path` + `message` 的脱敏信息并直接终止进程，**不**经分发器脱敏 catch（模块求值期的进程退出不可捕获）——因配置加载模块已对该信息脱敏，故不泄露。

分发器入口必须只在被直接运行时执行（主模块守卫），被 import 时绝不自跑。

交互式 provider 选择菜单必须**仅**在 `account add` 不带任何 provider 标志时触发。裸 `inbox-pilot`、裸 `inbox-pilot account`（无 add / list / disable）、以及任何未知子命令必须打印用法信息并以退出码 2 退出。

#### 场景:分发账号子命令
- **当** 运维者执行 `inbox-pilot account list`
- **那么** CLI 必须经公开生产入口运行既有的账号列表逻辑，将账号数据写到 stdout、日志写到 stderr，并原样透传账号 CLI 的退出码

#### 场景:分发 doctor 命令
- **当** 运维者执行 `inbox-pilot doctor`
- **那么** CLI 必须运行只读预检并以语义化退出码退出（全部关键检查通过为 0，任一关键检查失败为 1）

#### 场景:doctor 不被启动期配置加载牵连崩溃
- **当** 运维者在 `DATABASE_URL` 非法的环境下执行 `inbox-pilot doctor`
- **那么** 凡 `inbox-pilot doctor` 可达的 import 都不得求值启动期配置加载（`loadConfig`）；CLI 必须仍产出报告（该检查标为失败），且绝不在 import 期 `process.exit`

#### 场景:doctor 看见 .env 文件提供的 DATABASE_URL
- **当** 在仅经 `.env` 文件（而非进程环境）提供 `DATABASE_URL` 的部署上执行 `inbox-pilot doctor`
- **那么** 分发器必须已在任何 schema 解析之前加载该 `.env` 文件，使 doctor 把 `DATABASE_URL` 报告为存在、不误判为缺失（不假失败、不退出 1）

#### 场景:分发 setup 期抛错被脱敏
- **当** 分发任一子命令时其 setup（如构造仓储 / 动态 import）抛出可内嵌连接串或凭据的错误
- **那么** CLI 必须只打印固定脱敏文案、把该 setup 期抛错映射为固定失败退出码（`EXIT_FAILURE`）退出，绝不把原始错误 / 连接串 / 凭据子串打到 stderr

#### 场景:裸 account 子命令打印用法
- **当** 运维者执行裸 `inbox-pilot account`（不带 add / list / disable）
- **那么** CLI 必须将用法信息写到 stderr 并以退出码 2 退出，绝不打开交互菜单

#### 场景:未知子命令
- **当** 运维者执行带有未知子命令或无效参数的 `inbox-pilot`
- **那么** CLI 必须将用法信息写到 stderr 并以退出码 2 退出

### 需求:密钥输入安全

账号密钥（IMAP 口令、OAuth 令牌）禁止作为 argv 值被接受。IMAP 口令必须只能经交互式隐藏提示、管道 stdin（`--password-stdin`）或文件（`--password-file`）输入；作为 argv 标志值传入的密钥必须以用法错误被拒绝。交互隐藏提示、`--password-stdin`、`--password-file` 三种口令来源必须互斥：同时提供多于一个必须以用法错误（退出码 2）被拒绝。从 stdin / 文件读取的密钥必须按字节保留、仅剥去单个尾随换行（`\r?\n$`），禁止做整体 trim（否则会破坏带合法首尾空格的口令而导致静默认证失败）。`--password-stdin` 在 stdin 为 TTY（无管道喂入）时必须以用法错误退出并给出固定提示，禁止静默永久阻塞。

#### 场景:拒绝 argv 中的密钥标志
- **当** 运维者执行包含 `--password <value>`（或其他被禁止的密钥标志）的命令
- **那么** CLI 必须拒绝该命令并以退出码 2 退出，且密钥值绝不出现在日志中

#### 场景:经 stdin 提供口令
- **当** 运维者执行 `inbox-pilot account add --imap --password-stdin` 并从非 TTY 管道喂入口令
- **那么** CLI 必须从 stdin 读取该密钥、仅剥去单个尾随换行后逐字采用完成接入，且该密钥值绝不出现在 argv 或日志中

#### 场景:stdin 来源应经文件 / 变量喂入而非内联 echo
- **当** 文档 / `--help` / 用法文案描述 `--password-stdin`
- **那么** 该文案必须警示经 `< secret.txt` 或 `$VAR` 喂入密钥，禁止 `echo "literal" |`（会把密钥放进 echo 进程的 argv → shell history / ps）

#### 场景:stdin 无管道时不阻塞
- **当** 运维者给出 `--password-stdin` 但 stdin 为 TTY（无管道喂入）
- **那么** CLI 必须以用法错误（退出码 2）退出并给出固定提示，绝不静默永久阻塞

#### 场景:经文件提供口令
- **当** 运维者执行带 `--password-file <path>` 的接入命令
- **那么** CLI 必须从该文件读取、仅剥去单个尾随换行后逐字采用密钥值，且该密钥值绝不出现在 argv 或日志中

#### 场景:多个口令来源互斥
- **当** 运维者同时提供多于一个口令来源（如 `--password-stdin` 与 `--password-file`）
- **那么** CLI 必须以用法错误（退出码 2）拒绝

#### 场景:默认交互隐藏提示
- **当** 运维者执行 IMAP 接入命令且未提供任何非交互口令来源
- **那么** CLI 必须以隐藏方式交互提示输入口令

### 需求:口令文件权限强制

当口令经 `--password-file <path>` 提供时，CLI 必须先 `open` 该路径、再对**打开的文件描述符** `fstat`（open-then-fstat，而非先 stat 路径再 open——后者在校验与读取之间留有 TOCTOU 窗口，路径可被替换），并在其对 group 或 other 可读（`mode & 0o077 !== 0`）时拒绝读取——以用法错误（退出码 2）退出，固定错误信息必须指明该路径、禁止包含文件内容。该错误指明路径时必须用与 account-id 拒绝一致的**转义 / 净化表示**（如 JSON 转义）渲染该 path 参数，**绝不**原样回显——否则嵌入 path 参数的控制字符会经该错误信息注入一行伪造的 stderr / 日志。该强制为运行时行为，而非仅文档约定。

#### 场景:拒绝过宽权限的口令文件
- **当** 运维者执行带 `--password-file <path>` 的命令且该文件对 group 或 other 可读
- **那么** CLI 必须以用法错误（退出码 2）拒绝，错误信息指明该路径（用转义 / 净化表示渲染、绝不原样回显嵌入的控制字符）、且绝不包含文件内容（口令）

### 需求:account-id 校验

调用方显式提供的 `--account-id` 被原样用作 `MailAccount.id` 主键，而在其缺省时主键由 `--email` / `--host` 派生为 `imap:<email>@<host>`。两条路径都不设防：显式值不经校验，派生值由仅查非空（无邮箱格式校验）的 `--email` / `--host` 拼成。因此 CLI 必须对**最终**由派生函数返回、实际用作 `MailAccount.id` 主键的 accountId 值校验——在**所有**情形（显式 `--account-id` 或派生 `imap:<email>@<host>`）下都对该最终值跑校验。仅校验显式 `--account-id`、或仅在派生前校验 `--email` / `--host` 的各组成部分，都不充分：拼接而成的 `imap:<email>@<host>` 可能超过 255 字符、或以预校验各部分所漏掉的方式组合；含换行 / 控制字符的 `--host` / `--email` 可经派生伪造主键与 `accountId` 日志字段。因此校验必须落在派生函数的**最终返回值**（即实际主键）上，而非各组成部分。

允许的 id 必须匹配一个**完全锚定、定长**的字符集模式 `^[A-Za-z0-9:._@+=-]{1,255}$`——该模式纳入 `+`（plus-tagged 邮箱）、`=`（合法派生 id 可含 `=`，如 `--email=a=b` 派生出 `imap:a=b@h`；`=` 不构成日志注入，故不在此处拒绝）与既有 id 形态（`imap:user@host`、`gmail:email`），且不得误拒合法的 legacy / 自定义命名空间。该正则**不得**带 `i` / `u` 标志（会改变 ASCII 字符类语义）。该 `{1,255}` 长度上界是 CLI 级的合理性边界（sanity bound）；`MailAccount.id` 数据库列为无界文本（不截断），故该上界并非数据库对齐要求，而仅是 CLI 级防呆。非法值（畸形 / 非 ASCII / 空白 / 含换行或控制字符 / 空串 `""`）必须以用法错误被拒绝，而非被逐字接受为主键。校验必须拒绝控制字符 / 换行：因为 `accountId` 是结构化日志字段，未锚定的检查会放过形如 `evil\nINJECTED` 的值而造成日志注入。校验必须拒绝空串：`??` 视 `''` 为已定义、否则 `--account-id ""` 会被接受。

拒绝时的错误信息必须使用违规值的**转义 / 净化表示**（如 JSON 转义）或完全省略原始值（固定的「含非法字符」文案），**绝不**原样回显违规值——否则原始控制字符会经错误信息被再次注入 stdout / 日志。

#### 场景:拒绝含控制字符的 account-id
- **当** 运维者提供含嵌入换行或控制字符的 `--account-id`（如 `evil\nINJECTED`）
- **那么** CLI 必须以用法错误（退出码 2）拒绝，绝不把该值接受为主键；错误信息必须使用违规值的转义 / 净化表示或固定的「含非法字符」文案，绝不原样回显该值的控制字符到 stdout / 日志

#### 场景:拒绝经派生路径注入的控制字符
- **当** 运维者提供含嵌入换行或控制字符的 `--host`（或 `--email`）且未显式给 `--account-id`（走派生 `imap:<email>@<host>`）
- **那么** CLI 必须对派生函数返回的**最终**值跑校验，并在任何写入 / 日志之前以用法错误（退出码 2）拒绝，绝不把含控制字符的派生值接受为主键或写入 `accountId` 日志字段；错误信息同样使用转义 / 净化表示或固定文案

#### 场景:拒绝非 ASCII account-id
- **当** 运维者提供含字符集外字符（如非 ASCII）的 `--account-id`
- **那么** CLI 必须以用法错误（退出码 2）拒绝，绝不把该值接受为主键；错误信息必须使用违规值的转义 / 净化表示或固定文案，绝不原样回显

#### 场景:拒绝空串 account-id
- **当** 运维者提供空串 `--account-id ""`
- **那么** CLI 必须以用法错误（退出码 2）拒绝，且绝不把空串接受为主键

#### 场景:接受合法 account-id
- **当** 运维者提供匹配锚定字符集 `^[A-Za-z0-9:._@+=-]{1,255}$` 的 `--account-id`（含既有 `imap:user@host` 形态与 plus-tagged 邮箱）
- **那么** CLI 必须原样采用该 id 作主键

#### 场景:接受含等号的合法派生 id
- **当** 运维者提供 `--email=a=b`（导致派生 id `imap:a=b@h`，含 `=`）且未显式给 `--account-id`
- **那么** CLI 必须对派生函数返回的**最终**值 `imap:a=b@h` 跑校验、接受该派生 id（`=` 在锚定字符集内、不构成日志注入），并原样采用作主键

### 需求:doctor 预检

CLI 必须提供只读的 `doctor` 命令，检查部署就绪度：DB 可达性、app 凭据存在与否、Gmail 接入可用性、时区、host-port 本地占用、openssl 存在。该命令必须经人类可读表格或 `--json` 报告结果，并使用语义化退出码。该命令禁止执行任何写操作。

`doctor` 必须位于独立模块，且只从无副作用的 schema 模块取用 `configSchema` 与 Gmail 接入可用性判定；它禁止 import 启动期配置加载模块、账号入口、或任何在被 import 时会求值启动期配置加载（`loadConfig`）的模块——后者在导入期对非法 / 缺失配置会以非零码终止进程，会令 doctor 在报告前崩溃。`doctor` 必须经 `configSchema.safeParse(process.env)` 整体校验环境，仅在校验通过后才连接 DB。时区检查必须读取 `process.env.TZ`（TZ 不在 config schema 内）。host-port 检查必须仅为服务**自身** `HOST` / `PORT` 的本地 bind / 占用冲突探测（非外发主机），禁止发起任何外发的带凭据连接、禁止把底层错误透传。host-port 检查的 `detail` 必须是固定标签（如 `free` / `in-use` / `skipped`），绝不回显原始 `HOST` 值。

退出码必须只反映**关键**检查。**关键**检查涵盖所有会使启动期配置加载终止进程的 `configSchema` 校验失败：包括非法 `DATABASE_URL`、指向 openai.com 的 `OPENROUTER_BASE_URL`、以及任意其它 required / refine 校验失败——`configSchema.safeParse(process.env)` 的任一 parse error 即为关键；再加上 DB 可达性。任一关键检查失败必须使退出码为 1。可选凭据（如 OpenRouter API key、Gmail 接入可用性、openssl 存在）缺失为告警 / 提示检查，必须被报告但不影响退出码。

`doctor` 必须继承脱敏边界：绝不打印任何捕获的原始错误。处理 `configSchema.safeParse` 失败时，`doctor` 必须只取每个 issue 的 `path` 与 `message`（镜像启动期配置加载的 fail-fast 做法），绝不取 `issue.input`（= 含口令的非法 `DATABASE_URL` 等原始环境值）、原始 `error.issues` 对象、或 `process.env`；禁止 `JSON.stringify(parsed.error)` 这类会带出 `issue.input` 的写法。为使该 `issue.message` 直通在结构上保持 leak-safe（而非仅因当前各关键字段的自定义 message 恰为静态串），`configSchema` 的自定义 `message` 串必须**绝不内插被解析的值**——一个未来形如 `` `bad value: ${v}` `` 的承载密钥字段（如 `DATABASE_URL` / `OPENROUTER_API_KEY`）message 否则会令 doctor 的直通悄然开始泄露。DB 可达性（`SELECT 1`）失败必须报告固定标签（如 `unreachable`），绝不打印 Prisma 错误信息或 `DATABASE_URL` 连接串。对凭据 / 密钥检查，`--json` 的 `detail` 字段与人类可读表格必须只承载非密钥标签集（`set`/`missing`/`unreachable`）；禁止回显密钥值的任何部分（含前缀、长度、掩码尾巴）。

#### 场景:全部关键检查通过
- **当** 运维者执行 `inbox-pilot doctor` 且所有关键检查通过
- **那么** CLI 必须报告每项检查并以退出码 0 退出

#### 场景:关键检查失败
- **当** 运维者执行 `inbox-pilot doctor` 且关键检查（`configSchema` 校验或 DB 可达性）失败
- **那么** CLI 必须报告失败的检查并以退出码 1 退出

#### 场景:可选凭据缺失不影响退出码
- **当** 运维者执行 `inbox-pilot doctor` 且可选凭据（OpenRouter API key / Gmail 接入可用性 / openssl 存在）缺失但关键检查全通过
- **那么** CLI 必须把这些项报告为告警 / 提示，并仍以退出码 0 退出

#### 场景:非法 DATABASE_URL 仍出报告不崩溃
- **当** 运维者执行 `inbox-pilot doctor` 而 `DATABASE_URL` 非法 / 缺失
- **那么** CLI 必须仍产出一份报告（其中该检查标为失败）、不崩溃、并以退出码 1 退出，且报告绝不包含该 `DATABASE_URL` 环境值的任何子串

#### 场景:非法 OPENROUTER_BASE_URL 为关键失败
- **当** 运维者执行 `inbox-pilot doctor` 而 `OPENROUTER_BASE_URL` 指向 openai.com（`configSchema` 显式 refine 拒绝、会令启动期加载终止）
- **那么** CLI 必须把该 schema 校验报告为失败并以退出码 1（而非 0）退出

#### 场景:safeParse 失败不泄露 issue.input
- **当** `doctor` 的 `configSchema.safeParse(process.env)` 因非法 `DATABASE_URL`（值内嵌口令）失败
- **那么** CLI 输出（含 `--json`）必须只承载该失败的 `path` 与 `message`，绝不包含该非法 `DATABASE_URL` 值的任何子串、`issue.input`、原始 `error.issues` 或 `process.env`

#### 场景:DB 不可达只报固定标签
- **当** `doctor` 的 DB 可达性检查（`SELECT 1`）因连接错误失败
- **那么** CLI 必须把该检查报告为固定标签（如 `unreachable`），绝不打印 Prisma 错误信息或 `DATABASE_URL` 连接串

#### 场景:凭据检查不泄露密钥值
- **当** 运维者执行 `inbox-pilot doctor`（含 `--json`）且其包含凭据 / 密钥检查
- **那么** 每项凭据检查的 `detail` 与人类表格必须只承载 `set`/`missing`/`unreachable` 之一，绝不包含密钥值的任何部分（前缀 / 长度 / 掩码尾巴）

#### 场景:host-port 检查只报固定标签
- **当** 运维者执行 `inbox-pilot doctor`（含 `--json`）且其包含服务自身 `HOST` / `PORT` 的本地占用探测
- **那么** 该检查的 `detail` 必须是固定标签（如 `free` / `in-use` / `skipped`）之一，绝不回显原始 `HOST` 值，且不发起任何外发的带凭据连接

#### 场景:JSON 输出
- **当** 运维者执行 `inbox-pilot doctor --json`
- **那么** CLI 必须向 stdout 发出形如 `{ checks: [{ name, ok, detail }], ok }` 的结构化对象，其 `ok` 由关键检查决定，并保持退出码语义

### 需求:机器可读输出

`doctor`、`list` 与账号新增结果必须支持 `--json` 结构化输出，写到 stdout，日志保留在 stderr。账号新增 `--json` 结果必须走字段白名单 `{id, provider, email, enabled}`（镜像既有 `list` 已证实的行形态——`list` 只产出 id/provider/email/enabled，账号行上无 `status` 来源）；禁止包含 `authJson` / 口令 / token 等任何凭据字段。

#### 场景:list 的 JSON 输出
- **当** 运维者执行 `inbox-pilot account list --json`
- **那么** CLI 必须向 stdout 发出可解析的账号列表 JSON，并把日志保留在 stderr

#### 场景:账号新增结果的 JSON 输出
- **当** 运维者执行带 `--json` 的账号新增命令
- **那么** CLI 必须向 stdout 发出字段限于 `{id, provider, email, enabled}` 的可解析 JSON 对象，并把日志保留在 stderr

#### 场景:账号新增 JSON 不含凭据字段
- **当** 运维者执行带 `--json` 的账号新增命令并解析其 stdout 输出
- **那么** 该 JSON 对象必须不含 `authJson` / 口令 / token 等任何凭据字段

### 需求:顺手的接入参数

CLI 必须为 IMAP 接入提供顺手的参数：短别名 `-e/--email`、`-H/--host`、`-p/--port`（端口默认 993），以及 `--no-tls` 布尔（默认 TLS 启用、端口 993）。既有的 `--tls <true|false>` 值标志必须**保留**以向后兼容；`--no-tls` 是 `--tls false` 的便捷等价写法。

`--no-tls` 与任意 `tls` token 同时出现的处理必须**不依赖** `tls` 被解析进哪个桶——值形式 `--tls <true|false>`（落入 `values`）与值缺位形式 `--tls`（下一 token 以 `--` 开头时被解析为 BOOL、落入 `bools`）两种都算「`tls` token 存在」。仅检查「`tls` 值是否存在」会漏掉值缺位形式（`--tls --no-tls`），并令既有解析器（`--tls` 缺值时回退到「TLS 启用」）静默忽略 `--no-tls`、错误保留 TLS——此为不可接受的静默忽略。因此规则必须是：`--no-tls` 与任意 `tls` token 共存时，`--no-tls` 以**优先级**强制 tls=false；仅当存在**真实的值分歧**（`--tls true` 同时给 `--no-tls`，二者语义相反）时才以用法错误（退出码 2）拒绝；**一致对**（`--tls false` 同时给 `--no-tls`，二者都意指 tls=false）必须被接受、不报错。这消除了静默忽略与实现自由裁量。无 provider 标志的 `account add` 必须打开交互式 provider 选择菜单，而非报错退出——这反转了无 / 欠参调用打印用法并以退出码 2 退出的旧契约，既有「缺 provider」相关测试必须相应更新、不可静默破坏。交互菜单的触发边界**仅限**于此处（`account add` 不带任何 provider 标志）：裸 `inbox-pilot`、裸 `inbox-pilot account`、未知子命令仍保持 USAGE / 退出码 2（见「统一 CLI 入口」需求）。

#### 场景:短别名与默认端口
- **当** 运维者执行 `inbox-pilot account add --imap -e me@ex.com -H imap.ex.com`
- **那么** CLI 必须把 `-e` 解析为 email、`-H` 为 host，并在未给 `-p/--port` 时采用默认端口 993

#### 场景:--no-tls 禁用 TLS
- **当** 运维者在 IMAP 接入命令中给出 `--no-tls`
- **那么** CLI 必须以 TLS 禁用接入该账号（等价于 `--tls false`；默认为启用）

#### 场景:--tls true 与 --no-tls 值分歧互斥
- **当** 运维者在 IMAP 接入命令中同时给出 `--tls true` 与 `--no-tls`（语义相反的真实分歧）
- **那么** CLI 必须以用法错误（退出码 2）拒绝（二者相互排斥）

#### 场景:--tls false 与 --no-tls 一致对被接受
- **当** 运维者在 IMAP 接入命令中同时给出 `--tls false` 与 `--no-tls`（二者都意指 tls=false）
- **那么** CLI 必须接受该命令并以 TLS 禁用接入（不报错，因不存在值分歧）

#### 场景:值缺位的 --tls --no-tls 不被静默忽略
- **当** 运维者给出值缺位形式 `--tls --no-tls`（`--tls` 因下一 token 以 `--` 开头被解析为 BOOL、落入 `bools` 而非 `values`）
- **那么** CLI 必须把 `--no-tls` 与该 `tls` token 视为共存、由 `--no-tls` 以优先级强制 tls=false 接入（绝不静默忽略 `--no-tls` 而错误保留 TLS）

#### 场景:无 provider 标志打开交互菜单
- **当** 运维者执行不带任何 provider 标志的 `account add`
- **那么** CLI 必须打开交互式 provider 选择菜单，而非打印用法并以退出码 2 退出
