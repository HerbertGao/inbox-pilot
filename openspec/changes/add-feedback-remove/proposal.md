## 为什么

降噪反馈闭环（`interpret-feedback` / `apply-feedback` → `noise_senders.overlay`）当前**只能加不能减**：overlay 机器文件只做 set-union，误加一个发件人**没有任何撤销入口**，而控制面契约禁止手改机器文件。补 remove 方向，让「加错了」有一条与「加」同形的两阶段确认路径退回去。

同时，两个入口都**缺入口校验**：应用腿收到什么就写什么，提案腿 emit 的是候选**原文**而非即将写入的形态——违反跨仓契约「确认页展示的必须等于实际写入的」。

定位是**低风险、可逆操作的确认 UX**，不是安全边界：人在确认页点确认即授权，不经 `ctx.propose`/PARK。

契约 SOT：hangar `add-view-feedback-remove` 的 `specs/hangar-view/spec.md`。

## 变更内容

- **`apply-feedback` 支持 `remove`**：input 泛化为 `{ add?, remove? }`，求 `(existing ∪ add) \ remove` 后经 tmp+rename **一次**原子发布；**恰好 emit 一次** `feedback.applied`，**四字段恒在**，且**回执与请求配分**（`added ∪ already_present` == 去重后的 `add`、`removed ∪ not_present` == 去重后的 `remove`，四桶两两不交）。
- **`interpret-feedback` 新增结构化入口**：`{ add?, remove? }` → 归一 + 校验 + 与 overlay 比对 → emit `{ add, remove }` 两字段恒在。**既有 `{ text }` → add 路径一行不改**。
- **pilot 不做自然语言意图解析**：方向与地址由调用方（Pi / Claude Code / CLI）给结构化 JSON。
- **两个归一 + 可加入判据**：「一行是什么」= `trim`+小写（**不剥 `<>`**，与本能力生效前同语义，故存量生效集不迁移）；「用户指哪个条目」= 另加剥掉所有包裹层 `<>`。可加入判据：控制字符 / 非 ASCII / 非 dot-atom local / 域标签 >63 / TLD 非纯字母一律非法。**overlay 格式的所有权收在 loader 模块，pipeline 是纯消费者**。
- **两腿失败语义相反**：提案腿对非法项**不抛错**（非法项只是不出现在提案里）；应用腿对非法项、**非 canonical 项**、同项冲突**抛错**。
- **input 缺 key → `[]` 不抛错；key 存在但非 `string[]` → 抛错**。
- **非 ASCII 域名（IDN）v1 直接拒绝**：只归一写入侧会 false-green（匹配侧不转 punycode）。

## 功能 (Capabilities)

### 新增功能
<!-- overlay 写入语义并入既有 rules-config；触发路由与事件契约并入 processing-pipeline；不新建 capability。 -->
（无）

### 修改功能

- `rules-config`: 新增「noise overlay 机器写入」条目——canonical 归一与合法性、两腿相反的失败语义、`(existing ∪ add) \ remove` 与回执配分、一次原子发布、**overlay-only 语义（人工规则要人工改）**、绝不写 `rules.yaml`。此前 overlay 只有实现、无规范。
- `processing-pipeline`: 新增「降噪反馈两触发」条目——两个入口的 input/emit 契约、字段恒在与**恰好一次**、缺 key 与畸形 key 的相反处理、**pilot 禁止做 NL 意图解析**、未知触发名响亮失败。

## 影响

- **代码**：`src/pipeline.ts`（结构化入口、共用 canonicalize、集合运算与四态回执、应用腿收紧）、`src/pipeline.test.ts`（self-check）。`src/rules/rulesConfig.ts` **成为 overlay 格式的唯一所有者**（新增归一/校验/读/文件身份/自有键读取；`readNoiseOverlay` 降为 fail-open 包装）。其**行归一语义与本能力生效前逐字节相同**（`trim`+小写），故存量 overlay 的生效降噪集不变；`src/rules/applySafetyRules.ts` 匹配侧**不改**；`matchNoiseCandidates` **一行不改**。
- **规范**：`rules-config`、`processing-pipeline`。
- **跨仓部署序**：**inbox 先上线、view 后上线**。反序时**经 UI 的**路径在提案阶段即契约不符、此时无写；但应用腿是独立入口，绕过 UI 直调时旧 pilot 会照旧应用 `add` 半边而 view 仍判失败——即「报失败但写已发生」。
- **行为变更（须知）**：
  1. 应用腿对非法项与**非 canonical 项**从「静默归一/丢弃」改为**抛错**——调用方必须先走提案腿。
  2. **「移出」后需重启 daemon 才实际解静音**：overlay 由 CLI 进程写，而规则快照在常驻 daemon 启动时读一次、生产未接热重载（见 design 的已知残留）。回执报的是**文件已改**，不是**已生效**。
  3. 只处理**真正的邮箱**：`mailto:` 前缀、带括号/方括号/反斜杠的 local、无点域（`root@nas`）、数字 TLD（`admin@10.0.0.5`）一律**不可加入**。两类理由不同，别混为一谈：`mailto:` 与非 atext local 在匹配侧**永不命中**（写进去是 false-green）；而 `root@nas`、`admin@10.0.0.5` 在匹配侧**本来是生效的**，拒绝它们是「只处理真正的邮箱」这条**政策取舍**，不是正确性约束——将来要放宽，放宽的是 `add` 侧语言，`remove` 侧与 `L = W` 不受影响。既有 `{text}` 路径命中这类候选时会**静默不进提案**（它们仍可经 `remove` 删除）。

## 非目标

- **不新增 trigger、不改 hangar core、不加 Approval/PARK/新 Run 状态、不接 Pi/MCP、不加 `intents:`**。
- **不在 pilot 里做 NL 意图解析**（定型决策：NL→结构化归调用方）。
- **不新增裸域名专用入口 / 不加区分展示**：结构化 `add` 与 overlay 既有行为一致地接受域名条目，而匹配侧对域名是**后缀匹配（含全部子域）**——确认页上 `taobao.com` 与一个普通地址视觉同构、作用域却差一个量级，由人工确认兜底。区分展示属跨仓 UX，另开一条。
- **不做 IDN 支持**（需写入侧与匹配侧同时改 + 存量 overlay 迁移，单独一条）。
- **不做 overlay → `rules.yaml` 固化 / 清理工具**。
- **不改**「不追溯历史邮件」「敏感邮件不降温、不自动已读」的既有语义。
- **不给 view 加 optional 字段兼容层**：用部署序解决。
