## 上下文

hangar 迁移之后 pilot 不再是独立服务，而是 hangar daemon（launchd 托管的常驻进程）in-process 加载的一个 app：入口是 `app.yaml` 声明的触发器 + `dist/pipeline.js`，`src/main.ts` 已删。本变更处理那次迁移留在规范、依赖与配置里的空壳——被描述、被解析，但没有实现也没有消费者。

## 决策

### ① 健康检查需求是删除，不是迁移

删掉一条 MUST 要说清它守的东西现在谁守。这条守的是「存活性可被外部观测」，而承接不是一对一的：`/health` 外部可轮询、回答「此刻进程活着且数据库通」；hangar 的 run 记录是回顾性的、两次 cron 触发之间不作答。故拆成两半交出去——数据库可达性交给 `inbox-pilot doctor`（已实现，报 `unreachable`）；进程存活性交给 launchd + hangar daemon，且明说该承接方不由本仓规范约束，不写一条本仓无法验证的 MUST。

**注意承接说明的寿命**：`openspec-cn archive` 只把 `## 修改需求` / `## 新增需求` 的正文写进主规范，`## 移除需求` 块的 `**Reason**` / `**Migration**` **不进 `openspec/specs/`**，只随本变更冻进 `openspec/changes/archive/`。所以归档后主规范里既没有「健康检查端点」，也没有它被谁承接的记录。本变更接受这个代价（承接方本就不由本仓约束），但不要据此以为 Migration 段是长期权威。

### ② 增量的形态由 `openspec-cn` 的场景约束决定，不是文体偏好

实测 `@herbertgao/openspec-cn@1.6.0`：`## 修改需求`（MODIFIED）应用时，**块内场景标题必须是现行规范该需求场景集的超集**——删掉一个场景或改一个场景名，`archive` 直接中止（`current spec contains scenario(s) not present in the modified block`）。而 `show --json` 与 `validate --strict` 对同样的增量全部报成功，失败只在真正归档时才出现。`## 移除需求` + `## 新增需求` **同名**重建也被拒（`需求同时出现在多个部分`）。

故本变更的三份增量形态如下，改动它们时不要「顺手」改场景标题：

- `service-bootstrap`「环境配置校验」保持 MODIFIED，场景标题**逐字保留现行名**（这就是为什么正文改了而标题没跟着改）。
- `account-cli` 必须真正删掉「host-port 检查只报固定标签」这个场景，MODIFIED 做不到，故走「移除 `doctor 预检` + 以新名 `doctor 只读部署预检` 新增」。代价是需求改名会断掉仓内按旧名的指名。
- `imap-integration`「定时轮询调度与单账号不重入」走 `## 移除需求`——这条不是工具约束所迫，而是内容判断：改写它需要写一条新的无人实现的 MUST（见 proposal「变更内容」）。

推论写进验证步骤：**`validate --strict` 与 `show --json` 都不足以证明可归档**，必须在隔离副本上真跑一次 `archive`。

### ③ 本变更没有部署顺序约束

`configSchema` 结构上不可能是严格的：两处调用点都是 `configSchema.safeParse(process.env)`，而 `process.env` 恒含 `PATH` / `HOME`，严格 schema 会让每次运行从第一天起就失败。zod 对未知键静默丢弃，故 `.env` 里残留已删的键不产生任何后果，部署与清理无先后。清 `.env` 仅为卫生，列为非阻塞任务。

推论：`DIGEST_TIMES` 声明处原注释里「保留字段是为了不触发严格校验」的理由为假——schema 本就不严格。它真正的保留理由是 `daily-digest` 那条现行需求钉着它的声明形状。

## 风险 / 取舍

- **`doctor --json` 形状变化**（少 `host_port` 项）：本仓约定该输出供 Agent 会话起始 ping，字段减少属向后不兼容，需在 `docs/DEPLOY.md` 注明。
- **`doctor 预检` 需求改名**：openspec 的需求名是身份键，改名会让按旧名检索的历史记录断链，且新条目会落到 `openspec/specs/account-cli/spec.md` 文件末尾、与 `## 目的` 的枚举顺序不再一致。接受——替代方案是留一条描述已删探测的场景，那正是本变更要消灭的东西。
- **三个测试文件会红且类型检查抓不到**：`tsconfig.json` 排除 `src/**/*.test.ts`，CI 只跑子集——唯一的捕捉手段是手动全量 `pnpm test` 与 §3 的负向断言。
- **将来若要恢复 HTTP 形态**，本次删掉的需求要重写。可接受：留一条无人实现的 MUST 的成本更高。
