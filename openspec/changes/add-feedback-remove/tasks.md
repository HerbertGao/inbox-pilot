## 1. overlay 格式的唯一所有者（`src/rules/rulesConfig.ts`）

同一份 overlay 的五个语义问题此前各被 loader / 提案腿 / 应用腿独立回答 2–3 次。**成对一致不具传递性**：三个持有者时把 (A,B) 调平必然打破 (B,C)。故这些答案在本模块各只有一份，`pipeline.ts` 是纯消费者。

- [x] 1.1 `canonicalizeOverlayLine(raw): string | null` —— **行归一的唯一实现**（`trim` → 去包裹 `<>` → 小写；空 → null）。loader 读文件与两腿读用户输入全部走它
- [x] 1.2 `isAddableEntry(s)` —— 可加入判据：非 ASCII/控制字符（**归一前判**，`K` 之类会小写成 ASCII）· 长度 ≤254 · 域名 ≥2 段且每段 ≤63 字节、末段为 ≥2 位纯字母 TLD · local 为 **dot-atom**（atext 段以 `.` 分隔，无前导/尾随/连续点）
- [x] 1.3 `checkEntry(item, direction)` —— **两腿共用**，方向差异只存在这一处：`add` 要求已归一 **∧** 可加入；`remove` 只要求已归一
- [x] 1.4 `readOverlayFile(path, mode)` —— **读的唯一实现**，尺寸一律以 `statSync().size` 度量（与 loader 同量；改量解码后字节数会让含无效 UTF-8 的文件出现「loader 采纳、写路径拒绝」的分叉）。失败语义是**参数**：`fail-open`（loader）/ `fail-closed`（写路径与提案腿）
- [x] 1.5 `isSameFile(a, b)` —— 问文件系统要 `dev`/`ino` 身份。词法比较挡不住软链父目录（k8s `..data`、macOS `/tmp`→`/private/tmp`）与大小写不敏感盘
- [x] 1.6 `hasOwnKey` / `readOwnKey` —— 自有键读取（`in` 走原型链，被污染的 `Object.prototype` 能凭空造出请求）
- [x] 1.7 正则一律用码位转义写；`file(1)` 核对源文件为 UTF-8 text 而非 data

## 2. `src/pipeline.ts` 降级为纯消费者

- [x] 2.1 删除本地的 `canonicalizeEntry` / `isValidEntry` / `isCanonicalEntry` / `isCanonicalForm` / `readOverlayStrict` 及五条本地正则、`MAX_ENTRY_LEN`、读侧 `Buffer.byteLength`、`resolve()` 路径比较（净 −99 行）
- [x] 2.2 `runInterpretFeedback` 结构化分支：`readOverlayFile(..., 'fail-closed')` 读 → `keepValidEntries(raw, direction)` 归一 + 按方向判据 + 去重 → 同项两侧剔除 → 与 overlay 比对
- [x] 2.3 **提案就是将写入的 diff**：提案腿镜像应用腿的条数闸与序列化字节闸（`fitWithinWriteBudget`），超预算**截断**而非报错——干跑腿不能 throw，但也不能提议一份 apply 必拒的变更
- [x] 2.4 overlay 读不到时**两侧皆空**：干跑腿此时无法知道 diff，提议出去会让用户确认后拿到 `run.failed`；契约只有两个字段、表达不了「overlay 不可用」。响亮失败由应用腿承担
- [x] 2.5 `{text}` 腿：`matchNoiseCandidates` **一行未改**；其输出过 `keepValidEntries(_, 'add')`——候选已由 `normalizeSenderForCount` 剥 `<>` + 小写，故**归一维度恒等**，这一层的唯一作用是**过滤**掉不可加入的候选（否则确认后必在应用腿抛错）
- [x] 2.6 `runApplyFeedback`：`isSameFile` 路径闸 → `readOverlayFile(..., 'fail-closed')` → `(existing ∪ add) \ remove` → 一次原子发布 → 恰好 emit 一次四字段
- [x] 2.7 `readEntryList`：缺键 → `[]`（不抛）；键在（含值为 `undefined`）但非数组 / 条数超限 / `checkEntry` 不过 → 抛错；错误只回类型 + 长度，不回地址值
- [x] 2.8 `writeNoiseOverlayAtomic`：写前字节闸（与 loader 同一常量）· tmp 名带 pid · `O_NOFOLLOW` · `mode 0o600` · fs 错误只回 kind（Node 的 message 自带绝对路径）
- [x] 2.9 `readFeedbackText` 亦改用自有键读取

## 3. self-check（`src/pipeline.test.ts` / `src/rules/rulesConfig.test.ts`）

- [x] 3.1 `withOverlay` **同时设 `RULES_FILE`** —— 否则 `resolveRulesPath()` 仍指向仓内真实 rules.yaml，沙箱那份是生产代码从不命名的**诱饵**，哨兵断言无论生产代码做什么都不会红
- [x] 3.2 哨兵断言放在 env 还原与 `rmSync` **之后**（放 finally 头部时，哨兵一旦触发会把 env 与 tmp 目录泄漏给后续全部用例）
- [x] 3.3 **所有反馈用例走产品路径**：interpret 提案 → 把提案**逐字**喂进 apply。手工构造 apply 输入只出现在显式对抗用例里
- [x] 3.4 `payloadOf` 断言同 kind **恰好一次**；`assertReceiptPartition` 断言四桶与请求配分且两两不交
- [x] 3.5 nf④–㉖ 覆盖：可逆性（canonical 文件字节回滚 / 人工编辑文件集合等价）· 两向幂等 · 四字段恒在 · canonical 同函数 · 拒非 canonical · 拒非法与畸形 · 同项冲突 · 提案腿不抛错 · 归一后去重 · `not_present` · 规则引擎生效且敏感邮件不降温 · 混合 add+remove · 读失败 fail-closed · **L=W 存量可移除（走产品路径）** · 只认真邮箱 · 写侧三闸 · 原型链（**两腿各一条**）· 字节闸 · 路径闸（软链别名 + 大小写别名）· 提案的条数与字节截断
- [x] 3.6 `rulesConfig.test.ts` 增 **L ⊆ W 性质测试**：对含 `<>` / 大写 / CRLF / 空行 / 重复 / 无点域 / 数字 TLD 的语料，断言 `readNoiseOverlay` 读出的每一行都被 `checkEntry(_, 'remove')` 接受且已是归一形态
- [x] 3.7 `rulesConfig.test.ts` 增可加入判据的正反例（dot-atom 点位、域标签 63 字节、VERP/SRS/atext 特殊字符）

## 4. mutation 验证（守卫删了必须有断言挂）

- [x] 4.1 `canonicalizeOverlayLine` 不再剥 `<>` → `pipeline.test` 挂 4 条（证明 pipeline **真的在用** rulesConfig 那一份，而不是又抄了一份）
- [x] 4.2 `checkEntry` 方向差异被抹平 → 两个测试文件各挂
- [x] 4.3 `readOverlayFile` 的 fail-closed 改回空集 → 挂
- [x] 4.4 `hasOwnKey` 退回 `in` → 挂
- [x] 4.5 `isSameFile` **完全**退回词法 `resolve()` → 挂（首次变异只删 `dev/ino` 分支，剩下的 realpath fallback 仍能挡软链，故那次回绿是变异无效而非守卫多余）
- [x] 4.6 提案腿**字节**预算截断被删 → 挂（首次变异连条数一起删，而条数在 `keepValidEntries` 里另有一道，故那次回绿同因）
- [x] 4.7 写侧三闸、非数组抛错、`{add:undefined}` 抛错逐条挂

## 5. 运维与卫生

- [x] 5.1 `.gitignore` 加 `rules/noise_senders.overlay` —— 线上它在部署 checkout 里以未跟踪状态躺着：一个 `git clean -fd` 会抹掉 operator 攒的整份名单，误提交则把真实发件人地址推进仓库
- [ ] 5.2 上线后通知 hangar 侧再放 view（**部署序：inbox 先、view 后**；且需等 hangar 侧自己的验证轮完成）
- [ ] 5.3 生产验收（**两步都要，只验第一步会必然通过而用户的邮件照旧被降噪**）：
      ① 加一个地址 → 移出同一地址 → overlay 字节回到原内容；忙时重发 apply 幂等
      ② **重启 hangar daemon**，再确认该发件人的邮件确实不再被静默标已读——overlay 由 CLI 进程写，而规则快照在常驻 daemon 启动时读一次、生产未接热重载（见 design 已知残留）

## 6. 验证

- [x] 6.1 `pnpm build`（tsc）clean
- [x] 6.2 全量 `pnpm test` 绿
- [x] 6.3 `file(1)` 核对改动文件均为 UTF-8 text（无裸控制字节）
- [x] 6.4 OpenSpec `--strict` 验证通过

## 7. round-4 三 slot 的 blocker + Codex 的残余项

- [x] 7.1 归一拆成两个问题（RC 选项 A）：行归一 `trim`+小写**不剥 `<>`**（与本能力生效前同语义 → 存量生效集不迁移）；用户输入归一剥到**不动点**。方向决定用哪个
- [x] 7.2 `checkEntry` 共用前置去掉长度与控制字符（可加入的分量；混进来即 `L ⊄ W`）
- [x] 7.3 `readOverlayFile` / `isSameFile` 的 `statSync` 包捕获（`throwIfNoEntry` 只压制 ENOENT，逃逸即 **import 期崩溃**）
- [x] 7.4 `ENOTDIR` 不得折成空文件；非普通文件（FIFO/字符设备）拒绝——**该分支无测试网**，守卫拿掉后测试挂死而非变红，据实记账
- [x] 7.5 `isSameFile` 退化分支 basename 大小写不敏感（两目标都不存在时保守判同一个）
- [x] 7.6 add 侧非 ASCII 在**归一前**判（`K` 会小写成 ASCII `k` 穿过归一后的检查）
- [x] 7.7 apply 的 input 外层必须是普通对象（`null`/标量/数组此前回四个空桶）
- [x] 7.8 `{text}` 腿补路径闸 + present 差分 + 写预算，与结构化腿同纪律
- [x] 7.9 tmp 随机名 + `O_EXCL`（固定名可被预置成 rules.yaml 硬链，`O_TRUNC` 会先截断它，`O_NOFOLLOW` 挡不住硬链）
- [x] 7.10 新增**不动点性质断言**（穷举 ≤4 长度 4681 串）——不依赖语料；别名测试改硬链（此前在 CI 的 Linux 上零覆盖）
- [x] 7.11 上述逐条 mutation：6/7 落网，`isFile` 那条据实记为无网
