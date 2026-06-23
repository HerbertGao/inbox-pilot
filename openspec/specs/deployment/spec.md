# deployment 规范

## 目的
定义 inbox-pilot 的部署/运维载体约束：三类配置（DB / env / 文件形态）的生效语义与 `reload` 工具、运行时镜像的 libssl 完整性、时区解析与回退可观测、宿主机端口覆盖、容器内 `rules.yaml` 可达性。仅约束部署/运维载体，不涉及分类 / 规则 / 动作行为。

## 需求
### 需求:配置生效语义与 reload 工具

部署必须为三类配置生效语义提供文档与工具：

- DB 形态配置（账号，存 `MailAccount.authJson`）必须在进程重启时生效。
- env 形态配置（`DIGEST_TIMES`、`POLL_INTERVAL_SECONDS`、密钥，以及 `RULES_FILE` 这一「规则文件路径」覆盖）必须经由容器重建（`docker compose up -d --force-recreate`，而非 `restart`）才能生效。
- 文件形态配置（`rules.yaml` 的内容）必须实时热加载。

`RULES_FILE` 是「读哪个文件」的路径覆盖，属 env 形态，改它需要重建容器；`rules.yaml` 的内容属文件形态，实时热加载——二者不同轴，文档必须区分。

部署必须提供一个 `reload` 命令执行容器重建。该命令不得限定到单个服务（不带服务名参数），使发布在 postgres 服务端口映射上的 `POSTGRES_HOST_PORT` 改动也能被一并重新应用；`--force-recreate` 对 postgres 幂等且安全。

#### 场景:env 形态配置经 reload 重建后生效

- **当** 运维修改了 env 形态配置（如 `DIGEST_TIMES`）并执行 `reload` 命令
- **那么** 所有服务被重建并重新读取 `env_file`，新配置生效（例如摘要调度器按新配置打印新的任务计数）

#### 场景:restart 不重新读取 env_file

- **当** 运维修改了 env 形态配置后执行 `docker compose restart`
- **那么** 容器复用创建时烘焙的环境变量，env 改动不生效——文档必须明确此语义并将运维导向 `reload`

#### 场景:reload 不限定服务以覆盖端口改动

- **当** 运维修改了 `POSTGRES_HOST_PORT` 并执行 `reload` 命令
- **那么** `reload` 不带服务名、重建包含 postgres 在内的全部服务，端口映射改动被重新应用

#### 场景:文件形态配置实时热加载

- **当** 运维修改了容器内可见的 `rules.yaml` 内容
- **那么** 该变更被实时热加载（mtime 轮询），无需重建容器

### 需求:运行时镜像完整性

构建阶段与运行阶段（均基于 `node:24-bookworm-slim`，基础镜像本身不含任何 libssl）都必须包含 Prisma 引擎所需的 libssl。该 libssl 由安装 `openssl` 系统包提供（其携带 `libssl.so.3`）。`openssl` 必须在两处安装：build 阶段（`prisma generate` 之前）与 run 阶段（entrypoint 之前），因为 `prisma generate` 在 build 阶段运行并探测 libssl，Prisma 引擎在 run 阶段运行时同样需要 libssl。验收信号为：构建/generate 与启动两处日志均不出现 Prisma 的 openssl / libssl 探测告警。

#### 场景:build 与 run 两阶段装 openssl 后无 libssl 告警

- **当** 重建运行时镜像并启动容器
- **那么** build 日志（`prisma generate` 阶段）与运行时日志（容器启动阶段）均不出现 Prisma 的 openssl / libssl 探测告警

### 需求:时区解析与回退可观测

摘要调度器必须从 `TZ` 解析其时区。`TZ` 的默认值归属于应用本身：当 `TZ` 未设置或为空字符串时，应用必须回退到一个有文档的默认值（`Asia/Shanghai`），并发出一次性回退告警（如 `kind: 'tz-fallback-default'`），使该回退可被观测。compose 不得为 `TZ` 注入默认值（只从 `.env` 透传 `TZ`），以使未设置 / 为空的 `TZ` 能真正抵达应用的回退分支、令告警端到端可观测。`.env.example` 必须保留显式的 `TZ=Asia/Shanghai` 作为文档化的推荐值。

非法 `TZ` 字符串的行为由运维负责（node-cron 可能抛错或行为异常）；本变更不新增 `TZ` 合法性校验。

#### 场景:TZ 未设置时应用回退并告警

- **当** `TZ` 环境变量未设置（compose 不再注入默认值，故该值抵达应用），应用解析时区
- **那么** 应用回退到文档化的默认值 `Asia/Shanghai`，并发出回退告警日志（如 `kind: 'tz-fallback-default'`）

#### 场景:TZ 为空字符串时应用回退并告警

- **当** `TZ` 环境变量被设为空字符串，应用解析时区
- **那么** 应用按 `||` 语义同样回退到 `Asia/Shanghai` 并发出回退告警日志

#### 场景:TZ 已设置时采用且不告警

- **当** `TZ` 环境变量已显式设置为合法时区
- **那么** 应用采用该时区且不发出回退告警

### 需求:容器内 rules.yaml 可达性

`rules.yaml` 必须经挂载或镜像内拷贝在容器内可达，否则规则引擎将以内置 carry-forward 默认值静默运行，使「文件形态配置实时热加载」一类形同虚设。容器必须同时具备两条供给：

- docker-compose 以 `./rules:/app/rules:ro` bind-mount 注入宿主侧 `rules/`，使默认规则存在且可由宿主编辑，从而 mtime 热加载真正实时生效。
- Dockerfile run 阶段 `COPY rules ./rules` 烘焙一份镜像内拷贝，作为无挂载时的自包含兜底。

#### 场景:rules.yaml 可达时规则引擎按文件加载

- **当** 容器经 bind-mount 或镜像内拷贝具备 `/app/rules/rules.yaml` 并启动
- **那么** 规则引擎按该文件加载规则，启动日志不出现 `rules-config-load-failed`（不退化为 carry-forward 默认值）

### 需求:宿主机端口覆盖

compose 部署必须允许覆盖宿主机发布端口（postgres、app）以避免共享宿主机上的端口冲突，并且这些覆盖必须有文档。

#### 场景:在共享宿主机上覆盖端口

- **当** 共享宿主机上默认端口被占用，运维设置 `POSTGRES_HOST_PORT` / `APP_HOST_PORT`
- **那么** compose 按覆盖值发布宿主机端口，避免冲突；`APP_HOST_PORT` 必须在 README 中补全文档，远程 DB 的 ssh 隧道一行命令（far-end 端口绑定到 `POSTGRES_HOST_PORT`）必须在 runbook 中记录

