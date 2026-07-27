## 上下文

契约 SOT = hangar `add-view-feedback-remove` 的 `specs/hangar-view/spec.md`。本文件只记 inbox 侧**自己要裁决**的点。

四条硬性跨仓约束（逐字满足，不在此复述推导）：两事件的**每个声明字段恒在**（无变更即 `[]`）；`add`/`remove` 必须是**即将写入 overlay 的 canonical 形态**；`added`/`removed` = 本次真改了 overlay 的，`already_present`/`not_present` = 请求但本就已在/本就不在的；未知 trigger 仍 `throw`。

## 决策

### ① remove 的候选集 = 当前 overlay 内容

要移出的必然已在名单里，所以 interpret 阶段只读 overlay（`readNoiseOverlay`，无写），对它做与 add 侧**同样的确定性子串匹配**（无 LLM）。

得到的性质：`remove` 恒为 overlay 的子集 → **零幻觉对两侧都成立**（add 侧是「TOP-N 候选 ∪ 显式项」的子集，remove 侧是 overlay 的子集）。

### ② 方向（加入 / 移出）由确定性关键词判定，一次 interpret 只解一个方向

**为什么必须有方向判定**：两侧候选集不同但**高度重叠**——刚加进 overlay 的发件人仍在「最近高频发件人 TOP-N」里（加入降噪不会让邮件停止到达）。若不先定方向、两侧同跑，「把 taobao 加进降噪」会**同时**解出 `add=[noreply@taobao.com]` 与 `remove=[noreply@taobao.com]`，撞上决策 ④ 而 throw——正常用法全炸。

判定用整串小写后对撤销类动词（移出/移除/去掉/删掉/删除/取消/撤销/恢复/解除/remove/delete/undo/unmute/restore）做 `includes`（中文不分词，故直接子串）。未命中 → 视为「加入」（默认方向 = 本闭环上线时的唯一语义，向后兼容）。

代价：复合句「把 A 加进去、把 B 移出」需分两次说。**apply 侧本就支持同一 input 双向**（契约要求各自独立求解），故这只是 interpret 的表达力限制，不是契约缺口。

### ③ 显式 mailbox/domain 入口用确定性解析，非法项 throw 让 run 响亮失败

text 里带 `@` 的 token、或末段为纯字母（≥2 位）的带点 token（借此排除 `v1.2` / `1.2.3.4` 这类版本号与 IP）→ 直接当显式项，**add 侧不再要求它在 TOP-N 候选里**：加一个从未见过的地址是可逆低风险操作。

空值、控制字符、非法 mailbox/domain → **throw** → `run.failed` → view 呈现「命令失败 · 回 CLI trace」。响亮失败优于静默忽略一个用户点了名的地址。

`// ponytail: 失败原因须回 CLI trace（view 只投影声明字段）；要在页面显示拒绝原因得加 interpretation.rejected 字段并同步改 view 白名单，另开一条`

**附带裁决：文本里出现显式地址时跳过子串匹配。** 用户点名了确切地址，再跑模糊匹配只会引入 `com` 这类通用短 token 的误命中（「把 foo@example.com 加进降噪」会顺带命中所有 `.com` 候选）。显式优先于模糊，是既省代码又减误报的方向。

### ④ 非 ASCII 域名 v1 直接拒绝，不做单侧 IDN 归一

路线 A 的 DoD 写了「IDN 归一化」，但**只归一写入侧会造成静默不生效**：overlay 存 punycode，而匹配侧 `applySafetyRules` 比的是 `email.fromEmail`（normalizer 只小写、**不转 punycode**）→ 用户以为加了降噪、实际永不命中 = **false-green**。

故 v1：含非 ASCII 的条目与非法项同路 **throw** 并明确报错。真要支持 IDN 必须两侧同时改（单独一条，不在本变更）。

实现上用一条「可打印 ASCII」断言同时挡掉控制字符与全部非 ASCII——比拆成两个检查更短，且方向单调趋安全（宁可响亮拒绝，不可静默写入一个永不命中的条目）。

### ⑤ 同一地址同时出现在 add 与 remove → throw

不静默任选一边、不互相抵消成无操作。人确认的是一份 diff，自相矛盾的 diff 说明上游解析或人工编辑出了问题，应当让它可见。

### ⑥ 用户输入 throw、非用户输入静默丢弃

两类来源分开处理：

- **用户显式入口**（NL 里点名的地址、apply 收到的结构化项）→ 非法即 throw。apply 是**独立入口**，不信 view 回传的结果，重新归一 + 重新校验（很便宜）。
- **非用户输入**（DB 高频候选、overlay 现有行）→ 畸形项**静默丢弃**。一条手写坏进 overlay 的旧数据不该让整条命令失败。

`// ponytail: 校验不过的历史 overlay 行无法经 NL 移出，直接编辑该文件即可`

### ⑦ 无实际变更时不写文件

`added` 与 `removed` 皆空 → 跳过 tmp+rename。重发 apply 连 mtime 都不动，「不在名单的 remove 不产生写」是字面成立的，而不是「写了一份一模一样的内容」。

## 可逆性如何成立

`existing` 是 `Set`，按 overlay 行序插入；add 追加在末尾，remove 删除条目不扰动其余行的相对顺序。故 **add 之后再 remove 同一地址，overlay 的字节内容回到 add 之前**——这是本变更的核心断言（self-check nf⑤）。

前提：overlay 无重复行（机器文件，唯一写者是本路径，天然无重复）。

## 风险

- **行为变更**：apply 对非法项从「静默丢弃」改 throw。旧 view 若曾依赖「送非串也成功」会开始失败——这正是入口校验的目的。
- **关键词方向判定的误判**：如「把发**取消**订阅邮件的那个加进降噪」会被判成移出方向。误判的后果是解析结果为空或不符预期，**由人在确认页挡下**（interpret 无写）。可接受。
- **部署序**：inbox 先、view 后。反序则整条命令路径落 `contract_mismatch`。
