# deployment 规范

## 目的
定义 inbox-pilot 的部署/运维载体约束：三类配置（DB / env / 文件形态）的生效语义与对应动作、Prisma 引擎的 libssl 可用性、时区解析与回退可观测、数据库宿主机端口覆盖、`rules.yaml` 可达性。当前部署载体为 **hangar 托管的原生 node 进程**（macOS launchd 常驻 daemon 加载 `dist/pipeline.js`）；docker 只承载 postgres。仅约束部署/运维载体，不涉及分类 / 规则 / 动作行为。

## 需求
### 需求:配置生效语义与生效动作

部署必须为三类配置生效语义提供文档与明确的生效动作：

- DB 形态配置（账号，存 `MailAccount.authJson`）必须在 pilot 进程重启时生效。
- env 形态配置（密钥、`TZ`，以及 `RULES_FILE` 这一「规则文件路径」覆盖）在进程启动时一次性读入，必须经由**重启常驻 daemon**（`launchctl kickstart -k gui/$(id -u)/com.herbertgao.hangar-inbox`）才能生效；文档不得让运维以为改完 `.env` 即时生效。
- 文件形态配置（`rules.yaml` 的内容）必须实时热加载。

`RULES_FILE` 是「读哪个文件」的路径覆盖，属 env 形态，改它需要重启 daemon；`rules.yaml` 的内容属文件形态，实时热加载——二者不同轴，文档必须区分。

部署文档还必须写明当前的**已知缺口**：加载器的 mtime 热重载（`startRulesConfigReload`）在常驻 daemon 里没有生产调用方，故 `rules.yaml` 及其同目录 `noise_senders.overlay` 的改动实际同样要重启 daemon 才生效。缺口必须显式记录，不得让「实时生效」在运维侧静默失效。

容器形态特有的两条语义——`docker compose restart` 不重新读取 `env_file`、`reload` 必须不带服务名以整工程重建——随 app 容器一并退役，在原生进程形态下**无对应物**（唯一残留的容器是 postgres，见「数据库宿主机端口覆盖」）。

#### 场景:env 形态配置经重启 daemon 后生效

- **当** 运维修改了 pilot checkout 下的 `.env`（如轮换密钥）并重启 launchd daemon
- **那么** pilot 进程以新环境重新启动，新配置生效

#### 场景:改 .env 但不重启 daemon 时不生效

- **当** 运维修改了 env 形态配置却没有重启 daemon
- **那么** 常驻进程继续使用启动时读入的旧值，改动不生效——文档必须明确此语义并把运维导向重启 daemon

#### 场景:文件形态配置实时热加载

- **当** 运维修改了 pilot 可见的 `rules.yaml` 内容
- **那么** 该变更被实时热加载（mtime 轮询），无需重启进程

#### 场景:热重载未接线的缺口被文档记录

- **当** 运维在常驻 daemon 上改动 `rules.yaml` 或 `noise_senders.overlay`
- **那么** runbook 必须已写明「生产未接线 mtime 热重载、该改动要重启 daemon 才实际生效」，使运维不会误判为已生效

### 需求:Prisma 引擎的 libssl 可用性

运行 pilot 的环境必须提供 Prisma 引擎所需的 libssl，验收信号为运行期日志不出现 Prisma 的 openssl / libssl 探测告警。

当前形态（hangar 原生 node 进程）下 libssl 由宿主系统提供、不由本仓构建产物负责；`inbox-pilot doctor` 的 openssl 探测（告警级，不参与退出码）即该前提的只读检查点。

本需求原先的容器形态实现约束——两阶段镜像（build 与 run 均基于 `node:24-bookworm-slim`，基础镜像本身不含任何 libssl）都必须安装 `openssl` 系统包，因为 `prisma generate` 在 build 阶段探测 libssl、Prisma 引擎在 run 阶段需要 libssl——随 `Dockerfile` 一并退役，在当前形态下**无对应物**；它不是被放宽，而是其前提（构建运行时镜像）不再成立。**若未来恢复镜像形态，该约束必须重新被满足。**

#### 场景:运行环境缺 libssl 时可被只读预检发现

- **当** 运维在部署环境执行 `inbox-pilot doctor`
- **那么** 报告必须包含 openssl 是否可用这一项；缺失时以告警呈现，供运维在出现 Prisma 引擎故障前发现

### 需求:时区解析与回退可观测

摘要相关的时区必须从 `TZ` 解析。`TZ` 的默认值归属于应用本身：当 `TZ` 未设置或为空字符串时，应用必须回退到一个有文档的默认值（`Asia/Shanghai`），并发出一次性回退告警（如 `kind: 'tz-fallback-default'`），使该回退可被观测。运行载体不得为 `TZ` 注入默认值（只从部署环境 / `.env` 透传），以使未设置 / 为空的 `TZ` 能真正抵达应用的回退分支、令告警端到端可观测。`.env.example` 必须保留显式的 `TZ=Asia/Shanghai` 作为文档化的推荐值。

非法 `TZ` 字符串的行为由运维负责；本规范不要求 `TZ` 合法性校验。

#### 场景:TZ 未设置时应用回退并告警

- **当** `TZ` 环境变量未设置（运行载体不注入默认值，故该值抵达应用），应用解析时区
- **那么** 应用回退到文档化的默认值 `Asia/Shanghai`，并发出回退告警日志（如 `kind: 'tz-fallback-default'`）

#### 场景:TZ 为空字符串时应用回退并告警

- **当** `TZ` 环境变量被设为空字符串，应用解析时区
- **那么** 应用按 `||` 语义同样回退到 `Asia/Shanghai` 并发出回退告警日志

#### 场景:TZ 已设置时采用且不告警

- **当** `TZ` 环境变量已显式设置为合法时区
- **那么** 应用采用该时区且不发出回退告警

### 需求:rules.yaml 可达性

`rules.yaml` 必须在 pilot 进程可读的路径上，否则规则引擎将以内置 carry-forward 默认值静默运行，使「文件形态配置实时热加载」一类形同虚设。

- `RULES_FILE` 未设时，路径从加载器模块自身位置派生为 `<checkout>/rules/rules.yaml`，该文件由代码 checkout 一并提供，故默认规则恒存在且可由运维就地编辑。
- `noise_senders.overlay` 恒为 `rules.yaml` 的同目录文件、不可单独配置；反馈闭环要写它，故该目录必须对 pilot 进程可写（原生进程形态下是普通用户目录，天然满足；容器形态下靠 `rw` 挂载满足）。
- 部署必须保证该文件随代码一起更新到位；缺失时加载器不崩，但会记 `rules-config-load-failed` 并退化为 carry-forward——该信号必须在部署校验中被看见。

#### 场景:rules.yaml 可达时规则引擎按文件加载

- **当** pilot 启动且 `<checkout>/rules/rules.yaml`（或 `RULES_FILE` 指向的文件）可读
- **那么** 规则引擎按该文件加载规则，启动日志不出现 `rules-config-load-failed`（不退化为 carry-forward 默认值）

#### 场景:overlay 目录可写

- **当** 反馈闭环（`apply-feedback`）要写 `noise_senders.overlay`
- **那么** 该文件所在目录（`rules.yaml` 同目录）必须对 pilot 进程可写，否则写入失败必须以显式回执呈现、不得静默成功

### 需求:数据库宿主机端口覆盖

postgres 的 compose 部署必须允许覆盖宿主机发布端口（`POSTGRES_HOST_PORT`）以避免共享宿主机上的端口冲突，并且该覆盖必须有文档。postgres 只发布到宿主 loopback，远程访问经手动 ssh 隧道；隧道 far-end 端口必须绑定到 `POSTGRES_HOST_PORT` 而非硬编码 5432，该一行命令必须在 runbook 中记录。

app 侧的 `APP_HOST_PORT` 随 app 容器退役——原生进程形态下 pilot 不发布任何宿主端口，故**无对应物**。

#### 场景:在共享宿主机上覆盖数据库端口

- **当** 共享宿主机上默认 5432 被占用，运维设置 `POSTGRES_HOST_PORT`（生产为 5433）
- **那么** compose 按覆盖值发布宿主 loopback 端口，避免冲突；`DATABASE_URL` 与 runbook 里的 ssh 隧道命令必须随之对齐同一端口
