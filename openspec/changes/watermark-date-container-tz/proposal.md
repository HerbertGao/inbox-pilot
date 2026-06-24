## 为什么

`--process-from` / `set-process-from` 的日期串当前解析为 **UTC 零点**（`Date.UTC`）。对东于 UTC 的运维（mac-mini app 容器 `TZ=Asia/Shanghai`，已上线证实），这有两个反直觉后果：① 北京 06-24 00:00–07:59 之间盖「今天 2026-06-24」会被判**未来**拒绝（其 UTC 零点 06-24T00:00Z 此刻仍在未来），运维被迫等到北京 08:00 或改盖前一天；② 运维心里的「今天」是北京日历日，UTC 零点比它早/晚 8h，盖出来的水位线与意图差一截。实际止血时已撞上此坑（本仓 onboarding-date-watermark 部署当天）。

## 变更内容

- 把日期串 `YYYY-MM-DD` 的解析从 **UTC 零点**改为**容器本地时区零点**（进程 `TZ`，部署设为 `Asia/Shanghai`）：`parseProcessFromDate` 由 `Date.UTC(y,m-1,d)` 改 `new Date(y,m-1,d)`；round-trip 真日期校验由 `getUTC*` 改本地 `get*`。
- 未来判定**保持瞬时比较** `parsedMidnight.getTime() > now.getTime()`（不变）——改本地零点后，「本地今天」恒 ≤ now、不再误拒；「本地明天」仍被拒。
- `--process-from` 与 `set-process-from` **仍共用同一 helper**（同一守卫不漂移）。
- **不改**：`MailAccount.processFrom` 列仍存**绝对瞬时**（`TIMESTAMP(3)`，Prisma 按 UTC 读写）——仅「人类日期串 → 瞬时」这一步的时区口径变；与 `receivedAt` 的比较仍是绝对瞬时、不受影响；默认 seed `?? new Date()`（精确瞬时）不受影响；摄入 `SINCE`/`after:` 与摘要下界（均消费瞬时）不受影响。
- **无 DB 迁移、无新依赖、无新 env**。复用既有进程 `TZ`（OS 级）作日期串解析口径——这是**硬前提、非「优雅降级」**：摘要调度器用的是**应用级**兜底 `process.env.TZ || 'Asia/Shanghai'`（`digestTimezone.ts`，仅喂 node-cron 的 timezone 参数），它**不**覆盖 `new Date(y,m,d)`。故：`TZ` 已设（`.env.example` 默认 `Asia/Shanghai`、线上已设）→ 修复生效；`TZ` 未设 → 日期串解析按容器 OS 时钟（`node:24-bookworm-slim` = UTC）退回 UTC 零点 = **旧语义、静默 no-op**（不是优雅降级），由既有 `tz-fallback-default` 告警可观测。

## 功能 (Capabilities)

### 新增功能
<!-- 无 -->

### 修改功能
- `onboarding-watermark`: 「运维可调整存量账号的水位线」需求里日期解析口径由 **UTC 零点**改为**容器时区零点**；「显式覆盖起算日期」「今天不被误拒」等场景的时区口径随之更新（语义层变更，非仅实现）。

## 影响

- **代码**：`src/cli/processFromDate.ts`（`Date.UTC`→本地、round-trip 校验改本地字段）；`src/cli/account.ts` **运维可见文案**（help `--process-from`/`set-process-from` 两处、两条非法日期 `errln`、相关注释中的「UTC 零点」）改「容器时区零点」——**仅文案、行为不变**；`src/cli/processFromDate.test.ts` 与 `src/cli/account.test.ts`（用例改 TZ-aware：进程启动前固定 `TZ`、断言容器时区零点 / 本地今天放行）；`package.json`（新增 `test:tz` / `test:tz-utc` 脚本，作进程前置 `TZ` 跑）。
- **规范**：`onboarding-watermark` spec 中**日期串入参**的「UTC 零点」措辞改「容器时区零点」（req#7「运维可调整存量账号的水位线」、req#3「播种」的入参场景）；req#1「per-account 起算日期水位线（UTC）」的「UTC 语义」指**列存储**（绝对瞬时 / Prisma 按 UTC 读写）、**不变**，**标题保留「（UTC）」**（OpenSpec MODIFY 按标题匹配，不重命名），仅正文「UTC 语义」措辞改「UTC 存储语义」并补一句「口径区分：列=UTC 存储；日期串入参=容器时区零点」以免混淆（不改列语义）。req#7 下场景 `今天不被误拒`→`容器时区的今天不被误拒`、req#3「播种」下场景 `…不被抹到 UTC 零点`→`…不被抹到日期零点` 重命名（MODIFY 整体替换、意图不变、非丢场景）。
- **文档**：`docs/DEPLOY.md` 注明 `--process-from`/`set-process-from` 日期按**容器 `TZ`** 解析（`TZ` 为**硬前提**，未设则按 UTC = 旧语义）；并改写 `processFrom` runbook 的「UTC 零点前移问题」worked-example（约 :113-124、含「解析为 UTC 零点」）为容器时区口径：`Asia/Shanghai` 下盖「当日」→ 当日本地 00:00 = 前一日 16:00Z，比旧 UTC 零点再早 8h、**同日回移窗口更大**，故仍须「盖到接入处理日之后」（告诫保留，理由更新为本地午夜而非 UTC 午夜）。
- **不影响**：DB schema / 迁移、`processFrom` 存储语义、摄入与摘要的瞬时比较、默认 seed、其余能力。
