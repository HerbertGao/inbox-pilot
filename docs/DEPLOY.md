# 部署 / 运维 Runbook

inbox-pilot **不再跑在 docker 里**：pilot 由 hangar 以原生 node 进程托管（macOS launchd 常驻 daemon），代码 checkout + `.env` 在 `~/inbox-pilot-hangar`，轮询 / 摘要的定时在仓根 `app.yaml` 的 cron 触发器上。**只有 PostgreSQL 还是容器**——本仓 `docker-compose.yml` 里的 `postgres` 服务，发布在宿主 loopback，是生产库。账号凭据存 DB（`MailAccount.authJson`）。

不同载体上的配置「生效时机」不一致——改完配置后用错命令会得到与预期不符的运行时行为。本 runbook 把生效语义与正确动作固化下来。

## 生产实况（ts.mac-mini）

| 项 | 值 |
| --- | --- |
| launchd 服务 | `com.herbertgao.hangar-inbox` → `~/hangar-inbox-daemon.sh` → `node ~/hangar/packages/core/dist/cli.js daemon` |
| daemon 工作目录 / 应用目录 | WorkingDirectory `~/hangar`、`HANGAR_APPS=~/hangar/apps` |
| pilot 代码 checkout | `~/inbox-pilot-hangar`；env 也在那儿（`~/inbox-pilot-hangar/.env`，由 daemon 启动脚本 `set -a` 导出） |
| 规则文件 | `RULES_FILE` **未设** → 走默认派生路径 `~/inbox-pilot-hangar/rules/rules.yaml`（普通用户目录、可写，故 overlay 写得进去） |
| 数据库 | 容器 `inbox-pilot-postgres-1`，`5432/tcp -> 127.0.0.1:5433`（宿主 5432 被别的服务占了），由本仓 compose 管 |
| 定时 | 仓根 `app.yaml`：poll `*/3 * * * *`，digest `06:00 / 12:30 / 19:00`，均 `Asia/Shanghai` |

## 三类配置的生效语义

| 配置载体 | 例子 | 如何生效 | 动作 |
| --- | --- | --- | --- |
| DB 形态 | 账号（`MailAccount`，经 CLI add/disable） | 进程重启时生效 | 重启 daemon |
| env 形态 | `DATABASE_URL`、各类密钥、`TZ`、`RULES_FILE`（读哪个文件的路径覆盖） | env 在进程启动时一次性读入 | 改 `~/inbox-pilot-hangar/.env` 后重启 daemon |
| 文件形态 | `rules.yaml` / `noise_senders.overlay` 的**内容** | 加载器按 mtime 热重载，但生产 daemon 未接线（见下） | 同样要重启 daemon |

关键区分：`RULES_FILE`（决定读哪个规则文件，**env 形态**）与 `rules.yaml` 的**内容**（**文件形态**）是两回事。

定时（轮询间隔、摘要时刻）**不在 env 里**：它在仓根 `app.yaml` 的 cron 触发器上——`DIGEST_TIMES` 已退役，config schema 里保留它的字段声明只因 `daily-digest` 规范钉住了该声明的形状，无消费者读取。改定时 = 改 `app.yaml` + 重启 daemon。

### 已知缺口：rules.yaml / overlay 改动要重启 daemon

`src/rules/rulesConfig.ts` 里有 mtime 轮询热重载（`startRulesConfigReload`），但**生产路径没有调用它**——常驻 daemon 内 ESM 模块只加载一次，规则快照就此定格。因此改 `rules.yaml`，以及经降噪反馈闭环增删 `noise_senders.overlay`（`apply-feedback` 是其唯一写者），**都要重启 daemon 才实际生效**。

## 部署一次代码改动

```bash
ssh ts.mac-mini
cd ~/inbox-pilot-hangar
git pull
pnpm install            # 依赖有变时
pnpm build              # tsc → dist/；hangar 加载的是 dist/pipeline.js，不 build 等于没部署
pnpm migrate:deploy     # 仅当本次带了新迁移；幂等（见「迁移」）
launchctl kickstart -k gui/$(id -u)/com.herbertgao.hangar-inbox
```

校验：

1. `node dist/cli/inbox-pilot.js doctor`（只读预检：env 校验 + DB 可达性，不写任何东西）。
2. 等下一次 poll 触发（`*/3`），确认 daemon 日志里这一轮跑完、无 `run.failed`。

HTTP 形态退役后，`doctor --json` 的 `checks` 里不再有 `host_port` 项——按字段名解析该输出的调用方需同步，这是向后不兼容的形状变化。

### 通知凭据来源（doctor 查不到，缺了是静默失败）

telegram bot token **走 daemon 进程的 env**，但变量名不是固定的：`@herbertgao/hangar-notify` 的 resolver
从 `channels.yaml`（默认 `~/.config/hangar/channels.yaml`，可由 `HANGAR_NOTIFY_CONFIG` 覆盖）里
`bot: ${VAR}` 占位符取出变量名，再读 `process.env[VAR]`。同一份 yaml 的 `chat` 字段是投递目的地，不经 env。
**变量名的真相源是那份 `channels.yaml`，不在本仓**，本仓只按 `TG_BOT_INBOX` 记录当前取值。resolver 按路径
缓存该文件的内容，所以**改完 `channels.yaml` 要重启 daemon**。

**换占位符名时必须同步 `src/logger.ts` 的 redact 名单**：那份名单是写死成员的，只挡它列出的键名——
占位符改成别的名字而名单没跟，该变量就不再被脱敏，token 会有进日志的路径，且这条没有任何检查会发现。

**四种缺失全是静默的**，都只回 severity `info`：yaml 缺失或为空、该 app/lane 在 yaml 里没有条目、
占位符指名的变量未设或为空串。`src/notify/telegram.ts` 只在 `error` 级才记日志，`doctor` 没有通知检查项、
仍返回 0。净效果是 daemon 正常跑、分类正常、P0/P4 一条都发不出去。已经出问题时唯一的旁证是 daemon 日志里的
pino JSON 字段 `"kind":"notify-skipped-no-channel"`（本仓 pino 无 transport/formatter，日志是 JSON，不会出现
`kind=` 这种 logfmt 写法），且它只有负向意义——没这一行也可能只是还没来过 P0/P4 邮件。

排查手段在 hangar 那侧（`hangar-notify check`），语义以它自己的文档为准。**本仓没有能证明「通知已配通」的
检查**，只能证伪、不能证成——这是已知缺口，不由本变更引入也不由它关闭。

env 改动（改 `.env`）与规则/overlay 改动只需最后一步的 `launchctl kickstart`，不需要 build。

## 摘要时区（TZ）行为

时区在应用侧解析为 `process.env.TZ || 'Asia/Shanghai'`（先 trim）：

- **未设置 / 为空 / 纯空白**的 `TZ` → 回退到 `Asia/Shanghai`，并发一次性 `tz-fallback-default` 告警（可观测）。
- 线上 `.env` 已显式设 `TZ=Asia/Shanghai`；`app.yaml` 的每个 cron 触发器另外带显式 `timezone`，故**触发时刻**不依赖进程 `TZ`。`TZ` 影响的是进程内的 `new Date()` 本地性与日期串解析（见下「账号起算日期水位线」）。
- **非法 `TZ`**（非空、非空白）由运维负责（不校验）。

## 数据库

生产库是 compose 管的 postgres 容器，**只有它还在 docker 里**。app 已退役，故 compose 里只剩这一个服务。

### 端口与远程访问（ssh 隧道）

postgres 有意只绑 loopback（`127.0.0.1`），不对外、不上网络（Tailscale/LAN 不可达）。宿主端口可被 `POSTGRES_HOST_PORT` 覆盖以绕开冲突（线上用 `5433`）。远程访问经手动 ssh 隧道，far-end 端口绑到实际宿主端口而非硬编码 5432：

```bash
ssh -fNL 5432:127.0.0.1:${POSTGRES_HOST_PORT:-5432} <host>   # 线上：ssh -fNL 5432:127.0.0.1:5433 ts.mac-mini
```

### ssh 跑远程 docker 命令的 PATH 坑

非登录式的 `ssh <host> '<cmd>'` **拿不到 `/usr/local/bin`**——`docker` 与 `docker-credential-osxkeychain` 都在那儿，缺了它 docker 命令会「命令不存在」或凭据 helper 找不到。远程 docker 命令前一律先补 PATH：

```bash
ssh ts.mac-mini 'export PATH=$PATH:/usr/local/bin:$HOME/.orbstack/bin; docker compose -f ~/inbox-pilot/docker-compose.yml ps'
```

### 迁移

`prisma migrate deploy` 幂等——已应用的迁移（含分区部分索引）经 `_prisma_migrations` 表跳过，仅真正待应用的迁移会执行。它不触碰 `./data/postgres` 数据卷，库数据不受影响。

## rules.yaml 可达性

`RULES_FILE` 未设时，规则路径从加载器模块自身位置派生（`<checkout>/rules/rules.yaml`），随 checkout 一起提供；`noise_senders.overlay` 恒为同目录、不可单独配置。原生进程下该目录是普通用户目录、可写，overlay 写得进去。

若该文件缺失或不可读（如 checkout 不完整、`RULES_FILE` 指错），加载器**不崩**：记 `rules-config-load-failed` 并 carry-forward 到内置默认值——即规则名单静默退化。故部署后若日志里出现 `rules-config-load-failed`，说明规则文件没到位，要先修路径再谈别的。**app 不写 `rules.yaml`**（硬约束由写路径自己的撞名闸守）；overlay 属运行期状态，已在 `.gitignore` 里，不要提交。

## 账号起算日期水位线（`processFrom`）

每个账号有一个可空的「起算日期」水位线 `processFrom`：摄入与摘要都会排除 `receivedAt < processFrom` 的旧邮件（接入前的历史积压），`processFrom = NULL` 则不设下界、保持全量行为。

`add_process_from` 迁移**只新增可空列 `processFrom`、默认 NULL**——存量账号**不**被自动盖戳，行为不变（不回溯改写历史）。**新接入**的账号（`account add`）默认在接入时刻种值，无需手动盖。

### 存量账号止血（迁移部署后必做一次）

迁移部署后，要让已存在的账号压住接入前的历史积压，运维**必须**对每个存量账号显式盖戳：

1. 取账号 id（输出 `id` / `provider` / `email` / `enabled`）：

   ```bash
   account list           # 人类可读表格
   account list --json    # 脚本化取 id（输出 JSON 数组，便于 jq 提取）
   ```

2. 对每个存量账号盖戳到**接入处理日之后**的日期（如「今天」）：

   ```bash
   account set-process-from <id> <YYYY-MM-DD>
   ```

   `<YYYY-MM-DD>` 按**进程 `TZ`** 解析为该日的本地零点。`TZ` 是**硬前提**：`.env.example` 默认 `Asia/Shanghai`、线上 `.env` 已设——故运维心里的「今天」即本地今天，不再被判为未来而拒。**若 `TZ` 未设**，日期串按进程 OS 时钟所在时区解析（原生 macOS 进程即宿主本地时区；已退役的容器形态下是 UTC），摘要调度器的应用级 `?? Asia/Shanghai` 兜底**不**覆盖这一解析路径，由既有 `tz-fallback-default` 告警可观测。

3. **重启 daemon** 使摄入下界生效（下界在轮询路径上，不重启不生效）：

   ```bash
   launchctl kickstart -k gui/$(id -u)/com.herbertgao.hangar-inbox
   ```

4. 校验：下一次摘要不再包含接入前的旧邮件。

### 为何盖「接入处理日之后」（如今天）而非接入当日

存量账号必须盖到**接入处理日之后**的日期（盖「今天」是稳妥默认），原因有二：

- **本地午夜前移问题**：`set-process-from` 把日期解析为**进程时区零点**（`TZ`，部署为 `Asia/Shanghai`）。对当日（如当天下午）接入的账号盖「当日」，水位线会被**前移**到当日本地午夜 00:00——在 `Asia/Shanghai`（UTC+8）下这是**前一日 16:00Z**（比旧 UTC 零点的当日 00:00Z 还早 8h，**同日回移窗口更大**），反而把当日上午收到的邮件重新纳入。盖到次日才能让水位线确实晚于接入处理时刻。
- **缺 `Date:` 头的旧邮件**：历史旧邮件缺 `Date:` 头（或不可解析）时，其摘要 `receivedAt` 回落到**摄入时刻**（即接入当时倒入的时刻），而非真实收信时间。只有水位线**晚于**摄入时刻才能排除这类邮件——故须盖到接入处理日之后。

### `set-process-from` vs `add --process-from`

- `account set-process-from <id> <date>`：改**既有**账号的水位线（无条件覆盖、可双向移动）。改既有账号**只能**用它。
- `account add … --process-from <date>`：**仅用于新接入**指定起算日；对**已存在**账号执行不改其水位线（被忽略）。
- 两者的 `<date>` 都只接受 `YYYY-MM-DD`、按**进程 `TZ`** 解析为**该时区零点**（`TZ` 未设时见上「存量账号止血」步骤 2 的说明）；非法日期或未来日期以用法错误（退出码 2）拒绝。
- **既有已盖戳的水位线不被时区口径变更回写**——存量水位线保持其原值、仍正确排除接入前积压；如需把某账号的戳转成本地零点语义，运维重跑 `account set-process-from <id> <date>` 即可（可选，非必须）。
