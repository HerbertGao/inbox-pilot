## 移除需求

### 需求:doctor 预检

**Reason**: 本需求以 MUST 要求「服务自身 `HOST` / `PORT` 本地占用」探测（清单项、约束段、独立场景共三处），而该探测的对象——一个监听中的 HTTP 服务——随「健康检查端点」一并退役，`HOST` / `PORT` 两个环境变量也随之删除。`openspec-cn` 的 `## 修改需求` 只能在现行场景集上做超集改写，删场景会令 `archive` 中止（见 design ②），故本需求以「移除 + 以新名新增」重建。

**Migration**: 由本增量的「需求:doctor 只读部署预检」承接。**评审请直接 diff 这两份文本**——本增量不另给差异清单（前几稿的手写清单三次与实际不符）。

## 新增需求

### 需求:doctor 只读部署预检

CLI 必须提供只读的 `doctor` 命令，检查部署就绪度：DB 可达性、app 凭据存在与否、Gmail 接入可用性、时区、openssl 存在。该命令必须经人类可读表格或 `--json` 报告结果，并使用语义化退出码。该命令禁止执行任何写操作。

`doctor` 必须位于独立模块，且只从无副作用的 schema 模块取用 `configSchema` 与 Gmail 接入可用性判定；它禁止 import 启动期配置加载模块、账号入口、或任何在被 import 时会求值启动期配置加载（`loadConfig`）的模块——后者在导入期对非法 / 缺失配置会以非零码终止进程，会令 doctor 在报告前崩溃。`doctor` 必须经 `configSchema.safeParse(process.env)` 整体校验环境，仅在校验通过后才连接 DB。时区检查必须读取 `process.env.TZ`（TZ 不在 config schema 内）。

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

#### 场景:JSON 输出
- **当** 运维者执行 `inbox-pilot doctor --json`
- **那么** CLI 必须向 stdout 发出形如 `{ checks: [{ name, ok, detail }], ok }` 的结构化对象，其 `ok` 由关键检查决定，并保持退出码语义
