# safety-rules 规范

## 目的
待定 - 由变更 rules-pipeline-notify 创建。归档后请更新目的。
## 需求
### 需求:规则引擎为最终动作的唯一权威
`applySafetyRules(email, classification)` 必须是产出最终动作裁定 `FinalDecision` 的唯一权威——LLM 的 `Classification` 只是建议，**禁止**直接驱动任何标已读/通知动作，下游只认 `FinalDecision`。`applySafetyRules` **必须忽略** `classification.should_notify_now`/`should_mark_read`/`should_include_digest` 这三个建议动作布尔，全部从最终优先级 + 护栏**重新派生**（建议无权直接驱动动作）。规则施加必须**单调趋安全**：任一「强制不标已读」一旦置位即粘住，后续规则**禁止**把它翻回标已读。`FinalDecision.confidence` 由 `Classification` 透传、引擎不改写（仅作 <0.65 降级判断的输入）。`applySafetyRules` 是纯函数（无 I/O、无副作用），并在 `FinalDecision.appliedRules` 记录命中的规则名以便审计。

#### 场景:建议经规则引擎裁定为 FinalDecision
- **当** 给定一封 `NormalizedEmail` 与其 `Classification`
- **那么** 必须返回一个 `FinalDecision`（含 priority/category/confidence/shouldNotifyNow/shouldMarkRead/shouldIncludeDigest/reason/riskFlags/appliedRules），下游动作只读它、不读原始 `Classification`

#### 场景:规则只会更安全
- **当** 任一规则已将 `shouldMarkRead` 置为 false
- **那么** 同次裁定中**禁止**有任何后续规则把它改回 true

### 需求:优先级强制裁定
`applySafetyRules` 必须按固定顺序确定**最终优先级**，覆盖 LLM 建议:**主题**命中验证码 → 强制 `P0`；否则 `Classification.priority === 'P4'` → 保持 `P4`；否则 `confidence < 0.65` → 降级 `P1`；否则取 `Classification.priority`。`confidence < 0.65` 的强制降级本期落地（分类器仍如实上报 confidence）。`confidence < 0.65` 的降级仅针对 **LLM 的优先级建议**；验证码(P0)/P4(风险) 是**确定性安全强制**，不被低置信度降级（低置信度绝不下调安全级别）——这是对 PROJECT_INIT §12 顺序规则的**有意安全细化**。验证码强制 P0 只匹配**主题**（对齐 §12 `subjectContainsVerificationCode`）；正文里的验证码/安全关键词不强制 P0，改走「强制不标已读护栏」。

#### 场景:验证码主题强制 P0
- **当** 邮件**主题**命中验证码关键词（如「验证码」「verification code」）
- **那么** `FinalDecision.priority` 必须为 `P0`、`shouldNotifyNow` 为 true、`shouldMarkRead` 为 false（覆盖任何建议）

#### 场景:正文验证码不强制 P0 但不标已读
- **当** 验证码/安全关键词只出现在正文（主题未命中）
- **那么** 必须不强制 `P0`，但走「强制不标已读护栏」令 `shouldMarkRead` 为 false

#### 场景:低置信度降级 P1
- **当** `confidence < 0.65` 且未命中验证码、`Classification.priority` 非 P4
- **那么** `FinalDecision.priority` 必须降为 `P1`、`shouldMarkRead` 为 false、`shouldIncludeDigest` 为 true

### 需求:强制不标已读护栏
`FinalDecision.shouldMarkRead` 必须遵守:最终优先级为 P0/P1/P4 时一律 false（仅 P2/P3 默认标已读）；且即便最终为 P2/P3，命中以下任一**敏感轴**时**必须**强制 `shouldMarkRead=false`:
- **类别轴**:最终 `category ∈ {finance, security, transaction}`（银行→finance、支付→transaction、安全→security）;
- **关键词轴**:主题或正文命中支付/安全关键词（invoice/payment/合同/账单/异常登录 等），**以及医院/保险类关键词**（医院/医疗/挂号/病历/诊断/保险/保单/理赔/hospital/clinic/medical/insurance 等）;
- **发件域轴（可选补充）**:发件域命中内置敏感域名表。

硬约束「敏感邮件不自动标已读」由**关键词轴（确定性兜底）+ 类别轴（概率性广覆盖）**落地，**不要求**穷举域名白名单。覆盖分层（诚实边界、禁止过度宣称）：
- **确定性关键词兜底**（命中即必不标已读）:支付(支付/付款/账单/payment/invoice)、合同(合同/contract)、安全(异常登录/验证码/重置密码 等)、医院/保险(医院/医疗/挂号/病历/诊断/保险/保单/理赔/hospital/clinic/medical/insurance)、银行账单类(账单/对账单)。
- **类别轴（概率性广覆盖，消费 LLM 透传的 `category`、引擎不改写）**:叠加 finance(银行)/security/transaction——召回广但**非确定**。
- **残留缺口（best-effort、非零）**:任何**未命中关键词、又被 LLM 判为非敏感类别**的邮件——典型如无账单词的纯银行通知、未列入关键词表措辞的医院/保险邮件（如「保障方案续期」「复诊提醒」）。关键词表是**有限集、完备性不可证**——此残留为**本期 best-effort 取舍**：不维护域名白名单的代价；彻底消除需引入 medical/insurance 类别枚举（超范围，留后续）。

发件域名表为可选补充、**默认非空**（保留示例项使域名轴可被实例化、不破坏既有用例），不要求穷举维护。

此即「涉及标已读动作」的规则引擎兜底:标已读与否只由本引擎裁定（provider 禁止自行判断、禁止读原始 Classification），敏感/风险邮件**禁止**自动标已读。施加仍**单调趋安全**:任一轴一旦置 `shouldMarkRead=false` 即粘住，禁止翻回 true。

#### 场景:金融/安全/交易类别覆盖 P2/P3 的标已读
- **当** 一封最终优先级 P2 或 P3 的邮件，其最终 `category` 为 `finance`/`security`/`transaction`（如一封被判 P3 的银行营销邮件）
- **那么** `FinalDecision.shouldMarkRead` 必须为 false（即便 P2/P3 默认标已读），无需该发件域出现在任何白名单

#### 场景:支付/安全关键词覆盖标已读
- **当** 邮件主题/正文命中支付/安全关键词（如 invoice/payment/异常登录）
- **那么** `FinalDecision.shouldMarkRead` 必须为 false

#### 场景:医院/保险关键词覆盖标已读
- **当** 一封最终优先级 P2/P3 的医院或保险邮件，主题/正文命中医院/保险类关键词（如 保险/保单/理赔/医院/挂号/病历）
- **那么** `FinalDecision.shouldMarkRead` 必须为 false（确定性兜底硬约束的医院/保险类，无需域名白名单）

#### 场景:发件域命中可选敏感域名表覆盖标已读
- **当** 一封最终优先级 P2 的邮件，其发件域命中内置敏感域名表中的某项（该表默认非空）
- **那么** `FinalDecision.shouldMarkRead` 必须为 false（即便 P2 默认标已读）

### 需求:按最终优先级派生默认动作
`applySafetyRules` 必须按 PROJECT_INIT §5 优先级模型派生默认动作:P0 → 通知、不标已读；P1 → 入摘要、不标已读；P2 → 标已读、入摘要；P3 → 标已读、只计数（不入摘要）；P4 → 通知、不标已读。`shouldNotifyNow` 必须为「最终优先级 ∈ {P0,P4}」；`shouldIncludeDigest` 必须为「最终优先级 ∈ {P1,P2}」。

#### 场景:P2 普通邮件
- **当** 一封最终优先级 P2、未命中任何护栏的邮件
- **那么** `shouldMarkRead` 必须为 true、`shouldIncludeDigest` 为 true、`shouldNotifyNow` 为 false

#### 场景:P3 广告营销只计数
- **当** 一封最终优先级 P3 的邮件
- **那么** `shouldMarkRead` 必须为 true、`shouldIncludeDigest` 为 false、`shouldNotifyNow` 为 false

### 需求:名单用内置默认
本期规则所需的名单（验证码/支付/安全关键词、敏感域名）必须来自代码内置默认常量，**禁止**依赖 YAML 或外部配置文件（可配化是 P6）。

#### 场景:不读外部配置
- **当** `applySafetyRules` 判定敏感域名/关键词
- **那么** 必须使用内置默认名单，禁止读取 `rules.yaml` 或任何外部文件

