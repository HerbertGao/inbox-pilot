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
服务必须提供一个 fastify HTTP 服务，监听 `HOST:PORT`（容器内必须绑定 `0.0.0.0` 以便从宿主访问），并暴露 `/health` 端点。`/health` 只做存活与数据库连通性检查（liveness），不校验业务就绪度或 schema 完整性。

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

### 需求:容器化运行
项目必须提供 Dockerfile 与 docker-compose.yml，一键启动 inbox-pilot 与 postgres 两个服务（不含 Redis，不含已废弃的 `version:` 键）。app 容器必须发布端口供宿主访问；postgres 必须配置 healthcheck（`pg_isready`），app 必须 `depends_on: condition: service_healthy`；容器 entrypoint 必须先执行 `prisma migrate deploy`（fail-fast）再启动服务。

#### 场景:一键启动
- **当** 在配置好 `.env` 的环境执行 `docker compose up`（迁移可成功的前提下）
- **那么** inbox-pilot 与 postgres 容器必须于合理时间内进入 running（非 restarting）状态，迁移成功，5 张表存在，且从宿主请求 `/health` 返回 200（迁移持续失败属下一场景的 crash-loop，不计入本场景）

#### 场景:迁移失败时不以半启动状态对外服务
- **当** `prisma migrate deploy` 在 entrypoint 中失败
- **那么** app 容器必须以非零退出码终止（crash-loop），禁止在未迁移的数据库上启动并对外提供服务

