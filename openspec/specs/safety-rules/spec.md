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
`FinalDecision.shouldMarkRead` 必须遵守:最终优先级为 P0/P1/P4 时一律 false（仅 P2/P3 默认标已读）；且即便最终为 P2/P3，命中以下任一**敏感轴**（`sensitiveGuardFired`）时**必须**强制 `shouldMarkRead=false`:
- **类别轴**:最终 `category ∈ {finance, security, transaction}`;
- **关键词轴**:主题或正文命中支付/安全/医院/保险/合同/账单类关键词——**有效集 = 整个内置 `SECURITY_PAYMENT_KEYWORDS` ∪ YAML（只增不减）**;
- **验证码关键词轴**:主题**或正文**命中 `VERIFICATION_KEYWORDS`（验证码/otp/动态码/校验码/one-time code 等，**内置、不可 YAML 配**）——正文验证码不强制 P0（那是主题轴），但**必须**强制不标已读（与既有 `applySafetyRules` block ③ 第四守卫一致，本期重写**不得丢失**此轴）;
- **发件域轴（可选补充、非决定性）**:发件域命中 `never_mark_read_domains`——**内置默认为空、仅 operator 经 `rules.yaml` 配置**（项目不维护域名白名单）。

硬约束「敏感邮件不自动标已读」由**关键词轴（确定性兜底）+ 类别轴（概率性广覆盖）**落地，**不依赖任何域名白名单或内置域名默认**。覆盖分层（诚实边界、禁止过度宣称）：
- **确定性关键词兜底**:整个内置 `SECURITY_PAYMENT_KEYWORDS`（支付/合同/安全/医院/保险/账单类）——为**并集基底、不可被 YAML 删除**。
- **类别轴（概率性广覆盖、消费 LLM 透传 `category`、不改写）**:finance/security/transaction——召回广但**非确定**。
- **残留缺口（best-effort、非零，本期略扩大）**:未命中关键词、又被 LLM 判非敏感类别的邮件将被标已读；**清空内置域名默认后，此前由示例域名兜住、内容轴漏判的敏感邮件也落入此缺口**——no-whitelist 取舍下 best-effort 的扩大（CLAUDE.md 已接受）。**诚实边界**:断言只能钉「命中关键词/类别的敏感邮件不标已读」，**不能**钉「仅域名可识别、内容轴漏判」者。

`shouldMarkRead` 施加仍**单调趋安全**:任一敏感轴一旦置 false 即粘住，**禁止**翻回 true（含被新增轴改动 priority 后重新派生）。

#### 场景:金融/安全/交易类别覆盖 P2/P3 的标已读
- **当** 一封最终 P2/P3 的邮件 `category ∈ {finance,security,transaction}`
- **那么** `shouldMarkRead` 必须为 false（无需域名白名单）

#### 场景:支付/安全/医院/保险关键词覆盖标已读（含 operator 增配词）
- **当** 邮件命中整个内置 `SECURITY_PAYMENT_KEYWORDS` 任一词、或 operator YAML 增配的词
- **那么** `shouldMarkRead` 必须为 false（内置词不可被 YAML 删除）

#### 场景:发件域命中 operator 配置的域名表覆盖标已读
- **当** 一封 P2 邮件发件域命中 operator 经 `rules.yaml` 配的 `never_mark_read_domains`（内置默认空）
- **那么** `shouldMarkRead` 必须为 false

#### 场景:内置域名默认为空不削弱决定性护栏
- **当** operator 未配 `never_mark_read_domains`，一封敏感邮件经关键词轴或类别轴命中
- **那么** `shouldMarkRead` 必须仍为 false——决定性在内容轴

#### 场景:正文验证码（主题无验证码词）的 P2/P3 邮件仍不标已读
- **当** 一封 P2/P3 邮件**主题**无验证码词（故不强制 P0）、`category ∉ {finance,security,transaction}`、无 `SECURITY_PAYMENT_KEYWORDS` 命中，但**正文**含 `VERIFICATION_KEYWORDS`（如 OTP/验证码）
- **那么** `sensitiveGuardFired` **必须**为真（验证码关键词轴）、`shouldMarkRead` **必须**为 false——经 `applySafetyRules` 断言（本期重写不得丢正文验证码轴，对齐既有 `applySafetyRules.ts` block ③）

### 需求:可配置轴的有序管线、floor-only、绝不下调固定优先级或翻回标已读
P6 新增三个**可配置、空默认、加性**的轴（经 `rules-config` 加载），其判定**必须**作为既有引擎的**终末阶段**、按下述**精确顺序**施加于
**已裁定的最终优先级**，**禁止**削弱既有安全语义。规则管线顺序硬约束：
1. **既有 block ①**：裁定 `priority`（LLM 透传 + 验证码主题→P0 + `confidence<0.65`→P1 + P4 保持）。
2. **敏感守卫判定**：计算 `sensitiveGuardFired = 类别轴 ∨ 关键词轴(SECURITY_PAYMENT_KEYWORDS∪YAML) ∨ 验证码关键词轴(主题**或正文**命中 VERIFICATION_KEYWORDS，内置不可配) ∨ 域名轴`（即既有 `applySafetyRules` block ③ 的**全部**不标已读守卫——**含正文验证码轴**，**禁止**因本期重写丢轴；决定不标已读，下「强制不标已读护栏」）。
3. **新增 marketing 轴**（仅下调 P2→P3、绝不碰 P0/P1/P4/敏感）：`priority === 'P2' ∧ ¬sensitiveGuardFired ∧ 命中 marketing_keywords → priority = 'P3'`。
4. **新增 floor 轴（vip/important）**（urgency-floor，**禁用 `max()` 字面量算术**——`Priority` 是字符串枚举、P0/P4 非数值最大）：
   `priority ∈ {'P2','P3'} ∧ (发件人∈vip_senders ∨ 发件域∈important_domains) → priority = 'P1'`；`priority ∈ {P0,P1,P4} → no-op`。
   （marketing 在 floor 之前 → vip 发来的广告最终为 P1：vip 胜。）
5. **派生动作（从终末 `priority`）**：`shouldNotifyNow = priority ∈ {P0,P4}`；`shouldIncludeDigest = priority ∈ {P1,P2}`；
   **`shouldMarkRead = (priority ∈ {P2,P3}) ∧ ¬sensitiveGuardFired`**——**只算一次、敏感守卫的 false 粘住**，新增轴**绝不**直接置 `shouldMarkRead=true`、
   **绝不**从被自己改动的 priority 重新派生出 true（floor 把 P2/P3 抬到 P1 → markRead 自然变 false，安全方向；marketing 只在 P2 且非敏感时下调，
   始终是「广告→标已读」一致语义、不翻 false→true）。
三轴内置默认**空**：未配置时三轴全 no-op、行为与现状完全一致。

#### 场景:VIP/important 命中不下调 P0/P4（urgency-floor 非 max 字面量）
- **当** 一封 P0（验证码）或 P4（风险）邮件，其发件人/域命中 `vip_senders`/`important_domains`
- **那么** floor 轴**必须** no-op（P0/P4 不变）、`shouldNotifyNow` 不丢——**禁止**因 `max('P0','P1')` 字面量算术把 P0 下调为 P1

#### 场景:marketing 不下调 P1/P0/P4（含高置信 P1）
- **当** 一封 P1（含高置信非降级 P1）或 P0/P4 邮件主题含营销词
- **那么** marketing 轴**必须** no-op（只在 `priority==='P2' ∧ 非敏感`时下调）——**禁止**把 P1/P0/P4 下调为 P3、**禁止**翻 `shouldMarkRead`

#### 场景:marketing 不下调敏感 P2
- **当** 一封命中敏感轴的 P2 邮件主题含营销词
- **那么** marketing**必须** no-op（`sensitiveGuardFired` 为真）；`shouldMarkRead` 仍 false（护栏粘住）

#### 场景:vip + 广告 → P1（vip 胜）
- **当** 一封 P2 邮件发件人命中 `vip_senders`、主题又含营销词
- **那么** 终末 `priority` **必须**为 P1（marketing 先 P2→P3、floor 再 P3→P1）、`shouldMarkRead=false`

#### 场景:提升轴不解除护栏
- **当** 一封 P2 邮件命中 `important_domains` 被抬升、同时命中敏感关键词轴
- **那么** `shouldMarkRead` **必须**仍为 false（敏感守卫粘住、不被 priority 改动重新派生为 true）

### 需求:按最终优先级派生默认动作
`applySafetyRules` 必须按 PROJECT_INIT §5 优先级模型派生默认动作:P0 → 通知、不标已读；P1 → 入摘要、不标已读；P2 → 标已读、入摘要；P3 → 标已读、只计数（不入摘要）；P4 → 通知、不标已读。`shouldNotifyNow` 必须为「最终优先级 ∈ {P0,P4}」；`shouldIncludeDigest` 必须为「最终优先级 ∈ {P1,P2}」。

#### 场景:P2 普通邮件
- **当** 一封最终优先级 P2、未命中任何护栏的邮件
- **那么** `shouldMarkRead` 必须为 true、`shouldIncludeDigest` 为 true、`shouldNotifyNow` 为 false

#### 场景:P3 广告营销只计数
- **当** 一封最终优先级 P3 的邮件
- **那么** `shouldMarkRead` 必须为 true、`shouldIncludeDigest` 为 false、`shouldNotifyNow` 为 false

### 需求:名单从 rules-config 加载，内置 SECURITY_PAYMENT_KEYWORDS 整集并集、内置默认作 fallback
`applySafetyRules` 所需的可配置名单**必须**优先从 `rules-config`（`rules/rules.yaml`）加载——`security_keywords`、
`never_mark_read_domains`、`vip_senders`、`important_domains`、`marketing_keywords`。**验证码关键词与敏感类别集保持代码内置、不经 YAML 覆盖**
（守 §12.1 主题→P0 与类别轴硬约束）。当 rules.yaml 缺失/为空/某项非法/不可读时，该项**必须**逐项回落（首次启动内置默认 / 运行期重载 carry-forward 上一次有效值，见 `rules-config`）、记结构化日志、**禁止**让规则引擎裸奔。

**security 关键词为内置整集并集、只能增不能减**：有效 security 关键词集**必须** = **整个内置 `SECURITY_PAYMENT_KEYWORDS` 常量 ∪ YAML
提供的词**（**不是其某个子集**——`lists.ts` 注释明示该常量**全部**承载硬约束）。operator 配 `security_keywords`（含配成空、或不含某些内置词）
**绝不能**删除任何内置词，全部内置 security 词**必须**仍生效；YAML 只叠加。`security_keywords` 只驱动**不标已读**（**禁止**变成「主题→强制 P0」——
那是独立的验证码固定规则）。

**测试供给**：为使纯函数 `applySafetyRules` 可注入测试名单，其签名**必须**新增可选 `rules` 参数（缺省 `= getActiveRules()`）——保持纯函数与
现有调用点不变，单测经该参注入快照（含 operator `never_mark_read_domains`）测域名轴等。

**域名轴**：`never_mark_read_domains` 为可选、非决定性，**内置默认为空**（项目不维护域名白名单）；可替换。固定规则安全语义不变。

#### 场景:operator 配空/缺词 security_keywords 仍守全部内置硬约束词
- **当** operator 配 `security_keywords: []`、或一个不含某些内置词的列表、或一个标量（非数组）
- **那么** 有效集**必须**仍含**整个内置 `SECURITY_PAYMENT_KEYWORDS`**（YAML 只增不减、标量项回落内置默认）；经 `applySafetyRules` 对一封含
  内置词（如「医院预约」）的邮件断言 `shouldMarkRead=false`

#### 场景:验证码/类别保持内置不被 YAML 改
- **当** rules.yaml 试图配 verification/sensitive_categories
- **那么** 加载器丢弃之；验证码主题→P0 与类别轴仍由内置守住

