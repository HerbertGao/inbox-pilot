## 上下文

P3 交付：单 env IMAP 账号端到端；数据层/流水线已**按 accountId 键化**（去重键 `(accountId, providerMessageId)`、`getCursor/setCursor(accountId)`、`ensureAccountAnchor`、`processEmail`）。`MailAccount` 表已存在（id/provider/email/authJson/lastSyncCursor/enabled），P3 只用它当 FK 锚定行（authJson 空、IMAP 凭据在 env），并**显式设 `create.id = accountId`** 覆盖 `@default(cuid())`（`buildAnchorUpsertArgs`）。`ProviderActions` 仅 `markRead(email)`；scheduler 单账号、进程内 `isPolling` 锁、无全局并发上限、无 poll 超时。

P4 把账号加载层从「env 单账号」升级为「DB 注册表 + N 账号 + 两种 provider」，并接入 Gmail。**用户决定凭据模型为统一**：全部凭据入 `MailAccount.authJson`。

## 目标 / 非目标

**目标：**
- Gmail 账号端到端（OAuth、轮询、AI/* 标签分流），与 IMAP 共用 P2 流水线。
- 统一多账号注册表：从 DB 加载 N 个 enabled 账号（imap|gmail），per-account 调度 + 故障隔离 + 并发上限。
- 统一凭据模型：凭据入 authJson；P3 的 env-IMAP 迁入注册表。
- 一个 `Provider`/`ProviderActions` 抽象让 scheduler 多态迭代两种 provider。

**非目标：**
- GUI / 账号面板（onboarding 仅 CLI）；authJson at-rest 加密 / vault；Gmail Push/watch；historyId 增量（先 list-unread + dedup）；摘要(P5)/YAML/durable 重试(P6)；Outlook；账号热重载（CLI 改账号需重启）。

## 决策

**1. 凭据模型：统一 authJson（已定）。** `MailAccount` 是唯一账号真相源。authJson 结构按 provider：
- imap：`{ host, port, user, password, tls }`。
- gmail：`{ refreshToken, scopes }`（access token 运行期由 refreshToken 换、不长存；Gmail app 凭据 `GMAIL_CLIENT_ID/SECRET/REDIRECT_URI` 仍从 env——那是 app 凭据非账号凭据）。

放宽 CLAUDE.md「密钥只从 env」→ 账号凭据存 DB authJson（用户已确认；at-rest 加密留后续）。**redaction（主控 = 整体 redact `authJson` 对象）**：pino redact 按 key-path、不支持任意深度/key 后缀通配，父键 redact 会 censor 整棵子树——故 `authJson`/`*.authJson` 对子树内凭据**无视深度/casing** 全覆盖，是稳健做法；辅以叶子键 `password`/`refreshToken`/`accessToken` + **snake_case** `refresh_token`/`access_token`（google-auth-library / token 端点用 snake_case；运行期 OAuth2 client 的 `credentials.access_token`/`tokens` 不在 authJson 内、需单独覆盖）+ 含数组路径。**禁打印**账号/注册表对象整体、OAuth2 client 对象、token 响应、原始 Prisma/OAuth/IMAP 错误对象（只记 `code`/脱敏 message）。
- *备选*：env-list（IMAP 守 env）——被否；Gmail token 动态必须入 DB，统一更简，用户选统一。

**2. accountId == MailAccount.id，单一解析器（关键）。** `accountId`（去重/游标命名空间）**就是** `MailAccount.id`；所有写入路径（CLI add / 迁移）**显式设 `id`**、**覆盖 `@default(cuid())`**——延续 P3 `buildAnchorUpsertArgs` 的显式 id。否则 cuid 默认生效 → `MailAccount.id` ≠ `NormalizedEmail.accountId` → 每次 `saveEmail` FK 违约（CLI 账号）或去重键换命名空间 → 历史邮件全部重复处理。**CLI add 与迁移共用同一确定性派生**：gmail = `gmail:<getProfile().emailAddress 仅小写>`；imap = 确定性 `imap:<user>@<host>`，CLI add 以此 id **upsert**（主键去重、同邮箱重加命中同一行——**不**按 user@host 模糊查既有行，无此可查列：`MailAccount` 仅 `email`/`provider`/`authJson`，P3 还把 email 写成 `account.user`）。**legacy `IMAP_ACCOUNT_ID` 连续性由一次性迁移独占**（迁移设 `id`=P3 实际 accountId）；CLI 不得派生式重加 legacy-自定义-id 账号致分裂——提供 `--account-id` 对齐或文档「legacy 账号仅经迁移接入」。`MailAccount.email`（NOT NULL）：gmail=getProfile 邮箱；imap=`--email` 或回落 `user@host`（best-effort）。`accountRegistry.loadEnabledAccounts()` 启动期一次性加载（CLI 改账号需重启，`// ponytail: 启动期加载；热重载留后续`）。

**3. Provider 抽象（两层 seam）。** scheduler 面向 **poller**（per-account/per-poll 构造，`poll()`：取新邮件→`NormalizedEmail`→`processEmail`，注入本轮 repo + ProviderActions）；`executeActions` 持有 **`ProviderActions`**（动作 sink，由 `pollOnce` 在**本轮连接内**构造注入）：
- `markRead(email)`：IMAP 加 `\Seen`；Gmail 去 `UNREAD`（`shouldMarkRead` 时调）。
- `reflectPriority(email, decision)`：Gmail 加权威 `AI/P*` 标签（按需创建）；IMAP 本期 no-op。**始终**调用（标签是分类可见性，不被 shouldMarkRead 门控）；**幂等** + 与 markRead/markProcessed **失败隔离**（发送态失败只落 mail_actions；终态落库 I/O 故障向上传播由 at-least-once 重跑兜底，标签幂等重打无害）。

`reflectPriority`/`markRead` 放在 `executeActions` 实际持有的 `ProviderActions`（沿用 P3 seam、新增 reflectPriority），**不**放在 scheduler 面向的 poller 上；scheduler 只迭代 poller 工厂、不持长生命周期动作方法。**IMAP 连接共享（硬性）**：IMAP 的 ProviderActions 必须由 `poll()` 本轮连接构造并在其上操作（P3 `createImapProvider(connection)`），禁另开/陈旧连接；Gmail 无状态 HTTP 无此约束。
- *备选*：把标签塞进 markRead——否，标签不该被 shouldMarkRead 门控（P0/P4 不去 UNREAD 但仍要打标签）。把 reflectPriority 放 poller——否，executeActions 持有的是 ProviderActions。

**4. Gmail OAuth（Desktop-app loopback + 防护，已定）。** `account add --gmail` → 用 `GMAIL_CLIENT_*`（Desktop-app client）生成 authorize URL → 用户授权 → **loopback 一次性本地回调**（仅绑 `127.0.0.1`、**先绑临时空闲端口、再用该端口构造唯一精确 `redirect_uri`，授权 URL 与 `getToken` 两处用同一含端口精确串**——Desktop client 无需在 GCP 预注册具体端口，但两处 redirect_uri 必须**精确一致含端口**，否则 `redirect_uri_mismatch`）→ 换 refresh token 存 authJson。运行期用 `google-auth-library` OAuth2 client 自动 refresh。
- **禁 OOB**（`urn:ietf:wg:oauth:2.0:oob` 已于 2022 停用，运行期会失败）；从 onboarding 移除「粘贴 code」路径。
- 必须 `access_type=offline` **+ `prompt=consent`**（后者保证**已授权过的账号**也返回 refresh token——常见坑）；**缺 refresh token 仍显式失败**作兜底、不建残缺账号，文档给 revoke-重试 路径。
- 必须 **PKCE**（S256）；`code_verifier` 优先用 `generateCodeVerifierAsync()`（避免手搓 base64url 编码错致 PKCE 静默失效）；verifier 必须回传进 `getToken`，有测试断言 verifier 全程一致（否则 PKCE 被静默旁路）。已安装应用 client secret 非机密（随机器分发），PKCE 才是防授权码截获的实质防护。
- 必须 **`state`**（`crypto.randomBytes`）+ 回调常量时间校验；`state`/`code` **只消费一次**（拒绝并发/重复回调）；回调 `error=`（如 `access_denied`）干净中止、不换 token；监听器 `finally` 关闭 + 同意超时。
- account email **仅**取 `users.getProfile().emailAddress` 并**仅小写规范化**（信任 getProfile 的规范地址，**不**剥点/`+tag`、不折叠 googlemail≡gmail——剥点会误并不同 Workspace 地址），派生 `gmail:<email>`；**禁** `id_token`（需 openid/email scope、违反 scope 恰等约束）。
- **scope 恰等白名单 `{https://www.googleapis.com/auth/gmail.modify}`（全 URL 形式贯穿，测试以规范化单元素集精确相等断言）**；禁 `gmail.send`/`gmail.compose`/`https://mail.google.com/`/`openid`/`email` 等。注意 `gmail.modify` **技术上也接受 `messages.send`**——故「绝不发送」由**代码**保证（provider 无 send 方法、全路径无 `messages.send`、有断言测试），不由 scope 边界保证。refresh 失败 → 该账号隔离（**只记 `error.code`+固定 kind，禁记 `GaxiosError` 的 `.response`/`.config`/原始对象/`cause` 链**——其含 `refresh_token`/`client_secret` 字符串子串、key-redact 清不掉；有测试断言无凭据子串；标需重授权、不崩、不拖累他账号）。

**5. Gmail 轮询（list-unread + 分页 + DB 预去重，权威在 DB）。** `messages.list(q='is:unread')` 取未读、**每轮穷尽 `nextPageToken` 翻页**（默认每页 ≤100；list 纯 id 轻，必须列完所有未读页）→ 每页**先用 message id 对 `(accountId, providerMessageId)`+`processedAt` 预去重**（命中已处理跳过、**不调 `messages.get`**）；**预算只设在 `messages.get`/处理数(非翻页数)**——持久进度即 DB `processedAt`(无 Gmail 游标),未处理者**按最旧优先(list 默认最新优先故逆序)**处理至预算,超出者下轮穷尽 list 时再被发现处理,backlog 跨轮排空;最旧优先防新件持续涌入饿死旧件;**禁**把预算设翻页数(否则长期未读堆满前页、翻页预算耗尽 → 更旧未处理件永不被列 → 饿死)→ 仅未处理者 `messages.get(format='full')` → 映射 `NormalizedEmail`（message id / threadId；`snippet`→snippet；`text/plain`→textBody；**无 text/plain 时 `text/html` 去标签→textBody**——因分类器 `buildClassifierInput` 只读 textBody/snippet/headers、**绝不读 htmlBody**（防注入/token 膨胀），HTML-only 若只给 htmlBody 模型收不到正文；`payload.headers` 仅取分类器白名单 `reply-to`/`return-path`/`list-unsubscribe`/`authentication-results`→headers（from/subject 经各自字段入模型、不塞 headers）供安全轴）。**HTML-only 经 html→text 投影正常进流水线**；**全无正文**（加密/纯附件）→ subject+headers 分类（低置信→P1 安全降级）。**去重权威是 DB `processedAt`**；`AI/Processed` 仅**可选 cosmetic、非去重/过滤唯一依据**——杜绝「标签已打但 `processedAt` 未落」崩溃窗口致永久漏处理。逐封 try/catch+skip；读侧 429/配额 → 结束本轮 + 隔离。本期 Gmail 不用游标：`poll()` 不调 `getCursor`/`setCursor`，`lastSyncCursor` 留空。
- *备选*：historyId 增量 / `-label:AI/Processed` list 过滤——更省但前者有 expiration/复杂度、后者需 AI/Processed 严格 post-`markProcessed` 落（崩溃窗口）；MVP 先 `is:unread` 全列 + DB 预去重（`// ponytail: 每轮列全部未读 + DB 预去重；大量未读时上 historyId 或 post-commit AI/Processed 过滤，属后续`）。DB 预去重已解决「P0/P1/P4 长期未读每轮重 `get`」的无界成本（list 仅返回 id，重 get 才贵）。

**6. Gmail 动作（权威标签映射）。** 始终 `reflectPriority` 加权威标签（PROJECT_INIT §6.1）：P0→`AI/P0_Important_Now`、P1→`AI/P1_Later`、P2→`AI/P2_Digest`、P3→`AI/P3_Marketing`、P4→`AI/P4_Risk`；`AI/Processed` 为**可选 cosmetic 标记**（非去重唯一依据，见决策 5）。`shouldMarkRead` 时 `markRead`=`messages.modify` removeLabelIds `['UNREAD']`（幂等）。**动作顺序**：`reflectPriority`(标签) → `markRead`(去 UNREAD) → `markProcessed`(最后)——去 UNREAD 是唯一使邮件不再被 `is:unread` 取到的动作，先打标签保证「已不可再列」的邮件至少已带标签；残留窗口仅「去 UNREAD 后、markProcessed 前崩溃」（分类已落库、标签已打、已读，仅 processedAt 滞后，P2/P3 无通知 → 无用户可见丢失，at-most-once 同 P3；`// ponytail: 彻底闭合需 historyId 游标`）。标签缺失 `labels.create` 并**按 `(accountId, labelName)` 键缓存 labelId**（Gmail 标签按账号隔离）；409「已存在」→ 取该账号已存在 labelId（**create-or-get**）。`reflectPriority` 落 `mail_actions` 需**新增 `ActionType` `reflect_priority`**（现仅 `mark_read`/`notify`）。**错误分类（两通道）**：写侧 **429 + 一般发送态失败** 瞬时 → 走既有 executeActions 发送态契约（脱敏 kind、落 failed、**不抛**、仍 `markProcessed`）；**403 权限不足/scope 漂移**（存量 token 窄于 modify）非瞬时 → provider 抛**带类型致命错误 `ProviderReauthRequired`**，`executeActions` **重抛**（不吞、区别于发送态失败）→ `processEmail` **跳过 `markProcessed`** → per-account guard 隔离该账号本轮 + 标需重授权（同读侧 refresh 失败），不反复「failed+markProcessed」致永久静默；读侧 429/`ProviderReauthRequired` 同理绕过逐封 skip、上抛结束本轮。`reflectPriority` 幂等 + 与 markRead/markProcessed 发送态失败隔离。
- 规则引擎兜底不变：动作只认 `FinalDecision`；provider 禁读 Classification；P4/敏感/低置信 `shouldMarkRead=false` → 不去 UNREAD（但仍打标签——打标签不改读状态，不违反「P4/敏感不自动标已读」；P4 保持未读+`AI/P4_Risk` 标签在 Gmail 用户可见，通知失败也不丢）。

**7. per-account 调度 + 隔离 + 并发上限（共享信号量 + 超时）。** scheduler 为每个 enabled 账号建一个 P3 式 guardedPoll（各自 `isPolling` 锁 + 各自游标）。一个账号 poll 抛错 → catch+log+锁 finally 释放，**其他账号不受影响**。并发上限以**共享信号量**包裹各 guarded poll（acquire 后 `poll()`、`finally` release）实现全局上限（默认 **≤4**），**不**是仅一个 config 数字（N 个独立 cron 不会自动遵守全局上限）。必须**单轮 poll 超时**（或显式 `// ponytail` 接受无界时长）——否则挂死 poll 永占信号量名额、饿死队列。优雅关闭停全部调度；在途 poll 由自身 finally 释放锁与信号量。
- *备选*：单循环串行所有账号——慢账号阻塞他账号；故 per-account 独立 + 共享信号量。

**8. 迁移 P3 env-IMAP。** 一次性把现有 env `IMAP_*` 账号写入一条 `MailAccount` 行（`provider=imap`、authJson 含 env 来的凭据），**accountId 沿用 P3 的实际 accountId**——即 `deriveAccountId(IMAP_ACCOUNT_ID, user, host)`：**若操作者设过 `IMAP_ACCOUNT_ID` 则沿用该显式值**，否则 `imap:<user>@<host>`（保去重键/游标连续、不重处理历史）。`MailAccount.id` 显式设为该 accountId（覆盖 cuid）。提供迁移脚本或 `account add --imap` 重配。之后 config 停读 env `IMAP_*`。

## 风险 / 权衡

- **凭据明文存 DB authJson** → 用户已接受（个人部署）；缓解：authJson 严格不入日志 + 整体 redact；at-rest 加密留后续（非目标）。**残留**：DB 备份/副本/`pg_dump` 现含明文 IMAP 口令 + Gmail refresh token——操作者须相应保护备份介质（知情接受）。Gmail refresh token at-rest 比 IMAP 口令更敏感（Google 侧改密后仍有效、直到显式撤销）——缓解即 `account-registry` 的「disable 后立即重启 + 重新授权」。**怀疑泄露（而非撤销）的恢复 = 在 Google 侧撤销该 token / 取消应用授权 + 必要时轮换 `GMAIL_CLIENT_SECRET`**（re-auth 仅换发新 token、不会杀掉已泄露的旧 token）。
- **accountId 入日志含账号邮箱**（`gmail:<email>`/`imap:<user>@<host>`）→ 视作低敏运营标识、接受其入日志（决策见 `account-registry`）；权衡：日志（比 DB 防护更弱的介质）因此持久枚举所有受监控邮箱地址（PII），但非凭据；动作脱敏「禁含邮箱」专指第三方收件人地址/凭据；操作者须如保护备份介质一样注意日志介质。
- **Gmail `getProfile().emailAddress` 主地址漂移**（Workspace 改主别名等罕见情形）→ 派生出新 `gmail:<email>` id → 去重/游标命名空间分裂 → 历史重处理。低概率、个人部署主地址通常稳定；**接受为已知残留**,缓解:启动加载时若发现两条 enabled 行共享同一小写本地身份则**记警告**(检测分裂),不自动合并。彻底闭合需稳定账号标识(如 Google `sub`),超本期范围。
- **Gmail token 撤销/refresh 失败** → 该账号轮询失败但**隔离**（不拖累他账号）；记错 + 标记需重新授权；不崩进程。
- **list-unread 每轮重列** → 仅列 id（轻）；**预去重在 get 之前**，已处理未读不重复 `messages.get`；大量未读上 historyId 增量（后续）。
- **启动期加载账号、CLI 改账号需重启** → MVP 接受；`account disable` 在重启前不生效（staleness 窗口）——撤销/泄露账号 disable 后应立即重启。热重载后续。
- **markRead 语义跨 provider 不同**（\Seen vs 去 UNREAD）→ 由 ProviderActions 抽象封装，executeActions 只调 `markRead`/`reflectPriority`，不感知 provider。
- **provider 字符串字段**（`MailAccount.provider`）非 enum → 加载时校验 ∈ {imap,gmail}，未知 provider 的账号跳过 + 记错。
- **已安装应用 client secret 非机密** → 随机器分发、Google 视为非 secret；保持 redact 是 defense-in-depth，但其不是认证边界——故 PKCE（决策 4）才是防授权码截获的实质防护。

## 迁移计划

1. 加 `googleapis` + `google-auth-library`；config 加 `GMAIL_CLIENT_ID/SECRET/REDIRECT_URI`（env，app 凭据）、移除 env 单 IMAP（保留一轮兼容以迁移）。
2. 抽 poller / `ProviderActions(markRead, reflectPriority)` seam；imap 收敛；加 gmail provider；accountRegistry + per-account scheduler（共享信号量 + 超时）；CLI onboarding（凭据经 prompt/stdin）。
3. CLAUDE.md/config.yaml 改述「密钥」硬约束（app 凭据 env / 账号凭据 DB authJson、authJson 不入日志）。
4. 迁移 P3 env-IMAP → MailAccount 行（id = 实际 accountId，honor `IMAP_ACCOUNT_ID`）；切到注册表加载；移除/no-op 锚定 seam（`ensureAccountAnchor` 等）。
- **回滚**：注册表为空 → 无账号轮询、服务（/health）正常；Gmail 失败隔离不影响 IMAP；凭据改动可逐账号 disable（+ 重启）。

## 已决（原未决问题）

- **OAuth 回调形态**：Desktop-app loopback 本地一次性回调（仅绑 `127.0.0.1`、**先绑临时空闲端口、再用该端口构造唯一精确 `redirect_uri`，授权 URL 与 `getToken` 两处用同一含端口精确串**；Desktop client 无需 GCP 预注册具体端口，但两处须精确一致含端口）；`access_type=offline`+`prompt=consent`+PKCE(S256)+`state`；**禁 OOB**（已停用）。
- **并发上限默认值**：≤4（共享信号量 + 单轮 poll 超时），可后续调。
- **accountId 派生**：确定性派生（CLI add 与迁移共用同一规则）——Gmail `gmail:<getProfile 邮箱仅小写>`、IMAP `imap:<user>@<host>` 以主键 upsert（不模糊查既有行）；legacy `IMAP_ACCOUNT_ID` 仅经迁移或显式 `--account-id`；均显式写入 `MailAccount.id` 覆盖 cuid。
