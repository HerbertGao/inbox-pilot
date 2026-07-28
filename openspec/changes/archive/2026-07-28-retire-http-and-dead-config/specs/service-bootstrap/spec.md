## 修改需求

### 需求:环境配置校验
服务启动时必须用 zod 校验环境变量；校验失败必须快速失败（fail fast）并以非零退出码终止，禁止以缺省静默启动。

P0 必需变量集必须**仅**为：`DATABASE_URL`（无默认值，缺失即 fail-fast；须为合法的 postgres 连接串，scheme 为 `postgresql://` 或 `postgres://`，否则 fail-fast）。所有后续阶段变量（`OPENROUTER_*`、`GMAIL_*`、`TELEGRAM_*`、`BARK_*`、`DIGEST_*`）在 P0 必须为可选或不纳入校验，**禁止**因其缺失而拒绝启动。

所有密钥——包含内嵌口令的 `DATABASE_URL`——必须仅从环境变量读取，禁止写死在代码中。

#### 场景:缺失必需变量时拒绝启动
- **当** 启动服务且未提供 `DATABASE_URL`
- **那么** 服务必须打印明确的校验错误并以非零退出码终止

#### 场景:DATABASE_URL scheme 非法时拒绝启动
- **当** 提供的 `DATABASE_URL` 不是 `postgresql://` / `postgres://`（如 `https://...` 或非 URL 字符串）
- **那么** 服务必须在启动时 fail-fast、打印校验错误并以非零退出码终止

#### 场景:仅提供最小变量即可启动（启动不依赖数据库可达性）
- **当** 仅提供合法的 `DATABASE_URL`（不提供任何 provider / AI / 通知密钥），无论数据库此刻是否可达
- **那么** 服务必须成功启动（Prisma 惰性连接、启动时不调用 `$connect()`），禁止因缺少后续阶段变量、或数据库暂时不可达而拒绝启动

#### 场景:配置合法时正常加载
- **当** 提供了全部必需环境变量且格式合法
- **那么** 服务必须成功加载一个冻结的、类型安全的配置对象供其余模块读取

## 移除需求

### 需求:健康检查端点

**Reason**: pilot 已不是独立服务，而是 hangar 常驻 daemon in-process 加载的一个 app（见「运行载体与迁移前置」）。全仓无 fastify 引用、无 HTTP 服务、无 `/health` 端点——本需求整条无任何实现，而一条无人实现的 MUST 会让读者以为存在一道并不存在的检查。

**Migration**: 不在 pilot 侧新建替代物。数据库可达性的按需探测由 `inbox-pilot doctor` 承担（已实现该检查，报 `unreachable`）；进程存活性的承接方是 launchd + hangar daemon，不由本仓规范约束。随本需求一并退役的还有 `fastify` 依赖、`HOST` / `PORT` 两个环境变量、以及 `doctor` 中「服务自身 HOST:PORT 本地占用」那一项探测——探测对象已不存在，该项无判别力。
