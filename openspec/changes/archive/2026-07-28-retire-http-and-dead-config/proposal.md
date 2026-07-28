## 为什么

hangar 迁移把 pilot 从独立服务改成了 hangar daemon 内 in-process 加载的 app：HTTP 服务被删、轮询与摘要的调度移到 `app.yaml` 的 cron 触发器。但规范、依赖与配置没跟着走，至今仍在描述一批不存在的东西：

- `service-bootstrap` 的「健康检查端点」整节要求一个 fastify HTTP 服务，监听 `HOST:PORT`、暴露 `/health`——全仓无 fastify 引用、无 HTTP 服务、无 `/health`，而 fastify 仍挂在 `dependencies` 里。
- `package.json` 的 `dev` / `start` 指向 `src/main.ts` 与 `dist/main.js`，两个文件都已不存在。
- `imap-integration` 仍以 MUST 把轮询周期钉在 `POLL_INTERVAL_SECONDS` 上，而该字段被 config schema 解析出来后全仓无读取方——实际节奏在 `app.yaml` 的 `poll` cron 里。
- `HOST` / `PORT` 唯一的消费者是 `doctor` 的端口占用探测，而它探的是一个没有任何进程监听的端口。
- `NODE_ENV` / `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 三个 schema 字段同样无读取方：`NODE_ENV` 的唯一读取方读的是 `process.env.NODE_ENV`、绕过 schema；telegram 凭据已改由 `@herbertgao/hangar-notify` 的 resolver 解析。

同一类缺陷：**设了不报错，也不生效**。一条无人实现的 MUST 让读者以为存在一道并不存在的检查；一个解析了却无人消费的 env 让 operator 以为自己在调节什么。

## 变更内容

- **退役「健康检查端点」需求**（`service-bootstrap`）：fastify / `HOST:PORT` 监听 / `/health` / 200 与 503 语义整节删除。「数据库不可达时不得拒绝启动、Prisma 惰性连接」保留——它与 HTTP 无关，是启动韧性。
- **`pnpm remove fastify`**。
- **删 `package.json` 的 `dev` / `start` 两个死脚本**（目标文件均不存在，无替代物）。
- **删 config schema 六个无读取方的字段**：`HOST` / `PORT` / `NODE_ENV` / `POLL_INTERVAL_SECONDS` / `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`，连同 `doctor` 里那条 host-port 占用探测。
- **同步两条被上述删除打断的现行规范**：`service-bootstrap`「环境配置校验」的必需变量集含 `HOST` / `PORT` / `NODE_ENV`，收敛为只剩 `DATABASE_URL`；`imap-integration`「定时轮询调度与单账号不重入」以 MUST 钉着 `POLL_INTERVAL_SECONDS` 与 node-cron 自建调度，**整条删除**——改写它需要写一条新的无人实现的 MUST（IMAP 轮询当前无接线：`src/pipeline.ts` 的 `poll` 分支只处理 gmail 账号），而节奏与不重入的真实承接方都在仓外、本仓无法验证。不重入的规范归属仍在 `account-registry`，本变更不动那条，故删除不留下无主的约束。
- **`DIGEST_TIMES` 的 schema 字段保留**：`daily-digest`「DIGEST_TIMES 配置解析与降级」仍以 MUST 钉着它的声明形状（「config 层必须用裸 `z.string().optional()`」），删字段就是违反一条现行规范。声明处注释改为指名该规范条目；原「不触发严格校验」的理由为假（见 design ③）。
  - 同一判据对 `TELEGRAM_*` 的结论不同，需说明：`notifications`「通知密钥只从配置读、不入日志」里「必须只从 P0 `config` 读取」对这两个键的指名，早在 hangar-notify 迁移（凭据改由 resolver 解析）时就已失真，属**既有**缺口、不由本变更新增，故删这两个字段不触发 `DIGEST_TIMES` 那条保留理由。该失真条款的清理见「非目标」。
- **`.env.example` 删掉已退役键的示例值**：上述六个键，外加 `BARK_ENDPOINT`（既无 schema 字段也无消费者）与 `DIGEST_TIMES`（保留字段但无消费者，示例文件不该教人设它）。
- **`openspec/config.yaml`、`CLAUDE.md`、`README.md` 的技术栈行去掉 fastify**。

## 功能 (Capabilities)

### 新增功能

- `account-cli`「doctor 只读部署预检」：承接被移除的「doctor 预检」，**是重建而非新功能**。走「移除 + 改名新增」而非 `## 修改需求`，是因为要真正删掉「host-port 检查只报固定标签」这个场景，而 `openspec-cn` 的 MODIFIED 做不到（见 design ②）。

### 修改功能

- `service-bootstrap`：删除「健康检查端点」整条需求；「环境配置校验」随六字段删除而收敛。
- `imap-integration`：删除「定时轮询调度与单账号不重入」整条需求（理由见「变更内容」）。

**这两条的具体改动请直接 diff 增量与现行规范**——本提案不另给手写清单，前几稿的清单反复与实际不符。

## 影响

- **代码**：`package.json`、`pnpm-lock.yaml`、`src/config/configSchema.ts`、`src/cli/doctor.ts`、`src/cli/doctor.test.ts`、`src/cli/inbox-pilot.test.ts`、`src/config/config.test.ts`、`.env.example`。
  - 三个测试文件须同改（含一处删了也全绿的隐蔽多余属性，机制见 tasks 1.6）；`tsconfig.json` 排除 `src/**/*.test.ts`、CI 只跑子集，故类型检查与 CI 都抓不到，唯一的捕捉手段是 §3 的负向断言。
- **规范**：`service-bootstrap`、`imap-integration`、`account-cli`。
- **文档**：`openspec/config.yaml`、`CLAUDE.md`、`README.md`、`docs/DEPLOY.md`。
- **`doctor --json` 的输出形状变化**：少一项 `host_port`。若有调用方按字段名解析，属破坏性变更——仓内只有 `doctor` 自己与文档引用它，仓外未知。
- **`doctor 预检` 需求改名为 `doctor 只读部署预检`**：仓内有若干代码注释按旧名指名该规范条目，随 §1 一并改（清单见 tasks）。
- **不影响部署顺序**：删掉的字段即使残留在线上 `.env` 里也会被 zod 静默丢弃（推导见 design ③），先部署还是先清 `.env` 都可以。

## 非目标

本变更**只做上面列的删除，以及这些删除强制要求的规范同步**。同一场 hangar 迁移还在规范与代码里留下一批同族空壳——失效的 `/health` 引用、指向已删 `src/main.ts` 的接线描述、`account-registry` 与 `daily-digest` 里已无实现的进程内调度 MUST、`node-cron` 依赖、`account-cli`「统一 CLI 入口」里「配置加载模块被 import 时终止进程」的条款（`src/config/config.ts` 早已改为惰性 Proxy）、以及 `PROJECT_INIT.md` 仍被称作「权威上下文」却停留在 P0 快照。**本变更一处都不动**，也不为它们指派 owner——那是不可证伪的散文。其中大部分（不是全部）可经下面这条恢复，它扫规范与代码两侧；`PROJECT_INIT.md` 的定性冲突与 `account-cli`「统一 CLI 入口」的条款措辞不在其内，需人工从上面这段话里认领：

```sh
grep -rn "/health\|src/main\.ts\|node-cron\|POLL_INTERVAL_SECONDS\|isPolling\|只从 P0 .config" openspec/specs/ src/ package.json
```

**唯一需要明示的代价**：本变更删掉「健康检查端点」后，`/health` 在主规范集里不再有定义处，而 `daily-digest` 与 `account-registry` 仍有引用，其中数处在 `#### 场景` 的「那么」里、是验收条件。这些引用因此成为悬空术语，直到有变更整体退役它们所在的需求。只擦掉 `/health` 三个字会留下更大的失效 MUST 站着、还假装被审过，故本变更不那么做。
