## 修改需求

### 需求:IMAP 账号加载与持久化锚定
IMAP 账号必须经**统一账号注册表**加载（见 `account-registry`），**不再从 env 单账号读取**。该账号对应的 `MailAccount` 行（`provider='imap'`）即注册表条目、**含真实凭据于 `authJson`**（`{host,port,user,password,tls}`）。

`accountId` **必须就是该行的 `MailAccount.id`**（不再「或派生 id」二选一的含糊措辞）；`MailAccount.id` 由写入路径**确定性派生并显式设置**（CLI add 与迁移共用同一规则，见 `account-registry`「accountId 与 MailAccount.id 同一」需求）、**覆盖 `@default(cuid())`**：迁移沿用 P3 实际 accountId（`deriveAccountId(IMAP_ACCOUNT_ID,user,host)`，含旧显式值）;CLI add 用 `--account-id`（若给）否则确定性 `imap:<user>@<host>` 作主键 **upsert**（**不**按 user@host 模糊查既有行——无此可查列）；legacy 自定义 `IMAP_ACCOUNT_ID` 的连续性仅经迁移或显式 `--account-id`。这是去重键 `(accountId, providerMessageId)` 与游标连续、外键成立的前提。`MailAccount.email`（NOT NULL）取 `--email` 或回落 `user@host`（best-effort denormalization，非真相源）。

因「注册表行**本身即账号**、`MailAccount.id===accountId`、authJson 含真实凭据」，`mail_messages.accountId` 对 `mail_accounts.id` 的外键约束天然满足，**不再需要** P3 的「空 `authJson` 锚定行」机制：P3 的一次性 `ensureAccountAnchor(authJson:{})` + `buildAnchorUpsertArgs`/`AnchorAccount`/`AnchorUpsertArgs`（及其 call-shape 测试）被「行本身即账号、id 显式 = accountId、authJson 含真实凭据」取代——本变更必须**移除或改为 no-op** 这些锚定 seam 及其测试，并把 P3「锚定行先于调度建立」的不变量**改述为「注册表行必须先于该账号被调度而存在」**（由 CLI add / 迁移建行、注册表加载断言其存在），避免首次 `saveEmail` 触发 FK 违约。

IMAP 凭据从 `authJson` 解出、**只在内存、绝不以明文入日志**（不再从 env 读取 IMAP 凭据）。凭据不完整（缺 host/user/password）的 imap 账号行在加载时记错并跳过该账号（见 `account-registry`），不产出残缺连接、不影响其他账号。IMAP 的 `markRead`/`reflectPriority` 动作必须在 `poll()` 本轮打开的同一连接上操作（连接共享，见 `account-registry`「Provider 抽象」）。

#### 场景:IMAP 账号经注册表加载
- **当** 注册表有一个 enabled 的 `provider='imap'` 账号、其 authJson 含完整连接凭据
- **那么** 系统必须产出含稳定 `accountId`(= `MailAccount.id`) + 从 authJson 解出的连接参数的 IMAP 账号，供轮询

#### 场景:外键由注册表行满足（无需空 authJson 锚定）
- **当** 该 IMAP 账号首次 `saveEmail`
- **那么** `mail_messages.accountId` 的外键必须成立(注册表行已存在、`MailAccount.id===accountId`)，无需额外的空 authJson 锚定 upsert

#### 场景:注册表行先于调度存在
- **当** 一个 IMAP 账号被纳入 per-account 调度
- **那么** 其 `MailAccount` 行(id = 派生 accountId)必须已存在(由 CLI add / 迁移建立)，否则不调度该账号、记错

#### 场景:凭据不入日志
- **当** 任何路径记录该 IMAP 账号
- **那么** authJson 中的 password 等凭据必须被 redact，不出现明文
