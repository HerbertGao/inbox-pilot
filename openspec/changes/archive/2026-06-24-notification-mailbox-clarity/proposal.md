## 为什么

多账号上线后,通知**不指明是哪个邮箱**——运维收到 P0/P4 推送看不出来自哪个账号(`gmail:a@x` 还是 `imap:b@y`),多账号下定位困难。另外两处运维诉求:① 想给账号起**中文标识**(如「公司邮箱」「私人 Gmail」),但 account-id 主键故意限严格 ASCII(防日志注入,inbox-pilot-cli F 系列评审结论)、不能塞中文;② 分类标签是英文枚举(`system_alert`/`transaction`…),希望统一**中文**、便于在 Telegram 里用 hashtag 搜索。同时现有渲染 P0 与 P4 是**两套分支模板**、字段不一致(P0 显示分类/置信度、P4 显示风险/安全提示),维护割裂。

## 变更内容

- **通知指明邮箱**:渲染来源邮箱标签 = 账号 `label`（中文别名）优先、否则账号 `email`（稳定必有）——经 `accountLabel` 投影进 `NotificationPayload`;`accountId` 亦投影、仅作末位兜底(绝不空)。**不**用 accountId-strip 作主回落(自定义 account-id 未必含邮箱)。
- **可选中文别名**:**新增**可空列 `MailAccount.label`(允许中文/Unicode);`account add … --label <名>` 设置;通知**优先渲染 label**,未设回落账号 `email`(末位兜底裸 accountId、**绝不空**;**非** accountId-strip 派生)。**account-id 主键仍严格 ASCII 不放松**——`label` 是区别于 PK 的另一列,校验**拒控制/格式/bidi/行分隔 + trim 判空 + ≤64 码元**(防注入通知行/日志行),但允许 Unicode 字形。
- **分类中文标签**:category 9 枚举 → 中文映射(单点维护的新映射表),渲染为 `#系统告警`/`#交易`/`#安全`/`#营销` 等 hashtag。
- **P0/P4 统一模板**:合并成一套,`riskFlags` **非空才显示**、P4 安全提示按 `priority==='P4'` 条件附加;消除两分支字段不一致（**行为变更**:P0 此前不显示风险行,合并后 `riskFlags` 非空时会显示）。
- **不泄露正文**:仍只渲染白名单结构字段(`textBody`/`htmlBody` 类型层排除不变);`label`/邮箱标签/分类均为结构字段。

## 功能 (Capabilities)

### 新增功能
- `account-registry`: 「账号可选展示别名 `label`」——per-account 可空 Unicode 显示名,严格区别于严格-ASCII 的主键 `id`;校验拒控制/格式/bidi/行分隔 + trim 判空 + ≤64 码元。

### 修改功能
- `notifications`: 「通知不泄露完整正文」需求扩展——通知必须含**来源邮箱标签**(label 优先、否则账号 `email`,**不**用 accountId-strip 派生;末位兜底裸 accountId、绝不空)与**中文分类**;来源标签在渲染边界净化(剥控制/格式/bidi/行分隔);P0/P4 合并为单一模板(`riskFlags` 非空才显示、P4 安全提示条件附加);白名单与不泄露正文不变。
- `account-cli`: **新增**「接入可选展示别名 `--label`」需求(独立 ADD,不改既有「顺手的接入参数」)——`account add`(imap/gmail 两子命令)接受可选 `--label <名>`(写入 `MailAccount.label`,经 label 校验 + 值缺位守卫);`--json` 白名单不变;account-id 仍严格 ASCII。

## 影响

- **数据**:`prisma/schema.prisma` 新增 `MailAccount.label String?` + migration(可空列、无回填,存量账号 `label=NULL` → 渲染走账号 `email` 回落)。
- **代码**:label/email 穿透链镜像 `processFrom` **5 跳**——`src/repo/mailRepo.ts`/`inMemoryMailRepo.ts`(`AccountWriteInput`/`StoredAccount` 加 `label` + create 写/update 保留 + 3 处 select);`src/providers/provider.ts`(`ImapAccount`/`GmailAccount` 加 `accountLabel?`);`src/accounts/accountRegistry.ts`(`parseImap`/`parseGmail` 显式枚举 `accountLabel = label?.trim() || email`);`src/main.ts`(poller deps 接线);`src/normalizer/normalizeEmail.ts`(`NormalizedEmail`/`RawEmail` 加 `accountLabel?`);IMAP/Gmail poller `toRawEmail` 签名 + 填值;`src/actions/retryQueue.ts`+`rebuildNormalizedEmail`(retry 路径 select 补 `label`+`email`);`src/notify/notifier.ts`(`NotificationPayload` 加 `accountId`/`accountLabel`、`projectPayload` 投影);`src/notify/telegram.ts`(统一模板 + 邮箱标签 + 中文分类 + 条件 riskFlags/安全提示);新 `src/notify/categoryLabels.ts`(category→中文,单点);`src/cli/account.ts`(两子命令 `--label` + `validateLabel`〔值缺位守卫 + Unicode-aware 拒控制/格式/bidi + trim + 限长〕+ `JSON.stringify` 回显;`--json` 白名单不变)。
- **规范**:`notifications`/`account-registry`/`account-cli` 三处 spec 增量。
- **不影响**:account-id 主键 ASCII 约束、推送时机(哪些优先级推)、分类/规则引擎裁定、去重键、凭据模型;不泄露正文不变。
- **无新依赖**。
