## 移除需求

### 需求:定时轮询调度与单账号不重入

**Reason**: 本需求以 MUST 把轮询周期钉在 `POLL_INTERVAL_SECONDS` 上、并要求 pilot 用 node-cron 自建周期调度器与进程内锁——这三样东西本变更都在删或早已不存在。改写它需要写一条**新的**无人实现的 MUST：IMAP 轮询当前根本没有接线（`src/pipeline.ts` 的 `poll` 分支只处理 `provider === 'gmail'` 的账号，全仓无模块 import `src/providers/imap/*`），而节奏与不重入的真实承接方（`app.yaml` 的 `poll` 触发器、hangar daemon 的单活跃-run）都在仓外、本仓无法验证。按本变更的判据，那样只是把一类假描述换成另一类。

**Migration**: 不在本仓侧新建替代物。轮询节奏由仓根 `app.yaml` 的 `poll` cron 触发器 + hangar daemon 承担，不由本仓规范约束（本仓不写一条自己无法验证的 MUST）。**单账号不重入的规范归属不变**：`account-registry`「per-account 调度与故障隔离」仍在描述它，本变更不动那条需求，故本次删除不留下无主的约束。IMAP 轮询的接线缺口本变更同样不处理。
