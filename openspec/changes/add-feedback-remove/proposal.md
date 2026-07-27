## 为什么

降噪反馈闭环（`interpret-feedback` / `apply-feedback` → `noise_senders.overlay`）当前**只能加不能减**：overlay 机器文件只做 set-union，误加一个发件人**没有任何撤销入口**——operator 只能手工编辑容器里的机器文件。一个「本质无害、可逆」的域副作用，实现上却不可逆。

同时，两个入口都**缺入口校验**：apply 收到什么就写什么（非串静默丢弃、空白静默丢弃），interpret emit 的是候选地址**原文**而非即将写入的形态——违反跨仓契约「确认页展示的必须等于实际写入的」。

对侧 hangar 已开 `add-view-feedback-remove`，其 `specs/hangar-view/spec.md` 是本次的**契约 SOT**。本变更在 inbox 侧兑现该契约并补上入口校验。

## 变更内容

- **`apply-feedback` 支持 `remove`**：input 从 `{add}` 泛化为 `{add, remove}`，一次求 `existing ∪ add \ remove` 后经 tmp+rename **一次**原子发布；emit `feedback.applied` 的**四字段恒在**（`added` / `already_present` / `removed` / `not_present`，无变更即 `[]`）。**绝不碰人工维护的 `rules.yaml`**。
- **`interpret-feedback` 支持移出方向**：emit `interpretation.proposed {add, remove}`（两字段恒在）。方向由**确定性关键词**判定（无 LLM）；移出方向的候选集 = **当前 overlay 内容**（只读），故 `remove` 恒为 overlay 子集，零幻觉性质对两侧都成立。
- **显式 mailbox/domain 入口**：文本里带 `@` 或形如域名的 token 直接当显式项，**不要求**它出现在 digest TOP-N 候选里（加一个从未见过的地址是可逆低风险操作）。
- **canonical 归一 + 入口校验**：`trim → 去包裹 <> → 小写`，校验为非空、可打印 ASCII 的 `local@domain` 或 `domain`；非法项 → **throw**（`run.failed`），不静默丢弃。emit 的值即将写入 overlay 的形态。
- **非 ASCII 域名（IDN）v1 直接拒绝**：只归一写入侧会造成 false-green（见 design 决策 ③）。
- **加入与移出共用同一对 trigger**：撤销是同一意图的反向，不新增 trigger、不加 `intents:`、不接 Approval/PARK。

## 功能 (Capabilities)

### 新增功能
<!-- overlay 写入语义并入既有 rules-config；触发路由与事件契约并入 processing-pipeline;不新建 capability。 -->
（无）

### 修改功能

- `rules-config`: 新增「noise overlay 机器写入」的规范条目——canonical 归一与拒绝规则、`existing ∪ add \ remove` 集合语义与幂等回执、一次原子发布、绝不写 `rules.yaml`。此前 overlay 只有实现、无规范。
- `processing-pipeline`: 新增「降噪反馈两触发」的规范条目——`interpret-feedback` 干跑无写 / `apply-feedback` 幂等落盘的路由与事件契约、字段恒在、未知 trigger 响亮失败、跨仓部署序。

## 影响

- **代码**：`src/pipeline.ts`（interpret 加方向判定 + 显式地址解析 + remove 候选集；apply 加 set-difference 与入口校验；新增 canonical 归一/校验小工具）、`src/pipeline.test.ts`（self-check）。`src/rules/rulesConfig.ts` 的 `resolveNoiseOverlayPath` / `readNoiseOverlay` **只读复用、不改**；`src/rules/applySafetyRules.ts` 匹配侧**不改**。
- **规范**：`rules-config`、`processing-pipeline`。
- **跨仓部署序**：**inbox 先上线、view 后上线**。多 emit 字段对旧 view 无害（旧 view 只投影自己声明的字段）；反序会让整条命令路径落 `contract_mismatch`。
- **行为变更（须知）**：apply 对非法项从「静默丢弃」改为 **throw**。这是入口校验的目的——view 送来畸形结构化结果时响亮失败，而不是写进一个用户没确认过的名单。

## 非目标

- **不接 Pi、不接 MCP、不加 `intents:` 注册表、不加 Approval/PARK/新 Run 状态、不改 hangar core**。本变更定位是「低风险、可逆操作的确认 UX」，不是安全边界。
- **不引入 LLM / freetext 意图解析**：现有确定性子串匹配是零幻觉的最小形态；「加 digest TOP-N 之外的任意发件人」的触发点由本变更的显式地址入口覆盖。
- **不做 IDN 支持**：需匹配侧与写入侧同时改，单独一条。
- **不做 overlay → `rules.yaml` 固化 / 清理工具**（另一条待办）。
- **不改**「不追溯历史邮件」「敏感邮件不降温、不自动已读」的既有语义。
- **不给 view 加 optional 字段兼容层**：用部署序解决，反序时是响亮失败；真要并行部署再加。
