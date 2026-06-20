# inbox-pilot

无 GUI 的 AI 邮件路由器。接入 **Gmail + IMAP**，定时轮询未读邮件，用
**OpenRouter** 做 AI 分类，按优先级执行通知、标已读、打标签/移动文件夹和每日摘要。

第一版不做邮箱客户端、不做 GUI、不做自动回复，**绝不自动发送邮件**。对重要和风险
邮件保守处理，不误标已读。

## 优先级

| 级别 | 含义 | 默认动作 |
|---|---|---|
| P0 | 有时效/重要性，需立即通知 | 立即推送，不标已读 |
| P1 | 需处理但不必马上打扰 | 入摘要，不标已读 |
| P2 | 有信息价值，适合定时看 | 标已读，入摘要 |
| P3 | 广告/营销/低价值 | 静默标已读，只计数 |
| P4 | 疑似钓鱼/诈骗/支付风险 | 立即推送，不标已读 |

AI 只给建议，最终动作由规则引擎决定；分类失败或低置信度时降级 P1 且不标已读。

## 处理流程

```
cron 轮询未读 → NormalizedEmail → OpenRouter 分类 → 规则引擎兜底
  → 标签/已读动作 → 通知(P0/P4) / 摘要(P1/P2) → 落库去重
```

## 技术栈

Node.js 24 + TypeScript · PostgreSQL 16 + Prisma · imapflow · googleapis ·
OpenRouter（OpenAI 兼容 SDK）· node-cron · zod · pino · fastify。

## 快速开始

P0 必需变量仅 `DATABASE_URL`（须为合法 `postgresql://` / `postgres://` 连接串）；
缺失或 scheme 非法即 fail-fast 退出。`.env.example` 里的后续阶段变量（OPENROUTER /
GMAIL / TELEGRAM / BARK / POLL / DIGEST）P0 可留空。宿主侧命令一律用 `localhost`
形态的 `DATABASE_URL`；docker compose 下 app 容器会自动覆盖为 `@postgres:5432`。

### 一键起（docker compose）

```bash
cp .env.example .env        # P0 只需 DATABASE_URL；其余阶段变量可留空
docker compose up -d        # 起 postgres + inbox-pilot，entrypoint 自动 migrate deploy
curl localhost:3000/health  # 两容器就绪后返 {"status":"ok"}（200）
```

> 若宿主 5432 已被占用，用 `POSTGRES_HOST_PORT` 覆盖 postgres 的宿主端口：
> `POSTGRES_HOST_PORT=55432 docker compose up -d`（app 容器内部仍连 `postgres:5432`，不受影响）。

### 本地开发（宿主直跑）

```bash
nvm use                      # 仓库带 .nvmrc，固定 Node 24（Active LTS）
pnpm install
cp .env.example .env         # 确认 DATABASE_URL 指向本机可达的 postgres（localhost 形态）
docker compose up -d postgres # 仅起 postgres（宿主 5432 被占时加 POSTGRES_HOST_PORT 前缀，并同步改 .env 的端口）
pnpm migrate                  # = prisma migrate dev，建 5 张表
pnpm dev                      # tsx 起服务；或 pnpm build && pnpm start 跑生产 ESM 路径
```

> 完整需求、数据模型、目录结构、分类 Prompt 与验收标准见
> **[PROJECT_INIT.md](./PROJECT_INIT.md)**；开发约定见 **[CLAUDE.md](./CLAUDE.md)**。

## 开发阶段（详见 [ROADMAP.md](./ROADMAP.md)）

- **P0** 项目骨架（服务启动 + DB + docker）
- **P1** 邮件模型 + AI 分类内核（`NormalizedEmail` + OpenRouter 分类，离线可测）
- **P2** 规则引擎 + 处理流水线 + 通知
- **P3** IMAP 端到端
- **P4** Gmail 端到端
- **P5** 每日定时摘要
- **P6** YAML 规则 + 稳定性收尾
