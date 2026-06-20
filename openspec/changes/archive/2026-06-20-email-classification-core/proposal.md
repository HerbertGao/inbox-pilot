# P1 · 邮件模型 + AI 分类内核（email-classification-core）

## 为什么

P0 立起了能启动、连得上库的服务骨架，但还没有任何业务逻辑。整个系统最大的风险
集中在「AI 分类是否稳定、安全」——这必须先做成**离线可测**的内核，再接真实邮箱
（P3/P4）。本期交付两块地基：所有 provider 都要收敛到的统一邮件模型
`NormalizedEmail`，以及给定一封邮件、经 OpenRouter 稳定产出**校验过**的分类结果的
分类器。后续每个 provider 复用同一个模型与同一个分类器，规则引擎（P2）在其输出之上兜底。

## 变更内容

- 定义统一邮件模型 `NormalizedEmail`（PROJECT_INIT §7）与 `src/normalizer/normalizeEmail.ts`：
  把 provider 无关的原始邮件对象收敛为 `NormalizedEmail`，在**单点**强制去重键不变量
  （`accountId`、`providerMessageId` 必填非空）、默认空主题、默认数组字段、统一 header key 大小写。
- 定义 zod `ClassificationSchema`（`src/classifier/schema.ts`，PROJECT_INIT §4.4）：分类输出的唯一合法形状。
- 封装 OpenRouter 客户端（`src/classifier/openrouterClient.ts`）：OpenAI 兼容 SDK，
  `HTTP-Referer`/`X-Title` 头，主模型 + fallback 模型，密钥只从环境变量读，禁止直连其他模型商。
- 实现 `src/classifier/classifyEmail.ts`：从 `NormalizedEmail` 构造**最小化、不外泄正文**的模型输入，
  优先 structured outputs；不支持则退化 JSON mode + zod 校验，解析/校验失败**最多重试一次**；
  彻底失败时返回**安全默认**分类（P1、不标已读、入摘要、低置信度）。
- 安装运行依赖 `openai`（OpenRouter 的 OpenAI 兼容入口）。zod 已在 P0 装好。

## 功能 (Capabilities)

### 新增功能
- `email-model`: 统一邮件模型 `NormalizedEmail` 契约——所有 provider 原始邮件进入分类器前都必须
  经 `normalizeEmail()` 收敛为此模型；在单点强制去重键不变量与字段默认值。
- `email-classification`: AI 分类内核——OpenRouter 唯一入口与鉴权、`ClassificationSchema` 输出校验、
  structured-output 优先且失败退化重试、最小化送模型输入不外泄正文、彻底失败的安全默认。

### 修改功能
<!-- 无需求变更的现有规范，留空 -->

## 影响

- 新增源码：`src/normalizer/normalizeEmail.ts`、`src/classifier/{schema,openrouterClient,classifyEmail}.ts`、`src/classifier/classifyEmail.test.ts`（离线自检）。
- 新增运行期依赖 `openai`（仅指向 OpenRouter base URL）；测试用 stdlib `node:test` + 已装的 `tsx`，**无新测试依赖**；`package.json` 加 `test` 脚本、`tsconfig` exclude `*.test.ts`（不进 `dist`）。
- **扩展 P0 `config` schema**：把 6 个 `OPENROUTER_*` 加入——5 个（`OPENROUTER_BASE_URL`/`OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODEL`/`OPENROUTER_SITE_URL`/`OPENROUTER_APP_NAME`）用 `.default()` 带 §4.1 默认值，**仅 `OPENROUTER_API_KEY` 用裸 `.optional()`**（缺失走安全默认）。带默认的 optional 仍是「可选」，落在 P0 service-bootstrap 规范**已允许**的范围（其要求后续阶段变量「可选或不纳入校验」），故 service-bootstrap 规范需求不变、无需增量规范；logger `redact` 覆盖 `OPENROUTER_API_KEY`。
- `classifyEmail` 是**纯函数**：`NormalizedEmail` → 校验过的 `Classification`（或安全默认），
  不落库、不执行任何动作、不接 provider——这些分别属于 P2（规则引擎 + 流水线 + 落库）与 P3/P4。

## 非目标

- **不实现规则引擎 `applySafetyRules`**——验证码强制 P0、P4 强制不标已读、`confidence<0.65` 降级 P1、
  敏感域名/支付关键词不标已读，全部属于 P2。本期分类器**如实**上报模型给出的 priority 与 confidence，
  **不**根据 confidence 做降级（唯一例外是「彻底失败」的安全默认）。
- 不接任何 provider（IMAP/Gmail）、不做 provider→`NormalizedEmail` 的具体映射（属 P3/P4，届时复用 `normalizeEmail()`）。
- 不把分类结果写入 `mail_classifications`、不执行通知/标已读/打标签、不做摘要（属 P2–P6）。
- 不做附件深度解析、不做线程级语义、不做向量库、不做规则学习。
