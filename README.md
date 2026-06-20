# mail-router

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

Node.js 22 + TypeScript · PostgreSQL 16 + Prisma · imapflow · googleapis ·
OpenRouter（OpenAI 兼容 SDK）· node-cron · zod · pino · fastify。

## 快速开始

```bash
pnpm install
cp .env.example .env        # 填 OPENROUTER_API_KEY、DATABASE_URL、通知渠道等
docker compose up -d postgres
npx prisma migrate dev
pnpm dev
```

> 项目脚手架尚未生成。完整需求、数据模型、目录结构、分类 Prompt 与验收标准见
> **[PROJECT_INIT.md](./PROJECT_INIT.md)**；开发约定见 **[CLAUDE.md](./CLAUDE.md)**。

## 开发阶段

1. IMAP 跑通（拉取未读 → 分类 → 标已读 → 推送）
2. Gmail 轮询（OAuth → 标签 → 去 UNREAD）
3. 每日定时摘要
4. YAML 规则（VIP / 重要域名 / 永不标已读 / 关键词）
5. 稳定性（重试、去重、超时、互斥锁、结构化日志）
