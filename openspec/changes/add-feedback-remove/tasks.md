## 1. canonical 归一与入口校验（两入口共用）

- [x] 1.1 `src/pipeline.ts`：`canonicalizeEntry`（trim → 去包裹 `<>` → 小写）+ `isValidEntry`（非空 / ≤254 / 可打印 ASCII / `local@domain` 或 ≥2 段域名）
- [x] 1.2 `requireEntry(raw, where)`：**用户输入**归一 + 校验，非法 → throw（带 where 与截断后的原值，供 CLI trace 定位）
- [x] 1.3 `canonicalizeLoose(entries)`：**非用户输入**（DB 候选 / overlay 现有行）归一 + 保序去重，畸形项静默丢弃
- [x] 1.4 非 ASCII 与控制字符经同一条「可打印 ASCII」断言拒绝（IDN 单侧归一 = false-green，见 design ④）

## 2. interpret-feedback：方向判定 + 显式地址 + remove 候选集

- [x] 2.1 `isRemoveIntent(text)`：整串小写后对撤销类动词做 `includes`（中文不分词），未命中 → 加入方向
- [x] 2.2 `parseExplicitEntries(text)`：按「绝不出现在地址里的空白/标点」断词、剥句末句点；含 `@` 或 `looksLikeDomain` 的 token 走 `requireEntry`（`v1.2`/`1.2.3.4` 因末段含数字不误判）
- [x] 2.3 移出方向：候选集 = `readNoiseOverlay(resolveNoiseOverlayPath())`（**只读**）；`remove = 子串命中 ∪ (显式项 ∩ overlay)`，保 `remove ⊆ overlay`
- [x] 2.4 加入方向：候选集 = TOP-N（`slice(0, NOISE_TOPN)`，同 digest 展示）∪ 显式项；显式项存在时**跳过**子串匹配
- [x] 2.5 emit `interpretation.proposed { add, remove }`——**两字段恒在**，值均为 canonical 形态

## 3. apply-feedback：set-difference + 独立校验

- [x] 3.1 `normalizeFeedbackInput`：读 `add`/`remove` 两键（缺键 → `[]`；键在但非数组 → throw）；逐项 `requireEntry`；各自保序去重
- [x] 3.2 同一地址同时在两侧 → throw（不静默任选一边、不抵消成无操作）
- [x] 3.3 `existing ∪ add \ remove` → **一次** `writeNoiseOverlayAtomic`（tmp+rename）；`added`/`removed` 皆空时**跳过写**
- [x] 3.4 emit `feedback.applied { added, already_present, removed, not_present }`——**四字段恒在**
- [x] 3.5 `src/rules/rulesConfig.ts` 的 `resolveNoiseOverlayPath`/`readNoiseOverlay` **只读复用不改**；`src/rules/applySafetyRules.ts` 匹配侧**不改**

## 4. self-check（`src/pipeline.test.ts`，不铺新框架）

- [x] 4.1 `withOverlay` 沙箱：tmp overlay + 同目录 `rules.yaml` 哨兵，收尾逐字节断言 rules.yaml 未被写（覆盖所有反馈用例）
- [x] 4.2 nf⑤ 四字段恒在（deepEqual 整个 payload，既证恒在也证无多余字段）+ add/remove 各自幂等 + **add→remove 后 overlay 字节回滚**（核心可逆性断言）+ 无变更不写（mtime 不动）
- [x] 4.3 nf⑥ `"  <FOO@Example.COM>  "` → emit 与写入 bytes 同为 `foo@example.com`
- [x] 4.4 nf⑦ 12 类非法输入 + 非数组 `add` → throw，且 overlay 内容与 mtime 均未变
- [x] 4.5 nf⑧ 同址 add+remove（归一后同址）→ throw、不写
- [x] 4.6 nf⑨ 移出方向候选集 = overlay、`add=[]`、不在名单者不提案、全程无写
- [x] 4.7 nf⑩ 显式地址不受 TOP-N 限制 + canonical + 显式时跳过模糊匹配 + `v1.2` 不误判 + 非 ASCII 域名 throw
- [x] 4.8 nf⑪ 集成：apply 后经 `reloadRulesConfigForTest` 生效 → 非敏感 P2 落 P3；**敏感邮件不被降温、仍不自动已读**（`resetRulesConfigForTest` 收尾隔离）
- [x] 4.9 既有 nf④ 随入口校验收紧同步更新（非串/空白项从「静默丢弃」移交 nf⑦ 断言 throw）

## 5. 验证与收尾

- [x] 5.1 `pnpm build`（tsc）clean
- [x] 5.2 全量 `pnpm test` 绿（457）
- [ ] 5.3 上线后通知 hangar 侧放 view（**部署序：inbox 先、view 后**）
- [ ] 5.4 生产验一遍：加一个地址 → 移出同一地址 → overlay 回到原内容；忙时重发 apply 幂等
