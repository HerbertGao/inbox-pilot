## 修改需求

### 需求:executeActions 按 FinalDecision 分发并落 mail_actions
`executeActions` 必须只执行 `FinalDecision` 指定的动作——这是「涉及标已读动作」的规则引擎兜底:标已读动作**仅当** `FinalDecision.shouldMarkRead` 为 true 时发起（该值已由规则引擎裁定，P4/敏感/低置信邮件为 false），通知动作仅当 `shouldNotifyNow` 为 true 时发起；**禁止**依据原始 `Classification` 直接动作。每个动作必须先以 `pending` 落 `mail_actions`（**注**：`recordAction` 改为对 `(messageId, actionType)` 活跃行 upsert，**按既有活跃态分流**——命中活跃 **`retrying`** 行 → **保持 `retrying` 原样、不清零 `retryCount`/`nextRetryAt`** 并令 `executeActions` **SKIP 内联重执行**（drain 拥有）；命中活跃 **`pending`** 行 → 复用同行继续执行；无活跃行 → INSERT `pending`。配合活跃态 partial unique index，re-poll 重跑不产生第二条活跃行、不清零 durable 进度，见 `durable-retry` 增量），执行后更新为 `done`/`failed`/`skipped`/`retrying`（含 error）；失败必须有界重试（小常数，**禁止**无限重试），**且重试之间必须指数退避**：起始小常数（如 ~100ms）、**每次重试上限封顶**（如 ≤500ms）、**单封邮件总退避（含分类器退避，见 email-classification 增量）封顶为一个小秒级常数**（如 ≤~1s），防瞬时失败一瞬耗尽预算。**批量推理（退避预算必须按整轮校核、非仅单封）**：一轮 poll 顺序处理 N 封邮件、整轮受 `DEFAULT_POLL_TIMEOUT_MS`(5min) 约束——单封总退避封顶须使常规批量稳落超时内；即便病态全失败批量超时，`scheduler` 的 `raceWithTimeout` **只停等待 + 释放信号量名额**（**不**强行中断在途 poll）；在途 poll **继续按 `FinalDecision` 完成**，故超时本身**不发起任何标已读**、所有标已读仍经 `FinalDecision`（敏感邮件 `shouldMarkRead=false` 仍成立、**无不安全标已读**），per-mail `processedAt` 幂等保证已完成邮件不重处理——属**可用性**界定、非安全失败。退避**延迟本封完成**（仍在有界重试内），但**不得跳过该封其余动作**、各账号独立锁**不影响其他账号**。单个动作失败**禁止**阻断该封其余动作与 `markProcessed`。轮内有界重试是**单次 `executeActions` 调用内**的内存计数器。无渠道凭据时 `notify` 动作必须**直接**落 `skipped`、**不进入重试循环**、不计入重试预算。终态 = **`{done, skipped, failed, dead_letter}`**、中间态 = `{pending, retrying}`（`failed` 仍是 reauth/repo-I/O 致命通道的合法终态，**禁止**从终态枚举丢掉；`dead_letter` 是 durable 重试耗尽/超 staleness 的终态）。**注（孤儿 pending 残留）**：notify 已发出但其 `done` 落库抛出时会留一条 `pending` 行（既非终态亦非 `retrying`，drain 只选 `retrying` 故不重发，动作本身由 re-poll 重发兜底）——本期**不清扫**孤儿 `pending`（既有残留、非本变更引入，行陈旧可查），accepted residue。**发送态瞬时失败在单次调用内有界重试耗尽时，必须落 `retrying`（带 `retryCount`/`nextRetryAt`）而非终态 `failed`**，由 `durable-retry` 能力跨重启 drain 重试至成功或死信（见 `durable-retry` 增量）；`markProcessed` **仍最后无条件执行、不以动作成功为前提**（瞬时失败仍置 `processedAt`，**禁止** re-poll 重跑整条流水线/重新分类/重发其它动作）——durable 重试在 **`mail_actions` 行粒度**只重试那一条失败动作，与 `processedAt` 的 **email 粒度** re-poll 兜底**互补、不重叠**，故瞬时失败的 P0/P4 动作**不再是 at-most-once 永久丢失**。`ProviderReauthRequired`（账号级致命）与终态落库（repo I/O）的向上传播通道**不变**（仍 `failed`/re-throw、跳过 `markProcessed`、由 re-poll 兜底）。**持久化跨重启重试由本期 `durable-retry` 能力落地**（`retryCount`/`nextRetryAt` 列 + poll 内 drain），取代此前「延后」的取舍。`shouldIncludeDigest` 由 P5 的摘要调度消费，**不**在 `executeActions` 内产生动作。

#### 场景:标已读动作只认 FinalDecision
- **当** 一封邮件 `Classification` 建议标已读，但 `FinalDecision.shouldMarkRead` 为 false（如 P4/敏感域名）
- **那么** `executeActions` 必须不发起标已读动作

#### 场景:动作成功落库
- **当** `FinalDecision.shouldMarkRead` 为 true，`executeActions` 经 `ProviderActions` 标已读成功
- **那么** `mail_actions` 必须有一条该动作记录、状态为 `done`

#### 场景:动作失败有界重试且不阻断
- **当** 某个动作（如通知）执行失败
- **那么** 必须以有界重试发送态、不得阻断其余动作与最终 `markProcessed`

#### 场景:重试之间指数退避
- **当** 某动作首次失败、进入有界重试
- **那么** 重试之间必须有指数退避延迟（小常数起始、有上限），不得在一瞬间耗尽重试预算；总重试仍有界

#### 场景:瞬时耗尽落 retrying 而非永久丢失
- **当** 某动作（如 P0/P4 通知）在单次调用内有界重试耗尽仍发送态失败
- **那么** 必须落 `retrying`（带 `retryCount`/`nextRetryAt`）而非终态 `failed`，`markProcessed` 仍照常执行，且该动作由 `durable-retry` 跨重启 drain 兜底（不再 at-most-once 永久丢失）

#### 场景:无渠道降级时通知动作记 skipped
- **当** `shouldNotifyNow` 为 true 但无任何通知渠道凭据（通知器降级）
- **那么** 对应 `notify` 动作必须以 `skipped`（区别于 `done`/`failed`/`retrying`）落 `mail_actions` 并含原因，不阻断 `markProcessed`
