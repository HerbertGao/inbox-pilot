# Mail Router MVP 项目初始化文档

> 面向 Claude Code / VibeCoding 的项目初始化说明。  
> 项目定位：一个无 GUI 的 AI 邮件路由器，支持 Gmail + IMAP，使用 OpenRouter 作为唯一 AI 模型入口。

---

## 1. 项目目标

构建一个轻量级后台服务 `inbox-pilot`，用于接入 Gmail 与普通 IMAP 邮箱，对新邮件进行 AI 分类，并根据分类结果执行通知、标记已读、打标签/移动文件夹、定时摘要等动作。

第一版不做完整邮箱客户端，不做 GUI，不做规则学习，不做自动回复。重点是：

- 最少资源运行；
- Gmail + IMAP 同时支持；
- OpenRouter 统一 AI 分类；
- 邮件分流可控、可回放、可审计；
- 绝不自动发送邮件；
- 对重要邮件和风险邮件尽量保守，不误标已读。

---

## 2. MVP 范围

### 2.1 保留功能

- Gmail 邮箱接入；
- IMAP 邮箱接入；
- 新邮件同步；
- 邮件内容规范化；
- OpenRouter AI 分类；
- 基础安全兜底规则；
- Gmail label / IMAP 文件夹或 Seen 标记；
- Telegram / Bark / 飞书机器人推送，至少实现一种；
- 每日定时摘要；
- P3 广告营销邮件静默已读并计数；
- 处理日志与失败重试。

### 2.2 暂缓功能

- GUI 面板；
- 规则学习；
- 向量库；
- MCP Server；
- Outlook / Microsoft Graph；
- 自动写回信；
- 自动发送邮件；
- 附件深度解析；
- 多用户 SaaS；
- 历史邮件全量归档；
- 复杂线程级语义理解。

---

## 3. 推荐技术栈

### 3.1 后端语言

优先使用：

```text
Node.js 24 + TypeScript
```

原因：

- IMAP 生态中 ImapFlow 较成熟；
- Gmail API、定时任务、Webhook、通知集成方便；
- 适合快速 VibeCoding；
- 资源占用低。

### 3.2 核心依赖建议

```text
Runtime: Node.js 24
Language: TypeScript
Database: PostgreSQL 16
ORM: Prisma
IMAP: imapflow
Gmail: googleapis
AI Provider: OpenRouter via OpenAI-compatible SDK or fetch
Scheduler: node-cron
Config: dotenv + yaml
Validation: zod
Logging: pino
HTTP Server: Fastify or Express
```

### 3.3 最小部署

```text
Docker Compose
├── inbox-pilot
└── postgres
```

第一版不强制引入 Redis。任务状态直接落 PostgreSQL。

---

## 4. OpenRouter 集成要求

本项目只通过 OpenRouter 调用 AI 模型，不直接接 OpenAI、Claude、Gemini 等模型商 API。

OpenRouter 提供统一 API，可通过 OpenAI SDK 或直接 HTTP 请求调用模型。OpenRouter 使用 Bearer Token 鉴权，并支持 OpenAI-compatible Chat Completions API。

### 4.1 环境变量

```env
OPENROUTER_API_KEY=sk-or-xxx
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_FALLBACK_MODEL=openai/gpt-4o-mini
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_NAME=inbox-pilot
```

模型名可以先用便宜、速度快、结构化输出稳定的模型。后续可通过 OpenRouter Models API 查询可用模型和价格。

### 4.2 调用方式

建议封装为 `classifier/openrouterClient.ts`。

伪代码：

```ts
import OpenAI from 'openai'

export const openrouter = new OpenAI({
  baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': process.env.OPENROUTER_SITE_URL ?? 'http://localhost:3000',
    'X-Title': process.env.OPENROUTER_APP_NAME ?? 'inbox-pilot',
  },
})
```

### 4.3 结构化输出

分类结果必须使用 JSON Schema 或严格 JSON 输出。优先使用 OpenRouter 支持的 structured outputs；如果模型不支持 JSON Schema，则退化为普通 JSON mode + zod 校验 + 最多一次重试。

目标输出结构：

```json
{
  "priority": "P0",
  "category": "work",
  "should_notify_now": true,
  "should_mark_read": false,
  "should_include_digest": false,
  "confidence": 0.91,
  "reason": "疑似需要及时处理的工作邮件。",
  "risk_flags": []
}
```

### 4.4 分类 Schema

```ts
import { z } from 'zod'

export const ClassificationSchema = z.object({
  priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']),
  category: z.enum([
    'personal',
    'work',
    'finance',
    'system_alert',
    'security',
    'newsletter',
    'marketing',
    'transaction',
    'unknown',
  ]),
  should_notify_now: z.boolean(),
  should_mark_read: z.boolean(),
  should_include_digest: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(120),
  risk_flags: z.array(z.string()),
})
```

---

## 5. 邮件优先级定义

| 优先级 | 含义 | 默认动作 |
|---|---|---|
| P0 | 需要尽快亲自动手处理（明确时效/验证码/需立即响应的确认异常/重要人际往来）；仅「交易、告警、安全字样」或「来自重要公司」不够——例行通知/收据归 P2；账号/登录类安全提醒（登录活动/新设备/应用专用密码/sign-in 复核等「若本人可忽略」者）归 P1/P2，仅确认异常才 P0 | 立即推送，不标已读 |
| P1 | 需要处理，但不必马上打扰 | 加入摘要，不标已读 |
| P2 | 有信息价值，适合定时看（含交易收据、例行通知、账单提醒） | 标已读，加入摘要 |
| P3 | 广告、促销、营销、低价值通知 | 标已读，只统计数量 |
| P4 | 疑似钓鱼/诈骗/伪装身份——需**内容层欺骗证据**（正文诱导按欺骗前提行动）；含冒充上级/财务紧急转账等 BEC（发件人正常、无链接也算）；表层信号（可疑 TLD/截断/未渲染模板/单独 return-path）不单独触发 | 立即推送，不标已读 |

---

## 6. 邮箱接入设计

### 6.1 Gmail

第一版 Gmail 可先使用定时轮询 unread 邮件，后续再升级到 Gmail Push Notifications。

第一版流程：

```text
cron 每 1~5 分钟
  ↓
Gmail API 查询未读邮件
  ↓
获取 message detail
  ↓
转换为 NormalizedEmail
  ↓
AI 分类
  ↓
Gmail modify labels / remove UNREAD
```

Gmail 标签建议：

```text
AI/P0_Important_Now
AI/P1_Later
AI/P2_Digest
AI/P3_Marketing
AI/P4_Risk
AI/Processed
```

动作映射：

| 分类 | Gmail 动作 |
|---|---|
| P0 | 添加 AI/P0_Important_Now，不移除 UNREAD |
| P1 | 添加 AI/P1_Later，不移除 UNREAD |
| P2 | 添加 AI/P2_Digest，移除 UNREAD |
| P3 | 添加 AI/P3_Marketing，移除 UNREAD |
| P4 | 添加 AI/P4_Risk，不移除 UNREAD |

### 6.2 IMAP

第一版使用定时轮询，不强制 IDLE。

流程：

```text
cron 每 1~5 分钟
  ↓
SELECT INBOX
  ↓
SEARCH UNSEEN
  ↓
FETCH envelope + text body
  ↓
转换为 NormalizedEmail
  ↓
AI 分类
  ↓
标记 Seen / 移动到对应文件夹
```

IMAP 文件夹建议：

```text
AI-P0-Important-Now
AI-P1-Later
AI-P2-Digest
AI-P3-Marketing
AI-P4-Risk
```

如果某个邮箱不支持创建文件夹或移动不稳定，则退化为：

- P2/P3 只标记 `\Seen`；
- 所有分类结果保存在本地数据库；
- 不强依赖远端文件夹。

---

## 7. 统一邮件模型

所有 provider 都必须转换为统一结构后再进入分类器。

```ts
export type NormalizedEmail = {
  accountId: string
  provider: 'gmail' | 'imap'

  providerMessageId: string
  providerThreadId?: string
  uid?: number

  messageId?: string
  subject: string
  fromName?: string
  fromEmail: string
  to: string[]
  cc?: string[]

  date: string
  snippet?: string
  textBody?: string
  htmlBody?: string

  hasAttachments: boolean
  headers: Record<string, string>

  mailbox?: string
  labels?: string[]
}
```

---

## 8. 数据库设计

使用 PostgreSQL + Prisma。

### 8.1 mail_accounts

```prisma
model MailAccount {
  id             String   @id @default(cuid())
  provider       String
  email          String
  authJson       Json
  lastSyncCursor String?
  enabled        Boolean  @default(true)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  messages       MailMessage[]
}
```

### 8.2 mail_messages

```prisma
model MailMessage {
  id                String   @id @default(cuid())
  accountId         String
  providerMessageId String
  messageId         String?
  threadId          String?
  uid               Int?
  subject           String
  fromEmail         String
  fromName          String?
  receivedAt        DateTime
  snippet           String?
  bodyText          String?
  bodyHash          String?
  hasAttachments    Boolean  @default(false)
  isRead            Boolean  @default(false)
  processedAt       DateTime?
  createdAt         DateTime @default(now())

  account           MailAccount @relation(fields: [accountId], references: [id])
  classifications   MailClassification[]
  actions           MailAction[]
  digestItems       DigestItem[]

  @@unique([accountId, providerMessageId])
}
```

### 8.3 mail_classifications

```prisma
model MailClassification {
  id          String   @id @default(cuid())
  messageId   String
  priority    String
  category    String
  confidence  Float
  reason      String
  rawAiJson   Json
  createdAt   DateTime @default(now())

  message     MailMessage @relation(fields: [messageId], references: [id])
}
```

### 8.4 mail_actions

```prisma
model MailAction {
  id         String   @id @default(cuid())
  messageId  String
  actionType String
  status     String   @default("pending")
  error      String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  message    MailMessage @relation(fields: [messageId], references: [id])
}
```

### 8.5 digest_items

```prisma
model DigestItem {
  id         String    @id @default(cuid())
  messageId  String
  digestType String
  sentAt     DateTime?
  createdAt  DateTime  @default(now())

  message    MailMessage @relation(fields: [messageId], references: [id])
}
```

---

## 9. 项目目录结构

```text
inbox-pilot/
├── src/
│   ├── accounts/
│   │   └── accountService.ts
│   ├── providers/
│   │   ├── gmail/
│   │   │   ├── gmailClient.ts
│   │   │   ├── gmailPoller.ts
│   │   │   └── gmailActions.ts
│   │   └── imap/
│   │       ├── imapClient.ts
│   │       ├── imapPoller.ts
│   │       └── imapActions.ts
│   ├── normalizer/
│   │   └── normalizeEmail.ts
│   ├── classifier/
│   │   ├── openrouterClient.ts
│   │   ├── classifyEmail.ts
│   │   └── schema.ts
│   ├── rules/
│   │   ├── rules.yaml
│   │   └── applySafetyRules.ts
│   ├── actions/
│   │   ├── executeActions.ts
│   │   └── actionTypes.ts
│   ├── notify/
│   │   ├── telegram.ts
│   │   ├── bark.ts
│   │   └── notifier.ts
│   ├── digest/
│   │   ├── digestScheduler.ts
│   │   └── buildDigest.ts
│   ├── db/
│   │   └── prisma.ts
│   ├── jobs/
│   │   └── scheduler.ts
│   ├── config/
│   │   └── config.ts
│   └── main.ts
├── prisma/
│   └── schema.prisma
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## 10. 核心处理流程

```ts
async function processEmail(email: NormalizedEmail) {
  const existing = await db.mailMessage.findUnique({
    where: {
      accountId_providerMessageId: {
        accountId: email.accountId,
        providerMessageId: email.providerMessageId,
      },
    },
  })

  if (existing?.processedAt) return

  const saved = await saveEmail(email)

  const aiClassification = await classifyEmail(email)

  const finalDecision = applySafetyRules(email, aiClassification)

  await saveClassification(saved.id, finalDecision)

  await executeActions(email, finalDecision)

  await markProcessed(saved.id)
}
```

---

## 11. 分类 Prompt

```text
你是一个邮件分流器。请根据邮件内容判断处理优先级。

只能输出 JSON，不要输出解释性文本。

优先级定义（拿不准时往低判：宁可进摘要，不要误推送）：
P0: 需要你「尽快亲自动手处理」的事——明确时效性、验证码、需立即响应的确认异常、重要人际/面试/合同的实质往来。仅「来自重要公司」或「含交易、告警、安全字样」不够：交易收据、发货物流、例行系统告警、对账单等通知类归 P2。**账号/登录类安全提醒——登录活动、新设备登录、应用专用密码创建或移除、sign-in 复核等「若为本人操作可忽略」的例行信息性通知——归 P1/P2，不要仅因「安全/登录/可能有人在使用您的账号/password may be compromised」字样就判 P0；仅当邮件指出需你立即处置的确认异常（已确认盗用、账号被锁定、要求立即重置）才 P0。** 注：以上只是「不为 P0」；若正文含欺骗诱导你点链接/转账/交出密码或验证码，则仍按 P4（见下）。
P1: 需要你处理，但不必马上打扰。
P2: 有信息价值、适合定时摘要（含交易收据、例行通知、账单提醒等）。
P3: 广告、营销、促销、低价值通知，可静默已读，只统计数量。
P4: 疑似钓鱼、诈骗、伪装身份——需**内容层欺骗证据**：正文在诱导你按欺骗前提行动（如冒充身份诱导点链接、转账、交出验证码/密码）。**冒充上级/同事/财务/客服，以紧急、保密或绕开常规流程为由，诱导你转账、付款、改收款账户或提供账号/验证码（商业邮件诈骗 BEC）——即使发件人地址看似正常、正文无可疑链接，也必须归 P4**：这类欺骗全在内容、表层无破绽，正是收紧后最易漏判的一类。仅有表层信号**不**单独构成 P4——可疑 TLD（如 .xyz）、文本截断、未渲染的模板变量、return-path 单独异常（尤其命中自有转发域）——这些不算欺骗证据，按正文真实意图归 P1/P2。

安全要求：
- 真钓鱼 / 内容层欺骗**仍必须归 P4**（收紧的是触发条件、不是放弃 P4）。判 P4 看正文是否在实施欺骗，不看表层格式异常。
- 银行、医院、保险、合同、招聘、账单类邮件不要轻易标记为 P3。
- 置信度低于 0.65 时，不要建议自动标已读。
- 不要建议自动回复或自动发送邮件。

输出格式：
{
  "priority": "P0|P1|P2|P3|P4",
  "category": "personal|work|finance|system_alert|security|newsletter|marketing|transaction|unknown",
  "should_notify_now": true,
  "should_mark_read": false,
  "should_include_digest": true,
  "confidence": 0.0,
  "reason": "不超过80字",
  "risk_flags": []
}
```

> 注：以上 prompt 为 `src/classifier/prompt.ts` 的镜像，经 `rating-calibration-prompt` 收紧（P4 需内容层欺骗证据、表层信号不单独触发；P0 去「交易/告警」一刀切、收据归 P2）；以 `prompt.ts` 为实现权威。

发送给模型的邮件内容只包含必要字段：

```ts
const input = {
  from: email.fromEmail,
  fromName: email.fromName,
  subject: email.subject,
  date: email.date,
  snippet: email.snippet,
  textBody: truncate(email.textBody, 6000),
  headers: pickUsefulHeaders(email.headers),
  hasAttachments: email.hasAttachments,
}
```

---

## 12. 安全兜底规则

规则引擎必须在 AI 分类之后执行。AI 只给建议，代码决定最终动作。

### 12.1 固定规则

```ts
if (subjectContainsVerificationCode(email)) {
  forcePriority('P0')
  forceNotifyNow()
  forceDoNotMarkRead()
}

if (classification.priority === 'P4') {
  forceNotifyNow()
  forceDoNotMarkRead()
}

if (classification.confidence < 0.65) {
  // 注：验证码(P0)/P4(风险) 等安全强制不被 confidence<0.65 下调（见 safety-rules 规范的安全细化）——本伪码仅为顺序示意。
  forcePriority('P1')
  forceDoNotMarkRead()
  includeDigest()
}

if (isSensitiveDomain(email.fromEmail)) {
  forceDoNotMarkRead()
}

if (hasPaymentOrSecurityKeywords(email)) {
  forceDoNotMarkRead()
}
```

### 12.2 YAML 规则配置

```yaml
vip_senders:
  - boss@example.com
  - family@example.com

important_domains:
  - bank.com
  - github.com
  - apple.com

marketing_keywords:
  - 优惠
  - 折扣
  - sale
  - promotion
  - coupon

never_mark_read_domains:
  - bank.com
  - hospital.com
  - insurance.com

security_keywords:
  - 验证码
  - verification code
  - password reset
  - suspicious login
  - unusual activity
  - invoice
  - payment
  - contract

digest_times:
  - "12:30"
  - "21:30"
```

---

## 13. 通知策略

### 13.1 即时推送

P0 和 P4 立即推送。

格式：

```text
[P0 邮件] {subject}
发件人：{fromName} <{fromEmail}>
原因：{reason}
分类：{category}
置信度：{confidence}
```

P4 格式：

```text
[P4 风险邮件] {subject}
发件人：{fromName} <{fromEmail}>
风险：{risk_flags}
原因：{reason}
不要点击链接，请直接进入官网或邮箱客户端核验。
```

### 13.2 定时摘要

每天 12:30 和 21:30 发送摘要。

摘要结构：

```text
今日邮件摘要

P1 待处理：3 封
1. 发件人 - 主题 - 原因
2. 发件人 - 主题 - 原因

P2 订阅/通知：8 封
- GitHub 3 封
- Newsletter 5 封

P3 广告营销：26 封，已静默标记已读
```

---

## 14. Docker Compose

```yaml
version: "3.9"

services:
  inbox-pilot:
    build: .
    container_name: inbox-pilot
    env_file:
      - .env
    depends_on:
      - postgres
    restart: unless-stopped

  postgres:
    image: postgres:16
    container_name: inbox-pilot-postgres
    environment:
      POSTGRES_DB: mail_router
      POSTGRES_USER: mail_router
      POSTGRES_PASSWORD: mail_router_password
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
    ports:
      - "5432:5432"
    restart: unless-stopped
```

---

## 15. .env.example

```env
NODE_ENV=development
DATABASE_URL=postgresql://mail_router:mail_router_password@postgres:5432/mail_router

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_FALLBACK_MODEL=openai/gpt-4o-mini
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_NAME=inbox-pilot

GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REDIRECT_URI=http://127.0.0.1/oauth2/callback

TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

BARK_ENDPOINT=

POLL_INTERVAL_SECONDS=180
DIGEST_TIMES=12:30,21:30
```

---

## 16. 开发阶段拆分

### Phase 1：IMAP 跑通

目标：最快看到效果。

- 配置 IMAP 账号；
- 拉取 INBOX 未读邮件；
- 保存数据库；
- OpenRouter 分类；
- P2/P3 标记已读；
- P0/P4 推送；
- 保存 actions 日志。

### Phase 2：Gmail 轮询

- Gmail OAuth；
- 查询 unread 邮件；
- 创建 AI 标签；
- classify；
- add label / remove UNREAD；
- 保存处理日志。

### Phase 3：定时摘要

- 查询当天 P1/P2/P3；
- P1/P2 列出邮件；
- P3 只计数；
- 通过通知渠道发送。

### Phase 4：规则 YAML

- 加载 rules.yaml；
- VIP 发件人；
- important domains；
- never mark read domains；
- security keywords；
- marketing keywords。

### Phase 5：稳定性

- 失败重试；
- 重复邮件去重；
- OpenRouter 超时处理；
- AI JSON 解析失败重试一次；
- 单账号同步互斥锁；
- 日志结构化。

---

## 17. Claude Code 执行建议

### 17.1 初始化命令

```bash
mkdir inbox-pilot
cd inbox-pilot
pnpm init
pnpm add typescript tsx dotenv zod pino yaml node-cron prisma @prisma/client imapflow googleapis openai fastify
pnpm add -D @types/node
npx prisma init
```

### 17.2 优先生成顺序

Claude Code 应按以下顺序生成代码：

1. `package.json`、`tsconfig.json`、`.env.example`；
2. Prisma schema；
3. `src/config/config.ts`；
4. `src/db/prisma.ts`；
5. `src/classifier/schema.ts`；
6. `src/classifier/openrouterClient.ts`；
7. `src/classifier/classifyEmail.ts`；
8. `src/normalizer/normalizeEmail.ts`；
9. `src/rules/applySafetyRules.ts`；
10. `src/notify/notifier.ts`；
11. `src/providers/imap/imapPoller.ts`；
12. `src/providers/gmail/gmailPoller.ts`；
13. `src/actions/executeActions.ts`；
14. `src/digest/buildDigest.ts`；
15. `src/jobs/scheduler.ts`；
16. `src/main.ts`；
17. docker-compose.yml（现只剩 postgres 一个服务；app 已改由 hangar 原生托管，见 docs/DEPLOY.md）；
18. README。

### 17.3 重要约束

- 不要实现 GUI；
- 不要实现自动发送邮件；
- 不要在推送里泄露完整邮件正文；
- 不要把 OpenRouter API Key 写死；
- 不要让 LLM 直接决定最终动作，必须经过规则引擎；
- AI 分类失败时，默认 P1，不标已读；
- P4 永远不自动标已读；
- 银行、医院、保险、支付、合同类邮件默认不自动标已读（实现细化见 safety-rules 规范：关键词轴确定性兜底 支付/合同/安全/医院/保险/账单类 + 类别轴概率性广覆盖 finance/security/transaction；残留缺口——未命中关键词且被判非敏感类别者，如纯银行/医院/保险通知——非零、best-effort（不维护域名白名单的取舍；彻底消除需 medical/insurance 类别枚举，超范围），不再要求维护域名白名单）；
- 所有 provider 原始邮件必须先转换成 `NormalizedEmail`；
- 处理过的邮件必须通过 `(accountId, providerMessageId)` 去重。

---

## 18. 后续扩展方向

### 18.1 GUI 面板

后续只需读取数据库：

- `mail_messages`；
- `mail_classifications`；
- `mail_actions`；
- `digest_items`。

可做成：

- 今日决策流；
- 误判反馈；
- 规则配置；
- 模型调用成本统计。

### 18.2 规则学习

后续基于用户反馈生成规则建议：

- 某发件人连续 5 次被改为 P3，建议加入营销发件人；
- 某域名连续被提升为 P1，建议加入 important_domains；
- 某关键词频繁出现在 P0，建议加入 security 或 VIP 规则。

### 18.3 MCP Server

后续暴露受限工具给 Agent：

```text
list_important_emails
summarize_digest
mark_as_read
create_reply_draft
```

禁止自动发送邮件。

---

## 19. 验收标准

MVP 完成时应满足：

- 可以添加至少一个 IMAP 账号；
- 可以添加至少一个 Gmail 账号；
- 能周期性处理未读新邮件；
- 能调用 OpenRouter 完成 JSON 分类；
- P0/P4 能即时推送；
- P2/P3 能静默标记已读；
- P3 广告营销能按数量汇总；
- P1/P2 能进入每日摘要；
- 所有处理记录可在数据库中查询；
- AI 失败或置信度低时不会自动标已读；
- 重启服务后不会重复处理已处理邮件。

---

## 20. 参考资料

- OpenRouter Quickstart: https://openrouter.ai/docs/quickstart
- OpenRouter Chat Completion API: https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request
- OpenRouter Structured Outputs: https://openrouter.ai/docs/guides/features/structured-outputs
- OpenRouter Authentication: https://openrouter.ai/docs/api/reference/authentication
- OpenRouter Models API: https://openrouter.ai/docs/api/api-reference/models/get-models
- Gmail Push Notifications: https://developers.google.com/workspace/gmail/api/guides/push
- Gmail Modify Message: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify
- Gmail Labels: https://developers.google.com/workspace/gmail/api/guides/labels
- ImapFlow Docs: https://imapflow.com/docs/
