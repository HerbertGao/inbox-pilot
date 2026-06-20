## 上下文

仓库目前只有文档（PROJECT_INIT、README、ROADMAP）。P0 要立起一个可运行的服务骨架，
作为 P1–P6 的共同地基。技术栈已定（见 config.yaml）：Node 22 + TS + Prisma + fastify +
pino + zod，docker-compose 跑 inbox-pilot + postgres。本期不含任何业务逻辑。

## 目标 / 非目标

**目标：**
- 工程可 `pnpm dev` 本地启动、`docker compose up` 容器启动，且 `/health` 从宿主可达。
- 环境配置经 zod 校验、fail-fast；P0 仅必需 `DATABASE_URL`。
- 5 张表的 Prisma schema + 首次 migration 可执行。
- `/health` 反映存活 + DB 连通性（liveness）。
- 结构化日志（脱敏）、单例 Prisma 客户端。

**非目标：**
- 任何 provider / 分类 / 规则 / 通知 / 摘要 / 调度逻辑。
- 鉴权、就绪度细分探针、指标/追踪。
- `/health` 不校验 schema 完整性或业务就绪。

## 决策

- **模块系统：ESM + NodeNext**。Node 22 原生 ESM，新依赖（后续 openai SDK 等）ESM 优先。
  `tsconfig` 用 `module: NodeNext`。**约束：src/ 内相对 import 必须带 `.js` 扩展名**，否则
  `tsc` 通过但 `node dist/main.js` 报 module-not-found。开发用 `tsx` 直跑 TS，生产 `tsc` 产出 `dist/`。
- **配置加载：单文件 `config.ts` 用 zod**，进程启动最早处调用，失败 `process.exit(1)`，导出冻结的
  typed config。**P0 必需集仅 `DATABASE_URL`**（无默认，用 `z.string().url()` + scheme 必须为 `postgresql://`/`postgres://` 校验，挡掉合法但非 postgres 的 URL）；
  `NODE_ENV`/`HOST`(默认 `0.0.0.0`)/`PORT`(默认 `3000`，用 `z.coerce.number()`) 带默认；后续阶段变量
  （`OPENROUTER_*`/`GMAIL_*`/`TELEGRAM_*`/`BARK_*`/`POLL_*`/`DIGEST_*`）一律 optional、不纳入 P0 校验
  ——否则 shipped `.env.example`（这些键留空）将无法启动。
- **HTTP 监听**：fastify `listen({ host: HOST, port: PORT })`，容器内 `HOST=0.0.0.0`；compose 发布
  `3000:3000` 使宿主可验证 `/health`。
- **Prisma 表名：为 5 个 model 加 `@@map("snake_case")`**（mail_accounts 等），物理表名与文档/工具一致；
  字段沿用 §8 的 camelCase（列名默认、不加 `@map`，`@@unique([accountId, providerMessageId])` 按字段名引用，
  列名与字段名一致、无错配）。这是对 §8「照搬」的一处显式增补（§8 未写 `@@map`，默认会生成 PascalCase 表名）。
  保留 §8 的 4 个外键关系。
- **Prisma 客户端：单例 + 惰性连接**。globalThis 缓存避免 dev 热重载泄漏连接；**启动时不调用
  `$connect()`**，连接在首次查询时惰性建立——使服务启动不依赖数据库可达性（DB 暂时不可达时仍能起来，
  状态只通过 `/health` 反映）。
- **构建顺序（Docker）**：`pnpm install --ignore-scripts`（避免 `postinstall` 在 schema 拷入前触发）
  → copy `prisma/schema.prisma` → 显式 `prisma generate` → copy `src/` → `tsc`。package.json 仍保留
  `postinstall: prisma generate` 供本地（本地 schema 一直在）。
- **运行期 prisma CLI**：runtime 阶段不做 `--prod` 重装（会丢掉 devDep 的 prisma CLI），而是复用 build
  阶段的 `node_modules`（含 prisma CLI）+ `dist/` + `prisma/`（schema + migrations）；entrypoint 用
  `node_modules/.bin/prisma migrate deploy`。**build 与 run 阶段必须用同一 Node 22 base image flavor**
  （如同为 `node:22-bookworm-slim`）——`prisma generate` 产出的 query/migration engine 是 libc 相关的
  （musl vs glibc），跨 flavor 复用会在 run 阶段加载失败；若日后要跨平台再给 schema generator 加
  `binaryTargets`。
  <!-- ponytail: 复用整个 node_modules 会把 typescript/tsx 等 devDep 带进运行镜像（体积偏大）。
       这是 P0 的有意取舍（避免 --prod 丢失 prisma CLI 的坑）；镜像瘦身留作 P-later 优化，现在不做。 -->
- **迁移执行：不在应用启动时自动 migrate**。容器 entrypoint `set -e; node_modules/.bin/prisma
  migrate deploy; exec node dist/main.js`——迁移失败则容器非零退出（crash-loop），绝不在未迁移库上启动。
  本地用 `prisma migrate dev`。理由：应用进程不该悄悄改库结构，迁移是显式部署步骤。
- **DB 就绪**：compose 用 postgres `healthcheck: pg_isready -U <user> -d <db>`（带足够 `retries` /
  `start_period` 覆盖首次 initdb）+ app `depends_on: condition: service_healthy`。**不在 app 容器里加
  `until pg_isready` 等待**——app 镜像没有 pg 客户端二进制，且无界 `until` 会挂死；service_healthy 已
  保证 postgres 就绪后才启 app，残余的瞬时竞态由 `restart: unless-stopped` 兜底（migrate 偶发失败 →
  crash-loop 重试直到成功）。此 compose 形态显式替代 §14 的裸 `depends_on`。
- **DATABASE_URL 双形态**：`.env`/`.env.example` 默认 `localhost:5432`（宿主侧 `pnpm dev` 与
  `prisma migrate dev` 用，**显式覆盖 §15 的 `@postgres` 默认形态**，理由同 `@@map` 对 §8 的增补）；
  compose 发布 postgres `5432:5432` 作为宿主桥接，并对 app 服务以环境变量覆盖 `DATABASE_URL` 为
  `postgres:5432`（容器内 DNS）。约定：宿主命令一律用 localhost 形态。
- **/health 探测：`prisma.$queryRaw SELECT 1` 加超时**（~2–3s，`Promise.race`），DB 不可达或查询出错
  返 503，禁止挂起（注：`Promise.race` 只取消等待，不真正中断底层查询/连接池取用，可接受）。liveness only，
  不保证 schema 已迁移——up + /health 200 不等于 ready，ready 由「迁移成功 + 5 表存在」单独验收。
- **日志脱敏**：pino `redact` 覆盖 `DATABASE_URL`/`*_API_KEY`/`*.password`，禁止打印原始 config 对象；
  并禁止把原始连接串或未脱敏的 Prisma 错误（可能内嵌口令）写日志（key-based redact 清洗不了字符串内嵌口令）。
- **依赖：P0 只装 P0 用得到的**（`@prisma/client fastify pino zod dotenv` + dev `typescript tsx
  prisma @types/node`）。§17.1 列的 `yaml/node-cron/imapflow/googleapis/openai` 由各自所属阶段
  （P1–P6）安装，不在 P0 提前装——避免装而不用的依赖。
- **优雅关闭**：监听 SIGTERM/SIGINT，best-effort 关闭 fastify 与 `prisma.$disconnect()`（为后续
  poller/cron 留钩子）。P0 无在途业务，不强求 drain 语义；entrypoint 用 `exec` 使信号直达 node。

## 风险 / 权衡

- [ESM + Prisma/CJS 依赖互操作] → 用 NodeNext 标准互操作 + `.js` 扩展名约束；P0 验收必须跑
  `node dist/main.js`（生产 ESM 路径）而非仅 `tsx dev`，确保生成的 client 在 ESM 下可导入。
  **残留风险（forward-fragility，已知不在 P0 可证范围）**：openai/googleapis/imapflow 等 SDK 的
  ESM 互操作要到 P1 真正引入时才能完全验证；P0 只能证明 Prisma + 自有代码在 ESM 下可跑。
- [postgres 首次 initdb 期间 healthcheck 抖动] → healthcheck 配 `start_period` + `retries`，
  service_healthy 仅在真正可连后放行；瞬时竞态由 restart 兜底。
- [`/health` `SELECT 1` 轻微 DB 压力] → 可接受；如需再加缓存窗口（先不做，YAGNI）。
