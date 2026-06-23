## 1. 统一二进制 + 分发器

- [x] 1.1 在 `package.json` 加 `bin` 字段 `{ "inbox-pilot": "dist/cli/inbox-pilot.js" }`
- [x] 1.2 把 `configSchema` + `isValidGmailRedirectUri` + `isGmailOnboardingAvailable`（纯 schema + 校验器、无副作用）抽到新的无副作用模块（如 `src/config/configSchema.ts`）；`config.ts` 保留 `loadConfig()` + `export const config` 并从该纯模块 import schema
- [x] 1.3 暴露公开生产入口（生产 deps 工厂 / `runAccountCliMain()` 包装，内部构造生产 deps），供分发器与既有 `pnpm account` 自跑路径共用、不重复构造 deps；`runAccountCliMain` **返回**退出码、**不**在内部 `process.exit`（由分发器在自身主模块守卫下退出，避免退出码重复触发）
- [x] 1.4 新增 `src/cli/inbox-pilot.ts` 分发器，顶层在任何路由 / `safeParse` 之前先 `import 'dotenv/config'`（纯副作用、幂等、不 `loadConfig` / 不 `process.exit`，使 doctor 与 account 两路径都看见 `.env` 文件供给的 env）；顶层既不静态 import `account.ts`、也不静态 import `config.ts`；经动态 `await import('./doctor.js')` 路由 `doctor`（纯路径）、经动态 `await import('./account.js')` 路由 `account`（账号命令本就需 `config`）；保留 `pnpm account` 工作（向后兼容）
- [x] 1.5 分发器顶层把全部分发（account + doctor，含 setup 期抛错——如 `new PrismaMailRepo()` / 动态 import 失败）包进固定文案脱敏 catch，并把 setup 期抛错映射为**固定 `EXIT_FAILURE`**；复刻 `import.meta.url` 主模块守卫；`account` 分支**原样透传** `runAccountCli` 已返回的退出码（不二次包裹）；裸 `inbox-pilot`、裸 `inbox-pilot account`、未知子命令打印 USAGE 退出 2
- [x] 1.6 测试：仅经 `.env` 文件供给 `DATABASE_URL` 时 `inbox-pilot doctor` 把它报告为存在、不假失败 / 不退出 1

## 2. account-id 校验

- [x] 2.1 在 IMAP add 路径中，对 `deriveAccountId(...)` 返回的**最终**主键值（无论显式 `--account-id` 还是派生 `imap:<user>@<host>`）按锚定定长模式 `^[A-Za-z0-9:._@+=-]{1,255}$`（含 `=`；正则不带 `i` / `u` 标志）校验——在所有情形下都对该最终返回值校验（**不**采用「派生前校验各组成部分」作替代：拼接的 `imap:<email>@<host>` 可超 255 字符或以漏检的方式组合）；非法（含换行 / 控制字符 / 空白 / 空串 / 非 ASCII）返回 `EXIT_USAGE`、不逐字接受为主键。`{1,255}` 为 CLI 级合理性边界（`MailAccount.id` DB 列无界、不截断）
- [x] 2.2 拒绝时的错误信息用违规值的转义 / 净化表示（如 JSON 转义）或固定的「含非法字符」文案，绝不原样回显违规值（防原始控制字符经错误信息再注入 stdout / 日志）
- [x] 2.3 测试：含换行 / 控制字符的 `--account-id` 被拒绝（退出码 2），错误信息不含原始控制字符（用转义 / 净化表示或固定文案）
- [x] 2.4 测试：空串 `--account-id ""` 被拒绝（退出码 2）
- [x] 2.5 测试：含换行 / 控制字符的 `--host`（或 `--email`）在派生路径下、对最终返回值校验后被拒绝（退出码 2），不经派生进入任何写 / 日志
- [x] 2.6 测试：含 `=` 的合法派生 id（如 `--email=a=b` → `imap:a=b@h`）被接受

## 3. doctor 预检

- [x] 3.1 在独立模块（如 `src/cli/doctor.ts`）实现 `runDoctor`：只 import 无副作用 schema 模块、经 `configSchema.safeParse(process.env)` 先校验再连 DB；绝不 import `config.ts` / `account.ts` 或任何传递求值 `loadConfig()` 的模块；只读检查 DB 可达 / app 凭据 / Gmail 接入可用性 / TZ（读 `process.env.TZ`）/ host-port 本地占用探测（探服务自身 `HOST`/`PORT` 本地 bind；`detail` 为固定标签 `free` / `in-use` / `skipped`，绝不回显原始 `HOST` 值）/ openssl 存在；人类可读表格
- [x] 3.2 关键 vs 告警模型：任一会令 `loadConfig()` 启动期终止的 `configSchema.safeParse` 失败（非法 `DATABASE_URL`、指向 openai.com 的 `OPENROUTER_BASE_URL`、任意 required/refine）+ DB 可达性为关键检查（失败 → 退出 1）；可选凭据缺失（OpenRouter key / Gmail 接入 / openssl）为告警 / 提示、不影响退出码；退出码只反映关键检查
- [x] 3.3 脱敏：`runDoctor` 绝不回显原始错误；处理 `safeParse` 失败只取 `issue.path` + `issue.message`，绝不取 `issue.input` / 原始 `error.issues` / `process.env`（禁 `JSON.stringify(parsed.error)`）；DB 失败报固定标签 `unreachable`、绝不打印 Prisma 错误或连接串；凭据检查只回 `set`/`missing`/`unreachable`。`configSchema` 自定义 `message` 串绝不内插被解析的值（使 `issue.message` 直通按构造 leak-safe，杜绝未来 `` `bad value: ${v}` `` 承载密钥字段令直通悄然泄露）
- [x] 3.4 测试：非法 `DATABASE_URL` 下 doctor 仍出报告（该项标失败）、不崩溃、退出 1，报告不含 `DATABASE_URL` 值的任何子串、不在 import 期 `process.exit`
- [x] 3.5 测试：指向 openai.com 的 `OPENROUTER_BASE_URL` 下 doctor 退出 1（关键 schema 失败），而非 0
- [x] 3.6 测试：host-port 本地占用探测的 `detail` 为固定标签（`free` / `in-use` / `skipped`）之一、不含原始 `HOST` 值，且不发起任何外发带凭据连接

## 4. 机器可读输出

- [x] 4.1 为 `doctor`、`list` 与账号新增结果实现 `--json` 输出（数据走 stdout，日志走 stderr）
- [x] 4.2 账号新增 `--json` 结果走字段白名单 `{id, provider, email, enabled}`（镜像 `list` 已证实的行形态，不含 `status`）；禁含 `authJson` / 口令 / token
- [x] 4.3 测试：账号新增 `--json` 输出不含任何凭据字段

## 5. 顺手的接入参数

- [x] 5.1 新增短别名 `-e/--email`、`-H/--host`、`-p/--port`，端口默认 993，新增 `--no-tls`（= `--tls false` 便捷写法）；既有 `--tls <true|false>` 值标志（`account.ts:217`）保留向后兼容；`--no-tls` 与任意 `tls` token 共存（查 `values` 与 `bools` 两桶——值缺位的 `--tls --no-tls` 落入 `bools`）时由 `--no-tls` 优先置 tls=false，仅真实值分歧（`--tls true` + `--no-tls`）→ `EXIT_USAGE`，一致对（`--tls false` + `--no-tls`）被接受；消除对值缺位形式的静默忽略
- [x] 5.2 测试：`--tls true` + `--no-tls`（值分歧）→ 退出 2；`--tls false` + `--no-tls`（一致对）被接受；值缺位的 `--tls --no-tls` 不被静默忽略（由 `--no-tls` 置 tls=false）；`--no-tls` 单独 = `--tls false`
- [x] 5.3 无 provider 标志的 `account add` → 打开交互式 provider 选择菜单（反转无 / 欠参 → USAGE 退出 2 的旧契约）；交互菜单**仅**在此处触发——裸 `inbox-pilot`、裸 `inbox-pilot account`、未知子命令仍 USAGE 退出 2
- [x] 5.4 更新受影响的既有测试 `src/cli/account.test.ts`「account add：缺 provider → 参数错误」（断言 `EXIT_USAGE`）以匹配新无参语义（不静默破坏）；测试：裸 `inbox-pilot account` → USAGE 退出 2

## 6. 安全的口令来源

- [x] 6.1 在 IMAP add 路径实现 `--password-stdin` 与 `--password-file <path>` 读取器；密钥绝不进 argv；交互隐藏提示保持默认
- [x] 6.2 三种口令来源（stdin / file / 交互提示）互斥：同时给多于一个 → `EXIT_USAGE`
- [x] 6.3 `--password-file` 强制权限：先 `open` 路径再对打开的 fd `fstat`（open-then-fstat，避免 stat-路径-再-open 的 TOCTOU），group / other 可读（`mode & 0o077 !== 0`）→ `EXIT_USAGE`，固定错误指明路径、不含内容；指明路径时用与 account-id 拒绝一致的转义 / 净化表示（如 JSON 转义）渲染该 path 参数、绝不原样回显嵌入的控制字符（防经错误信息注入 stderr / 日志行）
- [x] 6.4 `--password-stdin` / `--password-file` trim 语义：只剥单个尾随换行（`content.replace(/\r?\n$/, '')`），不做整体 `.trim()`
- [x] 6.5 `--password-stdin` 无管道（`process.stdin.isTTY`）→ `EXIT_USAGE` 固定文案、不阻塞
- [x] 6.6 `add --imap` / `--password-stdin` 的 usage / `--help` 文案警示用 `< secret.txt` 或 `$VAR` 喂入，禁 `echo "literal" |`
- [x] 6.7 测试：`--password-stdin` 路径在无 TTY 下完成接入，含合法首尾空格的口令逐字保留

## 7. 验证

- [x] 7.1 验证 `doctor --json` 输出形状与退出码（关键失败 1 / 可选缺失 0；非法 `DATABASE_URL` 与指向 openai.com 的 `OPENROUTER_BASE_URL` 均退出 1 且不泄露 env 值子串）
- [x] 7.2 验证仅经 `.env` 文件供给 `DATABASE_URL` 时 `doctor` 报告其存在、不假失败（分发器顶层 dotenv bootstrap）
- [x] 7.3 验证 stdin 口令接入路径
- [x] 7.4 验证含换行 / 控制字符 / 空串的 `--account-id` 与含换行 / 控制字符的 `--host`（派生路径、对最终返回值校验）被拒绝，且拒绝错误信息不含原始控制字符
- [x] 7.5 验证 `--password` argv 值仍被拒绝
- [x] 7.6 验证 group/other 可读的 `--password-file` 被拒绝（退出 2，错误指明路径）
- [x] 7.7 验证同时给 `--tls true` 与 `--no-tls` → 退出 2（互斥）；host-port 检查 `detail` 仅为固定标签、不含原始 `HOST`
