## 修改需求

### 需求:可配置轴的有序管线、floor-only、绝不下调固定优先级或翻回标已读
新增的**可配置、空默认、加性**轴（经 `rules-config` 加载），其判定**必须**作为既有引擎的**终末阶段**、按下述**精确顺序**施加于
**已裁定的最终优先级**，**禁止**削弱既有安全语义。规则管线顺序硬约束：
1. **既有 block ①**：裁定 `priority`（LLM 透传 + 验证码主题→P0 + `confidence<0.65`→P1 + P4 保持）。
2. **敏感守卫判定**：计算 `sensitiveGuardFired = 类别轴 ∨ 关键词轴(SECURITY_PAYMENT_KEYWORDS∪YAML) ∨ 验证码关键词轴(主题**或正文**命中 VERIFICATION_KEYWORDS，内置不可配) ∨ 域名轴`（即既有 `applySafetyRules` block ③ 的**全部**不标已读守卫——**含正文验证码轴**，**禁止**因重写丢轴；决定不标已读，下「强制不标已读护栏」）。
3. **marketing 轴**（仅下调 P2→P3、绝不碰 P0/P1/P4/敏感）：`priority === 'P2' ∧ ¬sensitiveGuardFired ∧ 命中 marketing_keywords → priority = 'P3'`。
4. **新增 noise 轴**（operator 手配的过度高评降噪、`¬sensitiveGuardFired` 门控、绝不碰 P4/敏感）：
   `priority ∈ {'P0','P1','P2'} ∧ ¬sensitiveGuardFired ∧ (发件人精确∈noise_senders ∨ 发件域∈noise_senders) → priority = 'P3'`；
   `priority ∈ {P3,P4} → no-op`。noise 轴**置于 marketing 之后、floor 之前**——故被误列为 noise 的 vip/important 发件人可被 floor 救回（vip 胜）。
5. **floor 轴（vip/important）**（urgency-floor，**禁用 `max()` 字面量算术**——`Priority` 是字符串枚举、P0/P4 非数值最大）：
   `priority ∈ {'P2','P3'} ∧ (发件人∈vip_senders ∨ 发件域∈important_domains) → priority = 'P1'`；`priority ∈ {P0,P1,P4} → no-op`。
6. **派生动作（从终末 `priority`）**：`shouldNotifyNow = priority ∈ {P0,P4}`；`shouldIncludeDigest = priority ∈ {P1,P2}`；
   **`shouldMarkRead = (priority ∈ {P2,P3}) ∧ ¬sensitiveGuardFired`**——**只算一次、敏感守卫的 false 粘住**，新增轴**绝不**直接置 `shouldMarkRead=true`、
   **绝不**从被自己改动的 priority 重新派生出 true：floor 把 P2/P3 抬到 P1 → markRead 自然变 false，安全方向；marketing 只在 P2 且非敏感时下调，
   始终是「广告→标已读」一致语义、不翻 false→true；noise 仅在 `¬sensitiveGuardFired` 时把 P0/P1/P2 下调 P3，故 noise→P3 标已读与「敏感不自动已读」一致、不冲突。
四轴内置默认**空**：未配置时四轴全 no-op、行为与现状完全一致。当一封邮件被 noise 降级后又被 floor 抬升（round-trip），`appliedRules` **多条共存**（如 `noise→P3` + `vip-important→P1`）属预期审计语义——每步如实记录，非冲突。

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

#### 场景:noise 轴降级非敏感过度高评邮件到 P3 并标已读
- **当** 一封**非敏感**（`¬sensitiveGuardFired`）的 P0/P1/P2 邮件，其发件人精确命中或发件域命中 `noise_senders`，**且发件人不命中 `vip_senders`/`important_domains`**（命中 vip/important 的情形由「vip 救回」场景定义、不在此场景，二者互斥、消除终态歧义）
- **那么** 终末 `priority` **必须**为 P3；`shouldMarkRead` 为 true（静默已读 + 只计数）、`shouldIncludeDigest` 为 false、`shouldNotifyNow` 为 false；`appliedRules` 记 `noise→P3`

#### 场景:noise 轴绝不降级敏感邮件（守「不自动已读」硬底线）
- **当** 一封命中敏感守卫（类别/关键词/验证码/域名任一轴）的邮件，其发件人同时在 `noise_senders`
- **那么** noise 轴**必须** no-op（`¬sensitiveGuardFired` 门控为假）、邮件保持原优先级、`shouldMarkRead` **必须**仍为 false——敏感邮件「不自动标已读」硬底线**禁止**被 noise 轴绕过（规则引擎兜底：守卫 false 粘住）

#### 场景:noise 轴不碰 P4
- **当** 一封 P4（风险）邮件发件人命中 `noise_senders`
- **那么** noise 轴**必须** no-op（P4 不在降级集合）、`shouldNotifyNow` 为 true、`shouldMarkRead` 为 false 不变

#### 场景:vip 救回被 noise 误降（floor 在 noise 之后）
- **当** 一封非敏感 P1 邮件，其发件人同时在 `noise_senders` 与 `vip_senders`
- **那么** noise 先把它降到 P3、floor 再抬回 P1（vip 胜）；终末 `priority` 为 P1、`shouldMarkRead=false`
