## 上下文

- **现状管线**（`src/rules/applySafetyRules.ts`）：① 定 priority → ② 算 `sensitiveGuardFired` → ③ marketing 轴（P2→P3、`¬guard` 门控）→ ④ floor 轴（vip/important、P2/P3→P1）→ ⑤ 派生动作（`shouldMarkRead = (P2∨P3) ∧ ¬guard`，守卫 false 粘住）。
- **现状配置**（`src/rules/rulesConfig.ts`）：五类可配置名单从 `rules/rules.yaml` 热重载（逐项 zod 校验 + carry-forward + ingest 归一 + 256KB 上限 + 脱敏日志 + 深冻结）。`marketing` 是新增**第六类名单** `noise_senders` 的现成模板（注：rules-config 计「第六类名单」、applySafetyRules 管线计「第四轴」，两计数维度不同，勿混）。
- **现状摘要数据源**（`src/repo/mailRepo.ts:951` `listDigestCandidates`）：**经 `digestItems:{none}` 去重 + 只保留 P1/P2/P3（行 1006 起，P0/P4 丢弃，其出口是即时推送）**——这决定了 Top-N **不能**复用它（见决策 5）。
- **通知纯出站**：全仓无 `getUpdates`/`callback_query`/`webhook`/`inline_keyboard`；fastify 只挂 `/health`。任何「按钮」都需从 0 建入站子系统。
- **实证**：过度评级 93%；残留尖峰是**固定少数高频发件人**（NAS 每日、HKSS 每周）。
- **与 `rating-calibration-prompt` 的关系**：文件/spec 层面无重叠（可并行），但存在**单向数据依赖**——noise 的收益规模 = prompt 校准后的**残差**。若校准把 NAS/HKSS 一起压进 P3，`noise_senders` 可能上线即空跑（空名单 = no-op、零害，是可接受下限）。这正是把它做成「operator 显式录入 + 摘要发现」而非自动轴的另一理由：按需启用。

## 目标 / 非目标

**目标：**
- 给 operator「发现 + 录入 + 确定性降级」高频噪音发件人的低门槛通路，兜住 prompt 校准后的残留尖峰。
- **绝不**触碰「敏感邮件不自动已读」硬底线；被降级**可审计**（每决策 `appliedRules` 落库）——残留的无声 P3 风险按决策 6 = accepted-minor（专用摘要披露行延后提案 4）。

**非目标：**
- 不做 Telegram 交互按钮 / 任何入站子系统（见决策 4）。
- 不做「点降级→自动学习成规则」（撞 §18.2 + 敏感发件人地址复用风险）。

## 决策

**决策 1：`noise_senders` 只匹配「发件人精确 + 域名后缀」，不匹配主题。**
复用现成 `matchesVipSender`（裸地址精确）+ `matchesDomain`（域或子域）。
- 备选：结构化 `{sender?, domain?, subject?}` 项 / 拆 `noise_senders`+`noise_subjects` → 否决（过度工程；实证尖峰按发件人/域足矣）。
- **诚实边界**：主题噪音由既有 `marketing_keywords` 轴承载——但 marketing **只降 P2→P3、够不着 P0/P1**。故「P0/P1 的非营销主题噪音」既不被 marketing 命中、noise 又不匹配主题 = 残留缺口。取舍：实证尖峰按发件人足矣，不为此设 `noise_subjects`（缺口可由 ③A prompt 校准从源头压）。

**决策 2：管线位置 = marketing 轴后、floor 轴前，`¬sensitiveGuardFired` 门控。**
- 在 floor **之前** → 若 operator 误把一个 vip/important 发件人列进 noise，floor 仍能把它抬回 P1（**vip 胜**，安全方向）。
- `¬sensitiveGuardFired` 门控 → 命中敏感守卫的邮件**根本不进** noise 降级，「敏感不自动已读」底线结构性保住。

**决策 3：降级目标 = P3（静默已读 + 只计数）。**
命中的 **P0/P1/P2**（`¬guard`）→ **P3**。P4 不在集合（绝不碰风险邮件）；P3 已是 P3 则 no-op。P3 = 不推送、不入摘要、标已读——精确对应「我就是嫌它吵」。`shouldMarkRead` 仍在 ⑤ 单点派生（`(P2∨P3) ∧ ¬guard`）：noise→P3 且 `¬guard` ⇒ 标已读（静默），与 ⑤ 的 false 粘住不矛盾。
- 备选：降一级（P0→P1）/ 降到 P2（仍入摘要）→ 否决（达不到「静默」诉求）。
- **显性假设**：固定 P3 = 「operator 录入 `noise_senders` 即等价于声明『永久静默此发件人』」，**不区分**「系统性过评的真噪音」与「本就 P1/P2 的中等邮件」。这是可接受的简化（operator 已显式表达静默意图），不拆 noise 等级（那才是过度工程）。误降可见性由决策 6 闭合。

**决策 4：Telegram 交互按钮——已评估·暂缓（分阶段触发器）。**

```text
Stage 0 ── 现在（单用户 · 本 change 覆盖）
  治本 prompt 校准（并列 change）+ 摘要 Top-N 只读发现 → operator 编辑 rules.yaml 录入 noise_senders
  入站面：无
Stage 1 触发 ── 仍单用户，但实测 Stage 0 不够（需同时成立）：
  · prompt+YAML 后残留噪音仍高　· 频繁「手机当下」想消音、CLI/SSH 够不着
  → 最小入站：long-poll + 单按钮「别烦我」（一次性标已读、不学习）
Stage 2 触发 ── 第 2 个用户出现 = 决定性触发：
  · 单一 TELEGRAM_CHAT_ID 信任锚失效 → 需 per-user 绑定+鉴权
  · 非技术用户无法编辑 YAML/CLI → 按钮成唯一录入口
  · 多人通常 central 托管 → 有公网入口 → webhook 重新可行（摆脱 long-poll 单实例约束）
  · per-user 入站路由
  → 解冻完整交互子系统，并重估 §18.2 规则学习（按钮喂养）
```

**Stage 2 诚实标注**：对一个明确单人自用（自己 3 个邮箱）的项目，「第 2 个用户」现实命中概率接近零——Stage 2 是「**若项目性质从自用变为多用户托管**」的**假设性分叉**，非路线图上的预定里程碑（≈ YAGNI/暂不做，保留升级路径而已）。

**若做按钮的前置拦路石**（届时必须先解，本身即暂缓决策留下的资产）：long-poll 单实例约束 + offset 持久化；callback_data 64B 上限 → 用 `MailMessage.id`（cuid）间接句柄 + DB 反查防篡改；`from.id == TELEGRAM_CHAT_ID` 鉴权；`MailAction` 幂等去重；**IMAP `markRead` 连接绑定**（`src/providers/imap/imapActions.ts:7-10` 依赖当轮 poll 的 live 连接 + session UID）→ out-of-band 标已读须为 IMAP 重建连接（Gmail 无此坑）。

**不做的理由**：一次性「降级」按钮**近乎空操作**（邮件已推送完，无待发通知可改）；「点降级→学习成规则」撞 §18.2「规则学习」暂缓，且**敏感发件人地址复用**（`noreply@bank.com` 既发营销也发安全告警）一键拉黑会误杀未来 P0/P4。

**决策 5：摘要 Top-N 的数据源 = 新增 repo seam，绝不复用 `listDigestCandidates`。**
proposal 承诺「最近高频发件人 / 谁最吵」= **跨时间累计发送频率、含所有优先级**。但 `listDigestCandidates`（决策上下文）**去重已摘要邮件 + 丢弃 P0/P4**——若 Top-N 复用它，会**系统性漏掉最吵的告警类（P0/P4）、并因去重低估高频**，发现通路失效（与本 change 核心收益冲突）。
- **决策**：新增 `MailRepo` 方法（如 `countRecentSenders(since)`）：按 `receivedAt` 时间窗聚合**全部已处理邮件**、**不经 `digestItems` 去重**、**含所有优先级（P0–P4）**、**显式 select 白名单（仅 `fromEmail` + 计数，杜绝正文）**。`buildDigest` 用它渲染 Top-N。
- **时间窗 = 一个独立命名常量的「最近滚动窗」（如近 7 天）**。这是**频率快照**、与既有「摘要候选不得带固定年龄上限」规则**正交**（那规则护的是别按年龄漏掉未摘要邮件；Top-N 只是发现辅助）。**不引用** `DIGEST_MAX_AGE`（经核**不存在**于 src/），**不**声称与 onboarding-watermark 的 `processFrom` 一致（那是按账号水位线、语义不同）。近窗**限制**历史影响，但**不等价于** `processFrom`——近窗内的接入前历史邮件仍可能计入（频率快照可接受、非候选纳入）。
- **VIP 占榜诚实边界（不强制处理）**：`countRecentSenders` **不排除** vip/important，高频 VIP 可能出现在 TOP-N。**不强制**特殊处理：operator 认得自己配的 VIP、不会误加 noise（即便误加 floor 也救回 P1）。`[vip]` 标注/末位排序属**将来增强**——需把 vip/important 名单注入 digest，而 `buildDigest` 当前为**纯函数、无 rules 通路**（`getActiveRules` 不在 digest 路径）；不为此装饰破坏其可注入测试纪律。
- **空摘要交互（范围克制）**：Top-N **只随非空摘要附带**——既有「无 P1/P2 且 P3=0 不推空摘要」**不变**（不出 MODIFIED delta）。某 run 若无 P1/P2/P3 候选（即便近窗有 P0/P4 高频源），不单独为 Top-N 推送；Top-N 是滚动辅助、下份非空摘要再现。否决「为只读发现项新增空摘要触达路径」（过度）。

**决策 6：「无声消失」残留 = 诚实记录 + 降噪可见性靠现有手段；专用披露行延后到提案 4。**
误降风险：operator 误列发件人（地址打错、域写太宽如把 `notifications.github.com` 写成 `github.com`）→ 一封重要邮件 P0/P1 → P3 静默已读、不入摘要。**floor 只救 vip/important**（`applySafetyRules.ts:198-206`），救不回「未列入 vip/important 但确实重要」的发件人。
- **取舍（经 4 轮 review 收敛）**：曾设计「摘要新增一行披露今日 noise 降级 N 条」闭合此缺口，但其干净实现需 final priority（专列）+ `appliedRules`（埋在 `rawAiJson` JSONB、全仓无 JSON-path 查询）双重筛选，是反复生 finding 的不成比例复杂度（独立投影/类型污染/round-trip 过报等）。**对 operator 显式 noise 名单，残留有界**：① 名单是**显式人工录入**（非自动）；② 打错地址**自暴露**（目标噪音源仍持续到达、operator 会复查该条）；③ `appliedRules:['noise→P3']` **每决策已落库**（`rawAiJson.finalDecision`，可审计）；④ 敏感守卫门控保证敏感邮件根本不进降级；⑤ Top-N 帮发现高频源。真正的残留 = 「over-broad 域 + 非敏感 + 非高频的一次性重要邮件」无声 P3——**降级为 accepted-minor**（operator 配置错、可审计、部分自暴露）。
- **专用披露行延后到 ROADMAP 提案 4**：提案 4 是 auto-recurrence **自动**降级，无声消失更危险（非 operator 显式）、且**强制**需要「每日摘要一行让人看见被静默了什么」（见 ROADMAP 提案 4 节）。那套披露基建（含可查的降级信号）的**自然归属是提案 4**，届时同时覆盖自动 + 手动降级，避免在本 change 为手动名单单独造一套别扭的 JSONB 筛选。

## 风险 / 权衡

- **[operator 误列发件人 → 重要邮件被静默至 P3]**（accepted-minor，决策 6）→ ① operator 显式名单（非自动）；② 打错地址自暴露（目标噪音源仍到达）；③ `appliedRules:['noise→P3']` 每决策已落库可审计；④ 敏感守卫门控（敏感邮件根本不被降级）；⑤ floor 救回 vip/important；⑥ Top-N 助发现高频源。**诚实边界**：真正残留 = over-broad 域命中的「非敏感+非高频+一次性重要」邮件无声 P3——专用摘要披露行延后提案 4（其自然归属）。
- **[noise 降级把非敏感 P0 标已读]** → 这是**预期**行为（operator 显式声明该发件人为噪音）；敏感守卫门控保证敏感邮件永不落此路径。
- **[noise→P3→floor→P1 round-trip 的 appliedRules 多条共存]**（`noise→P3` + `vip-important→P1`）→ 非 bug、每步如实记录，属预期审计语义（spec 已注）。
- **[摘要 Top-N 泄露正文]** → 决策 5 的查询显式 select 白名单（仅 fromEmail + 计数），结构上不含正文。

## 迁移计划

- `rules/rules.yaml` 加 `noise_senders: []` 示例（空默认 = 全 no-op、行为与现状完全一致）。
- 新增 `countRecentSenders` repo seam（决策 5）；无 schema 迁移（只读聚合既有表）。回滚 = 移除 noise 轴块 + 配置项 + Top-N 区块 + repo seam。
