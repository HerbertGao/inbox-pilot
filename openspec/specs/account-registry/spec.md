# account-registry 规范

## 目的
待定 - 由归档变更 gmail-multi-account 创建。归档后请更新目的。
## 需求
### 需求:从注册表加载多账号
系统必须把账号来源从「env 单账号」改为 **`MailAccount` 表注册表**:启动时加载所有 `enabled=true` 的账号行（N 个），每行 `provider ∈ {imap, gmail}`，凭据从该行 `authJson` 解出。`provider` 非法（不在 {imap,gmail}）的行必须**跳过并记错**，不得中断其余账号加载。无 enabled 账号时服务正常启动（/health 可用）、仅不轮询。本期账号在**启动时一次性加载**;CLI 增删账号后需重启生效（`// ponytail: 启动期加载;热重载/SIGHUP 留后续`）。

#### 场景:加载全部 enabled 账号
- **当** 注册表有 N 个 enabled 账号（混合 imap/gmail）
- **那么** 系统必须为每个账号产出含稳定 `accountId` + 解出凭据的账号对象，供 per-account 轮询

#### 场景:非法 provider 跳过不中断
- **当** 某账号行 `provider` 不在 {imap,gmail}
- **那么** 系统必须跳过该行并记错，其余账号正常加载

#### 场景:无账号不崩
- **当** 注册表无 enabled 账号
- **那么** 服务正常启动、/health 可用、不发起任何轮询

#### 场景:disable 不即时生效（staleness 窗口）
- **当** 运行期 `account disable <id>` 后未重启
- **那么** 该账号仍被轮询到下次重启;CLI/文档必须明确告知此 staleness 窗口,并提示「禁用一个凭据已泄露/撤销的账号后应立即重启以停止轮询」

### 需求:accountId 与 MailAccount.id 同一且确定性生成
`accountId`（去重键 `(accountId, providerMessageId)` 命名空间 + 游标落点）必须**就是** `MailAccount.id`。`prisma/schema.prisma` 的 `MailAccount.id` 虽 `@default(cuid())`,但**所有写入路径(CLI `account add`、迁移)必须显式设置 `id` = 解析出的 accountId、覆盖 cuid 默认**——否则 `MailAccount.id`(cuid) ≠ `NormalizedEmail.accountId`,`mail_messages.accountId` 对 `mail_accounts.id` 的外键(`onDelete: Restrict`)将在每次 `saveEmail` 违约,或去重键落入新命名空间导致历史邮件全部重复处理(违反「重启不重复处理」)。此即 P3 `buildAnchorUpsertArgs` 显式 `create.id===accountId` 的延续,**不得**让 cuid 默认生效。

**确定性 id（CLI add 与迁移共用同一派生规则，防命名空间分裂）**:
- gmail → `gmail:<getProfile().emailAddress 规范化(仅小写)>`(仅取 `users.getProfile`,见 `gmail-integration`)。
- imap → **确定性派生 `imap:<user>@<host>`**;CLI add 以此 id **upsert**(主键即去重,同邮箱重加自然命中同一行、不分裂),**不**依赖按 `user@host` 模糊查既有行(无此可查列——`MailAccount` 仅有 `email`/`provider`/`authJson`,P3 锚定行还把 `email` 写成 `account.user` 而非 `user@host`,模糊查会漏)。
- **legacy `IMAP_ACCOUNT_ID`（P3 设过任意旧显式值）的连续性由一次性迁移独占负责**:迁移把 `MailAccount.id` 设为 P3 实际 accountId(`deriveAccountId(IMAP_ACCOUNT_ID,user,host)`),该账号迁移后即存在、为权威。**CLI 不得**用派生式重加一个 legacy-自定义-id 账号致分裂:`account add --imap` 提供可选 **`--account-id`** 显式指定 id(用于对齐 legacy 值),或文档明确「用过 `IMAP_ACCOUNT_ID` 的账号仅经迁移接入、勿 CLI 重加」。

**`MailAccount.email` 取值(NOT NULL,必须有定值)**:gmail = `getProfile().emailAddress`;imap = `--email` 显式提供、缺省回落 `user@host`(best-effort、非真相源,与 P3 `AnchorAccount.email` 一致)。两路径都必须写非空稳定值。

#### 场景:CLI 新增账号的外键成立
- **当** `account add` 新建一个账号行
- **那么** 该行 `MailAccount.id` = 解析 accountId(覆盖 cuid 默认)、`email` 非空,使该账号首次 `saveEmail` 的 `mail_messages.accountId` 外键命中已存在的 `mail_accounts.id`

#### 场景:同邮箱不分裂命名空间
- **当** 同一 IMAP 邮箱(无 legacy `IMAP_ACCOUNT_ID`)经迁移与经 CLI add 两路径接入
- **那么** 两者都用确定性 `imap:<user>@<host>`、CLI add 以该 id upsert 命中同一行,落同一去重/游标命名空间(不分裂、不重复处理)

#### 场景:legacy 自定义 id 迁移独占、CLI 不分裂
- **当** P3 设过任意 `IMAP_ACCOUNT_ID` 自定义值的账号
- **那么** 其 id 连续性由一次性迁移独占(`MailAccount.id`=该旧值);CLI 不得用派生式重加致分裂——需 `--account-id` 对齐或仅经迁移接入

### 需求:统一 authJson 凭据模型与凭据不入日志
账号凭据必须统一存于 `MailAccount.authJson`（imap:`{host,port,user,password,tls}`;gmail:`{refreshToken,scopes}`），不再从 env 读账号凭据（Gmail app 凭据 `GMAIL_CLIENT_*` 仍从 env、属 app 凭据非账号凭据）。

**凭据完整性校验（加载时,记错并跳过,不产出残缺连接、不影响其他账号）**:
- imap authJson 缺 host/user/password → 跳过+记错。
- gmail authJson 缺 refreshToken → 跳过+记错（与 imap 对称）。
- authJson 非预期对象(标量/数组)或字段形状与 provider 不符 → 跳过+记错。

**凭据绝不入日志**:`authJson` 及其中任何凭据字段绝不以明文进入日志。redaction 以「**整体 redact `authJson` 对象**」为**主控**（pino redact 按 key-path、不支持任意深度/key 后缀通配,父键 redact 会censor整棵子树,故 `authJson`/`*.authJson` 对子树内凭据无视深度/casing 全覆盖,是稳健做法）;辅以叶子键 `password`/`refreshToken`/`accessToken` 及 **snake_case** `refresh_token`/`access_token`/`client_secret`;运行期 OAuth2 client 的凭据不在 authJson 内、需**单独枚举其真实键路径**:**整体 redact `credentials`/`*.credentials` 与 `tokens`/`*.tokens` 子树**(google-auth-library 把 access/refresh token 放这两处)+ `_clientSecret`/`*._clientSecret`(google-auth-library 内部字段;`GMAIL_CLIENT_SECRET` 作 env 键已覆盖,`clientSecret` 驼峰多为 no-op 但无害保留)+ PKCE 的 `codeVerifier`/`code_verifier`(被记则旁路 PKCE);含数组路径。redact 路径**必须与本条声称覆盖的键一一对应**(不留「声称覆盖但路径未列」的缺口)。**禁止**打印账号/注册表对象整体、运行期 OAuth2 client 对象、token 响应、原始 Prisma/OAuth/IMAP 错误对象(只记 `code`/脱敏 `message`)——**含错误的 `cause` 链与 `AggregateError.errors`**(它们可重新内嵌原始错误对象/凭据子串,key-redact 无法清洗字符串内嵌的凭据,故按「只取 code+固定 kind、绝不传原始 error/其 cause/response/config 给 logger」的代码纪律落地)。**亦禁整体记录 `NormalizedEmail` 对象**(其 `to`/`cc` 是第三方收件人 PII):错误/动作路径只记 `accountId`+`providerMessageId`+脱敏 message。该纪律必须落到**全部错误 sink**(此前只在 refresh/403 处声明、未覆盖全部):①读侧逐封 `messages.get` catch(5xx `GaxiosError` 的 `.config.headers.Authorization` 含 bearer access_token);②scheduler per-account guard 记被传播的错误(只记 code+kind、不记传播对象/cause);③注册表 `authJson` 解析失败的「跳过+记错」**只记 `{accountId, provider, reason-kind}`,绝不记 authJson 值或 `JSON.parse` 错误对象**(其 `.message` 会回显含凭据的输入子串);④OAuth loopback 回调处理**绝不记回调 URL/query**(含单次性授权 `code` 与 `state`)、只记 `{kind, state-result, path}`(见 `gmail-integration`「OAuth」)。in-memory **解出凭据的对象**(如 `{host,user,password}`/`{refreshToken}`,凭据在**顶层字段**、不在 `authJson` key 下)**禁止整体记录**——`*.password` 仅覆盖一层、深层嵌套会逃逸,故凭据对象既不整体入日志、字段亦置于距任何被记录对象 ≤1 层。

#### 场景:凭据不入日志(含嵌套/casing)
- **当** 任何代码路径记录账号、其 authJson、运行期 token 对象或原始错误
- **那么** 凭据字段(password/refreshToken/accessToken 及 snake_case 变体)必须被 redact,序列化输出**不含**任何凭据明文(有断言测试,覆盖嵌套深度 + snake_case + 数组形态)

#### 场景:不完整凭据跳过
- **当** 某 imap 账号 authJson 缺 host/user/password,或某 gmail 账号缺 refreshToken,或 authJson 形状不符
- **那么** 该账号加载时记错并跳过,不产出残缺连接、不影响其他账号

#### 场景:accountId 作运营标识入日志可接受
- **当** 轮询/调度日志记录 `accountId`(其含 user@host / gmail 邮箱)
- **那么** 视 `accountId` 为低敏运营标识、可入日志;动作脱敏「禁含邮箱」专指**第三方收件人地址/凭据/token**,不含本账号的运营 accountId

### 需求:Provider 抽象统一两种 provider
系统必须区分两层 seam:**poller**(scheduler 面向,per-account/per-poll 构造)负责 `poll()`(取新邮件→收敛→`processEmail`);**`ProviderActions`**(动作 sink,**由 `pollOnce` 在本轮连接内构造并注入 `executeActions`**)含 `markRead(email)`(IMAP 加 `\Seen` / Gmail 去 `UNREAD`)与 `reflectPriority(email, decision)`(把最终优先级落到 provider 维度:Gmail 加权威 `AI/P*` 标签;IMAP 本期 no-op)。`reflectPriority`/`markRead` 是 `executeActions` 实际持有的 seam(沿用 P3 `ProviderActions`,新增 `reflectPriority`),**不**放在 scheduler 面向的 poller 上;scheduler 只迭代 poller 工厂、不感知具体 provider 也不持长生命周期动作方法。`executeActions` 必须**始终**调用 `reflectPriority`、并**仅在** `shouldMarkRead` 为 true 时调 `markRead`——动作只认 `FinalDecision`,provider 禁读原始 `Classification`。

**IMAP 连接共享(硬性)**:IMAP 的 `ProviderActions` 必须由 `poll()` 本轮打开的连接构造、并在该连接上操作(P3 `createImapProvider(connection)` 语义);**禁止**另开连接或用陈旧连接。Gmail 无状态 HTTP,无此约束。

`reflectPriority` 必须**幂等**且与 `markRead`/`markProcessed` **发送态失败隔离**:单动作发送态失败只落 `mail_actions`、不阻断其余动作与 `markProcessed`;终态落库 I/O 故障向上传播,由 `processEmail` at-least-once 重跑兜底(幂等故重跑安全)。**例外——账号级致命错误**:provider 动作遇账号级致命(token 撤销/scope 失配 403 等)必须抛**带类型的 `ProviderReauthRequired`**(**只携 `{accountId, kind}`,绝不把原始 `GaxiosError` 挂作 `cause`**——否则 cause 链泄露 token,见「凭据不入日志」);`executeActions` 对该类型**重新抛出**(不当发送态吞掉),但重抛前必须把该动作的 in-flight `mail_actions` 行(reflect_priority/mark_read)置 `failed`(reauth kind)、**不留 orphan pending 行**;→ `processEmail` **跳过 `markProcessed`** → scheduler 的 per-account guard catch、按上「需重授权账号必须真正暂停」隔离+暂停该账号(不反复「failed+markProcessed」致永久静默)。此为区别于「发送态瞬时失败(吞-继续)」的第二类通道。

#### 场景:动作经统一 seam 分发
- **当** 一封邮件被裁定 `FinalDecision`
- **那么** `executeActions` 必须对该账号的 `ProviderActions` 始终调 `reflectPriority`、并仅在 `shouldMarkRead=true` 时调 `markRead`;两者只依据 `FinalDecision`

#### 场景:IMAP 动作走本轮连接
- **当** IMAP 账号执行 `markRead`/`reflectPriority`
- **那么** 必须在 `poll()` 本轮打开的同一连接上操作,不另开/不复用陈旧连接

#### 场景:reflectPriority 失败隔离
- **当** `reflectPriority` 的标签写入失败(API 错误)或其终态落库抛出
- **那么** 不阻断 `markRead`;发送态失败只落 `mail_actions`,落库 I/O 故障向上传播由 at-least-once 重跑兜底(reflectPriority 幂等、重打无害)

### 需求:per-account 调度与故障隔离
scheduler 必须为每个 enabled 账号建独立的不重入轮询（各自 `isPolling` 锁同步获取 + `finally` 释放、各自 `lastSyncCursor`）。**任一账号的轮询异常（连接/OAuth/解析）必须被 catch+记错，不崩进程、不阻塞或拖累其他账号**。必须有**并发上限**:以**共享信号量(semaphore)包裹各 per-account guarded poll**(进入 `poll()` 前 acquire、`finally` release)实现全局上限(小常数,如 ≤4),超限者排队;**不**是仅一个 config 数字(N 个独立 cron 各自触发不会自动遵守全局上限)。必须有**单轮 poll 超时**(或显式以 `// ponytail` 接受无界 poll 时长并说明;Gmail 走 googleapis HTTP、无连接可 destroy,超时主要界定本轮、释放信号量名额,部分完成的工作靠 per-mail `processedAt` 幂等保一致,`AbortSignal` 取消为 best-effort)——否则一个挂死的 poll 永占信号量名额、饿死队列。**获取顺序**:先 acquire 信号量、再取 per-account 锁(避免账号排队期间持锁等待、致其下一 cron tick 被判重入而跳过);排队期间该账号 tick 跳过是可接受的。优雅关闭停全部调度;在途 poll 由其自身 `finally` 释放锁与信号量。

**需重授权账号必须真正暂停(不只是记日志)**:当某账号轮询抛 `ProviderReauthRequired`(token 撤销/scope 403,见 `gmail-integration`),scheduler 的 per-account guard 必须:(1)**进程内将该账号标为 suspended**,本进程后续 tick **跳过该账号**——否则每个 cron tick 都重列→重 get→重 403,形成对 Google 的紧打循环;(2)**持久化暂停**:置 `MailAccount.enabled=false`(复用既有字段、**无需新增 schema 列**;下次启动不再加载该账号)——`// ponytail: 复用 enabled 表「需重授权」;如需区分「用户禁用」vs「自动需重授权」再加 reauthRequiredAt 列,属后续`;(3)记结构化错误(只 `error.code`+kind,见日志脱敏)。**恢复**:`account add --gmail` 重新授权(upsert 新 refresh token + 置 `enabled=true`)后重启生效。并发上限默认值应 **≥ 预期账号数**(小型个人部署 cap≥N 即无饿死;真正公平轮转留后续 `// ponytail`)。

**并发上限设小常数(默认 ≤4),`// ponytail: cap≥账号数则无 tick 饿死;N≫cap 且多账号长 poll 时低频账号可能持续跳过 tick,需公平轮转——留后续`。**

#### 场景:一个账号故障不拖累其他
- **当** 某账号轮询抛异常（IMAP 连接失败 / Gmail OAuth 失效）
- **那么** 该异常被 catch+记错、其锁与信号量名额在 finally 释放,其他账号轮询照常、进程不崩

#### 场景:单账号不重入
- **当** 某账号上一轮未结束、其下一次触发到来
- **那么** 必须跳过该账号本次触发（不并发轮询同一账号），不影响其他账号

#### 场景:并发上限由共享信号量落地
- **当** enabled 账号数超过并发上限
- **那么** 同时进行的轮询数不得超过该上限(共享信号量),其余排队;一个挂死 poll 受单轮超时约束、不永久占名额

#### 场景:需重授权账号被暂停不再紧打 Google
- **当** 某账号轮询抛 `ProviderReauthRequired`(token 撤销/scope 403)
- **那么** guard 必须进程内标该账号 suspended(后续 tick 跳过)+ 置 `enabled=false`(持久,下次启动不加载)+ 记结构化错误;**不得**每 tick 重列重 get 重 403 紧打 Google;其他账号不受影响;恢复需 CLI 重授权(置 enabled=true)+ 重启

### 需求:账号 onboarding CLI
系统必须提供 CLI 子命令管理账号（不做 GUI）:`account add --imap`、`account add --gmail`（跑 OAuth 授权 → 存 refresh token 建行）、`account list`（列账号 + provider + enabled，**不**显示凭据）、`account disable <id>`。写操作把凭据写入 authJson,且 `MailAccount.id` 显式设为派生 accountId(见上「accountId」需求)。

**凭据输入与回显(硬性)**:IMAP 口令及任何凭据**禁止经命令行参数(argv)传入**(会落 shell 历史 / `ps`/proc args / 命令日志);必须经**交互式 prompt(关闭回显)或 stdin** 读取。写操作**绝不**回显/记录明文凭据。`account add` 同一邮箱(同派生 id)已存在时必须有定义行为:默认**拒绝**并提示(或经显式确认走 re-auth/更新凭据的 upsert),不静默覆盖。

#### 场景:list 不泄露凭据
- **当** 运行 `account list`
- **那么** 输出含 id/provider/email/enabled，**禁含**任何 password/token 明文

#### 场景:口令不经 argv
- **当** `account add --imap`
- **那么** 口令必须经交互 prompt(echo off)/stdin 读取,**禁**经命令行参数传入;凭据不回显/不入日志

#### 场景:add 写入 authJson 且 id 为派生值
- **当** `account add --imap` 提供完整凭据
- **那么** 系统必须建一条 `MailAccount` 行、`id` = 派生 accountId、凭据写入 authJson,且凭据不回显/不入日志

#### 场景:add 已存在账号有定义行为
- **当** `account add` 的派生 id 已存在
- **那么** 默认拒绝并提示(或经显式确认更新凭据),不静默覆盖

