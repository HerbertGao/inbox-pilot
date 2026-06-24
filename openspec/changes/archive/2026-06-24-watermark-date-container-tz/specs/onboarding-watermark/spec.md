## 修改需求

### 需求:per-account 起算日期水位线（UTC）
系统必须为每个账号维护一个可空的「起算日期」水位线 `processFrom`（`DateTime?`，**UTC 存储语义**：列存绝对瞬时、Prisma 按 UTC 读写）。`processFrom` 为 NULL 时表示**不设日期下界**（保持既有全量行为）。该水位线**禁止**复用 `lastSyncCursor`（归 IMAP UID 游标语义）或 `createdAt`（审计语义）——必须是独立列。存储为 Postgres `TIMESTAMP`（Prisma 按 UTC 读写），与 `receivedAt` 同类型，可直接比较、无隐式转换。

**口径区分**：本需求标题「（UTC）」**仅**指**列存储**（绝对瞬时 / UTC）；**人类日期串入参**（`--process-from` / `set-process-from` 的 `YYYY-MM-DD`）按**容器时区零点**解析（见「运维可调整存量账号的水位线」需求），二者不同口径、勿混。

#### 场景:NULL 水位线不设下界
- **当** 某账号的 `processFrom` 为 NULL
- **那么** 摄入与摘要**禁止**对该账号施加任何日期下界（等同当前全量行为）

#### 场景:独立列不复用既有列
- **当** 实现该水位线
- **那么** 必须新增独立列，**禁止**复用 `lastSyncCursor` 或 `createdAt`

### 需求:运维可调整存量账号的水位线
系统必须提供运维命令 `account set-process-from <id> <date>`，把指定账号的 `processFrom` 设为给定日期，使其此前收到的历史积压从摄入与摘要中排除。存量账号在数据库迁移时 `processFrom` 必须默认为 NULL（**禁止**在迁移中回溯改写历史），由运维显式 opt-in。`<id>` 经既有 `JSON.stringify` 转义回显（防控制字符注入）。

`<date>` 的解析与校验必须经**一个共享 helper**，`account add --process-from` 与 `set-process-from` **都**用它（两命令同一脚枪、同一守卫）：解析器**严格**只接受 `^\d{4}-\d{2}-\d{2}$` 形式、经 `new Date(y, m-1, d)` 落**容器时区零点**（进程 `TZ`，部署为 `Asia/Shanghai`——此 `TZ` 是**硬前提**：进程未设 `TZ` 时按容器 OS 时钟解析、退回 UTC 零点 = 旧语义、**静默 no-op**（**非**优雅降级；摘要的 app 级 `?? Asia/Shanghai` 兜底不覆盖 `new Date`），由 `tz-fallback-default` 告警可观测）；**禁止**用 `new Date(str)` 的宽松解析（会放过带时间分量 `…T14:00` 或 `2026-13-99` 这类被强转的串、破坏「容器时区零点」保证）；round-trip 真日期校验按**本地**字段（`getFullYear`/`getMonth`/`getDate`，拒进位归一的 `2026-02-30`）；不匹配 / `Invalid Date` → 用法错误（退出码 2）。**严格未来**（`parsedLocalMidnight.getTime() > now.getTime()`，瞬时比较）→ 用法错误（否则静默排除该日前**所有**邮件含合法新邮件）；判定按瞬时 `>`（非 date-to-date），使**容器时区的今天**（本地零点 ≤ now）不被误拒——消除旧 UTC 口径下「东于 UTC 的时区在 UTC 过零点前盖『今天』被判未来」的坑。

**口径说明**：仅「人类日期串 → 瞬时」这一步按容器时区；`processFrom` 列仍存**绝对瞬时**（`TIMESTAMP(3)`，Prisma 按 UTC 读写），与 `receivedAt`（绝对瞬时）比较 TZ 无关。例：容器 `Asia/Shanghai` 下 `2026-06-24` → 瞬时 `2026-06-23T16:00Z`。

`set-process-from` 是**无条件覆盖**（可双向移动水位线、无单调守卫）：把既有 `processFrom` 改为给定**容器时区零点**日期——若该日期**早于**既有值（如对当日 14:30 接入的账号盖 `<当日>` 的本地零点 00:00），水位线**前移**、会**重新纳入**此前被排除的当日上午邮件。故运维压积压须盖到**接入处理日之后**（见 runbook），而非当日。

#### 场景:运维盖戳存量账号压住历史积压
- **当** 运维对一个有历史积压的存量账号执行 `account set-process-from <id> <今天>`
- **那么** 系统必须把其 `processFrom` 设为该**容器时区**日期的零点瞬时；此后该账号 `receivedAt < processFrom` 的旧邮件不再被摄入、也不再进摘要

#### 场景:迁移默认 NULL 不回溯
- **当** onboarding-watermark 的迁移在已有账号的库上执行
- **那么** 既有账号的 `processFrom` 必须为 NULL（行为不变），**禁止**自动盖戳改写其历史

#### 场景:非法日期被拒绝
- **当** 运维执行 `account set-process-from <id> <不可解析的日期>`（不匹配 `^\d{4}-\d{2}-\d{2}$` / 进位归一的非真日期）
- **那么** 系统必须以用法错误（退出码 2）拒绝，**禁止**静默写入或回落

#### 场景:未来日期在两命令都被拒绝
- **当** 运维执行 `set-process-from <id> <容器时区晚于 now 的日期>` **或** `account add … --process-from <未来日期>`
- **那么** 系统必须经共享 helper 以用法错误（退出码 2）拒绝（防静默排除所有邮件直到该未来日）

#### 场景:容器时区的今天不被误拒
- **当** 运维传 `--process-from <容器时区今天的日期>`（其本地零点 ≤ now）
- **那么** 必须按 `parsedLocalMidnight > now`（瞬时）判为**非未来**、放行；**禁止**因旧 UTC 口径（UTC 零点在 UTC 过零点前 > now）而误拒

### 需求:播种在所有行创建路径，re-auth 必须保留
系统必须在账号**行创建**时为 `processFrom` 种值，且在 re-auth/update 时**保留**既有值。行创建有**两条**路径，都必须播种:
- IMAP 默认 `account add` 走 **`createAccount`**（独立 `.create`，**非** upsert）——必须在此播种；
- Gmail 接入 / 带 `--update` 走 **`upsertAccount` 的 `create` 分支**——在此播种，`update` 分支**不**含该字段（Prisma 语义 = 列不动，re-auth 自动保留）。

种值机制**归 repo 的行创建分支**、`update` 分支一律不动该列（使「seed-on-create / preserve-on-update / 只有 set-process-from 改既有」结构成立、CLI 无需分辨首次 vs re-auth）：create 分支（`createAccount` 与 `upsertAccount.create`）写 `input.processFrom ?? new Date()`——默认是**精确瞬时 `new Date()`**（**非**日期零点；零点解析**仅**用于显式 date-string，且按**容器时区**——见「运维可调整存量账号的水位线」需求；避免默认 seed 凭空提前 ≤24h）；`upsertAccount` 的 `update` 分支**一律不含** `processFrom`（Prisma = 列不动；InMemory 须 **get-before-set**：existing 存在则保留 `existing.processFrom`、**忽略** input，不存在则用 `input.processFrom ?? new Date()`，读必须先于 set）。因此对**既有**账号 `add --process-from` 也**不**改水位线（走 update 被忽略）；**只有 `set-process-from`** 能改既有行。`AccountWriteInput` 新增 `processFrom?` 作播种载体。

#### 场景:IMAP 默认 add 经 createAccount 也播种
- **当** 运维 `account add --imap`（不带 `--update`）经 `createAccount` 创建新行且未给 `--process-from`
- **那么** 新行的 `processFrom` 必须为接入时刻（精确 `new Date()`），**禁止**因只在 upsert 播种而落成 NULL

#### 场景:默认 seed 用精确瞬时、不被抹到日期零点
- **当** 接入未给 `--process-from`
- **那么** `processFrom` 必须为精确 `new Date()` 瞬时；（容器时区）零点解析**仅**作用于显式 date-string

#### 场景:显式覆盖起算日期
- **当** 运维 `account add … --process-from <ISO date>`
- **那么** 新行的 `processFrom` 必须为该日期（解析为**容器时区零点**，经共享 helper、含未来日期拒绝）

#### 场景:re-auth 在两 repo 都不重置水位线
- **当** 一个已存在、`processFrom = T0` 的 Gmail 账号被再次 `account add --gmail`（re-auth）、或 IMAP `--update` 走 `upsertAccount` 的 update 分支
- **那么** `processFrom` **必须**保持 `T0`（Prisma 经省略字段、InMemory 经 get-before-set 忽略 input），**禁止**被重置为 NULL 或 `now()`

#### 场景:对既有账号 add --process-from 不改水位线
- **当** 运维对一个**已存在**账号执行 `account add … --process-from <date>`（走 update 分支）
- **那么** 既有 `processFrom` **必须**不被改动（update 一律忽略 input 的 `processFrom`）；改既有行**只能**经 `set-process-from`
