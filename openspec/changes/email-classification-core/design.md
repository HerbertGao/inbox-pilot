## 上下文

P0 已落地服务骨架（config/zod、Prisma 5 表、fastify `/health`、pino、docker）。本期（ROADMAP P1）
做系统最大风险点的**离线可测**内核：统一邮件模型 `NormalizedEmail` 与 AI 分类器。技术栈已定
（见 config.yaml）：Node 24 + TS（ESM/NodeNext）+ zod 4 + OpenRouter（OpenAI 兼容 SDK）。本期不接
provider、不落库、不执行任何动作——这些在 P2–P6。规则引擎（applySafetyRules）是 P2，本期分类器
只产出**建议**，不做强制裁定（唯一例外是「彻底失败」的安全默认）。

## 目标 / 非目标

**目标：**
- `NormalizedEmail` 类型 + `normalizeEmail()`：provider 无关的原始邮件 → 统一模型，单点强制去重键不变量。
- `ClassificationSchema`（zod）：分类输出的唯一合法形状。
- `openrouterClient`：OpenAI 兼容 SDK 指向 OpenRouter，带 `HTTP-Referer`/`X-Title`，主 + fallback 模型。
- `classifyEmail`：纯函数 `NormalizedEmail` → 校验过的 `Classification`；structured-output 优先、失败退化
  JSON mode + zod、非法重试一次、主模型不可用回退 fallback、彻底失败返回安全默认（P1/不标已读/入摘要）。
- **离线可测**：模型调用置于一个可注入的 seam 之后，fixture 测试无需联网即可覆盖三条验收。

**非目标：**
- 规则引擎、动作执行、通知、摘要、落库、provider 接入、附件深解析（P2–P6）。
- 不据 confidence 做降级（那是 P2 规则引擎）；本期如实上报模型的 priority/confidence。

## 决策

- **`NormalizedEmail` 为纯 TS 类型 + `normalizeEmail(raw)` 单点收敛**。所有 provider（P3/P4）都经此函数，
  在**一处**强制不变量：`accountId`/`providerMessageId` 缺失即 `throw`（fail-fast，杜绝空去重键流入下游）；
  `subject` 空→`(无主题)`；`to`/`cc`/`labels`→`[]`；`hasAttachments`→`false`；header key 统一 `toLowerCase()`。
  *备选*：在分类器里各自校验——否决，会散落多点、易漏；单点收敛是去重正确性的唯一可信保证。
  *本期无 provider*：`normalizeEmail` 的入参是「provider 无关的 raw 公共形状」，由 fixture 驱动测试；
  具体 gmail/imap→raw 的映射放 P3/P4，届时只需 `normalizeEmail(buildRaw(providerMsg))`。

- **`classifyEmail` 是纯函数，模型调用置于可注入 seam**。签名约 `classifyEmail(email, deps?)`，`deps.chat`
  默认为真实 OpenRouter 调用，测试注入假实现返回 canned 响应（合法 / 先非法后合法 / 恒非法）。
  *备选*：直接在函数里 `new OpenAI()` 调用——否决，无法离线测三条验收（fixture 分类 / 非法 JSON 重试 / 失败默认）。
  用一个可选注入函数即可，不引入 class/interface（避免单实现的抽象）。

- **输出健壮性：单次重试、≤2 次模型调用的确定性状态机**（取代原先「≤2 调用 + 1 fallback」的模糊表述——review 指出两个重试机制叠加会产生 2/3/4 次的歧义，且与 §4.3「最多一次重试」冲突）。**按第 1 次的失败类别分流，两条重试路径共用一个全局计数器、硬上限 2 次**：

  | 第1次(主模型, json_schema)结果 | 分类 | 第2次 | 上限 |
  |---|---|---|---|
  | 解析通过且过 zod | 成功 | —（采用） | 1 |
  | 401/403 鉴权失败 | auth | **不重试**（同 key 必再失败）→ 安全默认 | 1 |
  | HTTP 200 解析失败/未过 zod，或 4xx 不支持 json_schema | content | 同**主模型** + json_object（§4.3 的退化重试） | 2 |
  | 5xx / 超时 / 网络异常 | transport | 改用 **fallback 模型** + json_object | 2 |
  | 其余非成功（429/402/404/通用 4xx/判不出类别） | catch-all | **不重试** → 安全默认 | 1 |
  | 第2次仍失败（任意类别） | — | 安全默认 | 2 |

  *理由*：把「内容失败（降级 response_format，同模型）」与「可用性失败（换 fallback 模型）」拆成两个正交轴，再合并为**一次**重试——既忠于 §4.3「最多一次重试」（content 轴 1 次），又用上 §4.1 的 fallback 模型（transport 轴），还避免 401 浪费一次 fallback 调用。**zod 始终是权威校验**：两次调用结果都过 `ClassificationSchema.safeParse`，不过即视为该次失败。json_schema 用 zod 4 原生派生（见下）。

- **json_schema 用 zod 4 原生 `z.toJSONSchema()` 派生，不手写、零漂移**。本分支已在 **zod 4**（`^4.4.3`），其内置 `z.toJSONSchema(ClassificationSchema)` 直接从同一个 zod schema 派生 json_schema 给模型作 structured-output 提示——**单一真相源**，彻底消除「手写字面量与 zod 漂移」的风险，也无需 `zod-to-json-schema` 依赖。zod 仍是运行期权威校验（`safeParse`）；structured-output 只是提示，模型不遵守时由 zod + 重试状态机兜底。
  <!-- ponytail: zod 4 自带 toJSONSchema，删掉了原本计划手写的 json_schema 字面量——少一段重复代码、少一类漂移 bug。 -->

- **最小化送模型输入 + 不外泄正文**（§11）。`buildClassifierInput(email)` 只取
  `from/fromName/subject/date/snippet/textBody(截断~6000)/headers(白名单)/hasAttachments`；
  **不发** `htmlBody`；headers 走**固定闭集**白名单 `{reply-to, return-path, list-unsubscribe, authentication-results}`
  （与 spec/tasks 一字不差，使「只发白名单」可确定性断言；`from` 已作为顶层 `from`/`fromName` 字段送出，不重复进 header），不整包塞入。隐私与 token 成本双收益。

- **Prompt 为常量模块**（§11 原文）：只输出 JSON、P0–P4 定义、钓鱼/支付→P4、银行/医院/保险/合同不轻易 P3、
  低置信不建议标已读、禁止建议自动收发。本期对模型仅最佳努力约束，强制裁定在 P2。

- **OpenRouter 客户端：惰性构造 + 显式 baseURL，绝不回落 OpenAI**（review 抓到的隐性 blocker）。`new OpenAI({ baseURL, apiKey, defaultHeaders: { 'HTTP-Referer', 'X-Title' } })`，**必须在分类尝试内部、确认有 key 后才构造**——OpenAI SDK 未显式设 baseURL 时默认指向 `api.openai.com`，eager 构造 + 缺 key 既会在返回安全默认前抛错、又可能直连 OpenAI，双重违反硬约束。`baseURL`/`HTTP-Referer`/`X-Title` 直接用 `config` 值——这些默认（`https://openrouter.ai/api/v1` / `http://localhost:3000` / `mail-router`）由 config 层的 `.default()` **单一来源**提供，故调用点**无需**再写 `?? 'https://...'` 兜底（避免 §4.2 伪码的双重默认）；**`OPENROUTER_API_KEY` 缺失 → 不构造、不发请求、直接安全默认**。给请求加超时（~20s），超时计入 transport 失败走 fallback/默认。
- **config 来源对齐**（review 抓到的契约矛盾）：spec/design/tasks 统一为「key 经 P0 校验后的 `config` 读取」。P0 的 `config.ts` 当前只暴露 `NODE_ENV/HOST/PORT/DATABASE_URL`（zod 剥离未知键），故本期**必须**把 6 个 `OPENROUTER_*` 加入 config schema：`OPENROUTER_BASE_URL`/`OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODEL`/`OPENROUTER_SITE_URL`/`OPENROUTER_APP_NAME` 五个带 **§4.1/§4.3 默认值**（`https://openrouter.ai/api/v1` / `google/gemini-2.5-flash-lite` / `openai/gpt-4o-mini` / `http://localhost:3000` / `mail-router`），使模型/baseURL 恒有值、状态机始终可执行；**仅 `OPENROUTER_API_KEY` 用裸 `.optional()`**（无默认，缺失即走安全默认）。带默认的 optional 仍是「可选」、不要求必填，落在 P0 service-bootstrap 规范**已允许**的范围内（后续阶段变量「可选或不纳入校验」），故 service-bootstrap 规范需求不变、无需增量规范；logger 的 redact 需覆盖 `OPENROUTER_API_KEY`（P0 已含）。
- **`normalizeEmail` 全必填字段契约**（review 抓到：原先只 fail-fast 去重键）：结构化字段 `accountId`/`provider`/`providerMessageId` 缺失/非法 → throw；其余必填字段补默认（`fromEmail→''`、`date→`摄入 ISO、`subject→(无主题)`、`to→[]`、`hasAttachments→false`、`headers→{}`），保证产出满足 §7 类型。throw 仅中止当封，P2 批量消费者必须逐封 catch+skip（forward 契约写进 email-model 规范）。
- **seam 类型显式化**：`classifyEmail(email, deps?)` 的 `deps.chat` **必须**有一个导出的命名类型 `ChatFn`（输入 messages + response_format + model → 返回原始字符串 / 抛传输错误），使测试假实现与真实 OpenRouter 路径同契约，避免 P2 复用时反推。
- **失败日志脱敏**：分类失败只记 `{ kind, model, attempt, zodIssuePaths }`，禁止写模型原始输出/原始 SDK 错误/请求 payload（可能内嵌 key 或正文；key 级 redact 清洗不了字符串内嵌内容）。
- **测试运行器（让「离线可测」真正可跑）**：review 指出仓库无 test runner、§5.1 无家可跑、且 tsconfig `rootDir:src` 会把测试编进 `dist`。决策：用 **Node 内置 `node:test`**（stdlib，零新依赖）经**已装的 `tsx`** 跑——`"test": "tsx --test 'src/**/*.test.ts'"`，测试文件 `*.test.ts` 与源码同目录、并在 tsconfig `exclude` 掉以免进 `dist`。ponytail 阶梯：stdlib + 已装 devDep，不引 vitest/jest。

- **ESM/NodeNext 沿用 P0 约束**：src/ 内相对 import 必须带 `.js` 扩展名。新增依赖仅 `openai`。

## 风险 / 权衡

- [模型对 json_schema 支持参差] → 以 json_object + zod + 重试为稳健主干，json_schema 仅作首选提示；
  zod 权威校验确保即便结构化输出被忽略也能拦下坏数据。
- [手写 json_schema 与 zod 漂移] → zod 为唯一权威校验，漂移只降提示质量、不破坏正确性；字段增多再引自动派生。
- [离线测试无法覆盖真实 OpenRouter 行为差异] → 本期 seam + fixture 只证明解析/重试/默认逻辑正确；
  真实模型连通在 P3/P4 接 provider 时随真实邮箱验证（已知不在 P1 可证范围）。
- [安全默认掩盖持续故障] → 安全默认必须结构化日志告警（`{kind,model,attempt}`），便于发现 OpenRouter 持续不可用；
  但绝不因此抛错中断流水线（宁可降级 P1 也不漏处理邮件）。**本期只发每次失败的结构化事件；聚合判定「持续故障」、阈值告警是 P2/可观测性的事**（P1 无 metrics sink / 无落库），此处显式标注以免被静默丢失。
- [每封 timeout 预算 × 轮询批吞吐] → P1 设 ~20s/请求，最坏 2 次调用 ≈ 40s/封。N 封串行分类可能超过轮询间隔、与下个 tick 重入。本期 P1 在隔离单封上正确，但**该 timeout 预算是个吞吐假设，P2 流水线必须显式与轮询间隔/批大小/并发/单账号互斥锁（P6）对账**——此处标注，避免 P2 在压测下才发现这道算术。
- [`headers: Record<string,string>` 合并多值 header] → §7 即此类型，真实邮件的多值 header（`Received` 多次、`Authentication-Results` 可重复）在归一时会塌成单值（last-non-empty-wins）。本期与 §7 一致、对白名单用途够用，但 P3/P4 接真实邮箱、P4 钓鱼判定依赖 `authentication-results` 时，若需保留多值则要把类型改成 `Record<string,string[]>`——那是对模型契约的**破坏性增量**，此处预先标注为已知约束，避免到时才发现。

## 迁移计划

- 仅新增依赖 `openai`；**无** Prisma schema / migration 变更（本期不落库）。
- 无破坏性变更；回滚＝移除新增 src 文件与 `openai` 依赖，P0 骨架不受影响。
