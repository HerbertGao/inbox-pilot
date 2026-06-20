## 0. 约束（贯穿全程）

- [x] 0.1 ESM/NodeNext：src/ 内所有相对 import 必须带 `.js` 扩展名（否则 `node dist/main.js` 报错）
- [x] 0.2 密钥（含 `DATABASE_URL`）只从环境变量读，禁止写死；日志禁止明文密钥/连接串/未脱敏 Prisma 错误

## 1. 工程初始化

- [x] 1.1 `pnpm init`，写 `package.json`：ESM（`"type": "module"`）、scripts（`dev` 用 tsx、`build` 用 tsc、`start` 跑 `node dist/main.js`、`postinstall: prisma generate`、`migrate`/`migrate:deploy`）
- [x] 1.2 安装运行依赖：`@prisma/client fastify pino zod dotenv`；开发依赖：`typescript tsx prisma @types/node`。**不**装 yaml/node-cron/imapflow/googleapis/openai（由 P1–P6 各自安装）。注：prisma CLI 虽是 devDep，runtime 镜像须保留它（见 5.1）
- [x] 1.3 写 `tsconfig.json`：`module: NodeNext`、`target: ES2022`、`strict: true`、`outDir: dist`、`rootDir: src`
- [x] 1.4 写 `.env.example`：默认 `DATABASE_URL=postgresql://...@localhost:5432/...`（宿主侧 dev/migrate 用，宿主命令一律用 localhost 形态），注释标明 compose 下由 app 服务覆盖为 `@postgres:5432`；后续阶段变量（OPENROUTER/GMAIL/TELEGRAM/BARK/POLL/DIGEST）作为留空占位、注明 P0 可选

## 2. 配置与日志

- [x] 2.1 `src/config/config.ts`：zod 校验。必需集仅 `DATABASE_URL`（无默认，`z.string().url()` 且 scheme 为 `postgresql://`/`postgres://`）；`NODE_ENV`/`HOST`(默认 `0.0.0.0`)/`PORT`(默认 `3000`，`z.coerce.number()`) 带默认；后续阶段变量 optional 不纳入校验（zod object 用非 strict 解析，容忍 `.env` 里未知/后续阶段键，避免 shipped `.env.example` 因多余键 fail-fast）。失败打印错误并 `process.exit(1)`，导出冻结的 typed config
- [x] 2.2 `src/logger.ts`：pino 实例，JSON 输出，配置 `redact`（`DATABASE_URL`、`*_API_KEY`、`*.password`），禁止打印原始 config 对象，禁止把原始连接串或未脱敏 Prisma 错误写入日志
- [x] 2.3 验证：缺 `DATABASE_URL` → 非零退出且报明确错误；仅给 `DATABASE_URL`（无任何 provider/AI 密钥）→ 能启动（对应 spec「缺失必需变量时拒绝启动」「仅提供最小变量即可启动」）

## 3. 数据库

- [x] 3.1 `npx prisma init`，`prisma/schema.prisma` 照搬 PROJECT_INIT §8 的 5 个 model，**为每个 model 加 `@@map("snake_case")`**（mail_accounts/mail_messages/mail_classifications/mail_actions/digest_items），保留 `@@unique([accountId, providerMessageId])` 及 §8 的 4 个外键关系（字段/列名沿用 camelCase、不加 `@map`）
- [x] 3.2 `src/db/prisma.ts`：单例 PrismaClient（globalThis 缓存），惰性连接——启动时不调用 `$connect()`
- [x] 3.3 生成首次 migration（`prisma migrate dev`，本地连 localhost），确认 5 张 snake_case 表、`(accountId, providerMessageId)` 唯一键、§8 的外键关系均建立（对应 spec「执行首次迁移」）

## 4. HTTP 服务与健康检查

- [x] 4.1 `src/main.ts`：启动最早处调用 config 校验；fastify `listen({ host: config.HOST, port: config.PORT })`（容器内 `0.0.0.0`）
- [x] 4.2 `GET /health`：`prisma.$queryRaw SELECT 1` 包一层超时（~2–3s，`Promise.race`），连通返 200，不可达/查询出错/超时返 503（禁止挂起；对应 spec 两个 /health 场景）
- [x] 4.3 监听 SIGTERM/SIGINT：best-effort 关闭 fastify 与 `prisma.$disconnect()`（entrypoint 用 `exec` 使信号直达 node）。P0 不强求 drain；`kill -TERM` 干净退出的验证为可选项
- [x] 4.4 验证：本地 `pnpm dev`（用 localhost 的 `DATABASE_URL`，需本地或已发布的 postgres）起服务，`curl /health` 返 200

## 5. 容器化

- [x] 5.1 `Dockerfile`：Node 22 多阶段（install → build → run），各阶段设 `WORKDIR /app`（使 entrypoint 的 `node_modules/.bin/prisma` 相对路径可解析），**build 与 run 阶段用同一 base image flavor**（如同为 `node:22-bookworm-slim`，避免 Prisma engine libc 不匹配）。install 用 `pnpm install --ignore-scripts`；build 阶段 copy `prisma/schema.prisma` 后显式 `prisma generate` 再 copy `src/` 并 `tsc`；**run 阶段复用 build 的 `node_modules`（含 prisma CLI）+ `dist/` + `prisma/`（schema + migrations），不做 `--prod` 重装**；entrypoint 必须为**单条 shell 形式**（`ENTRYPOINT ["sh","-c","set -e; node_modules/.bin/prisma migrate deploy; exec node dist/main.js"]`，**不可**拆成独立 ENTRYPOINT+CMD，否则 `set -e` 失效）——迁移失败即非零退出，**不加 `until pg_isready`**
- [x] 5.2 `docker-compose.yml`（不写 `version:` 键）：postgres:16 配 `healthcheck: pg_isready -U mail_router -d mail_router`（用 §14 的实际用户/库名，带 `start_period`/`retries` 覆盖首次 initdb）；app `depends_on: condition: service_healthy`、`restart: unless-stopped`、发布 `3000:3000`、以环境变量把 `DATABASE_URL` 覆盖为 `@postgres:5432`；postgres 发布 `5432:5432` 供宿主侧 migrate/dev；挂载 `./data/postgres`。显式替代 §14 的裸 `depends_on`
- [x] 5.3 验证：`docker compose up` → 两容器 running（非 restarting）、迁移成功（`prisma migrate status` clean）、5 张表存在、从宿主 `curl localhost:3000/health` 返 200（对应 spec「一键启动」「迁移失败时不以半启动状态对外服务」）。注：非 detached 下持续滚动的 restart 日志即迁移失败信号

## 6. 收尾

- [x] 6.1 README「快速开始」对齐真实命令（脚本名、迁移命令、宿主用 localhost 的 DATABASE_URL）
- [x] 6.2 自检：`pnpm build` 通过 **且** `node dist/main.js`（生产 ESM 路径）能起来并 `/health` 200；`docker compose up` 验收（两容器 running / 迁移成功 / 5 表 / 宿主 /health 200）全过
