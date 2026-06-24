## 上下文

通知投影在 `projectPayload(decision, email)`(`src/notify/notifier.ts:73`),产出白名单 `NotificationPayload`(无 `textBody`/`htmlBody`,类型层杜绝正文泄露);`renderTelegramText`(`src/notify/telegram.ts:29`)按 `priority==='P4'` 分两套模板渲染、Telegram 字面发送(无 `parse_mode`)。`NormalizedEmail.accountId`(`src/normalizer/normalizeEmail.ts:2`)已在投影作用域。`MailAccount` 主键 `id` 是严格 ASCII(inbox-pilot-cli 故意限制防日志注入)、且是结构化日志字段;`MailAccount.email` 是账号真实邮箱(稳定、必有)。category 是 9 值英文枚举(`src/classifier/schema.ts:7`;`Category = Classification['category']`)。多账号已上线,通知却不指明账号。

「account 字段逐跳进数据路径」有先例:`processFrom` 需 **5 跳**(DB row → `StoredAccount` → `ImapAccount`/`GmailAccount`〔`src/providers/provider.ts`〕→ poller deps〔`src/main.ts` 接线 + `pollAccount`〕→ `toRawEmail`/`normalizeEmail`),且 `accountRegistry.ts` 字面量**不显式枚举则被 spread 凭空丢失**(代码内有注释明证)。本变更的 label/email 必须走同一条链。

## 目标 / 非目标

**目标:**
- 通知**指明来源邮箱**(可靠:`label` 优先、否则账号 `email`);支持**可选中文别名**(不放松 account-id 主键 ASCII)。
- 分类渲染**统一中文** hashtag;P0/P4 **单一模板**、字段一致。
- 不泄露正文(白名单不变);无新依赖。

**非目标:**
- 不改 account-id 主键约束(仍严格 ASCII、防注入)。
- 不改推送**时机**(哪些优先级即时推)、不改分类/规则引擎裁定。
- **不做 `account set-label` 改既有账号别名命令**(`[out-of-scope]`;与 `set-process-from` 同形,需要时另起)——本变更 label 仅行创建时写,既有账号通知走 `email` 回落。
- **不给每日摘要做 per-邮箱归属**(`[out-of-scope]`;摘要跨账号聚合一条消息、本变更只覆盖 P0/P4 即时推送——已知 gap、非本期目标)。
- 不引入富文本/`parse_mode`(仍按字面发);不做 i18n 框架(单点中文映射表足够)。

## 决策

**决策 1:邮箱标签 = `label ?? email`(注册表/poller 处解析)→ 经 `NormalizedEmail.accountLabel` 投影;渲染最后兜底裸 accountId、绝不空。**
渲染需要「哪个邮箱收的」。来源在**注册表/poller**(账号行在作用域)处解析为 `accountLabel = row.label?.trim() || row.email`——`label`(中文别名)优先、否则账号真实 `email`(稳定必有)。**不**在渲染层用 accountId-strip 派生:IMAP 允许**自定义 account-id**(account-cli 允许 `--account-id`、未必含邮箱),`gmail:`/`imap:` strip 不可靠、且 `imap:` 这类 prefix-only id strip 后为空。`accountLabel` 经 `NormalizedEmail.accountLabel?`(承载,同 `processFrom` 5 跳链)到投影点。渲染 **sanitize-then-fallback**:`fromLabel = sanitizeSource(payload.accountLabel ?? '').trim()`,`mailboxLabel = fromLabel || payload.accountId`——先净化 label 候选,净化后为空才回落**裸 accountId**(ASCII、`sanitizeSource` 为 no-op、必非空)→ **绝不渲染空**「邮箱:」,守 spec「禁止不显示来源」(穿透链漏填**或候选净化后为空**均回落)。**渲染净化(choke point)**:`email` 是 IMAP `--email` 自由文本、add 处**未**按 label denylist 校验(只查非空、作登录名原样存),`sanitizeSource` 带 `u`+`g` flag 剥除 `\p{Cc}` + `\p{Cf}` + U+2028 / U+2029 / U+2066–U+2069——单点防 email 携 RTL-override 等重开来源伪装面(`label` 已 add 校验经 `fromLabel` 主动净化;裸 `accountId` 是 **clean-by-invariant**——PK 已钉死 ASCII〔决策 4〕、非主动再净化,若未来放松 PK 字符集须把 accountId 也纳入主动净化)。**不可**写成 `sanitizeSource(accountLabel || accountId)`(净化包在 fallback 外层):全-bidi/控制的候选 pre-sanitize 非空 → 被 `||` 选中 → 净化成空 → 空来源、违反「绝不空」。**替代(a)**校验 `--email` denylist——亦可,但只覆盖该路径;**替代(b)**notifier 反查注册表——弃(耦合 IO);accountId-strip 作主回落——弃(自定义 id 不可靠/可空)。

**决策 2:category→中文用 `Record<Category, string>` 全枚举映射(单点、编译期完整)。**
新 `src/notify/categoryLabels.ts` 导出 `Record<Category,string>`,覆盖全部 9 枚举(personal=个人 / work=工作 / finance=财务 / system_alert=系统告警 / security=安全 / newsletter=资讯 / marketing=营销 / transaction=交易 / unknown=未知);渲染 `#${中文}`。`Record<Category,…>` 使新增枚举臂**编译失败**(`tsc --noEmit` 守门,验收 5.1)、`switch+default` 会静默回退英文故弃。

**决策 3:P0/P4 合并为单一模板,`riskFlags`/安全提示条件渲染。**
一套字段序:`[优先级] 主题` / `邮箱:<mailboxLabel>` / `发件人` / `原因` / `分类:#中文` / `置信度`;`riskFlags` **非空才**加风险行(**注:P0 此前不显示风险行,合并后非空时会显示——属字段统一带来的行为变更、非纯整合**);**仅** `priority==='P4'` 才附安全提示。不改各字段不泄露正文性质。

**决策 4:`label` 校验——Unicode-aware 拒「控制 + 格式 + 行分隔 + bidi」类,允可见 Unicode;trim 后判空;限长 64 码元;值缺位守卫;PK 不动;回显双层。**
`validateLabel`(`account add --label` 处)规则,**规范层必须钉死**(不留「控制字符」泛指):
- **拒** Unicode 通用类 `\p{Cc}`(C0/C1 控制,含 `\n`/`\r`/`\t`/NUL/DEL/U+0085)**与** `\p{Cf}`(格式字符,含零宽 U+200B、BOM U+FEFF、bidi 嵌入/覆盖 U+202A–U+202E)**与** 行分隔 U+2028/U+2029 **与** bidi 隔离符 U+2066–U+2069。JS 实现用带 `u` flag 的 `\p{Cc}\p{Cf}` + **显式补 U+2028/U+2029**(行分隔属 `\p{Zl}/\p{Zp}`、**不**在 `\p{Cf}` 内,必须显式列);isolates U+2066–U+2069 本属 `\p{Cf}`、已覆盖(显式列出仅为清晰、非必需)。**理由**:仅拒 `\n`/`\r`(C0)会放过 RTL-override(U+202E)等 → 在 Telegram 客户端**视觉重排/伪装来源邮箱**(字面发送不防,重排由收端做),直接击穿「可辨来源」目标;以及 U+2028/U+2029 仍能断行伪造通知行。
- **trim 后判空**:`--label` 给了值就 `.trim()` 后非空,trimmed-empty(纯空白)→ 拒(否则存空白、渲染回落 email、`account list` 显示空)。
- **限长 ≤ 64 码元(UTF-16 code units)**——硬上限、固定常量(非「如」)。
- **值缺位守卫**:`--label` 后续 token 以 `-` 开头时被 `parseFlags` 当布尔落 `bools`(同 `--process-from` 坑)→ 必须 `flags.bools.has('label')` 检测、报 `--label 需要值参数` + 退出码 2(**禁止**静默 NULL)。
- **PK 不动**:account-id 仍严格 ASCII `^[A-Za-z0-9:._@+=-]…$`(`label` 是独立列)。
- **回显双层(defense-in-depth)**:CLI 成功/错误行的 `label` 经 `JSON.stringify` 转义(同 account-id 既有 `JSON.stringify(id)` 模式),不只依赖校验器——校验 + 转义双保险。
- **`label`/`accountLabel` 绝不进结构化日志字段**(显式约束,可被测试守住;现 notify 日志仅 `{kind,priority,channel,error}`,不加 label)。
校验失败 → 用法错误(退出码 2)、**不**触达 repo 写。

**决策 5:`label` 仅 create 分支写,update/re-auth 保留;既有账号无改 label 入口(走 email 回落)。**
`account add --label` 经 create 写入(IMAP `createAccount` / Gmail `upsertAccount.create`);`update` 分支(含 Gmail 每次 re-auth)**省略 `label`**(Prisma 列不动 = 保留;InMemory get-before-set 保留 `existing.label`)。故**首次接入**可设 label;**之后无法改**(无 `set-label`)——既有/未设 label 的账号通知走 `email` 回落(仍指明邮箱)。Gmail 恒走 upsert,首次 `add --gmail --label` 命中 create 分支、可设;之后 re-auth 不改。需改既有别名 = 后续 `set-label`(out-of-scope,同 `set-process-from` 先例)。

## 风险 / 权衡

- **label 注入面**(通知行/`account list`/日志)→ 决策 4 Unicode-aware 拒控制+格式+行分隔+bidi + trim + 限长 + `JSON.stringify` 回显 + 不进日志 + Telegram 字面发送;account-id PK ASCII 不被触及。
- **retry/drain 通知路径**(`src/actions/retryQueue.ts:109` → `mailRepo.ts` `rebuildNormalizedEmail`):重试重放的 email 从 DB 行重建。**修法**:`rebuildNormalizedEmail` 的 select 补 `account.label`+`account.email`、透传填 `accountLabel`(tasks 2.6)——使重试通知与首发一致指明邮箱;若实现时该 select 改动超预期,**退而**接受 retry 走裸-accountId 回落(accept-degraded:邮箱仍被命名、仅可能非别名/邮箱),并在 tasks 标注。
- **穿透链漏跳** → 决策 1 末位裸-accountId 兜底(绝不空),非静默崩;tasks 2.x 显式枚举全 5 跳 + 每跳测试,防静默丢。
- **既有账号无法改 label**(决策 5)→ 走 email 回落、仍指明邮箱;`set-label` 列为 out-of-scope 后续。

## 迁移计划

加可空列 `MailAccount.label String?` + 一次 migration(无回填、无数据依赖)。发布即生效:新接入 `--label` 写中文名、通知优先渲染;存量账号通知改为渲染账号 `email`(本就是改进、可辨来源)。回滚 = 删列 + 还原渲染(纯展示、无数据语义影响)。

## 待解决问题

- 无。`newsletter` 中文**已定为「资讯」**(映射表单点、决策 2/tasks 3.2 已落值);如需改「订阅」仅动该单点常量。
