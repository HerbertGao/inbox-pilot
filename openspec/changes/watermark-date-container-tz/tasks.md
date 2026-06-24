## 1. 日期 helper 改容器时区解析

- [x] 1.1 `src/cli/processFromDate.ts`：`parseProcessFromDate` 把 `Date.UTC(year, month-1, day)` 改为 `new Date(year, month-1, day)`（容器本地时区零点）；round-trip 真日期校验由 `getUTCFullYear/getUTCMonth/getUTCDate` 改本地 `getFullYear/getMonth/getDate`（仍拒 `2026-02-30` 进位归一）；**未来判定保持** `parsed.getTime() > now.getTime()`（瞬时比较，不动）；严格正则 `^\d{4}-\d{2}-\d{2}$` 与 `now` 注入参数不动；注释把「UTC 零点」改「容器时区零点（进程 `TZ`，部署 `Asia/Shanghai`；未设按 UTC = 旧语义，硬前提见 design 风险）」
- [x] 1.2 确认**不动** repo / poller / 摘要：`processFrom` 仍存绝对瞬时、默认 seed `?? new Date()` 与 `receivedAt` 比较均 TZ 无关；签名 `ProcessFromDateResult` 不变（仍 `{ok:true,date:Date}`）；两命令（`--process-from` / `set-process-from`）仍共用该 helper（同一守卫）
- [x] 1.3 `src/cli/account.ts` **运维可见文案改容器时区口径（仅文案、行为不变）**：help 文本 `:210`（`--process-from … （UTC 零点）`）、`:221`（`set-process-from … UTC 零点日期`）、两条非法日期 `errln` `:357`/`:667`（`需 YYYY-MM-DD 形式、解析为 UTC 零点`）、注释 `:334`/`:639-641`/`:660` 的「UTC 零点」→「容器时区零点」；**不动**任何控制流 / 退出码 / repo 入参 / `parseProcessFromDate` 调用点

## 2. 测试改 TZ-aware

- [x] 2.1 `src/cli/processFromDate.test.ts`：经**进程前置 `TZ`** 跑（决策 4；新增 `package.json` 脚本 `test:tz` = `TZ=Asia/Shanghai tsx --test 'src/cli/processFromDate.test.ts' 'src/cli/account.test.ts'` 与 `test:tz-utc` = `TZ=UTC tsx --test 'src/cli/processFromDate.test.ts'`；**不**靠用例内 `process.env.TZ=`、**不**靠宿主 ambient TZ）。断言分两类（决策 4）：**① TZ-robust（恒绿、任何 TZ 下跑）**——解析结果用**本地字段**核对（`getFullYear/Month/Date` == 入参、时分秒毫秒全 0）；本地「今天」（注入 `now`=当地午后）放行、本地「明天」拒、非法/进位归一（`2026-02-30`）/带时间分量（`…T14:00`）/空串拒；**② 绝对瞬时断言按 `process.env.TZ` 守卫**（不匹配则 `skip`、绝不 false-red）：`Asia/Shanghai` → `2026-01-15` = `2026-01-14T16:00:00.000Z`（`test:tz` 覆盖）；`UTC` → `2026-01-15` = `2026-01-15T00:00:00.000Z`（`test:tz-utc` 覆盖，固化「未设/UTC = 旧语义」容器默认路径）。**不**把 UTC 零点断言裸放进 Asia/Shanghai 前缀的文件（只能靠不可靠的运行期 mutate 或在开发机 ambient false-red）。**注**：「时分秒毫秒全 0」的 bulk 断言假定 runner 在**无午夜 DST 跳变的时区**（三个 mandated zone：Asia/Shanghai / UTC / 开发机 ambient 均满足；见决策 1）；若 CI 迁到零点跳变区（如 America/Sao_Paulo）需复核
- [x] 2.2 `src/cli/account.test.ts`：把 **4 处**硬编码 UTC 零点断言（`set-process-from`：`:921` 调用入参 Date + `:926` InMemory 存值；`add`：`:1031` `createAccount` 入参 + `:1053` `upsertAccount` 入参）改 **TZ-robust**——断言传入/存入的 Date 在**进程本地 TZ** 下为 `2026-03-15` 当日零点（本地 `getFullYear/Month/Date` == 2026-03-15 且时分秒毫秒全 0），**不**硬编码 `.toISOString()` 绝对瞬时（避免只在某一 TZ 成立、与 `test:tz`/`test:tz-utc` 互拆）；该文件在 `test:tz`（Asia/Shanghai）下跑。`futureDateStr()`（`:891`，`getUTCFullYear()+1`）**无需改**（次年元旦在任意 TZ 仍为未来）。**新增**一条命令级用例：断言非法 `--process-from` 的 `errln` 文案含「容器时区零点」（守住 1.3 文案）。其余命令级断言（退出码 / repo 调用入参形态 / 转义回显 / value-less 拒）不变

## 3. 文档

- [x] 3.1 `docs/DEPLOY.md`：① `processFrom` runbook 注明 `<YYYY-MM-DD>` 按**容器 `TZ`** 解析（`TZ` 为**硬前提**：`.env.example` 默认 `Asia/Shanghai`、线上 `.env` 已设；未设则按容器 OS = UTC = 旧语义，由 `tz-fallback-default` 告警可观测）；运维「今天」即本地今天、不再被判未来；② **改写** `:113-124` 的「UTC 零点前移问题」worked-example——两处「UTC 零点」文案在 `:117`（前移问题正文）与 `:124`（add/set 摘要）——为容器时区数字：`Asia/Shanghai` 下盖「当日」→ 当日本地 00:00 = 前一日 16:00Z（比旧 UTC 零点再早 8h、**同日回移窗口更大**），故仍须「盖到接入处理日之后」（告诫保留、理由改为本地午夜而非 UTC 午夜）；③ 既有已盖戳的水位线不被本变更回写（如需转本地语义可重跑 `set-process-from`）

## 4. 验收

- [x] 4.1 `pnpm exec tsc --noEmit` clean；`pnpm test`（ambient）、`pnpm run test:tz`（Asia/Shanghai）、`pnpm run test:tz-utc`（UTC）**三者皆绿**（绝对断言按 zone 守卫、其余 TZ-robust，故互不拆台）；**并跑一遍 `TZ=UTC pnpm test` 证伪**：因 bulk 断言 TZ-robust、绝对断言非 UTC-zone 时 `skip`，应仍全绿——以此确认每文件独立子进程隔离成立、前置 `TZ` 未干扰其它测试文件、UTC 默认路径由 `test:tz-utc` 覆盖
