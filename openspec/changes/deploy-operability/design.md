## 上下文

inbox-pilot 通过 docker-compose（`inbox-pilot` + `postgres` 两个服务，无 Redis）部署在共享宿主机上。Compose 把 env 形态的配置经 `env_file` 注入容器，把规则文件（`rules.yaml`）以挂载 / 镜像内文件形式提供，把账号凭据存 DB（`MailAccount.authJson`）。配置在不同载体上的「生效时机」不一致，且缺乏一份统一的部署 runbook 与一个命名的重建命令，导致运维在改配置后产生与预期不符的运行时行为。本设计只针对部署 / 运维载体，不改变分类、规则、动作的任何行为。仓库为 pnpm-only（`pnpm-lock.yaml` + `packageManager: pnpm@…`），脚本一律以 pnpm 形态描述。

## 目标 / 非目标

**目标：**
- 让三类配置（DB 形态 / env 形态 / 文件形态）的生效语义显式化，并提供一个 `reload` pnpm 脚本落地 env 形态配置的「重建容器」语义。
- 让构建阶段与运行阶段都自带 Prisma 引擎所需的 libssl（经安装 `openssl`），消除 Prisma 的 openssl / libssl 探测告警。
- 把 `TZ` 默认值的归属收归应用：未设置 / 为空时回退到文档化默认并发告警；移除 compose 侧的 `TZ` 默认注入使该回退可观测。
- 让 `rules.yaml` 在容器内真实可达，使「文件形态实时热加载」一类不再形同虚设。
- 让共享宿主机端口覆盖与远程 DB 访问有一份统一 runbook 可循。

**非目标：**
- 不把 env 形态标量（`DIGEST_TIMES` / `POLL_INTERVAL_SECONDS`）迁出 env 做实时热加载。现有 `rules.yaml` 热加载只替换内存快照，并不重建 cron 调度器；对这两个极少变更的值做实时热加载需全新的 cron 拆除 / 重建管线，代价失衡。
- 不改变 env 与 DB 的凭据划分。
- 不自动化远程 DB 访问；postgres 有意绑定 loopback，远程访问以手动 ssh 隧道文档化，不写代码。
- 不新增 `TZ` 合法性校验；非法 `TZ` 的行为由运维负责。
- 不在容器上新增 `/health` 的 `HEALTHCHECK` 指令，也不切换为非 root `USER`——两者均为后续独立变更。

## 决策

**1. `reload` 命令采用 `docker compose up -d --force-recreate`（不带服务名），而非 `restart`。**
- 在 `package.json` 增加 pnpm 脚本 `"reload": "docker compose up -d --force-recreate"`，文档中以 `pnpm run reload` 形态展示。该脚本调用 `docker compose`（v2 子命令形态），要求宿主装有 docker-compose v2。
- 不带服务名是有意的：`POSTGRES_HOST_PORT` 改动落在 postgres 服务的端口映射上，限定到 `inbox-pilot` 单服务会漏掉它；`--force-recreate` 对 postgres 幂等且安全。
- 关键事实（写入 runbook）：`docker compose restart` 不会重新读取 `env_file`——env 在容器创建时即被烘焙；`docker compose up -d --force-recreate` 会重新读取，且是幂等的。
- 替代方案：让运维记住手敲 `up -d`——被否决，因为它与「restart 即可」的直觉相悖，正是缺口来源；用一个命名命令把正确语义固化下来。

**2. 部署 runbook（`docs/DEPLOY.md` 或 README 章节）记录如下要点：**
- (a) 三类配置生效语义表格：DB 形态（账号）进程重启生效；env 形态（`DIGEST_TIMES`、`POLL_INTERVAL_SECONDS`、密钥、`RULES_FILE` 路径覆盖）需重建容器；文件形态（`rules.yaml` 内容）实时热加载。明确区分 `RULES_FILE`（读哪个文件，env 形态，需重建）与 `rules.yaml` 内容（文件形态，实时）。
- (b) 三条操作轴的区分（均为操作命令）：**镜像变更**（Dockerfile / 依赖）需 `docker compose build`（或 `up -d --build`）；**env 变更**需 `reload`（`up -d --force-recreate`，不重建镜像）；**文件配置**（`rules.yaml`）实时生效、无需任何命令。另：DB-config 载体（账号经 CLI add/disable）不在这三条操作命令轴上——它在进程重启时生效、与三轴正交，文档单列一行说明，以免读者误以为账号缺席于配置模型。
- (c) 共享宿主机端口覆盖 `POSTGRES_HOST_PORT` / `APP_HOST_PORT`；`APP_HOST_PORT` 在 README 中补全（`POSTGRES_HOST_PORT` 已有）。
- (d) 远程 DB 的 ssh 隧道一行命令，其 far-end 端口绑定到 `POSTGRES_HOST_PORT` 而非硬编码 5432，例如 `ssh -fNL 5432:127.0.0.1:${POSTGRES_HOST_PORT:-5432} <host>`，因为 postgres 绑定 loopback。
- (e) `reload` / recreate 会在容器重建时重跑 `prisma migrate deploy`，该操作幂等：已应用的迁移（含分区部分索引）经 `_prisma_migrations` 跳过，仅真正待应用的迁移会执行。
- (f) `reload` / recreate 不触碰 `./data/postgres` 数据卷。
- (g) 坏挂载处置：`./rules:/app/rules:ro` 在 compose 中是无条件的，且挂载存在时**完全遮蔽**镜像内烘焙的 `COPY rules` 拷贝——故双供给只保护「无挂载」场景，不保护「坏挂载」场景。若宿主缺 `./rules/rules.yaml`（tarball 部署、或 checkout 时未带该文件），Docker 会在挂载点自动建空目录 → 遮蔽镜像内拷贝 → `rules-config-load-failed → carry-forward`（正是本变更要修的退化）。因此 bind-mount 要求宿主 `./rules/rules.yaml` 存在；对纯镜像 / 自包含部署（无宿主 rules 目录），应**移除该 volume 行**以回落到镜像内烘焙拷贝。
- (h) `reload` = `docker compose up -d --force-recreate`（不带服务名）会一并重建 postgres，每次 env reload 都要等 `service_healthy` 健康门（约数十秒的 app 间隙）。仅改不触及 `POSTGRES_HOST_PORT` 的 env 时，可用进阶轻量捷径 `up -d --force-recreate inbox-pilot` 只重建 app；但统一的不带服务名 `reload` 仍是安全默认（它还会一并重新应用 `POSTGRES_HOST_PORT`）。
- (i) 重部署与校验顺序：build → `up -d --force-recreate` → 校验 `/health` → 校验摘要调度器 `taskCount`。

**3. 构建阶段与运行阶段都安装 openssl。**
- `node:24-bookworm-slim` 基础镜像不含任何 libssl；`prisma generate` 在 build 阶段运行并探测 libssl，Prisma 引擎在 run 阶段运行时同样需要 libssl。故 `openssl` 必须装两处：build 阶段在 `prisma generate` 之前、run 阶段在 entrypoint 之前。安装 `openssl` 携带 `libssl.so.3`，正是 Prisma 引擎所需。
- `ca-certificates` 解决的是另一件事——出站 HTTPS（OpenRouter / Gmail / Telegram）的根证书校验，与 libssl 探测无关；如保留则单列其理由，与 openssl 的 libssl 修复区分。
- 安装形态：`RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*`。
- 替代方案：换用自带 openssl 的基础镜像——被否决，改动面更大且偏离现有 `node:24-bookworm-slim` 基线；装包是最小、最局部的修复。

**4. `TZ` 默认值收归应用 + 回退告警 + 移除 compose 默认。**
- 应用在解析时区处使用 `process.env.TZ || 'Asia/Shanghai'`（用 `||` 而非 `??`，使空字符串也回退；当前为 `?? 'Asia/Shanghai'`、不发告警），并在回退时发出一次性 `logger.warn({ kind: 'tz-fallback-default' }, ...)`。
- 移除 docker-compose 的 `TZ: ${TZ:-Asia/Shanghai}` 默认注入，compose 仅从 `.env` 透传 `TZ`。否则 compose 在 Node 启动前就把 `TZ` 注入容器，`process.env.TZ` 永不为空，本变更**新增的**回退-告警分支在该目标 compose 部署形态下不可达——除非移除 compose 的 `TZ` 默认。移除默认后，未设置 / 为空的 `TZ` 能抵达应用回退分支，告警端到端可观测。
- `.env.example` 保留显式 `TZ=Asia/Shanghai` 作为文档化推荐值（已存在，本变更只需核验）。
- 不新增 `TZ` 合法性校验；非法 `TZ`（node-cron 可能抛错 / 行为异常）的处置由运维负责。

**5. `rules.yaml` 经挂载 + 镜像内拷贝双供给抵达容器。**
- 仓库有 `rules/rules.yaml`，但若镜像不 COPY、compose 不挂载，则 `/app/rules/rules.yaml` 在运行时缺失，规则引擎以内置 carry-forward 默认值静默运行（`rules-config-load-failed / fs-error / carry-forward`），「文件形态实时热加载」一类形同虚设。
- (i) docker-compose bind-mount `./rules:/app/rules:ro`（**已存在于 compose，本变更只核验**）：默认规则存在、可由宿主编辑，使 mtime 热加载真正实时。
- (ii) Dockerfile run 阶段 `COPY rules ./rules`（**净新增工作**）：作为无挂载时的自包含镜像兜底。
- 挂载目标为何是 `/app/rules`：规则路径经 `import.meta.url` 相对编译后的 `dist/rules/` 模块解析（**非 cwd**）。在 `tsconfig` 的 `outDir:dist` / `rootDir:src` 与 `WORKDIR /app` 下，`dist/rules/ → ../../rules = /app/rules`，故挂载目标必须是 `/app/rules` 才能与运行时解析的路径对齐。挂载目标因此与构建布局耦合：将来若 `outDir` 扁平化或打包改变模块深度，会静默打破挂载匹配（退化回 carry-forward）。

## 风险 / 权衡

- [`reload` 仍是手动步骤，运维可能忘记对 env 改动执行它] → runbook 的生效语义表把「env 形态需重建」写死，`reload` 命令把正确动作命名化降低记忆负担；不引入自动监听是为了不触碰 cron 重建管线（见非目标）。
- [回退告警仅在 `TZ` 未设置 / 为空时触发，已显式设置 `TZ` 的部署不受影响] → 这是预期行为：目标是让「未设置」变响亮，而非对正常配置噪声化。移除 compose 默认是让该告警在目标部署形态下真正可达的前提。
- [装系统包略增镜像体积与构建时间，且需在 build + run 两阶段各装一次] → `--no-install-recommends` + 清理 `/var/lib/apt/lists/*` 将增量控制在最小；换取消除 Prisma libssl 探测告警与脆弱性。
- [镜像内 COPY 的 `rules.yaml` 与宿主挂载并存] → 挂载存在时覆盖镜像内拷贝，宿主侧编辑生效；无挂载时回落到镜像内拷贝，二者不冲突，皆避免 carry-forward 退化。
- [坏挂载遮蔽镜像内拷贝] → `./rules:/app/rules:ro` 在 compose 中无条件、挂载存在时**完全遮蔽**镜像内 `COPY rules` 拷贝。双供给只保护「无挂载」、不保护「坏挂载」：宿主缺 `./rules/rules.yaml`（tarball 部署 / checkout 未带该文件）时 Docker 自动建空目录遮蔽烘焙拷贝，退化回 `rules-config-load-failed → carry-forward`。处置：bind-mount 要求宿主 `./rules/rules.yaml` 存在；纯镜像 / 自包含部署应移除该 volume 行以回落到烘焙拷贝（已写入 runbook (g)）。
- [残留缺口：env 标量不能实时热加载] → 有意接受（见非目标），仅当这些值开始频繁变更时再重新评估。

## 验证

- 重建镜像；build 日志（`prisma generate` 阶段）与 `docker compose logs`（运行时）均不出现 Prisma openssl / libssl 探测告警。
- 改 `DIGEST_TIMES` → 执行 `pnpm run reload` → 摘要调度器日志打印新的 `taskCount`（`restart` 不会）。
- 不设 / 置空 `TZ`（compose 不再注入默认）→ `tz-fallback-default` 告警触发；`TZ` 已设置 → 不触发。
- 容器启动日志不出现 `rules-config-load-failed`，规则按 `rules.yaml` 加载而非 carry-forward 默认。
