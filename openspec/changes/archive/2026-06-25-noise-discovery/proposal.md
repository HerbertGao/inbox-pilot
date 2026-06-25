## 为什么

即便收紧分类 prompt（并列的 `rating-calibration-prompt` 治本），仍会有**固定少数高频发件人**持续刷屏（实证：NAS 每日告警、HKSS 每周）。需要一条**低门槛通路**让 operator 发现这些尖峰并**确定性降级**——且绝不触碰「敏感邮件不自动已读」硬底线。

原 ROADMAP 提案 3 设想的「Telegram 交互降级按钮」经架构 + 产品双视角评估后**暂缓**（单用户下属过度工程；详见 design.md 的分阶段触发器）。本 change 取其「发现 + 录入 + 降级」的真实收益，用**零入站面**的方式实现。

**与 `rating-calibration-prompt` 的依赖关系（诚实披露）**：文件/spec 层面无重叠、可并行，但存在**单向数据依赖**——本 change 的收益规模 = prompt 校准后的**残差**。若校准把 NAS/HKSS 一并压进 P3，`noise_senders` 可能上线即空跑（空名单 = no-op、零害，是可接受下限）。这正是把它做成「operator 显式录入 + 摘要发现」而非自动轴的另一理由：按需启用。

## 变更内容

- **新增第六类可配置名单 `noise_senders`**（发件人精确 / 域名后缀）：命中且**非敏感**的 **P0/P1/P2** 邮件**确定性降级**到 **P3**（静默已读 + 只计数；不降到 P2/不降一级）。复用既有 `marketing` 轴模板与热重载 / carry-forward / 脱敏日志 / ingest 归一机制。
- **每日摘要新增「最近高频发件人 TOP-N（可加入 noise_senders）」只读区块**：零入站面的发现通路，operator 一眼看到谁最吵、复制进 YAML 即可。**数据源须经新 repo seam**（按 receivedAt 最近滚动窗聚合全部已处理邮件、含 P0/P4、不去重）——**不复用** `listDigestCandidates`（它丢 P0/P4 + 去重、会漏掉最吵的告警源）；**只随非空摘要附带**（不改既有空摘要抑制）。

## 功能 (Capabilities)

### 新增功能
<!-- 噪音轴并入既有 safety-rules/rules-config；发现区块并入 daily-digest；不新建 capability。 -->
（无）

### 修改功能
- `rules-config`: 新增第六类可配置名单 `noise_senders`（zod 校验、carry-forward、ingest 归一，与现有五类同等待遇；验证码 / 敏感类别集仍内置、不可 YAML 配）。
- `safety-rules`: 在既有可配置轴管线新增 **noise 轴**——置于 `marketing` 轴后、`floor` 轴前，`!sensitiveGuardFired` 门控；**只降 priority**（命中的 P0/P1/P2 → 降级），**绝不**解除「敏感不自动已读」护栏（守卫 false 粘住、不被 priority 改动重新派生为 true）。
- `daily-digest`: 摘要新增「高频发件人 TOP-N」只读区块（经新 repo seam、含 P0/P4、不去重、只随非空摘要）。「无声消失」专用披露行延后提案 4（见 design 决策 6）。

## 影响

- **代码**：`src/rules/rulesConfig.ts`、`src/rules/applySafetyRules.ts`、`src/repo/mailRepo.ts`（新 `countRecentSenders`）、`src/digest/buildDigest.ts`（+ `since`）、`src/digest/digestScheduler.ts`（调用点 + repo Pick）、`rules/rules.yaml`（示例）。CLI `mute` 见非目标（不在本期）；「无声消失」专用披露行延后提案 4。
- **规范**：`safety-rules`、`rules-config`、`daily-digest`。
- **入站交互（Telegram 按钮）= 已评估·暂缓**：分阶段触发器（Stage 0 现状 / Stage 1 单用户实测不足 / Stage 2 第 2 个用户）与若做的前置拦路石全部记入 design.md。

## 非目标

- **不做 Telegram 交互按钮 / 任何入站子系统**（评估结论：单用户过度工程；通知当前纯出站，按钮需从 0 建 long-poll 入站 + 信任边界扩张；详见 design 触发器）。
- **不做「点降级 → 自动学习成规则」**（撞 PROJECT_INIT §18.2「规则学习」暂缓 + 敏感发件人地址复用风险：`noreply@bank.com` 既发营销也发安全告警）。
- 不触碰验证码 / 敏感类别内置名单；不改 prompt（那是 `rating-calibration-prompt`）。
- noise 轴**绝不**清除 `shouldMarkRead` 硬底线；绝不降级命中敏感守卫的邮件。
- **CLI `inbox-pilot mute <sender>` 留作将来**（非本期）：录入 `noise_senders` 的真实下限是直接编辑 `rules.yaml`（已有热重载、改即生效），且摘要 Top-N 已把发件人地址列出可直接复制——`mute` 边际收益薄，移出本期范围避免实现期被夹带；若日后明确要一键录入再单列。
- 不引入向量库 / 多用户 / GUI。
