## 1. overlay 格式的唯一所有者（`src/rules/rulesConfig.ts`）

同一份 overlay 的五个语义问题此前各被 loader / 提案腿 / 应用腿独立回答 2–3 次。**成对一致不具传递性**：三个持有者时把 (A,B) 调平必然打破 (B,C)。故这些答案在本模块各只有一份，`pipeline.ts` 是纯消费者。

- [x] 1.1 `canonicalizeOverlayLine(raw): string | null` —— **行归一的唯一实现**（`trim` → 小写；空 → null）。**刻意不剥 `<>`**：与本能力生效前逐字节同语义，故存量 overlay 的生效集不迁移（剥了会让惰性行 `<a@b.com>` 重新部署后转活、开始静默已读）。剥 `<>` 是**用户输入归一**那一份的事（1.2），两者对应两个不同的问题
- [x] 1.2 `canonicalizeAddInput(raw): string | null` —— **用户输入归一的唯一实现**（同住本模块）：非 ASCII / 控制字符**归一前**判掉 → `trim` → 剥掉**所有**包裹层 `<>`（剥到不动点，只剥一层会写盘一个非不动点值）→ 转小写。**只做这两步变换、再不加第三步**：写路径的契约是收或拒，多一条「替用户猜地址」的改写就多一处「写进去的 ≠ 用户确认的」（`mailto:` 的归属见 9.3）。输出必为 1.1 的不动点
- [x] 1.3 `isAddableEntry(s)` —— 可加入判据 **=（匹配侧可达集 − 五项政策豁免）∩「长度 ≤ 254」**。**判据与豁免表的权威出处是 `rules-config` 规范，此处不复述**；本模块只负责让实现与那份规范逐条对应，并保证底座（`[^\s<>@]+@[a-z0-9.-]+` / 域名 `[a-z0-9.-]`）由匹配侧的两条谓词两端锚定得到，而不是另写一套
- [x] 1.4 `checkEntry(item, direction)` —— **两腿共用**，方向差异只存在这一处：`add` 要求已归一 **∧** 可加入；`remove` 只要求已归一。判据收紧时的验收口径是**撤销可达性**（loader 接受的任一行 `l`，`{remove:[l]}` 恒被接受），不是「共用前置里有没有混进可加入分量」——后一种说法每加一道闸就要重新论证一次，且已论错过两次（见 9.4）
- [x] 1.5 `readOverlayFile(path, mode)` —— **读的唯一实现**，尺寸一律以 `statSync().size` 度量（与 loader 同量；改量解码后字节数会让含无效 UTF-8 的文件出现「loader 采纳、写路径拒绝」的分叉）。失败语义是**参数**：`fail-open`（loader）/ `fail-closed`（写路径与提案腿）
- [x] 1.6 `resolveNoiseOverlayPath(rulesPath)` —— **「这个文件是哪个」的唯一答案，且由派生给出**：`join(dirname(rulesPath), 'noise_senders.overlay')`，不接受任何单独的路径入参/env。一个旋钮（`RULES_FILE`）定两个文件的位置，故它们不可能被指到对方身上（判据见 9.1）
- [x] 1.7 `hasOwnKey` / `readOwnKey` —— 自有键读取（`in` 走原型链，被污染的 `Object.prototype` 能凭空造出请求）
- [x] 1.8 正则一律用码位转义写；`file(1)` 核对源文件为 UTF-8 text 而非 data

## 2. `src/pipeline.ts` 降级为纯消费者

- [x] 2.1 删除本地的 `canonicalizeEntry` / `isValidEntry` / `isCanonicalEntry` / `isCanonicalForm` / `readOverlayStrict` 及五条本地正则、`MAX_ENTRY_LEN`、读侧 `Buffer.byteLength`、`resolve()` 路径比较（净 −99 行）
- [x] 2.2 `runInterpretFeedback` 结构化分支：`readOverlayFile(..., 'fail-closed')` 读 → `keepValidEntries(raw, direction)` 归一 + 按方向判据 + 去重 → 同项两侧剔除 → 与 overlay 比对
- [x] 2.3 提案腿镜像应用腿的序列化字节闸（`fitWithinWriteBudget`），超预算时**截断**提案。曾以「该函数不计 `present − remove` 的最终大小」为由删除，**该前提是错的**——函数本来就先算 `kept = present − remove` 再定尺寸，故予以恢复；删掉它会让提案腿不再镜像应用腿的字节闸，与 `processing-pipeline` 规范冲突。条数闸仍在 `keepValidEntries` 里
- [x] 2.4 overlay 读**失败**时**两侧皆空**：干跑腿此时无法知道 diff，提议出去会让用户确认后拿到 `run.failed`；契约只有两个字段、表达不了「overlay 不可用」。响亮失败由应用腿承担。**`ENOENT` 不算失败**——文件不存在就是真的空集，故全新部署的第一次 `add` 照常出提案
- [x] 2.5 `{text}` 腿：`matchNoiseCandidates` 的**匹配集**一行未改；其输出过 `keepValidEntries(_, 'add')`——候选已由 `mailRepo` 的计数归一（即 `applySafetyRules` 的 `normalizeFromAddress` 本身，见 9.6）剥 `<>` + 小写，故**归一维度恒等**，这一层的唯一作用是**过滤**掉不可加入的候选（否则确认后必在应用腿抛错）。本腿**读** overlay，但只用于「判定可用」与「取字节基线喂给 2.3 的闸」，**禁止**据它过滤提案（见 8.3）；候选查询本身收在 try 里（见 9.5）
- [x] 2.6 `runApplyFeedback`：撞名拒绝（`resolve(overlay) === resolve(rules)` 的纯字符串比较，仅在 rules 文件自己叫 `noise_senders.overlay` 时为真）→ `readOverlayFile(..., 'fail-closed')` → `(existing ∪ add) \ remove` → 一次原子发布 → 恰好 emit 一次四字段
- [x] 2.7 `readEntryList`：缺键 → `[]`（不抛）；键在（含值为 `undefined`）但非数组 / 条数超限 / **请求序列化字节 > `MAX_REQUEST_BYTES`（64 KiB）** / `checkEntry` 不过 → 抛错；错误只回类型 + 长度，不回地址值
- [x] 2.8 `writeNoiseOverlayAtomic`：写前字节闸（与 loader 同一常量）· tmp 名带 pid · `O_NOFOLLOW` · `mode 0o600` · fs 错误只回 kind（Node 的 message 自带绝对路径）
- [x] 2.9 `readFeedbackText` 亦改用自有键读取

## 3. self-check（`src/pipeline.test.ts` / `src/rules/rulesConfig.test.ts`）

- [x] 3.1 `withOverlay` **同时设 `RULES_FILE`** —— 否则 `resolveRulesPath()` 仍指向仓内真实 rules.yaml，沙箱那份是生产代码从不命名的**诱饵**，哨兵断言无论生产代码做什么都不会红
- [x] 3.2 哨兵断言放在 env 还原与 `rmSync` **之后**（放 finally 头部时，哨兵一旦触发会把 env 与 tmp 目录泄漏给后续全部用例）
- [x] 3.3 **所有反馈用例走产品路径**：interpret 提案 → 把提案**逐字**喂进 apply。手工构造 apply 输入只出现在显式对抗用例里
- [x] 3.4 `payloadOf` 断言同 kind **恰好一次**；`assertReceiptPartition` 断言四桶与请求配分且两两不交
- [x] 3.5 nf④–㉚ 覆盖：可逆性（canonical 文件字节回滚 / 人工编辑文件集合等价）· 两向幂等 · 四字段恒在 · canonical 同函数 · 拒非 canonical · 拒非法与畸形 · 同项冲突 · 提案腿不抛错 · 归一后去重 · `not_present` · 规则引擎生效且敏感邮件不降温 · 混合 add+remove · 读失败 fail-closed · **存量可移除（走产品路径）** · **豁免表之外不得严于匹配侧（`root@nas` / `admin@10.0.0.5` 必须收）** · 写侧三闸 · 原型链（**两腿各一条**）· 撞名拒绝 · 提案的条数截断与字节截断 · **写完不留孤儿 tmp** · **`{text}` 腿不据 overlay 过滤提案** · **单条 remove 永不被批量闸拦下**（nf⑲b：一条远超 `MAX_REQUEST_BYTES` 的存量行必须能删掉）
- [x] 3.6 `rulesConfig.test.ts` 增**撤销可达性的性质测试**：对含 `<>` / 大写 / CRLF / 空行 / 重复 / 无点域 / 数字 TLD / `> 254` 字符行的语料，断言 `readNoiseOverlay` 读出的每一行都被 `checkEntry(_, 'remove')` 接受且已是归一形态；端到端那一半（单条请求不被批量闸拦下）由 nf⑲b 承担
- [x] 3.7 `rulesConfig.test.ts` 增可加入判据的正反例：**拒**匹配侧永不命中的形态（`<a@x.com>`、`a b@x.com`、`a@x_y.com`）与五项豁免（`é@x.com`、控制字符 local、`nas`、`com`、`mailto:a@x.com`），**收**其余匹配侧命中的形态（`root@nas`、`admin@10.0.0.5`、`a@x.c`、VERP/SRS/atext）

## 4. mutation 验证（守卫删了必须有断言挂）

- [x] 4.1 `canonicalizeOverlayLine` 不再剥 `<>` → `pipeline.test` 挂 4 条（证明 pipeline **真的在用** rulesConfig 那一份，而不是又抄了一份）
- [x] 4.2 `checkEntry` 方向差异被抹平 → 两个测试文件各挂
- [x] 4.3 `readOverlayFile` 的 fail-closed 改回空集 → 挂
- [x] 4.4 `hasOwnKey` 退回 `in` → 挂
- [x] 4.5 撞名拒绝被删 → 挂（nf⑲）；批量闸的「第一条豁免」被抹平 → 挂（nf⑲b）
- [x] 4.6 提案腿条数截断被删 → 挂（`keepValidEntries` 的封顶，nf㉔）
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

## 7. 归一、读与写路径的收紧

- [x] 7.1 归一拆成两个问题：行归一 `trim`+小写**不剥 `<>`**（与本能力生效前同语义 → 存量生效集不迁移）；用户输入归一剥到**不动点**。方向决定用哪个
- [x] 7.2 `checkEntry` 共用前置去掉长度与控制字符（两者只该约束 `add`；留在前置就让对应的存量行删不掉，验收口径见 1.4）
- [x] 7.3 `readOverlayFile` 的 `statSync` 包捕获（`throwIfNoEntry` 只压制 ENOENT，逃逸即 **import 期崩溃**）
- [x] 7.4 `ENOTDIR` 不得折成空文件；非普通文件（FIFO/字符设备）拒绝——**该分支无测试网**，守卫拿掉后测试挂死而非变红，据实记账
- [x] 7.5 add 侧非 ASCII 在**归一前**判（`K` 会小写成 ASCII `k` 穿过归一后的检查）
- [x] 7.6 apply 的 input 外层必须是普通对象（`null`/标量/数组此前回四个空桶）
- [x] 7.7 `{text}` 腿补写预算；**present 差分不做**——它剔掉用户点名的真阳性、只留松匹配来的假阳性（见 8.3）
- [x] 7.8 tmp 随机名 + `O_EXCL`（固定名可被预置成 rules.yaml 硬链，`O_TRUNC` 会先截断它，`O_NOFOLLOW` 挡不住硬链）；开失败**不 unlink**（`EEXIST` 时那个文件不归本次调用所有）
- [x] 7.9 新增**不动点性质断言**（穷举 ≤4 长度 4681 串）——不依赖语料选得好不好
- [x] 7.10 上述逐条 mutation：`isFile` 那条据实记为无网，其余落网

## 8. 防御面减面与判据收敛

新缺陷有一个共同位置：**本能力新增的防御机器**，而非「加个 remove 路径」本身要的东西。根因不是修复质量——每加一道闸就多出一批文件系统/输入状态，且每个状态要在**两条腿上各表态一次**并保持一致，这张组合表越大越容易留空格。故减面而不是补格子。

- [x] 8.1 `isAddableEntry` 收敛为「匹配侧可达集 − 政策豁免」（判据与豁免表见 `rules-config` 规范）：删 `isValidDomain` / `DOMAIN_LABEL_RE` / `LOCAL_DOT_ATOM_RE`，底座由匹配侧的两条谓词两端锚定得到。**修 blocker**：`root@nas`（无点域）匹配侧命中却被判不可加入，而摘要表头正展示它可加入——NAS/路由器/内网 cron 这一整类对本能力生效前是功能回归
- [x] 8.2 文件同一性判定整套删除，改由**路径派生**消掉问题本身（见 9.1 / 9.2）。这一格是三套机器里唯一连问题都消掉的：它守的风险完全由一个**本不必存在的旋钮**造出来，换实现只是换一批要表态的文件系统状态，删旋钮才让状态归零
- [x] 8.3 删 `{text}` 腿的 overlay **present 差分**（该腿仍读 overlay，只为可用性判定与字节基线）。**修 major**：present 过滤剔掉用户点名的真阳性、只留短 token 松匹配进来的假阳性。`fitWithinWriteBudget` **不删**——「它不计 `present − remove` 的最终序列化大小」这个删除前提是错的，函数本来就先算 `kept = present − remove` 再定尺寸（见 2.3）
- [x] 8.4 长度闸留在 `isAddableEntry`（`add` 侧），**不进 `checkEntry` 共用前置**。缺陷：进了共用前置就让 `> 254` 的存量行结构性不可移除，而这类行是产品自己写出来的（本能力生效前的 `apply-feedback` 无任何长度闸），说它「只可能来自手改」是错的。`remove` 侧的无界改由**请求字节闸**关掉：单侧请求序列化字节 > `MAX_REQUEST_BYTES`（64 KiB）时应用腿抛错、提案腿截断，两条腿两个方向各判一次；该闸自身的第一条豁免见 9.4
- [x] 8.5 `.gitignore` 改 `rules/noise_senders.overlay*`。**修 major**：孤儿 tmp 含完整发件人名单且不被原 glob 匹配
- [x] 8.6 `writeNoiseOverlayAtomic` 的 open 单独成段，**开失败不 unlink**。**修 minor**：`EEXIST` 时那个文件不是本次创建的
- [x] 8.7 nf㉗ 从空转用例改为真会失败的断言（原用例蹲固定名，而实现用随机名，蹲名永不命中 ⇒ 去掉守卫也不变红）；改断「rename 后目录里不留 `.tmp`」
- [x] 8.8 规范、`tasks.md`、`proposal.md`、`design.md` 与实现对齐：可加入判据只在 `rules-config` 规范写全，其余文档改为引用；`fitWithinWriteBudget` 的去留与撤销可达性的陈述方式逐一核对到与实现一致
- [x] 8.9 新增**性质断言**「可加入判据 ==（匹配侧可达集 − 政策豁免）∩ 长度上限」（穷举 22620 串）：oracle 直接 import `applySafetyRules` 的 `normalizeFromAddress` / `normalizeFromDomain`（为此把两者从私有改为导出），**不抄正则进测试**——抄一份则匹配侧一改这条网就随之失效。六处偏离在测试里逐条显式枚举（五项政策豁免 + 长度上限），落在其中的串按「应拒」断言、其余按「应收」断言，且每条偏离都要有**独占见证**样本，否则这条分类是空转的。正反例清单只能抽样，恰好绕开偏离区就全绿
- [x] 8.10 上述性质**双向 mutation 验证**：判据在豁免表外再收紧（如地址侧也强制域名含点）→ 挂在「豁免表外不得严于匹配侧」；去掉 local 字母表检查（宽于底座，`<a@x.com>` 被放行）→ 挂在「不得宽于底座」；删掉任一项豁免 → 挂在该项的显式断言
- [x] 8.11 `tsc --noEmit` clean、全量 `npm test` 绿、OpenSpec `--strict` 通过

## 9. 旋钮减面与写路径的纯化

旋钮该不该存在只问一句：**设错时是响亮失败还是静默失败**。静默失败的旋钮不留（判据全文见 `design.md` ⑫）。

- [x] 9.1 **删掉 overlay 路径的独立 env 旋钮**，路径改为派生：`join(dirname(rulesPath), 'noise_senders.overlay')`。缺陷：该旋钮指错时，一次 apply 把 operator 的 `rules.yaml` 按平铺格式整体重写、缩进毁掉、无备份，而回执报成功——静默失败。`RULES_FILE` 相反（加载失败 + carry-forward + 告警，响亮），故保留。一个旋钮定两个文件的位置后，它们不可能被指到对方身上
- [x] 9.2 **删掉文件同一性判定整套**（函数、导出、三处调用点、其测试），**不设替代机制**。两条提案腿现在没有任何路径闸；应用腿只剩两行纯字符串比较（`resolve(overlayPath) === resolve(resolveRulesPath())`），仅在 rules 文件自己叫 `noise_senders.overlay` 时为真。不落文件系统调用，故软链 / 硬链 / 大小写不敏感盘 / bind mount 在此没有作用面——**禁止**为它们重建闸门
- [x] 9.3 **`mailto:` 从「归一时剥掉」改为「`isAddableEntry` 拒绝」**，成为第五项政策豁免。缺陷：剥前缀是替用户解析意图，而 local part 真叫 `mailto` 的发件人会被静默改写成另一个地址、静音错的人；带前缀的条目匹配侧本就永不命中，拒绝即可，让调用方提交裸地址。写路径由此只剩收与拒、零改写
- [x] 9.4 **批量闸只从第二条起生效**（`MAX_REQUEST_BYTES` 与条数闸，两条腿皆然）。缺陷：加在第一条上会让一条超长的存量行**不可移除**——正是本能力要消灭的那类结构性锁死。守的性质按**可达性**陈述：loader 接受的任一行 `l`，`{remove:[l]}` 恒被接受；**将来任何新增的批量闸都必须保留这条豁免**。改用可达性而非「共用前置里不含可加入分量」的代数论证，是因为后者每加一道闸都要重论一次、且已论错两次
- [x] 9.5 **`{text}` 腿的 `countRecentSenders` 收进 try**：失败记 `{kind:'noise-candidates-unavailable'}` 并给空提案。缺陷：这是该腿唯一的 DB 触点，一次抖动就让干跑腿抛错、违背「提案腿绝不抛错」，把健康的服务画成监控墙上的翻车
- [x] 9.6 **`src/repo/mailRepo.ts` 不再自留发件人归一**，改为 re-export `normalizeFromAddress`。缺陷：两份实现漂移时，`isAddableEntry`（定义为该函数的不动点集）会静默丢掉 `{text}` 腿的真阳性候选——共用已从「免同一发件人裂成多变体」升级为正确性前提
