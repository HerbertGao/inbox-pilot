# imap-integration 规范

## 目的
待定 - 由归档变更 imap-end-to-end 创建。归档后请更新目的。
## 需求
### 需求:IMAP 账号加载与持久化锚定
系统必须从配置（环境变量 `IMAP_*`）加载至多一个 IMAP 账号，产出供轮询使用的连接参数与一个**跨重启稳定**的 `accountId`（去重键依赖）。**且在调度器启动前必须确保 `mail_accounts` 存在该 `accountId` 对应行**（`upsert({ where:{id:accountId}, create:{id:accountId, provider:'imap', email:user, authJson:{}, enabled:true}, update:{} })`，**`create` 必须显式 `id = accountId`** 覆盖 `@default(cuid())`、`authJson` 为非空空对象 `{}`）——因为 `mail_messages.accountId` 对 `mail_accounts.id` 有外键约束（`ON DELETE RESTRICT`），缺锚定行或 id≠accountId 或 authJson 为 null 都会使首次 `saveEmail` 触发约束违约、被 poller per-email catch 静默吞掉每封。该 upsert 必须在调度器 arm 前 await 完成、每次启动无条件执行且幂等。env 仍是配置真相源，DB 仅存此锚定行（`provider`/`email` 为只写 denormalization、非真相源；`lastSyncCursor` 等后续游标挂于此行）。改变 `accountId` 来源（user/host 变更或改设 `IMAP_ACCOUNT_ID`）会形成新去重命名空间 + 新锚定行 + 一次性重处理（与 UIDVALIDITY 重置同属 at-least-once）。

配置完整性:`IMAP_HOST` 缺失时，系统必须**不启用** IMAP 轮询且正常启动（IMAP 为可选 provider）；但 `IMAP_HOST` 已设而 `IMAP_USER`/`IMAP_PASSWORD` 缺失时必须 **fail-fast 配置错误**（在 accountService 抛错终止该账号加载，不静默降级、不反复尝试坏连接，不得产出 `imap:undefined@host` 之类残缺 accountId）；该校验属 accountService 层、不在 config 层。IMAP 口令等密钥**只**从环境变量读取，禁止写死、禁止以明文写入日志。

#### 场景:配置齐全则加载账号并锚定 DB 行
- **当** `IMAP_HOST` / `IMAP_USER` / `IMAP_PASSWORD` 等必要项齐全
- **那么** 系统必须产出一个含稳定 `accountId` 的 IMAP 账号配置，并 upsert 对应 `mail_accounts` 行（`id = accountId`、`authJson = {}`），使后续 `saveEmail` 的外键约束成立

#### 场景:锚定行先于调度建立
- **当** 服务启动（含崩溃重启）
- **那么** `mail_accounts` 锚定 upsert 必须在调度器被 arm 之前 await 完成，使首轮轮询的任何 `saveEmail` 都已有父行（无条件执行、幂等）

#### 场景:缺 host 则禁用 IMAP 而非崩溃
- **当** `IMAP_HOST` 未设置
- **那么** 系统必须跳过 IMAP 轮询启动、记录一条信息日志，且服务其余部分（/health 等）正常运行

#### 场景:host 有而凭据缺失则不静默坏连接
- **当** `IMAP_HOST` 已设但 `IMAP_USER` 或 `IMAP_PASSWORD` 缺失
- **那么** 系统必须 **fail-fast 配置错误**（accountService 抛错），**禁止**产出残缺 accountId 或每轮反复发起注定失败的连接

### 需求:轮询并收敛为 NormalizedEmail
IMAP 轮询必须 SELECT INBOX、按增量 UID 游标取新邮件（见「增量 UID 游标避免重复 FETCH」需求；首轮或 UIDVALIDITY 变化时退化为 SEARCH UNSEEN）、FETCH envelope 与文本正文，并把每封原始邮件经 `normalizeEmail` 收敛为 `NormalizedEmail` 后才交给分类流水线。分类器**禁止**接收任何未规范化的原始 IMAP 对象。`envelope.from` 映射必须明确:`fromEmail` 取**裸地址**（`mailbox@host`，不含显示名/尖括号），`fromName` 取显示名——使敏感发件域护栏与通知格式拿到干净地址。`providerMessageId` 必须取**跨重启稳定**的标识(优先 `Message-ID` 头;**规范化=首尾去空白、保留尖括号内内容逐字、不大小写折叠**,使同一邮件跨轮产出一致键);`Message-ID` 缺失时回退为 `imap-uid:<uidValidity>-<uid>`,该回退在**同一 UIDVALIDITY 期内**（含服务重启）稳定，但服务端 UIDVALIDITY 重置时会变（见下「去重键」场景的退化说明）。

#### 场景:未读邮件被收敛并进入流水线
- **当** INBOX 存在未读邮件
- **那么** 每封必须被 FETCH、`fromEmail` 取裸地址、经 `normalizeEmail` 收敛为 `NormalizedEmail`，并调用 `processEmail` 处理

#### 场景:显示名形态的敏感发件人仍触发护栏
- **当** 一封敏感邮件的 `envelope.from` 为显示名形态（如 `客服 <noreply@bank.com>`）
- **那么** 映射出的 `fromEmail` 必须为裸地址 `noreply@bank.com`,使敏感域/规则护栏正常命中

#### 场景:稳定去重键（含退化披露）
- **当** 一封**含 `Message-ID`** 的 IMAP 邮件在两次轮询（含服务重启后）中被 FETCH
- **那么** 两次产出的 `(accountId, providerMessageId)` 必须一致，使第二次经流水线去重被跳过；对**无 `Message-ID`** 的邮件,去重在同一 UIDVALIDITY 期与服务重启间仍稳定,仅在服务端 UIDVALIDITY 重置时可能重处理一次（at-least-once,与流水线既有语义一致,MVP 接受）

### 需求:增量 UID 游标避免重复 FETCH
轮询必须用持久化的增量游标（`mail_accounts.lastSyncCursor`，形如 `<uidValidity>:<uid>`）只取新邮件，避免每轮重复 FETCH 已处理邮件——这是「P0/P1/P4 不标已读、却也不重复扫描」的关键（不靠标已读来抑制重扫）。有效游标轮 SEARCH `UID 游标+1:*`（**不带 seen 过滤**，以保留崩溃重取）；**该增量分支**空结果集即 no-op、游标不变（uidValidity 已匹配、无需重写）。

游标推进规则（**定义在本轮实际取回的 UID 序列上、非 dense 整数区间**——避免 expunge 删除留下的 UID 空洞永久卡死高水位）:取回邮件按 **UID 升序**处理;高水位 = 取回序列中「其及之前所有取回封都已处理」的最高 UID（**经 dedup 早退跳过的 UID 视同已处理**、计入推进），遇首个未成功（失败/跳过/崩溃中断、未 `markProcessed`）的取回 UID 即停在其前。轮末 `setCursor`：**增量轮**写 `<当前uidValidity>:<取回高水位>`。**退化轮（首轮/UIDVALIDITY 变化）**的 floor 按优先级:① 取回全部成功（**含空集**）且 `UIDNEXT`（`mailboxOpen` 给出）为正整数 → `<当前uidValidity>:<UIDNEXT-1>`（当前 UID 上界：当前未读已处理、未来邮件 UID 必 > UIDNEXT-1，既不漏新邮件、也不回扫已读历史）；② 有取回封失败 → `<当前uidValidity>:<取回序列连续高水位>`（失败封下轮重取）；③ `UIDNEXT` 缺失/非正整数（RFC 3501 rev1 允许服务器省略 UIDNEXT）→ 退化为本轮取回连续高水位；④ 连取回高水位也无（空集且无 UIDNEXT）→ `<当前uidValidity>:0`（下轮 `UID 1:*` 一次性全量重扫、dedup 兜底，且已清除 UIDVALIDITY 不一致）。**禁止**写出 `NaN`/非有限游标；**禁止**用旧 UIDVALIDITY 的 prev-uid 作 floor（跨命名空间无意义、会被 `UID prevUid+1:*` 永久跳过低位未读）。退化轮即使取回空集也必须写当前 uidValidity（否则反复 UNSEEN 重扫）；增量分支的「空集 no-op」**仅**适用于 uidValidity 已匹配时。失败/崩溃中断的邮件因游标不越过它，下一轮被重新 FETCH 重试（at-least-once，dedup 经 `processedAt` 保证已处理的不重复）。

首轮（无游标）或邮箱当前 UIDVALIDITY 与游标内记录不一致时，必须退化为 SEARCH UNSEEN 处理当前未读积压、**禁止** FETCH 整箱历史；其稀疏 UID 集同样按上述「取回序列连续高水位」推进。

**已知接受的退化（poison 邮件）**:某 UID 持续失败时游标钉在其前一位，每轮重取它 + 其后全部（其后已处理者 dedup 跳过但仍 FETCH）→ O(积压) 浪费、无死信/skip-after-N。本期接受（安全优先、绝不静默丢弃失败邮件）；死信 / durable 重试预算属 P6。

#### 场景:已处理邮件不再被重复 FETCH
- **当** 一封 P0/P1/P4 邮件已 `markProcessed`、游标已推过其 UID，进入下一轮轮询
- **那么** 该邮件**禁止**被再次 FETCH（SEARCH `UID 游标+1:*` 不含它），即便它在邮箱中仍为未读

#### 场景:失败邮件下轮重取重试
- **当** 某封邮件本轮处理失败/跳过/崩溃中断（未 `markProcessed`）
- **那么** 游标**禁止**越过其 UID，使其下一轮被重新 FETCH 重试；其后已处理的邮件经 dedup 跳过、不重复处理

#### 场景:UIDVALIDITY 变化时安全重扫并重写游标
- **当** 邮箱当前 UIDVALIDITY 与游标内记录不一致（或无游标）
- **那么** 轮询必须退化为 SEARCH UNSEEN 处理当前未读（**禁止** FETCH 整箱历史），dedup 保证含 `Message-ID` 的邮件不被重复处理；轮末必须 `setCursor` 写**当前** UIDVALIDITY + 退化轮 floor（按本需求正文优先级：全成功/空集→`UIDNEXT-1`；有失败→取回连续高水位；UIDNEXT 缺失→见 floor 优先级 ③④），使下一轮回到增量分支、不再反复 UNSEEN

#### 场景:UIDVALIDITY 重置且 UNSEEN 取回空集仍重写游标
- **当** UIDVALIDITY 变化后退化轮 SEARCH UNSEEN 返回零封
- **那么** 轮末仍必须 `setCursor` 写 `<当前 UIDVALIDITY>:<UIDNEXT-1>`（**非** 旧 prev-uid、**非** 0；UIDNEXT 缺失时按正文 floor 优先级 ④ 写 `<当前 UIDVALIDITY>:0`），使下一轮进入增量分支且既不漏新命名空间的低位未读、也不回扫整箱已读；**禁止**因「空集 no-op」保留旧 uidValidity 导致永久 UNSEEN 重扫

#### 场景:expunge 空洞不卡死游标
- **当** 取回区间中某 UID 因用户删除（expunge）而不在取回结果里
- **那么** 高水位按**实际取回序列**推进、不要求该缺失 UID 被处理，故不被永久卡死

### 需求:经规则引擎裁定执行真实标已读
IMAP provider 必须实现 `ProviderActions.markRead`，对指定邮件标 `\Seen`，且实现**幂等**（重复标已读不报错）。标已读动作**只能**由 `executeActions` 在 `FinalDecision.shouldMarkRead` 为 true 时发起——这是「涉及标已读动作」的规则引擎兜底：provider **禁止**自行判断优先级或读取原始 `Classification`，敏感/风险/低置信邮件已由 `applySafetyRules` 将 `shouldMarkRead` 置 false，故**绝不**会被标已读。本变更默认仅标 `\Seen`，不做文件夹移动。`markRead` 消费 `NormalizedEmail.uid`（当前 UIDVALIDITY 下的活动 UID）：poller **必须**为每封转交 `processEmail` 的邮件填充 `uid`；`uid` 缺失时 `markRead` **必须 fail-loud**（抛结构化错误），**禁止**静默 no-op（避免「报告成功但实际没标」）。`markRead` 抛出的错误**必须脱敏为固定 kind 串、零插值**：消息必须是固定 kind 枚举之一，**不得**插入任何连接/账号/服务器值（host/IP/port/user/口令/mailbox/IMAP 命令文本）；原始错误可在 debug 日志另记、但不得进入抛出的消息（仅截断不足以脱敏，因主机串常在前 200 字内）。

#### 场景:仅在裁定标已读时标 Seen
- **当** 一封邮件的 `FinalDecision.shouldMarkRead` 为 true
- **那么** IMAP provider 必须对该邮件标 `\Seen`

#### 场景:P0/P4 等不标已读邮件保持未读
- **当** 一封邮件的 `FinalDecision.shouldMarkRead` 为 false（如 P0/P1/P4、敏感、低置信）
- **那么** IMAP provider **禁止**对其标 `\Seen`，该邮件在邮箱中保持未读

#### 场景:标已读失败脱敏且不阻断处理
- **当** 标 `\Seen` 调用因连接/服务器错误失败
- **那么** 抛出的错误消息**必须等于固定 kind 串、零服务器/账号插值**（测试断言相等，不只是缺子串），该失败落 `mail_actions`，且不阻断其余动作与 `markProcessed`

#### 场景:uid 缺失则 fail-loud
- **当** 转交 `markRead` 的邮件缺活动 `uid`
- **那么** `markRead` 必须抛结构化错误（落 `mail_actions=failed`），**禁止**静默 no-op

### 需求:定时轮询调度与单账号不重入
系统必须用 node-cron 按 `POLL_INTERVAL_SECONDS` 周期触发 IMAP 轮询，并保证**单账号轮询不重入**：cron 回调在进入任何 await 前**同步**获取进程内锁，上一轮尚未结束时新触发必须跳过；锁**必须在 `finally` 中释放**（含轮询抛异常的路径），否则一次轮询异常会永久锁死该账号、再不轮询。

#### 场景:到点触发轮询
- **当** 距上次轮询已达 `POLL_INTERVAL_SECONDS`
- **那么** 系统必须发起一次该账号的未读轮询

#### 场景:慢轮询不重入
- **当** 一轮轮询耗时超过 `POLL_INTERVAL_SECONDS`、下一次 cron 触发到来
- **那么** 系统必须跳过该次触发，直至上一轮结束

#### 场景:轮询抛异常不锁死后续
- **当** 某一轮轮询整体抛出异常
- **那么** 锁必须在 `finally` 中释放，下一次 cron 触发能正常发起轮询（不被永久锁死）

### 需求:单封失败隔离与重启不重复
轮询循环必须逐封 normalize + 处理，并对**单封**的 normalize/处理异常 catch+skip（记录后继续），禁止单封失败中断整批轮询。已处理邮件（`processedAt` 非空）在后续轮询中必须经去重被跳过，保证服务重启后不重复处理。

注:P2/P3 邮件若在标 `\Seen` 后、`markProcessed` 前**崩溃**，因增量游标未越过其 UID，下一轮仍按 `UID 游标+1:*` 被重新 FETCH（**不依赖 UNSEEN**）→ dedup 见 `processedAt`=null → 重跑（标已读幂等）→ `markProcessed` → 游标推进。故无孤儿行——增量游标修复了纯 UNSEEN 模型下「标已读后崩溃→永久跳过」的退化。P0/P1/P4 不标已读，崩溃后同样经游标重取重跑（at-least-once）。

注（区分 markRead **调用失败**，非崩溃）:markRead 重试耗尽仍失败时 executeActions 不抛、落 `mail_actions=failed`，processEmail 仍 `markProcessed`、游标照常推进，该 P2/P3 **保持未读且不再重试**——既有 at-most-once-after-retry 语义（与 notify 一致）；「保持未读」是安全方向（保守不误标已读），接受、**非孤儿**（行已 `markProcessed`、状态于 `mail_actions` 可查）。

#### 场景:单封失败不中断整批
- **当** 某封邮件 normalize 抛出（如缺去重键）或处理抛出
- **那么** 系统必须跳过该封并记录，继续处理同批其余邮件

#### 场景:重启不重复处理
- **当** 服务重启后再次轮询，遇到此前已处理（`processedAt` 非空）的未读邮件
- **那么** 流水线必须经去重跳过，不重复分类/动作

