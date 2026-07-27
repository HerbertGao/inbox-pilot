## 上下文

契约 SOT = hangar `add-view-feedback-remove` 的 `specs/hangar-view/spec.md`；域细节实施说明见同目录 `design.md`（冲突时以 spec.md 为准）。本文件只记 inbox 侧自己要裁决的点。

## 决策

### ① pilot 不做自然语言意图解析（定型）

方向与地址由调用方（Pi / Claude Code / CLI）给结构化 JSON，pilot 只做归一、校验、集合运算。

**为什么不在 pilot 里做。** 曾有一版让 pilot 自己解析中文 NL（切句字符类 + remove 关键词集 + 裸域名扫描正则）。它经四轮独立对抗 review 后被整节删除，因为实测产出三条「少一个字符」级缺陷，而**没有任何仓内机制会重跑一份写在 markdown 里的正则**：

- 切句字符类里的全宽标点在文档往返中被折叠成 ASCII、顿号完全缺失 → 「把 a@x 降噪、把 b@y 移出」成了一句 → 两个地址全判 remove；
- 裸域名正则的 lookahead 少一个 `@` → `first.last@company.com` 额外抽出 `first.last`，写成用户从没点名过的域级降噪规则；
- remove 关键词是整句子串匹配、包含地址本身 → `restore@example.com` 因含 `restore` 被判反向。

本仓实测同源缺陷：`把noreply@taobao.com加进降噪`（中文不加空格是常态）整句被送进校验 → run.failed；`按 readme.md 说的把 taobao 加进降噪` → `readme.md` 被当显式项写进提案，且顺手关掉模糊匹配，用户真正想降噪的地址静默消失；`别再降噪 taobao 了`（意图＝移出）→ 提议**加入**。

命令框后面要接的 agent 本来就在做 NL→结构化，这层留在 pilot 里是重复且不可回归的。

### ② 两腿的失败语义相反

- **提案腿（干跑）对非法项不抛错**：非法项只是不出现在提案里；一项都没有时两侧皆 `[]`，确认页现成的空态文案就是回执。理由：hangar-view 的健康态由**最近一次 run** 派生，一次打错字的 `run.failed` 会把健康的 inbox 画成监控墙上的翻车，而抽屉按数据最小化看不到原因——用户输入错误不该污染 liveness 信号。
- **应用腿对非法项 / 非 canonical 项 / 同项冲突抛错**：到应用腿的项是刚给人看过的结构化结果，异常即契约漂移，该响亮。

这是对「非法输入 fail loud」的一处定向降级，fail-loud 由应用腿承担。

### ③ 应用腿拒绝非 canonical 项

归一化对合规输入是**幂等**的；不幂等说明调用方跳过了提案腿，是契约违规。这条把「确认页显示的 == 实际写入的」从纪律变成**结构保证**——而不是靠两个入口各自记得归一。

配套：**interpret 与 apply 必须调用同一个 `canonicalizeEntry`**。两个入口各写一份必然漂移，而 view 的回执校验按原串比较，漂移一个字符就让每条命令都报 `receipt_mismatch`。

### ④ 非 ASCII 域名 v1 直接拒绝，不做单侧归一

只归一写入侧会**静默不生效**：overlay 存 punycode，而匹配侧 `applySafetyRules` 比的是 `email.fromEmail`（normalizer 只小写、**不转 punycode**）→ 用户以为加了降噪、实际永不命中 = false-green。真要支持必须两侧同时改，并含存量 overlay 迁移（另开一条）。

实现上用「含任何码位 > U+007F 即非法」一条断言覆盖。控制字符同路拒绝，且**正则用码位转义写**——控制字符本身贴进源码或文档会在编辑器 / 剪贴板 / JSON 往返里被静默吃掉，一份「看起来有这个字符类」的正则会变成没有。本变更在实现过程中被这个坑咬过两次，两次都是 `file(1)` 把源文件判成 `data` 才暴露。

### ⑤ 同项同时出现在 add 与 remove → 抛错

不静默任选一边：`(existing ∪ add) \ remove` 会让 remove 悄悄胜出，而回执 `{added:[X], removed:[X]}` 在读者眼里是「加了又移了」、文件里却没有 X——回执说谎，且 view 的跨桶检查会判它失败。提案腿则把该项从两侧同时剔除（它不抛错）。

### ⑥ `{text}` 路径的输出做 canonical 化

`matchNoiseCandidates` **一行未改**（匹配集不变），但其输出要过一次归一：normalizer **不**小写 `fromEmail`，原样 emit 会让混合大小写的候选在应用腿撞上决策 ③ 的「非 canonical → 抛错」而断腿。对已是小写的候选（绝大多数）这是逐字节的恒等变换。

### ⑦ 无实际变更时不写文件

`added` 与 `removed` 皆空 → 跳过 tmp+rename。重发 apply 连 mtime 都不动，「不在名单的 remove 不产生写」是字面成立的。

## 可逆性的确切范围

条目集按 overlay 行序维护（新增追加在末尾、删除不扰动其余行序），故对同一地址先 add 后 remove，overlay 的**字节内容**回到 add 之前。

**字节等价只对由 `writeNoiseOverlayAtomic` 写出的文件成立。** 人工编辑过的存量文件（无尾换行 / CRLF / 空行 / 重复行 / 大写）写回时按 canonical 形态重新序列化，**只保证集合等价**——self-check 对这两种情形各有一条断言。

## overlay-only：移出不是全局撤销

生效降噪集是 `rules.yaml noise_senders ∪ overlay`，本路径只动 overlay。同时被人工 `rules.yaml` 命中的地址「移出」后**仍会被降噪**；「不在名单」也只表示不在机器 overlay。规范里已写明**人工规则要人工改**。

## 已知残留（本变更不修，明确记账）

- **写路径复用了读路径的 fail-open**：`readNoiseOverlay` 对 loader 是正确的（读不到→不静音，安全方向），但应用腿把 `[]` 当「现有集为空」后会全量覆盖。实测 overlay `chmod 000` 或超过 loader 的 256KB 上限时，一次 apply 会静默抹掉整份名单并回绿。属既有缺口（add 路径上早已存在），修法是写路径改用只把 `ENOENT` 视为空的严格读取。
- **overlay 改动在常驻 daemon 内不生效**：`startRulesConfigReload` 全仓只有测试调用，生产 `buildAndPublish` 只在模块加载时跑一次；hangar daemon 长驻 + ESM 模块缓存 ⇒ 移出后需重启 daemon 才实际解静音。属既有缺口（`rules-config` 规范的「改即生效」在生产未接线）。
- **校验不过的历史 overlay 行仍被 loader 消费**：如一行 `com` 会让所有 `.com` 发件人命中降噪，而新校验器不允许经反馈路径移除它（提案腿会把它过滤掉）。修法是让 loader 与应用腿共用同一套合法性过滤。

三条都不是本变更引入的，且修法都会越出「只动反馈闭环」的范围，故记账不修。

## 风险

- **行为变更**：应用腿对非法项与非 canonical 项从静默处理改为抛错。调用方必须先走提案腿。
- **部署序**：inbox 先、view 后。反序时提案阶段即契约不符，此时无写。
