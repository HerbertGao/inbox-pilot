## 修改需求

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
