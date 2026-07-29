## 1. 实现

- [ ] 1.1 从 `586dc62^` 取回 `src/providers/imap/imapPoller.ts` 与 `src/providers/imap/imapPoller.test.ts` 作为**起点**（`git show 586dc62^:<path>`）。算法部分不改（游标解析 / `advanceHighWater` / `computeCursorToWrite` 的退化轮 floor 四级优先含 `need-max-uid` 哨兵 / 增量轮不带 `seen` 过滤）；改的是 1.3 的接缝
- [ ] 1.2 `src/repo/mailRepo.ts` 恢复 `getCursor(accountId)` / `setCursor(accountId, cursor)`——读写 `mail_accounts.lastSyncCursor`。列与生产数据都在，只是方法在 `586dc62` 被移除。接口与内存实现（测试用）同步补上
- [ ] 1.3 `src/pipeline.ts` 抽出 provider 无关的单封处理链：入参为已归一的 `NormalizedEmail`（外加 `accountId` / `providerMessageId` / 复访标记），内容为「分类（复用/LLM）→ 规则 → `executeActions` → emit → `markProcessed`」。现有 `processOneEmail` 的 `gmail.get` 与两级读错误分流**留在 Gmail 侧**，不进共享链（design ③）
- [ ] 1.4 IMAP 侧的单封路径复用 1.3 的共享链，并复用既有 per-email 超时 + `Fence` 包装——**不另写一套**（design ②：否则超时语义在两个 provider 上分叉）
- [ ] 1.5 `src/pipeline.ts` 的 poll 分支同时处理 imap 账号：删掉「只留 gmail」的过滤，改为按 `provider` 分派；账号级异常 catch+记错、不中断其余账号
- [ ] 1.6 poller 每账号每轮发一条结构化日志 `kind: 'imap-poll-round'`，字段含 `accountId` / `isDegraded` / `fetched` / `processed` / `failed`——**禁含**凭据、host、正文、收件人。这是 4.3 唯一能证明「它真的跑了」的证据源，缺它则该步无法机械断言
- [ ] 1.7 `imapClient.ts` / `imapActions.ts` **不改**——两者在 `586dc62` 中原样保留且仍符合规范

## 2. 规范

- [ ] 2.1 `openspec-cn archive restore-imap-polling --yes`（缺 `--yes` 会因未勾任务停在交互提示、非交互下退出 1）。前置：3.9 已通过。本步不手改 `openspec/specs/`
- [ ] 2.2 `imap-integration` 的其余四条需求**一个字都不改**——本变更是让实现满足它们

## 3. 验证

除 3.10（变异测试，本就要人工注入再复原）外，每一步都是可原样粘贴执行的断言：失败退出非零，**无占位符、无需人工判读**。

**先在仓根跑这一段**——只验 cwd 不够，被读的每个文件都要在：

```sh
for f in package.json src/pipeline.ts src/repo/mailRepo.ts \
         src/providers/imap/imapClient.ts src/providers/imap/imapActions.ts \
         openspec/specs/imap-integration/spec.md; do
  test -r "$f" || { echo "缺文件: $f"; exit 1; }
done
test -d src
```

`! grep …` 形态在文件缺失时（grep 返回 2）会被 `!` 翻成通过，故上面这段不是形式主义。

**§1/§2 每一步都必须有一条会因它漏做而变红的断言**，对应关系：1.1→3.1 · 1.2→3.2 · 1.3/1.4→3.3 · 1.5→3.4 · 1.6→3.5 · 1.7→3.6 · 2.1→3.9。

- [ ] 3.1 poller 回来了且导出两个入口：
      ```sh
      test -f src/providers/imap/imapPoller.ts \
        && grep -qE '^export (async )?function pollAccount' src/providers/imap/imapPoller.ts \
        && grep -qE '^export (async )?function pollOnce' src/providers/imap/imapPoller.ts
      ```
- [ ] 3.2 游标方法回来了（接口与实现都要，故要求 ≥2 处命中）：
      ```sh
      test "$(grep -cE 'getCursor|setCursor' src/repo/mailRepo.ts)" -ge 2
      ```
- [ ] 3.3 共享链存在且**两个 provider 都调用它**——只抽不接是这条最容易的假绿：
      ```sh
      grep -qE 'imapPoller' src/pipeline.ts \
        && test "$(grep -c 'processOneEmail\|processNormalizedEmail' src/pipeline.ts)" -ge 2
      ```
      （落地时把函数名替换为实际名，并保持「≥2 处引用」这个形状——定义 1 处 + 至少 1 处调用）
- [ ] 3.4 poll 分支不再只留 gmail：
      ```sh
      ! grep -qE "filter\(.*provider === 'gmail'.*\)$" src/pipeline.ts \
        && grep -q "'imap'" src/pipeline.ts
      ```
- [ ] 3.5 每轮日志 kind 存在（4.3 的证据源）：
      ```sh
      grep -q "imap-poll-round" src/providers/imap/imapPoller.ts
      ```
- [ ] 3.6 连接层与动作层未被改动：
      ```sh
      git diff --quiet 586dc62 -- src/providers/imap/imapClient.ts src/providers/imap/imapActions.ts
      ```
- [ ] 3.7 `npx tsc --noEmit` clean（rc=0）
- [ ] 3.8 `pnpm test` 全绿**且用例数严格多于改动前的 482**（新增 poller 用例）：
      ```sh
      pnpm test > /tmp/t.log 2>&1; rc=$?
      test "$rc" -eq 0 || { tail -30 /tmp/t.log; false; }
      grep -qF ' fail 0' /tmp/t.log \
        && awk '/ tests [0-9]+$/ { n=$NF } END { exit !(n > 482) }' /tmp/t.log
      ```
      用 `-F` / `awk` 而非 `^.` 正则：汇总行以 `ℹ`（UTF-8 三字节）开头，`.` 在 `LC_ALL=C` 下只吃一字节，会让断言因 locale 而非逻辑变红
- [ ] 3.9 **归档 preflight（隔离副本上真跑 `archive`）**——唯一能证明可归档的步骤，**必须在 2.1 之前跑**：
      ```sh
      S=$(mktemp -d) && cp -R openspec "$S"/ \
        && (cd "$S" && pnpm dlx @herbertgao/openspec-cn@1.6.0 archive restore-imap-polling --yes) \
             > "$S/archive.log" 2>&1
      rc=$?; grep -q 'Specs 更新成功' "$S/archive.log"; hit=$?
      test $rc -eq 0 -a $hit -eq 0 || cat "$S/archive.log"; rm -rf "$S"; test $rc -eq 0 -a $hit -eq 0
      ```
      `validate --strict` 与 `show --json` **都不足以作证据**：实测二者对不可归档的增量均报成功
- [ ] 3.10 **对验收套本身做一次变异测试**：把 1.5 的 imap 分派临时改回「只留 gmail」，重跑 3.4——必须变红；确认后复原
- [ ] 3.11 改动面不含 **C0 控制字符**：
      ```sh
      LC_ALL=C grep -rn $'[\001-\010\013\014\016-\037\177]' \
        src/ openspec/changes/restore-imap-polling/; rc=$?
      test $rc -eq 1
      ```
      **只接受 `rc == 1`（无命中）**：`rc == 0` 是命中、`rc == 2` 是读取错误，用 `! grep` 会把读取错误也当通过

## 4. 部署

- [ ] 4.1 在 `ts.mac-mini` 的 `~/inbox-pilot-hangar` 拉取、`pnpm install --frozen-lockfile`、`pnpm build`（无 schema 变更，**不需要** `migrate:deploy`；但既有部署纪律仍要求它先于重启执行，跑一次为幂等 no-op）
- [ ] 4.2 `launchctl kickstart -k gui/$(id -u)/com.herbertgao.hangar-inbox`，随后**必须**用 `launchctl list | grep hangar-inbox` 确认 service 仍在册——实测该 service 曾在一次成功 kickstart 之后从 launchd 注册表消失，只看 kickstart 退出码不足以证明 daemon 活着
- [ ] 4.3 等一个 `poll` 周期，断言该 imap 账号真的被轮询到（证据源是 1.6 那条日志）：
      ```sh
      grep -q '"kind":"imap-poll-round"' ~/hangar-inbox.out.log ~/hangar-inbox.err.log
      ```
      **不要**用「没有报错」当通过——静默失效正是本变更要消灭的东西
- [ ] 4.4 断言游标语义正确：首轮**必须**走增量分支（`isDegraded=false`），否则说明游标没读到、会退化成 `SEARCH UNSEEN` 并可能漏掉迁移期间被别的客户端读过的邮件：
      ```sh
      grep '"kind":"imap-poll-round"' ~/hangar-inbox.out.log ~/hangar-inbox.err.log \
        | tail -1 | grep -q '"isDegraded":false'
      ```
- [ ] 4.5 **人工确认**：首轮之后检查该邮箱，确认被标已读的邮件符合预期（该邮箱三周未被 pilot 触碰，这是恢复写操作后的第一轮）。此步无法机械断言，是本套唯一需要人眼的一条
