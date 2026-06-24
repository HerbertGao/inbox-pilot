# 部署 / 运维 Runbook

inbox-pilot 经 docker compose 部署：两个服务 `inbox-pilot`（app）+ `postgres`，无 Redis。env 形态配置经 `env_file` 注入容器；规则文件 `rules.yaml` 经挂载 + 镜像内拷贝双供给；账号凭据存 DB（`MailAccount.authJson`）。

不同载体上的配置「生效时机」不一致——改完配置后用错命令（如以为 `restart` 即可）会得到与预期不符的运行时行为。本 runbook 把生效语义与正确动作固化下来。

## 三类配置的生效语义

| 配置载体 | 例子 | 如何生效 | 命令 |
| --- | --- | --- | --- |
| DB 形态 | 账号（`MailAccount`，经 CLI add/disable） | 进程重启时生效 | 重启容器 / `reload` |
| env 形态 | `DIGEST_TIMES`、`POLL_INTERVAL_SECONDS`、密钥、`RULES_FILE`（读哪个文件的路径覆盖） | 需**重建容器**（env 在容器创建时即被烘焙） | `pnpm run reload` |
| 文件形态 | `rules.yaml` 的**内容** | 实时热加载（mtime 监听换内存快照） | 无需任何命令 |

关键区分：`RULES_FILE`（决定读哪个规则文件，**env 形态**，改它需重建容器）与 `rules.yaml` 的**内容**（**文件形态**，改它实时生效）是两回事。

> `docker compose restart` **不会**重新读取 `env_file`——env 在容器创建时即被烘焙。`docker compose up -d --force-recreate` 会重新读取，且对两个服务都幂等。env 改动必须走 `reload`（= recreate），不能走 `restart`。

## 三条操作轴（均为操作命令）

| 变更类型 | 例子 | 命令 |
| --- | --- | --- |
| 镜像变更 | Dockerfile / 依赖 | `docker compose build`（或 `docker compose up -d --build`） |
| env 变更 | `DIGEST_TIMES`、密钥、`RULES_FILE` 路径等 env 形态值 | `pnpm run reload`（= `up -d --force-recreate`，不重建镜像） |
| 文件配置 | `rules.yaml` 内容 | 实时生效，无需任何命令 |

> 正交补充：DB-config 载体（账号经 CLI `add` / `disable`）不在上面这三条操作命令轴上——它在**进程重启**时生效，与三轴正交。这里单列以免误以为账号缺席于配置模型。

## 摘要时区（TZ）行为

摘要调度器时区在应用侧解析为 `process.env.TZ || 'Asia/Shanghai'`（先 trim）：

- **未设置 / 为空 / 纯空白**的 `TZ` → 回退到 `Asia/Shanghai` 供 cron 用，并发一次性 `tz-fallback-default` 告警（可观测）。
- **重要**：`.env` 不设 `TZ` 时，容器 OS 时钟（Node `new Date()`、`docker logs` 原始 wall-clock）为 **UTC**——cron *触发*不受影响（显式 `timezone` 已传给 node-cron），但若想让容器 OS 时钟 / `Date` 本地性对齐，请在 `.env` 设 `TZ=Asia/Shanghai`。
- **非法 `TZ`**（非空、非空白）由运维负责（不校验）：受影响的摘要任务被跳过（记 `digest-schedule-construct-failed`）；轮询 + `/health` 不受影响。

## 共享宿主机端口覆盖

部署在共享宿主机时，宿主侧端口可被环境变量覆盖以绕开端口冲突：

- `POSTGRES_HOST_PORT`（默认 `5432`）：覆盖 postgres 的宿主端口映射。app 容器内部仍经 `@postgres:5432` 内网连库，不受此映射影响。
- `APP_HOST_PORT`（默认 `3000`）：覆盖 app 的宿主端口映射（容器内部仍监听 3000）。

例：`POSTGRES_HOST_PORT=55432 APP_HOST_PORT=33000 docker compose up -d`。

## 远程访问 DB（ssh 隧道）

postgres 有意绑定 loopback（`127.0.0.1`），不对外暴露。远程访问经手动 ssh 隧道，隧道 far-end 端口绑定到 `POSTGRES_HOST_PORT` 而非硬编码 5432：

```bash
ssh -fNL 5432:127.0.0.1:${POSTGRES_HOST_PORT:-5432} <host>
```

far-end（`127.0.0.1:${POSTGRES_HOST_PORT:-5432}`）随宿主实际端口走；若宿主用了 `POSTGRES_HOST_PORT` 覆盖，隧道会自动对齐。

## reload / recreate 的副作用与保证

- **migrate-deploy 幂等**：`reload` / recreate 会在容器重建时重跑 `prisma migrate deploy`。该操作幂等——已应用的迁移（含分区部分索引）经 `_prisma_migrations` 表跳过，仅真正待应用的迁移会执行。
- **不触碰数据卷**：`reload` / recreate **不触碰** `./data/postgres` 数据卷，库数据不受影响。
- **会一并重建 postgres**：`reload`（= `docker compose up -d --force-recreate`，不带服务名）会**一并重建 postgres**，每次都要等 `service_healthy` 健康门（约数十秒的 app 间隙）。
  - 进阶轻量捷径：仅改**不触及** `POSTGRES_HOST_PORT` 的 env 时，可用 `docker compose up -d --force-recreate inbox-pilot` 只重建 app，跳过 postgres 重建。
  - 但不带服务名的 `reload` 仍是安全默认——它还会一并重新应用 `POSTGRES_HOST_PORT`（端口映射落在 postgres 服务上，限定到单服务会漏掉它）。

## rules.yaml 坏挂载处置

compose 的 `./rules:/app/rules:ro` bind-mount 是无条件的：**挂载存在时完全遮蔽镜像内烘焙的 `COPY rules` 拷贝**。双供给只保护「无挂载」场景，不保护「坏挂载」场景。

若宿主缺 `./rules/rules.yaml`（tarball 部署、或 checkout 时未带该文件），Docker 会在挂载点自动建一个空目录 → 遮蔽镜像内拷贝 → 触发 `rules-config-load-failed → carry-forward` 退化。

处置：

- **bind-mount 部署**：要求宿主 `./rules/rules.yaml` 存在。
- **纯镜像 / 自包含部署**（无宿主 rules 目录）：应**移除该 volume 行**，回落到镜像内烘焙拷贝。

## 重部署与校验顺序

1. `docker compose build`（仅镜像变更时需要）
2. `docker compose up -d --force-recreate`（= `pnpm run reload`）
3. 校验 `/health`：`curl localhost:${APP_HOST_PORT:-3000}/health` 返 `{"status":"ok"}`（200）。
4. 校验摘要调度器：确认日志打印新的 `taskCount`（env 改动如 `DIGEST_TIMES` 生效的标志；`restart` 不会）。

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

   `<YYYY-MM-DD>` 按**容器 `TZ`** 解析为该日的本地零点（容器时区零点）。`TZ` 是**硬前提**：`.env.example` 默认 `Asia/Shanghai`、线上 `.env` 已设——故运维心里的「今天」即本地今天，不再被判为未来而拒（旧 UTC 口径下东于 UTC 的运维在 UTC 过零点前盖「今天」会被误拒的坑已消除）。**若 `TZ` 未设**，日期串按容器 OS 时钟（`node:24-bookworm-slim` = UTC）解析、退回 **UTC 零点 = 旧语义**（摘要调度器的应用级 `?? Asia/Shanghai` 兜底**不**覆盖这一解析路径），由既有 `tz-fallback-default` 告警可观测。

3. **重启**服务使摄入下界生效（下界在轮询路径上，不重启不生效）：

   ```bash
   docker compose restart inbox-pilot
   ```

4. 校验：下一次摘要不再包含接入前的旧邮件。

### 为何盖「接入处理日之后」（如今天）而非接入当日

存量账号必须盖到**接入处理日之后**的日期（盖「今天」是稳妥默认），原因有二：

- **本地午夜前移问题**：`set-process-from` 把日期解析为**容器时区零点**（容器 `TZ`，部署为 `Asia/Shanghai`）。对当日（如当天下午）接入的账号盖「当日」，水位线会被**前移**到当日本地午夜 00:00——在 `Asia/Shanghai`（UTC+8）下这是**前一日 16:00Z**（比旧 UTC 零点的当日 00:00Z 还早 8h，**同日回移窗口更大**），反而把当日上午收到的邮件重新纳入。盖到次日才能让水位线确实晚于接入处理时刻。
- **缺 `Date:` 头的旧邮件**：历史旧邮件缺 `Date:` 头（或不可解析）时，其摘要 `receivedAt` 回落到**摄入时刻**（即接入当时倒入的时刻），而非真实收信时间。只有水位线**晚于**摄入时刻才能排除这类邮件——故须盖到接入处理日之后。

### `set-process-from` vs `add --process-from`

- `account set-process-from <id> <date>`：改**既有**账号的水位线（无条件覆盖、可双向移动）。改既有账号**只能**用它。
- `account add … --process-from <date>`：**仅用于新接入**指定起算日；对**已存在**账号执行不改其水位线（被忽略）。
- 两者的 `<date>` 都只接受 `YYYY-MM-DD`、按**容器 `TZ`** 解析为**容器时区零点**（`TZ` 未设则退回 UTC 零点 = 旧语义，见上「存量账号止血」步骤 2 的硬前提说明）；非法日期或未来日期以用法错误（退出码 2）拒绝。
- **既有已盖戳的水位线不被本次时区口径变更回写**——存量水位线保持其原值、仍正确排除接入前积压；如需把某账号的戳转成本地零点语义，运维重跑 `account set-process-from <id> <date>` 即可（可选，非必须）。
