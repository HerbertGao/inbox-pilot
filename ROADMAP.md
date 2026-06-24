# Roadmap：0 → MVP

7 期，每期一个可独立验证的里程碑。原则：先把最大风险（AI 分类 + 安全兜底）做成
**离线可测**，再接真实邮箱；每个 provider 复用同一条处理流水线。

每一期开工时建议起一个 OpenSpec change（`openspec-propose`）。详细需求见
[PROJECT_INIT.md](./PROJECT_INIT.md)，硬约束见 [CLAUDE.md](./CLAUDE.md)。

| 期 | 主题 | 里程碑 | 依赖 |
|---|---|---|---|
| P0 | 项目骨架 | 服务能启动、连得上 DB、docker 跑得起来 | — |
| P1 | 邮件模型 + AI 分类内核 | 给一封邮件 → 稳定产出校验过的分类 | P0 |
| P2 | 规则引擎 + 流水线 + 通知 | 假 provider 跑通「分类→兜底→落库→动作→推送」 | P1 |
| P3 | IMAP 端到端 | 真实 IMAP 邮箱跑通第一条完整通道 | P2 |
| P4 | Gmail 端到端 | Gmail 标签化分流 | P2 |
| P5 | 每日定时摘要 | 到点发送摘要 | P2 + 任一 provider |
| P6 | YAML 规则 + 稳定性收尾 | 规则可配置 + 达成 §19 验收 | P2–P5 |

---

## P0 · 项目骨架

- **目标**：一个能启动、连得上 DB、跑得起 docker 的空服务。
- **交付**：`package.json` / `tsconfig.json` / pnpm 依赖；`src/config/config.ts`（zod
  校验 env）；`prisma/schema.prisma` + 首次 migration；`src/db/prisma.ts`；pino
  logger；`Dockerfile` + `docker-compose.yml`；`src/main.ts`（fastify + `/health`）。
- **验收**：`docker compose up` 起来，`/health` 返 200，`prisma migrate` 成功，5 张表存在。

## P1 · 邮件模型 + AI 分类内核

- **目标**：给一封邮件 JSON，稳定产出校验过的分类结果。
- **交付**：`NormalizedEmail` 类型 + `src/normalizer/normalizeEmail.ts`；
  `classifier/schema.ts`（zod `ClassificationSchema`）；`openrouterClient.ts`
  （OpenAI 兼容 + `HTTP-Referer`/`X-Title` 头 + fallback model）；`classifyEmail.ts`
  （structured output；不支持则退化 JSON mode + zod + 最多重试一次）。
- **验收**：fixture 邮件离线跑通分类；非法 JSON 触发一次重试；最终失败默认 P1 且不标已读。

## P2 · 规则引擎 + 处理流水线 + 通知

- **目标**：给一封 `NormalizedEmail`，用假 provider 跑完全链路。
- **交付**：`rules/applySafetyRules.ts`（固定安全规则：验证码强制 P0、P4 强制不标已读、
  `confidence<0.65` 降级 P1、敏感域名/支付关键词不标已读——名单先用内置默认）；
  `actions/executeActions.ts` + `actionTypes.ts`（动作分发 + `mail_actions` 状态/重试）；
  `notify/notifier.ts` + 一个渠道（telegram 或 bark）；`processEmail` 主流水线
  （去重 `(accountId, providerMessageId)` → save → classify → rules → save → actions → markProcessed）。
- **验收**：假 provider 灌样例邮件，P0/P4 触发推送、P2/P3 动作落 `mail_actions`、重复邮件不二次处理。

## P3 · IMAP 端到端

- **目标**：真实 IMAP 邮箱跑通第一条完整通道（最快看到效果）。
- **交付**：最小 `accountService`（从 DB/env 读 IMAP 账号）；`imapClient`；
  `imapPoller`（SELECT INBOX / SEARCH UNSEEN / FETCH envelope+text → `NormalizedEmail`）；
  `imapActions`（标 `\Seen` / 移动文件夹，失败退化仅标 Seen）；`jobs/scheduler.ts`（node-cron 轮询）。
- **验收**：配真实 IMAP 账号，未读邮件被分类、P2/P3 标已读、P0/P4 推送、actions 有日志；重启不重复。

## P4 · Gmail 端到端 + 统一多账号

- **目标**：Gmail 账号跑通，标签化分流；**并把多账号（多 IMAP + 多 Gmail）统一在本期落地**——
  P3 决策：多账号延后与 Gmail 合并（见下「多账号」），避免只为 IMAP 建一遍账号加载/凭据层、Gmail 来时重做。
- **交付**：Gmail OAuth（授权 + token 存 `authJson`）；`gmailClient`；标签管理（创建 `AI/*` 标签）；
  `gmailPoller`（查 unread → message detail → `NormalizedEmail`）；`gmailActions`
  （按 P0–P4 映射 add label / remove UNREAD）；接入 scheduler。
- **多账号（统一账号注册表）**：N 个账号、每个 `provider=imap|gmail`；凭据统一存 `MailAccount.authJson`
  （Gmail OAuth token / IMAP 凭据）；per-account 调度 + 故障隔离（一个账号挂不拖累其他）+ 并发上限。
  **数据层/流水线已就绪**——去重键 `(accountId, providerMessageId)`、`getCursor/setCursor(accountId)`、
  `ensureAccountAnchor`、整条 `processEmail` 已按 accountId 键化；本期只需改账号加载层
  （config/accountService/main 三处单账号接线 → 多账号注册表）+ scheduler 起 N 个 per-account 轮询。
  配置模型（env 列表 vs DB 后端 vs YAML）开工时定。
- **验收**：配 ≥2 个账号（含至少 1 Gmail + 1 IMAP）；未读被分类分流；P2/P3 去 UNREAD/标 Seen、
  P0/P4 保留并推送；各账号去重/游标互不干扰；一个账号 IMAP/OAuth 故障不影响其他账号轮询。

## P5 · 每日定时摘要

- **目标**：每天定点发送摘要。
- **交付**：`digest/buildDigest.ts`（查当天 P1/P2 列表 + P3 计数，写 `digest_items`）；
  `digest/digestScheduler.ts`（node-cron @ `DIGEST_TIMES`）；复用 `notifier` 发送。
- **验收**：到点收到摘要——P1/P2 逐条、P3 仅数量汇总；同一封不重复进摘要。

## P6 · YAML 规则 + 稳定性收尾

- **目标**：规则可配置化 + 达到验收标准的健壮性。
- **交付**：`rules/rules.yaml` + 加载（`vip_senders` / `important_domains` /
  `never_mark_read_domains` / `security_keywords` / `marketing_keywords`）喂给 `applySafetyRules`；
  失败重试与退避；OpenRouter 超时处理；单账号同步互斥锁；结构化日志完善。
- **验收**：[PROJECT_INIT.md §19](./PROJECT_INIT.md) 全部验收项通过；改 YAML 即时生效；并发轮询不重入同一账号。

---

## 生产降噪与评级校准（post-MVP · 优先做）

MVP 上线到 ts.mac-mini 后实际运行暴露的问题，经诊断 + Software Architect 决策拆成 **4 个 OpenSpec 提案**。
**次序：先发提案 1 止血，2、3 可并行跟上（3 软排在 2 后），4 待前置就绪再做。** 每个开工起一个 change（`/opsx:propose`）。

**背景实证**（live DB + Gmail，2026-06-23 接入当天）：1189 封旧邮件一次性处理、594 条进单次摘要、
P0–P2 占 **93%**（仅 5.6% 进 P3 静默）；旧邮件为**真·未读**（故按**日期**排除，不纠结读未读）。

| 提案 | 解决 | 风险 | 次序 / 依赖 |
|---|---|---|---|
| 1 `onboarding-date-watermark` | 旧邮件刷屏（摄入水位线 + 摘要年龄窗） | 中 | **先做**（活跃事故） |
| 2 `notification-mailbox-clarity` | 通知不指明邮箱 + `#`分类 + 统一 P0/P4 模板 | 低 | 1 后，独立 |
| 3 `rating-calibration` | 过度评级（prompt 收紧 + 手动降噪轴 B1） | 中高（**安全**回归） | 软排 2 后 |
| 4 `recurrence-auto-downgrade` | 周期性噪音自动降级（B2） | 中 | **推迟**：依赖 bodyHash 写入 + 回填 + 索引 |

### 提案 1 · onboarding-date-watermark（解决「旧邮件刷屏」）
- **两层都做、缺一不可**：已入库的 1189 封旧货只能靠**摘要年龄窗**压住，**水位线**只挡未来摄入——两者解决不同集合。
- 新列 `MailAccount.processFrom DateTime?`（**不复用** `lastSyncCursor`（归 IMAP UID 游标）/`createdAt`）；接入时种 `now()`（可加宽限期 / `--process-from <ISO>` 覆盖）。
- 摄入：IMAP 退化轮加 `SEARCH SINCE`、Gmail 加 `q += after:<epoch>`（Gmail 原本**完全无界**，最大收益）；`processFrom=NULL` ⇒ 省略下界（现状）。
- **存量 3 账号**：迁移设 `NULL`（保持现状，dedup 已护稳态）+ 新 CLI `account set-process-from <id> <date>` 把它们盖到今天；外加全局 `DIGEST_MAX_AGE≈7d` 给 `listDigestCandidates` 兜底，压住现有积压不再进摘要。
- 锚点：`prisma/schema.prisma`、`imapPoller.ts:119`、`gmailPoller.ts:101`、`mailRepo.ts:847-870`、`cli/account.ts`。

### 提案 2 · notification-mailbox-clarity（解决「不知哪个邮箱」+ 中文化）
- `accountId` 加进 `NotificationPayload`（已在作用域）→ 渲染**人类可读邮箱标签**（剥 `gmail:`/`imap:` 前缀）。
- **可选中文邮箱别名**（用户诉求：添加账号时想用中文标识）。关键取舍：**account-id 主键保持 ASCII 不放松**——它是主键 + 结构化日志字段，inbox-pilot-cli 已故意禁非 ASCII 防日志注入（F 系列评审的结论），放松即重新引入注入面。改为**另加**可选列 `MailAccount.label`（允许中文/Unicode，仅校验**拒控制字符/换行** + 限长，区别于 PK 的严格 ASCII）+ 账号 `add` 时 `--label <名>` 设置；通知**优先渲染 label**，未设则回落派生的 accountId 标签。
- **分类统一中文标签**（用户诉求）：category 英文枚举 → 中文映射，渲染 `#系统告警` / `#交易` / `#安全` / `#营销` 等（Telegram 支持中文 hashtag，便于统一搜索）。映射表是唯一新增、单点维护。
- **P0/P4 合并成一套模板**，`riskFlags` 非空才显示——消除现有字段不一致。
- 不泄露正文（均为已白名单结构字段，`textBody`/`htmlBody` 仍结构性排除）。
- 锚点：`notifier.ts:26-35,73-84`、`telegram.ts:29-49`、`prisma/schema.prisma`（新 `label` 列）、`cli/account.ts`（`--label` + label 校验）。
- 范围注：因加了 `label` 列 + account-add 流程，比纯渲染略大（仍低风险：增列 + 可选 flag）。

### 提案 3 · rating-calibration（③A prompt + ③B-手动 B1）
- **③A 只改 prompt、不动规则引擎**：把「**任何疑似**钓鱼/异常登录/支付风险 → P4」改为「**P4 需内容层欺骗证据**（诱导按欺骗前提行动），表层信号（TLD `.xyz` / 截断 / 未渲染模板 / return-path 单独，尤其命中自有转发域）**不作数**」；P0 去掉「交易/告警」一刀切（收据 → P2）。
- **强制双向回归语料**：4 个误报样例（网易登录 / PayPal 收据 / HKSS / 交易收据）+ 一组**真钓鱼**；CI 里真钓鱼掉出 P4 即失败——证明没削弱检测。
- **③B-B1**：rules.yaml 新增第六轴 `noise_senders`（按发件人 / 域名 / 主题降级到 P2/P3），插在敏感守卫之后、`!sensitiveGuardFired` 门控——能压过度高评的 P0，**绝不**清「不自动已读」硬底线（被降级的 cloudflared 告警若来自敏感发件人仍保持未读）。NAS 每日 + HKSS 每周各一行规则即可。
- 锚点：`classifier/prompt.ts:21,23,26-27`、`rules/applySafetyRules.ts:185-206`、`rules/rulesConfig.ts` + `specs/rules-config/spec.md`。
- **全套最大风险**：③A 失败即**安全事故**（真钓鱼被降级 + 自动已读）。四重拆弹：① 引擎硬底线原封不动（prompt 只能误评、清不掉底线）；② 真钓鱼反向语料 CI 守门；③ 非对称收紧（只收表层触发，内容欺骗仍偏 P4）；④ 现有 `confidence<0.65→P1` 兜底犹豫。

### 提案 4 · recurrence-auto-downgrade（③B-自动 B2 · 推迟）
- **为何推迟（前置工作）**：`bodyHash` 是**死列**（`schema.prisma:38`，`src/` 无任何写入）→ 需补写入路径 + **回填历史行** + 加索引 `(accountId, fromEmail, receivedAt)`，是有状态新子系统，非加索引即可。
- 设计已预解：指标用「**归一主题 + fromEmail** 复发计数 / 滚动窗」（exact `bodyHash` 因模板含时间戳/ID 会漏数，仅作二次确认）；归一主题 = 去数字/日期/UUID + 小写 + 折叠空白；阈值 ≈ 14 天内 ≥3 次 → 降级候选。
- 同 B1 门控：`!sensitiveGuardFired`、**绝不**动验证码 / 敏感类。
- **可观测**：每决策 `appliedRules:['auto-recurrence→P2']`（机器审计）+ **每日摘要里一行**「N 条按复发自动降噪：…」让人看见被静默了什么（防误降的项无声消失）。

---

## 后续技术演进（非 MVP 阻塞，留作有计划迁移）

- **Prisma 7 升级（可选与 Node 26 一并做）**：Prisma 7 是 breaking major（新客户端生成模型 / ESM、引擎走 wasm、会拖入
  `react`/`@types/react` 传递依赖），需改 `prisma/schema.prisma` 的 generator/output、`src/db/prisma.ts`，并随真库验证
  `prisma migrate`。Prisma 7 **仍支持当前 LTS**（Node `^20.19`/`^22.12`/`^24`，含现用的 Node 24），并新增对 Node 26 的支持——
  故 **Prisma 7 迁移在 Node 24 上即可进行，不以 Node 26 为前提**。推迟它纯因其是 breaking major（需专门迁移）；**可选**地
  与未来 Node 26 升级（Node 26 约 2026-10 转 Active LTS）一并做以减少 churn，但二者**并非互为前提**：CLI 与 `@prisma/client`
  须同主版本同步升、跑通迁移与全量测试。在此之前，dependabot 已忽略 Prisma 与 `@types/node` 的 major、并把
  `prisma` + `@prisma/client` 分组（见 `.github/dependabot.yml`），避免被拆开 auto-bump 推着走。
