# email-classification 规范

## 目的
待定 - 由归档变更 email-classification-core 创建。归档后请更新目的。
## 需求
### 需求:OpenRouter 唯一入口与鉴权
分类器调用 AI 模型时**必须且仅可**经 OpenRouter（OpenAI 兼容 Chat Completions API）；**禁止**直连 OpenAI / Claude / Gemini。构造 SDK 客户端时**必须显式传入** baseURL（取经 P0 校验的 `config.OPENROUTER_BASE_URL`，缺省用默认 `https://openrouter.ai/api/v1`），**禁止**依赖 SDK 默认值——OpenAI SDK 在未显式设置 baseURL 时会默认指向 `api.openai.com`，这会同时违反「仅经 OpenRouter」与「绝不直连其他模型商」。鉴权 Bearer Token 必须取自环境变量 `OPENROUTER_API_KEY`（经 P0 校验的 `config` 读取），**禁止**写死。请求必须带 `HTTP-Referer`（`OPENROUTER_SITE_URL`，缺省 `http://localhost:3000`）与 `X-Title`（`OPENROUTER_APP_NAME`，缺省 `inbox-pilot`）头。主模型 `OPENROUTER_MODEL` 与回退模型 `OPENROUTER_FALLBACK_MODEL` **必须在 config schema 带 §4.1 默认值**（`google/gemini-2.5-flash-lite` / `openai/gpt-4o-mini`），使二者**恒有值**——状态机第 1/2 次调用始终有模型可用；六个 `OPENROUTER_*` 中**只有 `OPENROUTER_API_KEY` 无默认**（缺失即走安全默认，见下），其余五个均带默认。客户端**必须惰性构造**（在分类尝试内部、确认 key 存在后才 `new`），**禁止**在模块加载期 eager 构造——否则缺 key 会在 `classifyEmail` 返回安全默认之前抛出，破坏「彻底失败也返回安全默认、绝不抛未捕获异常」契约。`OPENROUTER_API_KEY` 缺失时，分类**禁止**发起任何网络调用，必须直接走彻底失败的安全默认。

#### 场景:始终显式指向 OpenRouter，绝不回落 OpenAI 默认
- **当** 分类器构造 AI 客户端（无论 `OPENROUTER_BASE_URL` 是否在 env 设置）
- **那么** 客户端 baseURL 必须显式为 OpenRouter（已设置用其值、未设置用 OpenRouter 默认），apiKey 来自环境变量，并带 `HTTP-Referer`/`X-Title` 头；禁止出现指向 `api.openai.com` 或其他模型商的可能

#### 场景:密钥缺失时不构造、不调用、直接安全默认且不抛异常
- **当** `OPENROUTER_API_KEY` 缺失，调用 `classifyEmail`
- **那么** 必须不构造客户端、不发起任何网络请求，直接返回彻底失败的安全默认（P1/不标已读/入摘要），且不抛出未捕获异常、不泄露密钥到日志

#### 场景:密钥被拒时不静默成功
- **当** `OPENROUTER_API_KEY` 存在但被 OpenRouter 拒绝（401/403 鉴权失败）
- **那么** 该次分类必须按「彻底失败的安全默认」处理，禁止伪造成功结果或泄露密钥到日志

### 需求:分类输出 Schema 校验
分类器采纳的每一个分类结果**必须**通过 zod `ClassificationSchema` 校验（PROJECT_INIT §4.4）：
`priority` ∈ `{P0,P1,P2,P3,P4}`；`category` ∈ `{personal, work, finance, system_alert, security, newsletter, marketing, transaction, unknown}`（共 9 个）；`should_notify_now`/`should_mark_read`/
`should_include_digest` 为布尔；`confidence` ∈ `[0,1]`；`reason` 长度 ≤ 120（按字符串长度计，此为**权威上限**；§11 prompt 里的「不超过80字」只是给模型的软提示，本期不强制，81–120 长度的 `reason` 仍合法采纳）；`risk_flags` 为字符串数组。
任何未通过校验的模型输出**禁止**被直接采纳。

#### 场景:合法输出通过校验并采用
- **当** 模型返回的 JSON 满足 `ClassificationSchema`
- **那么** 必须解析为类型安全的 `Classification` 对象并采用

#### 场景:非法输出被拒
- **当** 模型输出缺字段、`priority` 为未知值、`confidence` 越界或 `reason` 超长
- **那么** 该输出禁止被采纳，必须进入有限重试，重试仍失败则回退到安全默认

### 需求:有界的两次调用重试状态机
分类器的模型调用**必须**遵循一个**单次重试、最多 2 次模型调用**的确定性状态机，杜绝「最多一次重试」(PROJECT_INIT §4.3) 与 fallback 模型 (§4.1) 两个机制叠加导致的调用次数歧义与成本失控。zod 始终是权威校验——两次调用的结果都**必须**过 `ClassificationSchema.safeParse`。状态机：

- **第 1 次调用**：主模型 `OPENROUTER_MODEL`，优先 structured outputs（json_schema）。
- 按第 1 次的**失败类别**分流（分类**必须对所有非成功结果穷尽、互斥**，**判定顺序 auth → content → transport → catch-all**，即 401/403 先于 content-4xx 判定，避免重叠；每类至多触发 1 次重试）：
  - **成功**（解析通过且过 zod）→ 直接采用。
  - **鉴权失败**（恰好 401/403）→ **禁止重试**（同一 key 在 fallback 上必然同样失败），直接安全默认。
  - **内容/格式失败**（HTTP 200 但无法解析或未过 zod；或经 SDK `error.code`/`message` 判定为「不支持 json_schema/response_format」的 4xx——**判不出是否属此类的 4xx 一律归入下面的 catch-all**）→ **第 2 次调用：同一主模型、降级 json_object 模式**（即 §4.3「退化 JSON mode + 最多一次重试」）。
  - **传输/可用性失败**（5xx / 超时 / 网络异常）→ **第 2 次调用：`OPENROUTER_FALLBACK_MODEL`、json_object 模式**。
  - **其余任何非成功结果**（429 限流 / 402 余额不足 / 404 模型不存在 / 通用 4xx；或无法判定类别的错误）→ **不重试，直接安全默认**——保证状态机对所有结果都有定义、避免 429 重试风暴、且总调用 = 1。
- 第 2 次仍失败（任何类别）→ 安全默认。
- **硬上限：任一封邮件的模型调用次数 ≤ 2**，由一个贯穿两条重试路径的**单一计数器**保证。模型名取经 config 默认的 `OPENROUTER_MODEL`/`OPENROUTER_FALLBACK_MODEL`（见鉴权需求，二者恒有值），故状态机两次调用始终有模型可用。

#### 场景:首选结构化输出
- **当** 发起第 1 次分类请求
- **那么** 必须以 json_schema 结构化输出方式请求主模型 `OPENROUTER_MODEL`

#### 场景:内容失败触发同模型 json_object 降级（恰好一次重试）
- **当** 第 1 次（主模型）返回无法解析/未过 zod，或 4xx 指示不支持 json_schema
- **那么** 必须以**同一主模型 + json_object** 重试恰好一次；仍失败则安全默认，总调用次数 = 2

#### 场景:传输失败回退 fallback 模型
- **当** 第 1 次（主模型）报 5xx/超时/网络异常
- **那么** 第 2 次必须改用 `OPENROUTER_FALLBACK_MODEL` + json_object；仍失败则安全默认，总调用次数 = 2

#### 场景:鉴权失败不浪费 fallback 调用
- **当** 第 1 次返回 401/403（key 无效）
- **那么** 必须不发起第 2 次调用，直接安全默认，总调用次数 = 1

#### 场景:未归类的非成功结果不重试直接安全默认
- **当** 第 1 次返回 429/402/404/通用 4xx，或返回无法判定类别的错误
- **那么** 必须不发起第 2 次调用，直接安全默认，总调用次数 = 1（保证状态机对所有结果穷尽定义）

### 需求:传输失败重试前指数退避（不增调用次数、calls≤2 不变）
当两次调用重试状态机走**传输/可用性失败**路径（5xx / 超时 / 网络异常 → 第 2 次调用 `OPENROUTER_FALLBACK_MODEL`）时，系统**必须**在第 2 次
模型调用**之前**插入**恰好一次裸 delay**（指数退避：起始小常数、有上限），落在既有 `retryOnce` 内。该 delay **必须不增加**贯穿状态机的调用计数
（**`calls ≤ 2` 硬上限结构保持不变**——delay 不是一次调用），**禁止**改变状态机的失败分流、降级语义或安全默认（鉴权失败→直接安全默认、内容失败→同模型
json_object，均不受影响）。退避**必须按失败类别 gate 在传输/可用性分支**——`retryOnce` 被**内容失败**路径（同主模型 json_object 降级）共用，故**禁止**无条件在 `retryOnce` 顶端 sleep；**内容重试路径无退避**（其延迟无收益）。鉴权/未归类（429/402/404/通用 4xx）等**不重试**路径**无**退避（在 `retryOnce` 之前返回安全默认）。该分类器退避**必须**计入流水线**单封邮件总退避预算**
（与动作退避求和、≤~1s 封顶，见 `processing-pipeline`），防分类器退避与动作退避叠加撑爆单轮 poll 超时。超时/失败仍走既有「AI 失败 → 降级 P1、
不标已读、入摘要」（验证码/P4 安全强制不被下调）。

#### 场景:传输失败第 2 次调用前退避一次、calls≤2 不变
- **当** 第 1 次（主模型）报 5xx/超时/网络异常、进入 fallback 重试
- **那么** 第 2 次 `chat()` 之前**必须**有恰好一次退避 delay；调用计数仍 ≤ 2（delay 不计为调用）；失败分流与安全默认语义不变

#### 场景:不重试路径无退避
- **当** 第 1 次报 401/403（鉴权）或 429/402/404（未归类）
- **那么** **禁止**插入退避 delay（这些路径不重试、直接安全默认）、总调用 = 1

#### 场景:内容失败重试路径无退避（gate 在传输分支）
- **当** 第 1 次为内容/格式失败（同主模型 json_object 降级重试）
- **那么** 该重试**无**退避 delay（退避只 gate 在传输/可用性分支）；`retryOnce` 共用、**禁止**无条件 sleep

#### 场景:分类器退避计入单封总预算
- **当** 一封邮件既触发分类器传输退避、又在动作阶段触发动作退避
- **那么** 二者之和**必须**受单封 ≤~1s 总退避封顶约束（防叠加撑爆轮超时）

### 需求:最小化送模型输入，不外泄正文
分类器构造发往模型的输入时，**必须**只包含必要字段（`from`、`fromName`、`subject`、`date`、`snippet`、
截断后的 `textBody`、白名单 `headers`、`hasAttachments`，见 PROJECT_INIT §11）。`textBody` **必须**截断到
约 6000 字符上限；**禁止**发送 `htmlBody`；header **必须**只取一个**固定闭集**白名单
`{reply-to, return-path, list-unsubscribe, authentication-results}`（仅这些 key 可进入模型输入，其余一律剔除），
使「只发白名单」可被确定性断言；**禁止**把全部 `headers` 原样塞入。

#### 场景:超长正文截断
- **当** `NormalizedEmail.textBody` 超过约 6000 字符
- **那么** 送入模型的正文必须被截断到上限以内，禁止发送完整超长正文

#### 场景:不发送 htmlBody 与非白名单 header
- **当** `NormalizedEmail` 含 `htmlBody` 及白名单外的 header（如 `received`、`x-mailer`）
- **那么** 模型输入禁止包含 `htmlBody`，且 header 只能是闭集 `{reply-to, return-path, list-unsubscribe, authentication-results}` 内的 key，白名单外的 header 必须被剔除

### 需求:彻底失败的安全默认
`classifyEmail` 必须在有界次数的模型调用全部失败（鉴权失败 / 传输错误 / 超时 / 多次非法 JSON）时返回一个**安全默认**分类而非抛出未捕获异常，其字段为：`priority=P1`、
`should_notify_now=false`、`should_mark_read=false`、`should_include_digest=true`、`confidence=0`、
`category=unknown`、`reason` 标注「AI 分类失败，降级 P1」、`risk_flags=[]`。

`classifyEmail` 自身**只产出建议、绝不执行任何动作**——它不会真正标任何邮件已读、不发送/回复邮件；
`should_mark_read` 等只是给规则引擎的建议字段，最终是否标已读由 P2 的 `applySafetyRules` 规则引擎决定
（规则引擎兜底：AI 失败默认不标已读，P4 与敏感域名永不自动标已读）。

记录失败告警日志时，**必须**只写结构化字段（如 `{ kind, model, attempt, zodIssuePaths }`），**禁止**写入模型原始输出字符串、原始 SDK 错误对象或请求 payload——它们可能内嵌 `OPENROUTER_API_KEY` 或正文片段，而 P0 logger 的 key 级 redact 清洗不了字符串内嵌内容（与 P0「禁止记录未脱敏 Prisma 错误」同源约束）。

#### 场景:AI 彻底失败时返回完整安全默认
- **当** 有界次数（≤2）的模型调用全部失败（鉴权/网络/超时/反复非法 JSON）
- **那么** `classifyEmail` 必须返回完整安全默认 `{ priority:'P1', category:'unknown', should_notify_now:false, should_mark_read:false, should_include_digest:true, confidence:0, reason:'AI 分类失败，降级 P1', risk_flags:[] }`，且不抛出未捕获异常

#### 场景:分类器只建议不执行动作
- **当** `classifyEmail` 产出任意分类结果（含安全默认）
- **那么** 它必须只返回建议字段、不执行任何 IMAP/Gmail 标已读或发送动作；真正的动作由下游规则引擎（P2）裁定

#### 场景:失败日志不外泄密钥与正文
- **当** 分类失败需记录告警日志
- **那么** 只能写 `{ kind, model, attempt, zodIssuePaths }` 等结构化字段，禁止写入模型原始输出、原始 SDK 错误对象或请求 payload

### 需求:分类 Prompt 安全约束
分类 prompt **必须**指示模型只输出 JSON、不输出解释性文本，并内含 PROJECT_INIT §11 的安全要求：
疑似钓鱼/诈骗/异常登录/支付风险归为 P4；银行/医院/保险/合同/招聘/账单类不要轻易标为 P3；
置信度低于 0.65 时不要建议自动标已读；**禁止**建议自动回复或自动发送邮件。本期 prompt 只对模型做
最佳努力约束；具有强制力的最终裁定仍在 P2 规则引擎（本期分类器不据 confidence 做降级，唯一例外是上面的彻底失败安全默认）。

#### 场景:Prompt 含 P4 与敏感类目约束
- **当** 构造分类 prompt
- **那么** prompt 必须包含 P0–P4 定义、钓鱼/支付风险归 P4、银行/医院/保险/合同类不轻易标 P3 的指示

#### 场景:Prompt 要求只输出 JSON 且禁止建议自动收发
- **当** 构造分类 prompt
- **那么** prompt 必须要求只输出 JSON，并明确禁止建议自动回复或自动发送邮件

