## 1. canonical 归一与合法性（两个入口共用同一函数）

- [x] 1.1 `src/pipeline.ts`：`canonicalizeEntry`（`trim` → 去包裹 `<>` → 小写 → 丢空），**interpret 与 apply 共用**
- [x] 1.2 `isValidEntry`：归一后判空 / 超长 / 控制字符 / 非 ASCII / 域名（末段 ≥2 位纯字母 TLD）/ mailbox（local 非空且不含空白与 `@,;<>"`）
- [x] 1.3 控制字符与非 ASCII 正则**用码位转义写**（`\u0000-\u001f`、`\u007f`、`^\u0000-\u007f`）；`file(1)` 核对源文件仍是 UTF-8 text 而非 data
- [x] 1.4 `isCanonicalEntry`：`canonicalizeEntry(raw) === raw && isValidEntry(raw)`——归一幂等性即「调用方走过提案腿」的结构证据

## 2. interpret-feedback：新增结构化入口，NL 路径不动

- [x] 2.1 `readStructuredFeedback`：input 带 `add`/`remove` 任一键 → 结构化分支；两键都缺 → 既有 `{text}` 路径
- [x] 2.2 `keepValidEntries`：归一 + 校验 + 按归一后的值去重；非法项 / 非串 / 非数组**静默丢弃，不抛错**
- [x] 2.3 结构化分支与 overlay 比对（`readNoiseOverlay`，**只读**）：`add` 只提议真会新增的、`remove` 只提议真在名单里的；同项冲突从两侧同时剔除
- [x] 2.4 `{text}` 路径：`matchNoiseCandidates` **一行未改**，只对其输出做 canonical 化（normalizer 不小写 `fromEmail`，原样 emit 会在应用腿撞上「非 canonical → 抛错」）
- [x] 2.5 两分支都 emit `interpretation.proposed { add, remove }`——两字段恒在、恰好一次
- [x] 2.6 删除上一版的 NL 解析器（`parseExplicitEntries` / `looksLikeDomain` / `TOKEN_SPLIT_RE` / `isRemoveIntent` / `REMOVE_MARKERS`）

## 3. apply-feedback：集合运算 + 独立校验

- [x] 3.1 `readEntryList`：缺 key → `[]`（**不抛错**）；key 存在但非数组 → 抛错；逐项 `isCanonicalEntry` 不过 → 抛错；保序去重
- [x] 3.2 错误消息**只回形状不回值**（类型 + 长度），地址不进 run trace
- [x] 3.3 同项同时在两侧 → 抛错（只报条数，不报地址）
- [x] 3.4 `(existing ∪ add) \ remove` → **一次** `writeNoiseOverlayAtomic`；`added`/`removed` 皆空时跳过写
- [x] 3.5 `existing` 读入时过同一个 `canonicalizeEntry`，使两个入口的集合同域（否则历史 `<a@b.com>` 行提案说能移出、apply 说 `not_present`）
- [x] 3.6 emit `feedback.applied` 四字段——恒在、恰好一次
- [x] 3.7 `rulesConfig.ts` 的 `resolveNoiseOverlayPath` / `readNoiseOverlay` **只读复用不改**；`applySafetyRules.ts` 匹配侧**不改**

## 4. self-check（`src/pipeline.test.ts`，不铺新框架）

- [x] 4.1 `withOverlay` 沙箱：tmp overlay + 同目录 `rules.yaml` 哨兵，哨兵断言放 **`finally`**（放 try 内会在 `fn` 抛出时被静默跳过）
- [x] 4.2 `payloadOf` 断言该 kind **恰好一次**；`assertReceiptPartition` 断言四桶与请求配分且两两不交
- [x] 4.3 既有 NL 路径零回退（nf①–③ 未改动仍绿）
- [x] 4.4 nf④ 可逆性（核心）：canonical 文件 → 字节回滚；人工编辑过的存量文件 → 集合等价
- [x] 4.5 nf⑤ add/add 与 remove/remove 各自幂等；四字段恒在、无变更不写（mtime 不动）
- [x] 4.6 nf⑥ canonical 是同一个函数：interpret 的 emit 原样投 apply 通过，写入 bytes 与 emit 逐字相同
- [x] 4.7 nf⑦ apply 拒非 canonical（4 种未归一形态），overlay 内容与 mtime 均未变
- [x] 4.8 nf⑧ apply 拒 13 类非法项 + 3 类畸形 shape；缺 `remove` key 正常应用
- [x] 4.9 nf⑨ 同项冲突 → 抛错、不写
- [x] 4.10 nf⑩ interpret 不抛错：非法项/冲突项/畸形 shape → 不出现在 emit、无写、run 正常结束
- [x] 4.11 nf⑪ 归一后去重（interpret 侧 `A@X.com` 与 `a@x.com` 一项）
- [x] 4.12 nf⑫ remove 不在名单 → `not_present`、`removed` 空、文件未变
- [x] 4.13 nf⑬ 集成：apply 后经 `reloadRulesConfigForTest` 生效 → 非敏感 P2 落 P3；**敏感邮件不被降温、仍不自动已读**

## 5. mutation 验证（对 4.6/4.7/4.9/4.8 四条守卫）

- [x] 5.1 去掉 `isCanonicalEntry` 的幂等判据 → 测试挂
- [x] 5.2 删掉同项冲突守卫 → 测试挂
- [x] 5.3 `readEntryList` 的非数组抛错改成 `return []` → 测试挂（首次变异误命中了 `keepValidEntries` 的同形行，重打后确认）
- [x] 5.4 让 `canonicalizeEntry` 不再剥 `<>`（归一漂一个字符）→ 测试挂

## 6. 验证与收尾

- [x] 6.1 `pnpm build`（tsc）clean
- [x] 6.2 全量 `pnpm test` 绿（459）
- [x] 6.3 `file(1)` 核对 `src/pipeline.ts` / `src/pipeline.test.ts` / spec delta 均为 UTF-8 text（无裸控制字节）
- [ ] 6.4 上线后通知 hangar 侧再放 view（**部署序：inbox 先、view 后**）
- [ ] 6.5 生产验一遍：加一个地址 → 移出同一地址 → overlay 回到原内容；忙时重发 apply 幂等
