# email-model 规范

## 目的
待定 - 由归档变更 email-classification-core 创建。归档后请更新目的。
## 需求
### 需求:统一邮件模型契约
系统必须定义统一邮件模型 `NormalizedEmail`，覆盖 PROJECT_INIT §7 的字段集
（`accountId`、`provider`、`providerMessageId`、可选 `providerThreadId`/`uid`/`messageId`、
`subject`、可选 `fromName`、`fromEmail`、`to`、可选 `cc`、`date`、可选 `snippet`/`textBody`/`htmlBody`、
`hasAttachments`、`headers`、可选 `mailbox`/`labels`）。所有 provider 的原始邮件在进入分类器之前
**必须**先经 `normalizeEmail()` 收敛为 `NormalizedEmail`；分类器**禁止**接收任何未规范化的原始 provider 对象。

#### 场景:原始邮件经单点收敛为统一模型
- **当** 把一个 provider 无关的原始邮件对象传入 `normalizeEmail()`
- **那么** 必须返回一个携带 §7 字段集的 `NormalizedEmail`，供分类器及后续阶段消费

#### 场景:分类入口只接收规范化模型
- **当** 任一 provider（IMAP/Gmail，后续阶段实现）需要分类一封邮件
- **那么** 必须先调用 `normalizeEmail()` 得到 `NormalizedEmail` 再送入分类器，禁止绕过该收敛点

### 需求:结构化不变量与失败隔离
`normalizeEmail()` 必须在**单点**校验三个由调用方提供的结构化字段：`accountId`、`provider`（必须为 `gmail`/`imap`）、`providerMessageId` 均存在且非空——去重键 `(accountId, providerMessageId)` 与 provider 路由依赖三者完整，缺失任一（或 provider 非法）必须 fail-fast 抛出明确错误，**禁止**产出结构化字段缺失的 `NormalizedEmail` 流入后续阶段。该 throw **仅中止当封邮件**：后续阶段的批量消费者（P2 `processEmail` 轮询循环——**此为 P2 义务、非 P1 交付物**，P1 不在此处实现任何循环）**必须**逐封捕获该异常、跳过并记录该封，**禁止**让单封失败中断整批轮询；缺去重键的邮件是**有意丢弃**（无法满足「重启不重复处理」），不是漏处理泄漏。

#### 场景:缺结构化字段时拒绝
- **当** 传入的原始邮件缺少 `accountId`、`provider` 或 `providerMessageId`（或为空字符串、provider 非 `gmail`/`imap`）
- **那么** `normalizeEmail()` 必须抛出明确错误，禁止返回结构化字段缺失的 `NormalizedEmail`

#### 场景:产出携带完整结构化字段
- **当** 传入的原始邮件含合法的 `accountId`、`provider`、`providerMessageId`
- **那么** 返回的 `NormalizedEmail` 必须携带非空三者，使 `(accountId, providerMessageId)` 可作为稳定去重键

### 需求:必填字段默认与归一
`normalizeEmail()` 必须为 `NormalizedEmail` 的每个**必填**字段（除已 fail-fast 的结构化字段外）补默认值并归一，使产出始终满足 PROJECT_INIT §7 的类型契约、杜绝 `undefined` 必填字段：缺失或空的 `subject` 必须补为 `(无主题)`；缺失或空的 `fromEmail` 必须补为 `''`（空发件人本身可作为 P4 风险信号，交由模型/规则判断，**禁止**在 normalize 阶段因其缺失而丢弃邮件）；缺失或非法的 `date` 必须补为摄入时刻的 ISO 字符串；`to` 缺失必须默认为 `[]`；`hasAttachments` 缺失必须默认为 `false`；`headers` 缺失必须默认为 `{}`，且其 key 必须统一为小写。小写归一后若出现仅大小写不同的同名冲突（如 `From` 与 `from`），必须采用确定性规则**后写非空覆盖**（last-non-empty-wins），**禁止**用空值覆盖已有非空值，以免静默丢失安全相关 header（如 `authentication-results`）；两者**均非空**时按源迭代顺序后写覆盖（last-written-wins），使规则对所有冲突形态完备。可选字段（`cc`/`labels`/`fromName`/`snippet`/`textBody`/`htmlBody`/`uid`/`messageId`/`providerThreadId`/`mailbox`）缺失时保持未设置即可。

#### 场景:缺必填字段时补默认
- **当** 传入的原始邮件缺少 `subject`、`fromEmail`、`date`、`to`、`hasAttachments`、`headers`
- **那么** 返回的 `NormalizedEmail` 必须分别得到 `(无主题)`、`''`、摄入时刻 ISO 字符串、`[]`、`false`、`{}`，且无任一必填字段为 `undefined`

#### 场景:header key 归一为小写且冲突确定性合并
- **当** 传入的原始邮件 `headers` 含大小写混杂、且存在仅大小写不同的同名 key（如 `From` 与 `from`，其一为空值）
- **那么** 返回的 `headers` key 必须全部为小写，且同名冲突按 last-non-empty-wins 合并，非空值禁止被空值覆盖

