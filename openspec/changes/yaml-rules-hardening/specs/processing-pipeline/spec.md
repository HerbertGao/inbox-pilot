## 修改需求

### 需求:executeActions 按 FinalDecision 分发并落 mail_actions
`executeActions` 必须只执行 `FinalDecision` 指定的动作——这是「涉及标已读动作」的规则引擎兜底:标已读动作**仅当** `FinalDecision.shouldMarkRead` 为 true 时发起（该值已由规则引擎裁定，P4/敏感/低置信邮件为 false），通知动作仅当 `shouldNotifyNow` 为 true 时发起；**禁止**依据原始 `Classification` 直接动作。每个动作必须先以 `pending` 落 `mail_actions`，执行后更新为 `done`/`failed`（含 error）；失败必须有界重试（小常数，**禁止**无限重试），**且重试之间必须指数退避**：起始小常数（如 ~100ms）、**每次重试上限封顶**（如 ≤500ms）、**单封邮件总退避（含分类器退避，见 email-classification 增量）封顶为一个小秒级常数**（如 ≤~1s），防瞬时失败一瞬耗尽预算。**批量推理（退避预算必须按整轮校核、非仅单封）**：一轮 poll 顺序处理 N 封邮件、整轮受 `DEFAULT_POLL_TIMEOUT_MS`(5min) 约束——单封总退避封顶须使常规批量稳落超时内；即便病态全失败批量超时，`scheduler` 的 `raceWithTimeout` **只停等待 + 释放信号量名额**（**不**强行中断在途 poll）；在途 poll **继续按 `FinalDecision` 完成**，故超时本身**不发起任何标已读**、所有标已读仍经 `FinalDecision`（敏感邮件 `shouldMarkRead=false` 仍成立、**无不安全标已读**），per-mail `processedAt` 幂等保证已完成邮件不重处理——属**可用性**界定、非安全失败。退避**延迟本封完成**（仍在有界重试内），但**不得跳过该封其余动作**、各账号独立锁**不影响其他账号**。单个动作失败**禁止**阻断该封其余动作与 `markProcessed`。重试是**单次 `executeActions` 调用内有界**——内存计数器，只把终态 `done`/`failed` 落 `mail_actions`（无 retryCount 列、不跨重启累计）。无渠道凭据时 `notify` 动作必须**直接**落 `skipped`、**不进入重试循环**、不计入重试预算。`{done, failed, skipped}` 为终态、`pending` 为唯一中间态。P0/P4 通知在单次调用内重试耗尽仍失败时，必须以 `failed` 落 `mail_actions` 且 `markProcessed` **仍然照常执行**（该邮件不再重试）；这是接受的 **at-most-once-after-retry** 丢失，`markProcessed` **不**以通知成功为前提。**持久化跨重启重试/投递队列经 P6 评估后仍延后**（需重试 sweep + retryCount 列/单调键，非 §19 必需；本期以 in-call 有界重试 + 指数退避足够，未 `markProcessed` 的邮件由 restart 重跑兜底）。`shouldIncludeDigest` 由 P5 的摘要调度消费，**不**在 `executeActions` 内产生动作。

#### 场景:标已读动作只认 FinalDecision
- **当** 一封邮件 `Classification` 建议标已读，但 `FinalDecision.shouldMarkRead` 为 false（如 P4/敏感域名）
- **那么** `executeActions` 必须不发起标已读动作

#### 场景:动作成功落库
- **当** `FinalDecision.shouldMarkRead` 为 true，`executeActions` 经 `ProviderActions` 标已读成功
- **那么** `mail_actions` 必须有一条该动作记录、状态为 `done`

#### 场景:动作失败有界重试且不阻断
- **当** 某个动作（如通知）执行失败
- **那么** 必须以 `failed`（含 error）落 `mail_actions` 并有界重试，且不得阻断其余动作与最终 `markProcessed`

#### 场景:重试之间指数退避
- **当** 某动作首次失败、进入有界重试
- **那么** 重试之间必须有指数退避延迟（小常数起始、有上限），不得在一瞬间耗尽重试预算；总重试仍有界

#### 场景:无渠道降级时通知动作记 skipped
- **当** `shouldNotifyNow` 为 true 但无任何通知渠道凭据（通知器降级）
- **那么** 对应 `notify` 动作必须以 `skipped`（区别于 `done`/`failed`）落 `mail_actions` 并含原因，不阻断 `markProcessed`
