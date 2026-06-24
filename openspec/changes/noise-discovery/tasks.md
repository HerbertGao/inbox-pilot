## 1. rules-config 第六轴 noise_senders

- [ ] 1.1 `src/rules/rulesConfig.ts`：`KNOWN_KEYS` 加 `'noise_senders'`；`ActiveRules`/`LastValid`/`builtinLastValid`/`assembleActive`/`buildAndPublish` 的 candidate 同步加项（复刻 `marketing_keywords` 的 zod 逐项校验 + carry-forward + freeze）
- [ ] 1.2 `rules/rules.yaml`：加 `noise_senders: []` 示例 + 注释（空默认 = 全 no-op、行为与现状一致）
- [ ] 1.3 `src/rules/rulesConfig.test.ts`：加载/ingest 归一/某项非法仅该项回落 noise_senders 的单测
- [ ] 1.4 回归确认（动 `KNOWN_KEYS`/`buildAndPublish` 不破既有安全契约）：加 `noise_senders` 后，未知/凭据形态键仍被静默丢弃、且**键名绝不入日志**（至多记数量）——既有 rules-config 安全契约，`rulesConfig.test.ts` 覆盖

## 2. safety-rules noise 轴

- [ ] 2.1 `src/rules/applySafetyRules.ts`：在 marketing 轴后、floor 轴前插 noise 块——`priority ∈ {P0,P1,P2} ∧ ¬sensitiveGuardFired ∧ 命中 noise_senders → priority='P3'`，`appliedRules.push('noise→P3')`
- [ ] 2.2 匹配复用现成 helper：`matchesVipSender`（发件人裸地址精确）∨ `matchesDomain`（发件域或子域）对 `rules.noiseSenders`
- [ ] 2.3 `src/rules/applySafetyRules.test.ts`：noise→P3 且标已读；命中敏感守卫时 noise no-op 且保未读（硬底线）；P4 不碰；vip 在 floor 救回；marketing→noise→floor 顺序

## 3. 摘要高频发件人只读区块（Top-N）

- [ ] 3.1 **新增 repo seam** `src/repo/mailRepo.ts` `countRecentSenders(since)`：按 `receivedAt` **最近滚动窗（新增独立命名常量，如近 7 天——不引用不存在的 `DIGEST_MAX_AGE`、不绑 processFrom 水位线）**聚合**全部已处理邮件**的 fromEmail 计数——**含所有优先级（P0–P4）、不经 `digestItems` 去重、显式 select 白名单（仅 fromEmail+计数、不含 bodyText）**。**禁止**复用 `listDigestCandidates`（它丢 P0/P4 + 去重）。Prisma + InMemory 两实现同步
- [ ] 3.2 `src/digest/buildDigest.ts`：用 `countRecentSenders` 渲染「最近高频发件人 TOP-N」只读区块 + 「可加入 noise_senders」提示；数据不足/无邮件优雅退化；**Top-N 只随非空摘要附带**（无 P1/P2/P3 候选时不单独推送、不改既有空摘要抑制）。（VIP 占榜不强制处理——见 design 决策 5 诚实边界；`[vip]` 标注属将来增强，不把 rules 名单灌进纯函数 buildDigest）
- [ ] 3.3 **buildDigest 签名/调用点/类型**：`buildDigest(repo, now)` 加最近窗 `since`（或内部按 now 派生）；扩 `buildDigest` 的 `Pick<MailRepo,...>` 与 `DigestRunDeps`/`DigestSchedulerOptions.repo`（`digestScheduler.ts:112,205`）**加 `countRecentSenders`**（否则类型不过）；同步更新调用点 `runDigestOnce`（`digestScheduler.ts:~129`）
- [ ] 3.4 单测：TOP-N 聚合含 P0/P4 且不去重 + 退化 + 无常规内容时不单独推送 + 断言无 bodyText 字段进入结果对象

> 注：「被 noise 降级的邮件」专用摘要披露行**不在本 change**——「无声消失」残留按 design 决策 6 记为 accepted-minor（operator 显式名单 + appliedRules 已落库可审计 + 打错自暴露 + 敏感门控 + Top-N 助发现）；专用披露基建延后至 ROADMAP 提案 4（自动降级、其自然归属）。

## 4. 验证 + 文档

- [ ] 4.1 全量 `node:test` 绿；`noise_senders: []` 时行为与现状完全一致（四轴全 no-op）
- [ ] 4.2 确认硬底线：敏感邮件即便发件人在 `noise_senders` 仍不自动已读（`¬sensitiveGuardFired` 门控 + 守卫 false 粘住）
- [ ] 4.3 确认审计可见：每条 noise 降级在 `appliedRules` 落 `noise→P3`（可审计）；「无声消失」残留按 design 决策 6 = accepted-minor，专用摘要披露行延后提案 4
