## 0. 约束（贯穿全程）

- [x] 0.1 ESM/NodeNext：src/ 内所有相对 import 必须带 `.js` 扩展名（沿用 P0）
- [x] 0.2 密钥只从 P0 的 `config` 读（环境变量），禁止写死；安全默认/失败路径的日志禁止泄露密钥或完整正文
- [x] 0.3 本期不落库、不接 provider、不执行任何动作、不实现规则引擎——越界即停

## 1. 依赖与脚手架

- [x] 1.1 安装运行依赖 `openai`（仅指向 OpenRouter base URL）；zod 已在 P0 装好。测试用 Node 内置 `node:test` + 已装的 `tsx`，**无新测试依赖**
- [x] 1.2 扩展 P0 `config` schema 加 6 个 `OPENROUTER_*`：`OPENROUTER_BASE_URL`/`OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODEL`/`OPENROUTER_SITE_URL`/`OPENROUTER_APP_NAME` 用 `.default()` 带 §4.1 默认值（`https://openrouter.ai/api/v1`/`google/gemini-2.5-flash-lite`/`openai/gpt-4o-mini`/`http://localhost:3000`/`mail-router`，使模型/baseURL 恒有值）；**仅 `OPENROUTER_API_KEY` 裸 `.optional()`**（无默认，缺失走安全默认）。带默认的 optional 仍是「可选」，落在 P0「后续阶段变量可选」允许范围内，service-bootstrap 规范需求不变、无需增量规范；确认 logger `redact` 覆盖 `OPENROUTER_API_KEY`
- [x] 1.3 测试运行器：`package.json` 加 `"test": "tsx --test 'src/**/*.test.ts'"`；`tsconfig.json` `exclude` 追加 `src/**/*.test.ts`（避免测试文件编进 `dist`）。ponytail：stdlib `node:test` + 已装 `tsx`，不引 vitest/jest

## 2. 邮件模型 email-model

- [x] 2.1 `src/normalizer/normalizeEmail.ts`：定义 `NormalizedEmail` 类型（PROJECT_INIT §7 全字段集）
- [x] 2.2 实现 `normalizeEmail(raw)`：结构化不变量——`accountId`/`provider`(须 `gmail`/`imap`)/`providerMessageId` 缺失/空/非法即 `throw` 明确错误；注释 throw 仅中止当封、P2 批量消费者须逐封 catch+skip（对应 spec「结构化不变量与失败隔离」）
- [x] 2.3 `normalizeEmail` 全必填字段默认与归一：`subject`→`(无主题)`、`fromEmail`→`''`、`date`→摄入 ISO、`to`→`[]`、`hasAttachments`→`false`、`headers`→`{}`；header key 统一 `toLowerCase()`，同名冲突 last-non-empty-wins（空值不覆盖非空）（对应 spec「必填字段默认与归一」）

## 3. 分类 Schema 与 OpenRouter 客户端

- [x] 3.1 `src/classifier/schema.ts`：zod `ClassificationSchema`（§4.4：priority/category 枚举、3 个布尔、confidence ∈[0,1]、reason ≤120、risk_flags 数组），导出 `Classification` 类型（对应 spec「分类输出 Schema 校验」）
- [x] 3.2 `src/classifier/schema.ts`：用 zod 4 原生 `z.toJSONSchema(ClassificationSchema)` 派生 json_schema（单一真相源、零漂移、无新依赖；仅作模型 structured-output 提示，zod `safeParse` 为运行期权威校验）
- [x] 3.3 `src/classifier/openrouterClient.ts`：**惰性**构造 `new OpenAI({ baseURL, apiKey, defaultHeaders })`——baseURL **显式**取 `config.OPENROUTER_BASE_URL`、缺省回落 OpenRouter 默认（禁止落到 SDK 的 `api.openai.com`）；`HTTP-Referer`/`X-Title` 同理带默认；请求超时 ~20s；缺 `OPENROUTER_API_KEY` 时不构造、不发请求（对应 spec「OpenRouter 唯一入口与鉴权」四个场景）
- [x] 3.4 在 `classifyEmail.ts` 导出命名 seam 类型 `ChatFn`（messages + response_format + model → 原始字符串 / 抛传输错误），真实实现与测试假实现共用该契约

## 4. classifyEmail 内核

- [x] 4.1 `src/classifier/prompt.ts`（或 classifyEmail 内常量）：§11 分类 prompt——只输出 JSON、P0–P4 定义、钓鱼/支付→P4、银行/医院/保险/合同不轻易 P3、低置信不建议标已读、禁止建议自动收发（对应 spec「分类 Prompt 安全约束」）
- [x] 4.2 `buildClassifierInput(email)`：只取 `from/fromName/subject/date/snippet/textBody/headers/hasAttachments`；`textBody` 截断 ~6000；**不发** `htmlBody`；header 只取闭集白名单 `{reply-to, return-path, list-unsubscribe, authentication-results}`，其余剔除（对应 spec「最小化送模型输入，不外泄正文」）
- [x] 4.3 `src/classifier/classifyEmail.ts`：纯函数 `classifyEmail(email, deps?)`，`deps.chat: ChatFn` 默认真实 OpenRouter 调用、测试可注入（离线可测 seam）
- [x] 4.4 重试状态机（单次重试、≤2 次调用、单一全局计数器，**对所有非成功结果穷尽且互斥**）：第1次 主模型+json_schema；按失败类别分流——**内容失败**(200 解析/zod 失败 或经 SDK error.code/message 判定不支持 json_schema 的 4xx)→同主模型+json_object 重试1次；**传输失败**(5xx/超时/网络)→`OPENROUTER_FALLBACK_MODEL`+json_object 重试1次；**鉴权失败**(401/403)→不重试直接安全默认；**其余非成功**(429/402/404/通用4xx/判不出)→不重试直接安全默认。两次结果都过 `ClassificationSchema.safeParse`（对应 spec「有界的两次调用重试状态机」五个场景）
- [x] 4.5 硬上限：实现须保证任一封邮件模型调用次数 ≤ 2（单一计数器贯穿两条重试路径），供 §5.1 用 `chatSpy` 调用次数断言
- [x] 4.6 彻底失败安全默认：返回**完整 8 字段** `{ priority:'P1', category:'unknown', should_notify_now:false, should_mark_read:false, should_include_digest:true, confidence:0, reason:'AI 分类失败，降级 P1', risk_flags:[] }`；**不抛未捕获异常**；失败日志只写 `{ kind, model, attempt, zodIssuePaths }`，禁止写模型原始输出/原始 SDK 错误/请求 payload（对应 spec「彻底失败的安全默认」三个场景）
- [x] 4.7 确认 `classifyEmail` 只产出建议、绝不执行任何标已读/收发动作（对应 spec「分类器只建议不执行动作」）

## 5. 离线验收

- [x] 5.1 自检 `src/classifier/classifyEmail.test.ts`（`node:test` + 注入假 `chat` spy，无需联网；断言一律针对 `classifyEmail` 的**返回值**，禁止只断言喂进去的假响应）：
  - 合法 JSON → 返回校验过的 `Classification`（验收①）
  - 首次内容失败、二次合法 → 成功，且 `chatSpy` 恰好被调用 **2** 次（验收②，**必须断言调用次数**，否则「恰好一次重试」无法证伪）
  - 恒非法 / 恒 throw → 返回**完整 8 字段安全默认元组**（`priority:'P1'`+`category:'unknown'`+`should_notify_now:false`+`should_mark_read:false`+`should_include_digest:true`+`confidence:0`+`reason:'AI 分类失败，降级 P1'`+`risk_flags:[]`，**8 个字段全部断言**）、不抛异常、`chatSpy` 调用 ≤ 2 次（验收③）
  - 第1次 throw（传输失败）、fallback 合法 → 成功且第2次用 `OPENROUTER_FALLBACK_MODEL`（断言 model 参数）
  - 第1次 401 → 不发起第2次调用（`chatSpy` 调用 1 次）→ 安全默认
  - 第1次 429/404（其余非成功）→ 不发起第2次调用（`chatSpy` 调用 1 次）→ 安全默认
  - 缺 `OPENROUTER_API_KEY` → 不调用 `chat`、不抛异常 → 安全默认
  - `normalizeEmail`：缺 `accountId`/`provider`/`providerMessageId` → throw；缺 `subject`/`fromEmail`/`date`/`to`/`hasAttachments`/`headers` → 补默认（断言无 undefined 必填）；`From`+`from`（其一空值）→ 小写归一 + last-non-empty-wins
  - `buildClassifierInput`：超长 `textBody` 截断、`htmlBody` 不出现、**产出 header 集合 ⊆ 闭集 `{reply-to, return-path, list-unsubscribe, authentication-results}`**（正向断言子集，且 `from`/`received` 等不在 header 中）
- [x] 5.2 `pnpm test` 通过（§5.1 全绿、失败即非零退出）且 `pnpm build`（tsc）通过；P0 的 `/health` 与启动不受影响（本期未碰 main/db/schema；`*.test.ts` 已 exclude 出 `dist`）
