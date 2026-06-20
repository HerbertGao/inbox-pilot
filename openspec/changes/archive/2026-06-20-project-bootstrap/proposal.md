# P0 · 项目骨架（project-bootstrap）

## 为什么

仓库目前只有文档，没有可运行的代码。后续所有功能（分类、规则、provider、摘要）
都需要一个能启动、连得上数据库、跑得起容器的服务骨架作为地基。先把地基立稳，
后面每一期都能在同一条流水线和数据模型上叠加。

## 变更内容

- 初始化 Node.js 22 + TypeScript 工程（`package.json`、`tsconfig.json`、pnpm 依赖）。
- 引入 zod 校验的环境配置加载（`src/config/config.ts`），密钥只从环境变量读。
- 落地 Prisma 数据模型与首次 migration（PROJECT_INIT §8 的 5 张表），单例 Prisma 客户端（`src/db/prisma.ts`）。
- 接入结构化日志 pino。
- 提供最小 fastify 服务与 `/health` 健康检查（`src/main.ts`）。
- 提供 `Dockerfile` 与 `docker-compose.yml`（inbox-pilot + postgres，无 Redis）。
- 提供 `.env.example`。

## 功能 (Capabilities)

### 新增功能
- `service-bootstrap`: 服务启动与运行底座——环境配置校验、数据库连接与迁移、
  健康检查端点、结构化日志、容器化运行。

### 修改功能
<!-- 无现有规范，留空 -->

## 影响

- 新增源码目录 `src/`（config、db、main）与 `prisma/`。
- 新增 `package.json`、`tsconfig.json`、`Dockerfile`、`docker-compose.yml`、`.env.example`。
- 引入运行期依赖：`@prisma/client`、`fastify`、`pino`、`zod`、`dotenv`；开发依赖：`typescript`、`tsx`、`prisma`、`@types/node`。这是 PROJECT_INIT §17.1 的**有意 P0 子集**——`yaml`、`node-cron`、`imapflow`、`googleapis`、`openai` 由各自所属阶段（P1–P6）安装，P0 不提前装。
- 服务监听 `HOST`(默认 `0.0.0.0`)`:PORT`(默认 `3000`)，docker-compose 发布该端口供宿主访问。
- 不触及任何邮件 provider、分类器或通知逻辑（后续期处理）。

## 非目标

- 不实现任何邮箱接入（IMAP / Gmail）、AI 分类、规则引擎、通知或摘要——分别属于 P1–P6。
- 不实现 GUI、账号管理 UI、认证授权。
- `/health` 只做存活与 DB 连通性检查，不做业务就绪度探测。
