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

## 后续技术演进（非 MVP 阻塞，留作有计划迁移）

- **Prisma 7 升级（可选与 Node 26 一并做）**：Prisma 7 是 breaking major（新客户端生成模型 / ESM、引擎走 wasm、会拖入
  `react`/`@types/react` 传递依赖），需改 `prisma/schema.prisma` 的 generator/output、`src/db/prisma.ts`，并随真库验证
  `prisma migrate`。Prisma 7 **仍支持当前 LTS**（Node `^20.19`/`^22.12`/`^24`，含现用的 Node 24），并新增对 Node 26 的支持——
  故 **Prisma 7 迁移在 Node 24 上即可进行，不以 Node 26 为前提**。推迟它纯因其是 breaking major（需专门迁移）；**可选**地
  与未来 Node 26 升级（Node 26 约 2026-10 转 Active LTS）一并做以减少 churn，但二者**并非互为前提**：CLI 与 `@prisma/client`
  须同主版本同步升、跑通迁移与全量测试。在此之前，dependabot 已忽略 Prisma 与 `@types/node` 的 major、并把
  `prisma` + `@prisma/client` 分组（见 `.github/dependabot.yml`），避免被拆开 auto-bump 推着走。
