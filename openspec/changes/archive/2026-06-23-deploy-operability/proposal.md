## 为什么

通过 docker-compose 部署 inbox-pilot 暴露出若干可运维性缺口，它们会静默地产生错误的运行时行为：

- 改了 env 形态的配置（如 `DIGEST_TIMES`）后执行 `docker compose restart` 并不会生效——`restart` 复用容器创建时烘焙进去的环境变量，只有 `docker compose up -d --force-recreate` 才会重新读取 `env_file`。这次编辑被静默吞掉，导致定时摘要按陈旧配置运行。
- 运行时镜像 `node:24-bookworm-slim` 基础镜像不含任何 libssl；`prisma generate` 在 build 阶段、Prisma 引擎在 run 阶段都需要 libssl，因此当前发出 Prisma 的 openssl / libssl 探测告警。
- `TZ` 默认值的归属错位：当前应用以 `process.env.TZ ?? 'Asia/Shanghai'` 回退、不发告警；本变更新增「未设置 / 为空 `TZ` 时回退并告警」分支，但 compose 在 Node 启动前注入 `TZ: ${TZ:-Asia/Shanghai}`，使新增的回退-告警分支在目标 compose 部署形态下不可达——除非移除 compose 的 `TZ` 默认注入，调度时区的回退因而不可观测。
- 仓库已有 `rules/rules.yaml`，compose 已 bind-mount `./rules:/app/rules:ro`（本变更只需核验），但 Dockerfile 不 COPY；当宿主缺 `./rules` 时 Docker 会在挂载点自动建空目录、遮蔽镜像内拷贝，`/app/rules/rules.yaml` 在容器内缺失，规则引擎以内置 carry-forward 默认值静默运行，「文件形态实时热加载」一类形同虚设。净新增工作是 Dockerfile 的 `COPY rules ./rules` 兜底。
- 缺口不在「端口 / `TZ` 未文档化」——`.env.example` 已记录 `POSTGRES_HOST_PORT` / `APP_HOST_PORT`（含指引）与 `TZ`，README 已记录 `POSTGRES_HOST_PORT`。真正缺的是一份**统一的部署 runbook**、确实缺失的**远程 DB ssh 隧道一行命令**，以及 README 中缺的 **`APP_HOST_PORT`**。

## 变更内容

针对 docker-compose 部署的可运维性加固（不改变分类 / 规则 / 动作行为）：

- 提供 `reload` 命令（`docker compose up -d --force-recreate`，不带服务名，使 postgres 端口映射改动也被重新应用）和一份统一的部署 runbook，明确三类配置生效语义：DB 形态（账号）在重启时生效；env 形态（`DIGEST_TIMES`、`POLL_INTERVAL_SECONDS`、密钥、`RULES_FILE` 路径覆盖）需要重建容器；文件形态（`rules.yaml` 内容）实时热加载。
- 在 build 阶段（`prisma generate` 之前）与 run 阶段（entrypoint 之前）都安装 `openssl`，提供 Prisma 引擎所需的 libssl（`libssl.so.3`），消除两处探测告警。
- 把 `TZ` 默认值收归应用：应用以 `process.env.TZ || 'Asia/Shanghai'` 回退（空字符串也回退）并发告警；移除 compose 的 `TZ: ${TZ:-Asia/Shanghai}` 默认注入，使新增的回退-告警分支在目标部署形态下可达、未设置 / 为空的 `TZ` 抵达应用回退分支、告警端到端可观测；`.env.example` 保留显式 `TZ=Asia/Shanghai` 作为推荐值。
- 让 `rules.yaml` 真实可达容器：核验 compose 已有的 `./rules:/app/rules:ro` bind-mount（默认规则存在 + 可宿主编辑使热加载实时）+ 新增 Dockerfile run 阶段 `COPY rules ./rules`（自包含镜像兜底）。
- 在 runbook 中记录 `POSTGRES_HOST_PORT` / `APP_HOST_PORT`、远程 DB 的 ssh 隧道一行命令（far-end 端口绑定 `POSTGRES_HOST_PORT`），并在 README 补全 `APP_HOST_PORT`。

## 功能 (Capabilities)

### 新增功能
- `deployment`: docker-compose 部署的可运维性契约——配置生效语义（DB / env / 文件三类，区分 `RULES_FILE` 路径与 `rules.yaml` 内容）与 `reload` 工具、运行时镜像完整性（build + run 两阶段 openssl）、时区解析与回退可观测（应用归属默认值 + compose 不注入默认）、容器内 `rules.yaml` 可达性、宿主机端口覆盖与文档。

### 修改功能
<!-- 无规范级行为变更：分类 / 规则 / 动作行为不受影响。 -->

## 非目标 (Non-goals)

- 不把 `DIGEST_TIMES` / `POLL_INTERVAL_SECONDS` 从 env 迁出到热加载文件或 DB。现有的 `rules.yaml` 热加载只替换内存快照，并不重建 cron 调度器。对这些标量做实时热加载需要全新的 cron 拆除 / 重建管线——对两个极少变更的值而言代价失衡。仅当它们开始频繁变更（如每周）时再重新评估。
- 不改变 env 与 DB 的凭据划分。
- 不自动化远程 DB 访问；postgres 有意绑定 loopback。runbook 记录手动 ssh 隧道，不写代码。
- 不新增 `TZ` 合法性校验；非法 `TZ` 的行为由运维负责。
- 不在容器上新增 `/health` 的 `HEALTHCHECK` 指令，也不切换为非 root `USER`——两者均为后续独立变更。

## 影响

- 代码 / 配置：`package.json`（新增 `reload` pnpm 脚本；该脚本要求宿主装有 docker-compose v2，即 `docker compose`）、`Dockerfile`（build + run 两阶段安装 openssl + ca-certificates；run 阶段 `COPY rules ./rules`）、`docker-compose.yml`（移除 `TZ` 默认注入；`./rules:/app/rules:ro` 挂载已存在、本变更只核验）、时区解析代码路径（`||` 回退 + `tz-fallback-default` 告警）。
- 文档：新增统一部署 runbook（`docs/DEPLOY.md` 或 README 章节），涵盖三类配置生效语义、三条操作轴（镜像 / env / 文件，均为操作命令；DB-config 载体即账号经 CLI add/disable 在进程重启时生效、与三轴正交，单列一行以免读者误以为账号缺席于模型）、宿主机端口覆盖、远程 DB ssh 隧道、迁移幂等性、数据卷不受影响、坏挂载（宿主缺 `./rules/rules.yaml` 时空目录遮蔽镜像内拷贝）的处置、`reload` 重建 postgres 的代价说明、重部署与校验流程；README 补全 `APP_HOST_PORT`。
- 依赖：运行时镜像在 build + run 两阶段各安装系统包 openssl（+ 视需 ca-certificates，用于出站 HTTPS）。
- 行为：无分类 / 规则 / 动作行为变更；纯部署 / 运维加固。
