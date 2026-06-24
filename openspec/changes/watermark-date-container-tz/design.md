## 上下文

`parseProcessFromDate`（`src/cli/processFromDate.ts`）现把 `YYYY-MM-DD` 经 `Date.UTC(y,m-1,d)` 解析为 **UTC 零点**，并 round-trip 校验真日期（拒 `2026-02-30`），再以 `parsedUtcMidnight.getTime() > now.getTime()` 拒未来。`--process-from`（接入覆盖）与 `set-process-from`（改既有）共用它。`processFrom` 列是 `TIMESTAMP(3)`、存绝对瞬时，与 `receivedAt` 绝对瞬时比较。部署在 mac-mini，app 容器 `TZ=Asia/Shanghai`。UTC 口径在东于 UTC 的运维处产生「本地今天被判未来」「日期与直觉差 8h」两个坑（onboarding-date-watermark 部署当天撞上）。

## 目标 / 非目标

**目标：**
- 日期串按**容器时区**解析（运维输入「今天」即本地今天、不被误拒、符合直觉）。
- 仅改「人类日期串 → 瞬时」这一步；存储、比较、摄入/摘要下界、默认 seed 全不动。
- 两命令仍共用同一 helper；测试确定、不引入 TZ flakiness。

**非目标：**
- 不引入 `--tz` flag / 时区参数（运维心智是「容器 TZ」，不需要 per-命令时区）。
- 不改 `processFrom` 列类型/存储语义、不加 DB 迁移、不加 env。
- 不改水位线 ±1 天粗粒度（onboarding-date-watermark 决策 5），不加 post-fetch 过滤。
- 不回写已盖戳的存量水位线（见迁移计划）。

## 决策

**决策 1：本地零点用 `new Date(year, month-1, day)`，委托进程 `TZ`（= 容器 `TZ`）。**
`new Date(y,m,d)` 按进程本地时区取该日零点的绝对瞬时，时区/夏令时/历史 offset 由运行时 ICU/系统库正确处理。**替代**：自己按固定 +08:00 偏移算——弃（重造时区轮子、易在 DST/历史 offset 出错，且把 Asia/Shanghai 写死）。round-trip 校验相应由 `getUTCFullYear/Month/Date` 改本地 `getFullYear/Month/Date`（仍拒进位归一的非真日期）。**DST 边界（显式限定）**：在「本地午夜不存在」的时区（夏令时跳过午夜，如 `America/Sao_Paulo 2018-11-04` 午夜 00:00→01:00），`new Date(y,m,d)` 会落到当日 01:00——本地 `get*` round-trip 仍过、日期被**接受**，但存的瞬时非该日零点。部署时区 `Asia/Shanghai` 自 1991 起**无 DST**、无此跳变，故「落本地零点」保证对部署成立。本提案据此**显式限定**支持「无午夜 DST 跳变的时区」（`Asia/Shanghai` 满足）；跨时区移植前需复核此前提。

**决策 2：未来判定保持瞬时比较 `parsed.getTime() > now.getTime()`，不变。**
本地零点是绝对瞬时，与 `now` 直接比较天然正确：本地「今天」零点 ≤ now（今天稍早）→ 放行；本地「明天」零点 > now → 拒。比 UTC 口径更直观（本地今天恒放行，无 08:00 前误拒）。**不**改成 date-to-date 比较（仍要防把未来日静默放行）。

**决策 3：列存储与比较语义不变——只动入参口径。**
`processFrom` 仍存 `new Date(...)` 产出的绝对瞬时（Prisma 按 UTC 落 `TIMESTAMP(3)`）。例：本地 `2026-06-24` → 瞬时 `2026-06-23T16:00Z`（Asia/Shanghai）→ 存 `2026-06-23 16:00:00`。与 `receivedAt`（绝对瞬时）比较 TZ 无关。spec 里「UTC 语义/零点」措辞**仅**指日期串入参那处，改为「容器时区零点」；列存绝对瞬时这点不变、措辞澄清即可。默认 seed `?? new Date()` 是瞬时、天然不受影响。

**决策 4：TZ-敏感测试在**进程启动前**经环境前置 `TZ` 跑（不靠用例内改 `process.env.TZ`、不靠宿主 ambient TZ）。**
口径锚定在**进程边界**：用环境前置的测试命令（新增脚本 `test:tz` = `TZ=Asia/Shanghai tsx --test 'src/cli/processFromDate.test.ts' 'src/cli/account.test.ts'`，TZ 在进程启动前即定、不依赖运行期重读、与 Node 版本无关）。**已实测**：`tsx --test <glob>` 每个测试文件跑在**独立子进程**（互不污染），故前置 `TZ` 对各文件一致生效、且不串扰其它测试文件。**不**首选「用例内 `process.env.TZ='…'`」——其重读行为依赖 V8/Node 版本（本仓 `engines: ^24`，开发机为 v22，二者可能不同），且宿主 ambient TZ（开发机 = `Asia/Shanghai`）会**掩盖**真实容器（OS = UTC）行为造成 false-green。**断言分两类，避免「绝对瞬时断言」与多 TZ 跑互斥**：① **TZ-robust 断言**（任何进程 TZ 下都成立，故 `test:tz`、ambient `pnpm test`、`TZ=UTC` 证伪跑**皆绿**）——解析结果的**进程本地字段**（`getFullYear/Month/Date` == 入参、时分秒毫秒全 0）；本地「今天」（注入 `now`=当地午后）放行、本地「明天」拒、非法/进位归一/带时间分量/空串拒；② **绝对瞬时断言按 `process.env.TZ` 守卫**（只在匹配 zone 跑、其它 zone `skip`，绝不 false-red）：`TZ==='Asia/Shanghai'` 时 `2026-01-15 → 2026-01-14T16:00:00.000Z`；`TZ==='UTC'` 时 `2026-01-15 → 2026-01-15T00:00:00.000Z`（固化「未设/UTC = 旧语义」的容器默认路径），分别由 `test:tz`（`TZ=Asia/Shanghai`）与 `test:tz-utc`（`TZ=UTC`）覆盖。**不**把 UTC 零点断言裸放进 `test:tz` 前缀（=Asia/Shanghai）的文件里——那只能靠运行期 mutate `process.env.TZ`（本决策已判其版本相关/不可靠）或在开发机 ambient（Asia/Shanghai）下 false-red。**替代**：给 helper 加显式 tz 注入参数——弃（污染签名、生产无人传、运维心智是容器 TZ）。

## 风险 / 权衡

- **测试 TZ 依赖引入 flakiness / false-green**（CI runner / 容器 TZ 与开发机不同则本地零点瞬时漂移；开发机 ambient `Asia/Shanghai` 会掩盖容器 UTC 行为）→ 经**进程前置 `TZ`** 跑（决策 4）；尽量断言 TZ-robust 性质（本地今天/明天用注入 `now` 相对表达），少硬编码绝对瞬时；若硬编码则在固定 `TZ=Asia/Shanghai` 下；并跑一遍 `TZ=UTC pnpm test` **证伪**（确认隔离成立 + 容器默认路径被覆盖）。
- **TZ 依赖是硬前提、非优雅降级**：日期串解析走进程 OS 级 `TZ`（`new Date`），摘要的 app 级 `?? Asia/Shanghai` 兜底（`digestTimezone.ts`）**不覆盖**此路径。`TZ` 已设（`.env.example` 默认 `Asia/Shanghai`、线上已设）→ 修复生效；`TZ` 未设 → 日期串退回 UTC 零点 = 旧 bug（**静默 no-op**，非优雅降级），由既有 `tz-fallback-default` 告警可观测。**本变更不强加 env / 不改镜像**（用户决策：仅文档化此硬前提）；线上经直接更新 `.env`（`TZ=Asia/Shanghai`）兜底，如需根除该 footgun（镜像钉 `TZ` / doctor 守卫）另起单独变更。
- **已盖戳的存量水位线不被改写**（见迁移计划）→ 仅未来的日期解析变；如要既有戳转本地语义，运维重跑 `set-process-from` 即可（可选，非必须；差值 8h、对半年前积压无实质影响）。

## 迁移计划

无 DB 迁移。发布即生效（下次 `--process-from`/`set-process-from` 按容器 TZ）。已止血盖的 `2026-06-24`（UTC 06-24T00:00Z）保持原值、仍正确排除 06-23 积压，无需回写。回滚 = 还原 `parseProcessFromDate` 至 `Date.UTC`（纯代码、无数据影响）。

## 待解决问题

- 无。`tsx --test` 的 TZ 写法已定（决策 4：进程前置 `TZ`；「每文件独立子进程、无串扰」已实测确认）。
