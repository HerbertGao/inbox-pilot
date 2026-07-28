## 1. 代码：退役 HTTP 形态与死配置

- [x] 1.1 `pnpm remove fastify`，确认 `pnpm-lock.yaml` 同步更新——lock 里 fastify 与 `@fastify/*` 的命中必须归零（实测这些全是 fastify 自身及其传递依赖，应能剪净），否则 3.6 永久红
- [x] 1.2 `src/config/configSchema.ts` 删这六个字段的声明**及其上方描述它们的注释**——这份列表是 3.1 断言的同一份列表，改一处必须改两处：
      `HOST` · `PORT` · `NODE_ENV` · `POLL_INTERVAL_SECONDS` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_CHAT_ID`
      注释残留 3.1/3.2 都抓不到（不含被匹配的字面 token），必须手工带走：telegram 两字段上方整个「P2 通知渠道（telegram）…」段头、以及 `POLL_INTERVAL_SECONDS` 上方那句「轮询间隔仍是进程级 env 配置」
- [x] 1.3 `src/config/configSchema.ts` 的 `DIGEST_TIMES` 声明处注释：删掉「保留字段是为了不触发严格校验」这个理由（为假，见 design ③），改为指名 `openspec/specs/daily-digest/spec.md`「需求:DIGEST_TIMES 配置解析与降级」——该字段的保留理由是那条需求钉着它的声明形状
- [x] 1.4 `src/cli/doctor.ts` 删 host-port 探测**及其全部残留文字**：`DoctorDeps.checkHostPort` 注入点、`defaultCheckHostPort` 整个函数（连同其上的 jsdoc 块）、`PORT_PROBE_TIMEOUT_MS`、`deps.checkHostPort ?? defaultCheckHostPort` 那一行、`checks.push({ name: 'host_port', ... })` 那一段、`import { createServer } from 'node:net'`（唯一使用者是被删的函数；`tsconfig.json` 无 `noUnusedLocals`，类型检查抓不到这个死 import），以及文件头与 jsdoc 里提到 host-port 的全部注释行
- [x] 1.5 `src/cli/doctor.test.ts` 删 host-port 用例、共享默认 deps 里的 `checkHostPort` 桩、文件头注释里的对应条目
- [x] 1.6 `src/cli/inbox-pilot.test.ts` 删 `doctorDeps` 里的 `checkHostPort` 桩——注入点删除后它是指向不存在字段的多余属性；`tsconfig.json` 排除 test 故类型检查不报，运行期被忽略故用例数与 `pnpm test` 全绿都不受影响，唯一会红的是 3.2
- [x] 1.7 `src/config/config.test.ts` 删 `POLL_INTERVAL_SECONDS` 用例**连同其上的段头注释**（注释里也含该键名，只删用例会让 3.2 变红）
- [x] 1.8 `package.json` 删 `dev`（`tsx src/main.ts`）与 `start`（`node dist/main.js`）两个脚本——目标文件均不存在，无替代物
- [x] 1.9 `.env.example` 删这八个键：1.2 的六个，外加 `BARK_ENDPOINT`（从无 schema 字段、从无消费者）与 `DIGEST_TIMES`（字段保留但无消费者，示例文件不该教人设它），并删掉随之变空的小节注释头
- [x] 1.10 把仓内按旧需求名指名规范条目的注释改为新名「需求:doctor 只读部署预检」——**全部 5 处、3 个文件**：`src/cli/doctor.ts`（2 处）、`src/cli/doctor.test.ts`（1 处）、`src/config/configSchema.ts`（2 处）。`src/cli/doctor.ts` 文件头同一行里的 capability 名 `inbox-pilot-cli` 也是失效的（现规范是 `account-cli`），顺手一起改

## 2. 规范与文档

- [x] 2.1 `openspec-cn archive retire-http-and-dead-config --yes`（**缺 `--yes` 会因未勾任务停在交互提示、非交互下退出 1**）。前置：3.11 与 3.12 已通过。本步不手改 `openspec/specs/`；手改见 2.6
- [x] 2.2 `openspec/config.yaml` 的技术栈行删掉 `HTTP: fastify | ` **整段前缀**——只删 `fastify` 一词会留下悬空的 `HTTP: `（3.6 覆盖这一点）
- [x] 2.3 `CLAUDE.md` 与 `README.md` 的技术栈行去掉 ` · fastify`（`node-cron` 保留）
- [x] 2.4 `docs/DEPLOY.md` 里描述 `POLL_INTERVAL_SECONDS` 与 `DIGEST_TIMES` 的那段改写：前者字段已删，不能再提它；后者的保留理由改为「被 `daily-digest` 规范钉住声明形状」
- [x] 2.5 `docs/DEPLOY.md` 新增一句：`doctor --json` 的 `checks` 少了 `host_port` 项，按字段名解析的调用方需同步（向后不兼容）
- [x] 2.6 归档增量覆盖不到、须手改 `openspec/specs/` 的三处（`archive` 只写增量里有的段落，故这三处从归档重放得不到，必须单列并由 3.5c 守住）：
      `service-bootstrap/spec.md` 的 P0 变量集段落补注「`TELEGRAM_*` / `BARK_*` / `POLL_*` 已无字段」（增量的 `## 修改需求` 正文不含此插入语）·
      `account-cli/spec.md` 的 `## 目的` 把「doctor 预检」改为「doctor 只读部署预检」（增量里没有 `## 目的` 段，`archive` 不会写它）·
      `imap-integration/spec.md` 补「轮次串行」前提归属段（该规范的增量只有 `## 移除需求`）

## 3. 验证

除 3.7（需按其说明改写 3.6 的豁免项）与 3.14（变异测试，本就要人工注入再复原）外，每一步都是可原样粘贴执行的断言：失败退出非零，**无占位符、无需人工判读**。

**先在仓根跑这一行**：`test -f package.json && test -d src || { echo '不在仓根'; false; }`——下面多条断言是 `! grep …` / `! jq -e …` 形态，而 `grep` 读不到文件时返回 2、`jq` 出错返回 5，`!` 会把这两种**读取失败**一并翻成通过（3.13 因此改用显式 `rc == 1`）。cwd 不对时六条会集体假绿。工具用 `pnpm dlx @herbertgao/openspec-cn@1.6.0`——`openspec-cn` 这个名字在本机解析到哪个发行方/版本取决于 PATH，而 design ② 的全部行为结论与 3.11 依赖的输出串都是版本相关的。

**§1/§2 每一步都必须有一条会因它漏做而变红的断言**，对应关系：1.1→3.6 · 1.2→3.1 · 1.3→3.1b · 1.4/1.5/1.6/1.7→3.2 · 1.8→3.4 · 1.9→3.3 · 1.10→3.5 · 2.2/2.3→3.6 · 2.4/2.5→3.5b · 2.6→3.5c。

- [x] 3.1 **六个字段的声明清零**（本变更的头号动作，字段列表与 1.2 同源）：
      ```sh
      ! grep -nE '^[[:space:]]*(HOST|PORT|NODE_ENV|POLL_INTERVAL_SECONDS|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)[[:space:]]*:' \
          src/config/configSchema.ts
      ```
      改动前命中 6 行。**没有这一步，漏删其中五个字段时其余各步会全绿**：3.2 查的是消费者（`config.HOST` / `checkHostPort` 等）而不是声明
- [x] 3.1b `grep -q 'daily-digest' src/config/configSchema.ts`（1.3 要求 `DIGEST_TIMES` 声明处指名那条规范；漏做则该串不存在）
- [x] 3.2 死符号清零（消费者侧；下划线与连字符两种写法、以及被删字段的 `config.*` / `parsed.data.*` 消费形式都覆盖）：
      ```sh
      ! grep -rnE 'POLL_INTERVAL_SECONDS|(config|parsed\.data)\.(HOST|PORT|NODE_ENV|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)|checkHostPort|host_port|host-port|PORT_PROBE_TIMEOUT_MS|node:net' src/
      ```
      注意 `src/db/prisma.ts` 的 `process.env.NODE_ENV` 是合法保留（它绕过 schema），故只匹配 `config.` / `parsed.data.` 前缀
- [x] 3.3 `.env.example` 的退役键清零（1.9 的对应断言；改动前命中 8 行）：
      ```sh
      ! grep -nE '^(HOST|PORT|NODE_ENV|POLL_INTERVAL_SECONDS|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|BARK_ENDPOINT|DIGEST_TIMES)=' .env.example
      ```
- [x] 3.4 `package.json` 死脚本清零（1.8 的对应断言）：`! jq -e '.scripts | has("dev") or has("start")' package.json`
- [x] 3.5 旧需求名清零（1.10 的对应断言）：`! grep -rn "doctor 预检" src/`（新名「doctor 只读部署预检」不含该子串）
- [x] 3.5b 文档同步（2.4 / 2.5 的对应断言）：`! grep -q 'POLL_INTERVAL_SECONDS' docs/DEPLOY.md && grep -q 'host_port' docs/DEPLOY.md`
- [x] 3.5c 2.6 那三处手改仍在（归档增量重放不出它们，故只有这条断言守着）：
      ```sh
      grep -q 'doctor 只读部署预检' openspec/specs/account-cli/spec.md \
        && grep -q '轮次串行' openspec/specs/imap-integration/spec.md \
        && grep -q '已无字段' openspec/specs/service-bootstrap/spec.md
      ```
- [x] 3.6 fastify 与悬空 `HTTP: ` 残留（**归档前跑**，此时主规范仍含 fastify，属预期）：
      ```sh
      { grep -rn "fastify" --include="*.ts" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.md" . \
          | grep -v node_modules | grep -v openspec/changes/archive \
          | grep -v -e 'ROADMAP\.md:' -e 'PROJECT_INIT\.md:' \
                   -e 'openspec/specs/service-bootstrap/spec\.md:' \
                   -e 'openspec/changes/retire-http-and-dead-config/'
        grep -nE 'HTTP: *(\||$)' openspec/config.yaml
      } > /tmp/fastify-left; test ! -s /tmp/fastify-left || { cat /tmp/fastify-left; false; }
      ```
      必须为空。落盘再 `test ! -s` 是必需的：管道最后一环是 `grep -v`，它在**有**违规时返回 0、干净时返回 1，直接看退出码语义是反的。两个豁免文件是历史记录（分别记录 P0 当时建了什么、初始需求文档的安装命令），不描述当前形态，故不改
- [x] 3.7 归档后复跑 3.6，去掉 `openspec/specs/service-bootstrap` 与本变更目录两条豁免（届时前者已被改写、后者已移入 `archive/` 被首行 `grep -v` 排除），仍须为空
- [x] 3.8 `npx tsc --noEmit` clean
- [x] 3.9 `pnpm test` → **482 pass / 0 fail**（改动前 483；删掉 doctor host-port 与 config `POLL_INTERVAL_SECONDS` 各一个用例 = 481，另加一条 review 阶段补回的 doctor 成功路径脱敏用例 = 482）。机器断言而非人眼看汇总：
      ```sh
      pnpm test > /tmp/t.log 2>&1; rc=$?
      test "$rc" -eq 0 && grep -qF ' pass 482' /tmp/t.log && grep -qF ' fail 0' /tmp/t.log
      ```
      用 `-F` 定值匹配而非 `^.`：汇总行以 `ℹ`（UTF-8 三字节）开头，`.` 在 `LC_ALL=C` 下只吃一字节，会让这条因 locale 而非逻辑变红
      `tsconfig.json` 排除 `src/**/*.test.ts`，故此步不可由 3.8 代替
- [x] 3.10 `pnpm build && node dist/cli/inbox-pilot.js doctor --json | jq -e '[.checks[].name] | index("host_port") == null'` → 退出码 0（改动前该断言失败）。必须先 build（`dist/` 不是 3.8 的产物）；不能用裸 `inbox-pilot`（`package.json` 是 `private`、`bin` 未 link，该名字不在 PATH 上）
- [x] 3.11 **归档 preflight（隔离副本上真跑 `archive`）**——唯一能证明可归档的步骤，**必须在 2.1 之前跑**：
      ```sh
      S=$(mktemp -d) && cp -R openspec "$S"/ \
        && (cd "$S" && pnpm dlx @herbertgao/openspec-cn@1.6.0 archive retire-http-and-dead-config --yes) \
             > "$S/archive.log" 2>&1
      rc=$?; grep -q 'Specs 更新成功' "$S/archive.log"; hit=$?
      test $rc -eq 0 -a $hit -eq 0 || cat "$S/archive.log"; rm -rf "$S"; test $rc -eq 0 -a $hit -eq 0
      ```
      分别断言退出码与成功标记：成功串打印在「已归档为…」之前，只 `grep -q` 会放过其后的失败；失败时先把日志打出来再删临时目录。**`validate --strict` 与 `show --json` 都不足以作证据**：实测 MODIFIED 块删掉或改名一个场景时两者均报成功，而 `archive` 会中止并报 `current spec contains scenario(s) not present in the modified block`——失败是静默的，直到真正归档才现形
- [x] 3.12 形态冒烟（**归档前跑**；归档后变更目录已移入 `archive/`，按裸 id 解析的行为未定义）：
      ```sh
      pnpm dlx @herbertgao/openspec-cn@1.6.0 show retire-http-and-dead-config --json \
        | jq -e '([.deltas[].operation] | index("REMOVED") != null) and ([.deltas[].spec] | unique | length == 3)' \
        && pnpm dlx @herbertgao/openspec-cn@1.6.0 validate retire-http-and-dead-config --strict
      ```
      两条都只是形态冒烟，**不作为可归档的证据**——证据是 3.11
- [x] 3.13 改动面不含 **C0 控制字符**（本仓被字面控制字符咬过三次）：
      ```sh
      LC_ALL=C grep -rn $'[\001-\010\013\014\016-\037\177]' \
        src/ package.json .env.example docs/ openspec/changes/archive/2026-07-28-retire-http-and-dead-config/; rc=$?
      test $rc -eq 1
      ```
      文件集写死、非空。**只接受 `rc == 1`（无命中）**：`rc == 0` 是命中、`rc == 2` 是读取错误，用 `! grep` 会把读取错误也当成通过；早先那版用占位符当参数，零参数时 grep 读空 stdin 返回 1、`!` 翻成 0，是一条当场为假绿的断言。作用域是 C0（不含 tab / LF / CR），**不覆盖零宽 Unicode**（如 U+200B）
- [x] 3.14 **对验收套本身做一次变异测试**：在 1.2 里故意保留一个字段声明不删，重跑 3.1——必须变红；确认后再删掉它。这是唯一能证伪「检查与动作不是同一个东西」的手段，成本一次运行

## 4. 部署（无顺序约束，见 design ③）

- [ ] 4.1 在 `~/inbox-pilot-hangar` 拉取、`pnpm install`、`pnpm build`
- [ ] 4.2 `pnpm migrate:deploy`（`prisma migrate deploy`）——`service-bootstrap`「运行载体与迁移前置」无条件要求它在重启 daemon **之前**执行，非零退出即中止部署，禁止把 pilot 放到未迁移的库上
- [ ] 4.3 `launchctl kickstart -k gui/$(id -u)/com.herbertgao.hangar-inbox` 重启 daemon
- [ ] 4.4 确认日志出现 `daemon started`；跑
      `node dist/cli/inbox-pilot.js doctor --json | jq -e '.ok'` → 退出码 0。
      `.ok` 就是「关键检查全过」（`config` 校验 + DB 可达性），config 失败与 DB 不可达都会让它为 false。**不要**逐项取 `.ok` 输出多个值——`jq -e` 的退出码只看最后一个输出值，而 config 校验失败时 `database` 被记为 `{ok:true, detail:"skipped"}` 排在其后，恰恰在要挡的场景上返回 0。也不要用「全绿」——6 项检查里有 4 项 `ok` 由构造写死为真
- [ ] 4.5 （非阻塞卫生，何时做都行）在 `ts.mac-mini` 的 `~/inbox-pilot-hangar/.env` 里删掉已退役的键——残留键被 zod 静默丢弃，删不删都不影响启动
