## 上下文

`586dc62`（#35）把 pilot 从独立服务改成 hangar 内 in-process app 时，对 IMAP 侧做了不对称的处理：连接层（`imapClient.ts`，194 行）与动作层（`imapActions.ts`，83 行）原样保留且仍符合规范，**轮询编排层被整个删除**，而规范一条没改。本变更补回中间那一层，并把 Gmail 路径里与 provider 无关的部分抽出来共用。

## 决策

### ① 从 `586dc62^` 取回，而不是重写

被删的 `imapPoller.ts` 里，IMAP 专属算法是这个变更最容易写错的部分，且当年是按现行规范逐条写的：

- 游标 `<uidValidity>:<uid>` 解析，任何非有限/格式不符 → 按首轮处理；
- `advanceHighWater`：按**取回序列**（非 dense UID 区间）推「连续已处理前缀」，故 expunge 空洞不卡死；
- `computeCursorToWrite` 的退化轮 floor 四级优先，含哨兵 `need-max-uid`——退化轮空集且 UIDNEXT 缺失时**禁写 `:0`**（下轮 `UID 1:*` 会无界重扫整箱历史）；
- 增量轮不带 `seen` 过滤（保崩溃重取），并显式处理「RFC 3501 的 `N:*` 即使无 UID ≥ N 也总返回最高 UID」——靠 `processedAt` dedup 早退保安全。

这些结论重写一遍不会更好，只会更可能漏掉其中一条。**取回后要改的是接缝，不是算法。**

### ② 接缝变了三处，必须逐处对齐

| 旧 | 今 |
|---|---|
| `executeActions(email, decision, { repo, messageRowId, ... })`，自己落 `mail_actions` 行 | 签名去掉 `repo`/`messageRowId`，改为返回 `{ reflect, markRead, notify, notifyExhausted }`，由调用方 emit |
| 动作审计落库 | `ctx.emit('reflect.ok' / 'notify.sent' / …)` 走 hangar 事件流 |
| 无 run 生命周期 | per-email 超时 + `Fence`（超时后挡掉晚到的 emit/markProcessed）+ per-run 墙钟 + `AbortSignal` |

第三条是最容易漏的：旧 poller 的 `processOne` 是裸 try/catch，没有 fence 概念。IMAP 路径必须与 Gmail 路径**共用**这套包装，而不是各写一份——否则超时语义会在两个 provider 上分叉。

### ③ 共享点划在 `NormalizedEmail`，因为规范就是这么划的

「分类器**禁止**接收任何未规范化的原始 IMAP 对象」「经 `normalizeEmail` 收敛为 `NormalizedEmail` 后才交给分类流水线」——规范已经指定了边界。故抽出的共享函数取一个已归一的 `NormalizedEmail`（外加 `accountId` / `providerMessageId` / 复访标记），两个 provider 各自负责「取到并归一」。

不共享取件端：Gmail 是 `messages.get` + 两级读错误分流（429 结束本轮 / 401·scope-403·invalid_grant 结束本轮并持久 suspend），IMAP 是 `fetchByUid` + expunge 返回 null。错误分类学完全不同，强行统一会把两边的分流逻辑都拧坏。

### ④ 轮次串行的前提在仓外，但可验证

「增量 UID 游标」需求的正确性依赖同账号轮次不重叠——两轮重叠时慢轮的 `setCursor` 会覆盖快轮高水位，退化轮 floor ④ 还会写 `:0` 触发整箱重扫。

该前提由 hangar 持有：`packages/core/src/cli.ts` 的 daemon 维护一个 per-app `inFlight` 集合，`if (inFlight.has(app.id))` 时跳过本次 tick。它对 pilot 的义务是反向的一条——hangar 自己的注释写着「a pilot's `run()` **MUST self-bound its time**; a hung run permanently pins inFlight and that app never [runs again]」。既有 per-run 墙钟满足它。

本变更为此新增一条需求把这个前提写进规范，**而不是**假设读者会去仓外读 hangar 的源码。

### ⑤ 游标既存值决定了首轮形态，这是好事

生产该账号 `lastSyncCursor = 1:1321162911`。恢复后首轮直接走增量分支 `SEARCH UID 1321162912:*`：

- **不**是退化轮，故不做 `SEARCH UNSEEN`——迁移这三周里若该邮箱被别的客户端读过，那些邮件不会因为「已读」而被漏掉；
- **不**重扫整箱，故不会把三周前的历史邮件当新邮件处理一遍；
- 若服务端 UIDVALIDITY 在这期间变过，`parsed.uidValidity !== uidValidity` 会判退化轮并按 floor 优先级安全重扫——这条路径已被既有算法覆盖。

## 风险 / 取舍

- **恢复轮询即恢复写操作**。该邮箱三周没被 pilot 碰过，首轮会对判定 `shouldMarkRead` 的邮件真实写 `\Seen`。规范既定行为，但值得在部署步骤里单列一条「首轮后人工确认标已读结果符合预期」。
- **抽取共享链会动 Gmail 路径**。这是本变更唯一触及现有工作代码的地方，回归风险集中在此：现有 Gmail 测试必须全绿且**不修改**，是这次重构正确性的主要证据。
- **475 行取回不等于 475 行可用**。接缝改动可能显著改写其中的 `processOne` 与 deps 形态；实际落地行数以最终 diff 为准，不在提案里承诺。
