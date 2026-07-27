# service-bootstrap 规范

## 目的
待定 - 由归档变更 project-bootstrap 创建。归档后请更新目的。
## 需求
### 需求:环境配置校验
服务启动时必须用 zod 校验环境变量；校验失败必须快速失败（fail fast）并以非零退出码终止，禁止以缺省静默启动。

P0 必需变量集必须**仅**为：`DATABASE_URL`（无默认值，缺失即 fail-fast；须为合法的 postgres 连接串，scheme 为 `postgresql://` 或 `postgres://`，否则 fail-fast）；`NODE_ENV`、`HOST`、`PORT`（须可解析为数字）带默认值。所有后续阶段变量（`OPENROUTER_*`、`GMAIL_*`、`TELEGRAM_*`、`BARK_*`、`POLL_*`、`DIGEST_*`）在 P0 必须为可选或不纳入校验，**禁止**因其缺失而拒绝启动。

所有密钥——包含内嵌口令的 `DATABASE_URL`——必须仅从环境变量读取，禁止写死在代码中。

#### 场景:缺失必需变量时拒绝启动
- **当** 启动服务且未提供 `DATABASE_URL`
- **那么** 服务必须打印明确的校验错误并以非零退出码终止，且不监听端口

#### 场景:DATABASE_URL scheme 非法时拒绝启动
- **当** 提供的 `DATABASE_URL` 不是 `postgresql://` / `postgres://`（如 `https://...` 或非 URL 字符串）
- **那么** 服务必须在启动时 fail-fast、打印校验错误并以非零退出码终止

#### 场景:仅提供最小变量即可启动（启动不依赖数据库可达性）
- **当** 仅提供合法的 `DATABASE_URL`（不提供任何 provider / AI / 通知密钥），无论数据库此刻是否可达
- **那么** 服务必须成功启动（Prisma 惰性连接、启动时不调用 `$connect()`），禁止因缺少后续阶段变量、或数据库暂时不可达而拒绝启动；启动后 `/health` 按数据库实际状态返回 200 或 503（见健康检查端点）

#### 场景:配置合法时正常加载
- **当** 提供了全部必需环境变量且格式合法
- **那么** 服务必须成功加载一个冻结的、类型安全的配置对象供其余模块读取

### 需求:数据库连接与迁移
项目必须提供 Prisma 数据模型与首次 migration，覆盖 mail_accounts、mail_messages、mail_classifications、mail_actions、digest_items 共 5 张表（物理表名通过 `@@map` 固定为上述 snake_case；字段与列名沿用 §8 的 camelCase，不加 `@map`），并保留 PROJECT_INIT §8 定义的外键关系与约束；同时暴露单例 Prisma 客户端供全局复用。该客户端必须惰性连接（启动时不调用 `$connect()`），使服务启动不依赖数据库可达性。

#### 场景:执行首次迁移
- **当** 在已连接的 PostgreSQL 上运行 `prisma migrate`
- **那么** 数据库中必须存在上述 5 张 snake_case 表，含 mail_messages 的 `(accountId, providerMessageId)` 唯一键，以及 §8 定义的 4 个外键关系

#### 场景:复用单例客户端
- **当** 多个模块导入 Prisma 客户端
- **那么** 必须复用同一个客户端实例，禁止每次创建新连接池

### 需求:健康检查端点
服务必须提供一个 fastify HTTP 服务，监听 `HOST:PORT`（默认绑定 `0.0.0.0`，不写死回环），并暴露 `/health` 端点。`/health` 只做存活与数据库连通性检查（liveness），不校验业务就绪度或 schema 完整性。

#### 场景:依赖正常时返回健康
- **当** 服务运行且数据库可达，请求 `GET /health`
- **那么** 必须返回 HTTP 200

#### 场景:数据库不可达时在有限时间内返回不健康
- **当** 数据库不可达，或 `SELECT 1` 探测查询出错，请求 `GET /health`
- **那么** 必须在有限时间内（带超时，如 ~2–3s，禁止挂起）返回 503

### 需求:结构化日志
服务必须使用 pino 输出结构化（JSON）日志；必须配置 redact，使 `DATABASE_URL`（含口令）、`*_API_KEY`、`*.password` 等敏感字段不以明文出现，且禁止直接打印原始 config 对象。基于 key 的 redact 无法清洗字符串内嵌的口令，因此还必须禁止将原始数据库连接串或未脱敏的 Prisma 错误对象（可能内嵌连接串）写入日志。

#### 场景:启动写出结构化日志且不泄露密钥
- **当** 服务启动并写出启动日志（即使记录了配置摘要）
- **那么** 日志必须为结构化格式，且不含任何密钥、口令或连接串明文

#### 场景:错误路径不泄露连接串
- **当** 数据库连接或查询出错（错误信息可能内嵌 `DATABASE_URL` 口令）
- **那么** 写入日志的内容禁止包含连接串或口令明文，禁止直接记录原始 Prisma 错误对象或连接串

### 需求:运行载体与迁移前置
pilot 必须以 **hangar 托管的原生 node 进程**运行：仓根提供 `app.yaml`（executor + cron 触发器定义），构建产物 `dist/pipeline.js` 由 hangar 常驻 daemon（macOS launchd 服务）in-process 加载并调用其 `run(ctx)`。项目不再提供 app 容器镜像。

数据库仍由本仓 `docker-compose.yml` 的 `postgres` 服务提供：必须配置 healthcheck（`pg_isready`）、只发布到宿主 loopback、数据落在持久卷上（不含 Redis，不含已废弃的 `version:` 键）。

「先迁移、后服务」这一前置不得因载体变更而失效——容器形态曾由 entrypoint 的 `prisma migrate deploy`（fail-fast）承担，原生形态下必须由部署流程在重启 daemon **之前**执行 `prisma migrate deploy`，失败即中止部署。app 容器专属的 `depends_on: condition: service_healthy`（启动前等 postgres 健康门）随容器退役、**无对应物**：原生形态下数据库不可达表现为运行期失败与 `inbox-pilot doctor` 报 `unreachable`，而不是启动编排。

#### 场景:部署后 pilot 被 hangar 加载并按触发器运行
- **当** 在配置好 `.env` 的 checkout 上完成构建与迁移，并重启 launchd daemon（迁移可成功的前提下）
- **那么** 5 张表必须存在，hangar 必须按 `app.yaml` 的 cron 触发器加载并调用 pilot，且 `inbox-pilot doctor` 的关键检查（配置校验 + 数据库可达）通过

#### 场景:迁移失败时不让 pilot 在未迁移的库上运行
- **当** `prisma migrate deploy` 以非零退出码失败
- **那么** 部署必须中止，禁止重启 daemon 把 pilot 放到未迁移的数据库上运行

