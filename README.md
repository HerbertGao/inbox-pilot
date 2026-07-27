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

必需变量仅 `DATABASE_URL`（须为合法 `postgresql://` / `postgres://` 连接串）；缺失或
scheme 非法即 fail-fast。`.env.example` 里的其余变量（OPENROUTER / GMAIL / TELEGRAM /
`RULES_FILE` / `TZ`）按需填。`DATABASE_URL` 一律用 `localhost` 形态——postgres 只绑宿主
loopback。

### 部署形态

pilot 由 **hangar** 以原生 node 进程托管（launchd 常驻 daemon 加载 `dist/pipeline.js`），
**不跑在 docker 里**；docker 只剩 `docker-compose.yml` 里的 postgres。轮询与摘要的定时在
仓根 `app.yaml` 的 cron 触发器上。完整部署 / 运维 runbook（三类配置的生效语义、部署一次
代码改动、远程 DB 隧道等）见 **[docs/DEPLOY.md](./docs/DEPLOY.md)**。

### 本地开发（宿主直跑）

```bash
nvm use                       # 仓库带 .nvmrc，固定 Node 24（Active LTS）
pnpm install
cp .env.example .env          # 确认 DATABASE_URL 指向本机可达的 postgres（localhost 形态）
docker compose up -d postgres # 起本地 postgres（宿主 5432 被占时加 POSTGRES_HOST_PORT 前缀，并同步改 .env 的端口）
pnpm migrate                  # = prisma migrate dev，建 5 张表
pnpm test                     # 全量自测
```

> pilot 没有 standalone 服务入口——`run(ctx)` 由 hangar 加载 `dist/pipeline.js` 调用；
> 本地只读预检用 `node dist/cli/inbox-pilot.js doctor`（需先 `pnpm build`）。

> 完整需求、数据模型、目录结构、分类 Prompt 与验收标准见
> **[PROJECT_INIT.md](./PROJECT_INIT.md)**；开发约定见 **[CLAUDE.md](./CLAUDE.md)**。

## 开发阶段（详见 [ROADMAP.md](./ROADMAP.md)）

- **P0** 项目骨架（服务启动 + DB）
- **P1** 邮件模型 + AI 分类内核（`NormalizedEmail` + OpenRouter 分类，离线可测）
- **P2** 规则引擎 + 处理流水线 + 通知
- **P3** IMAP 端到端
- **P4** Gmail 端到端
- **P5** 每日定时摘要
- **P6** YAML 规则 + 稳定性收尾
