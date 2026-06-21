# CLAUDE.md

inbox-pilot：无 GUI 的 AI 邮件路由器后台服务。

权威上下文见：
- **[PROJECT_INIT.md](./PROJECT_INIT.md)** —— 完整需求、数据模型、目录结构、Prompt、验收标准。
- **[openspec/config.yaml](./openspec/config.yaml)** —— 技术栈、约定、安全约束的精简 SOT（OpenSpec 用）。

## 不可违反的硬约束

- 绝不自动发送/回复邮件。
- LLM 只给建议，最终动作由 `applySafetyRules` 规则引擎决定。
- P4 永不自动标已读。敏感邮件（银行/医院/保险/支付/合同/安全）不自动标已读由规则引擎内容轴落地：关键词轴确定性兜底（支付/合同/安全/医院/保险/账单类），类别轴概率性广覆盖（finance/security/transaction）；不依赖域名白名单。残留缺口（未命中关键词且被判非敏感类别者，如纯银行/医院/保险通知）非零、best-effort（不维护域名白名单的取舍；彻底消除需 medical/insurance 类别枚举，超范围）。
- AI 失败或 `confidence < 0.65`：降级 P1、不标已读、入摘要（验证码/P4 等安全强制不被低置信度下调）。
- 所有 provider 原始邮件先转成 `NormalizedEmail` 再进分类器。
- 去重键 `(accountId, providerMessageId)`，重启不重复处理。
- 通知不泄露完整正文；密钥只从环境变量读，不写死。

## 技术栈

Node.js 24 + TypeScript · PostgreSQL 16 + Prisma · imapflow · googleapis ·
OpenRouter（OpenAI 兼容 SDK，禁止直连其他模型商）· node-cron · zod · pino · fastify。
