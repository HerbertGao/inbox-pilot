## 为什么

降噪反馈闭环（`interpret-feedback` / `apply-feedback` → `noise_senders.overlay`）当前**只能加不能减**：overlay 机器文件只做 set-union，误加一个发件人**没有任何撤销入口**，而控制面契约禁止手改机器文件。补 remove 方向，让「加错了」有一条与「加」同形的两阶段确认路径退回去。

同时，两个入口都**缺入口校验**：应用腿收到什么就写什么，提案腿 emit 的是候选**原文**而非即将写入的形态——违反跨仓契约「确认页展示的必须等于实际写入的」。

定位是**低风险、可逆操作的确认 UX**，不是安全边界：人在确认页点确认即授权，不经 `ctx.propose`/PARK。

契约 SOT：hangar `add-view-feedback-remove` 的 `specs/hangar-view/spec.md`（**未锚定版本**，代价见 design 的「上下文」）。

## 变更内容

- **`apply-feedback` 支持 `remove`**：input 泛化为 `{ add?, remove? }`，求 `(existing ∪ add) \ remove` 后经 tmp+rename **一次**原子发布；**恰好 emit 一次** `feedback.applied`，**四字段恒在**，且**回执与请求配分**（`added ∪ already_present` == 去重后的 `add`、`removed ∪ not_present` == 去重后的 `remove`，四桶两两不交）。
- **`interpret-feedback` 新增结构化入口**：`{ add?, remove? }` → 归一 + 校验 + 与 overlay 比对 → emit `{ add, remove }` 两字段恒在。既有 `{ text }` 路径的**匹配集不变**，但它周围的行为改了（见下方「行为变更」第 4 条）。
- **pilot 不做自然语言意图解析**：方向与地址由调用方（Pi / Claude Code / CLI）给结构化 JSON。
- **两个归一 + 可加入判据**：「一行是什么」= `trim`+小写（**不剥 `<>`**，与本能力生效前同语义，故存量生效集不迁移）；「用户指哪个条目」= 另加剥掉所有包裹层 `<>`。**写路径只做收与拒、不做改写**——每多一条「替用户猜他想要哪个地址」的变换，写进文件的条目就与用户确认过的条目多一处不等。可加入判据 **=（匹配侧可达集 − 五项政策豁免）∩「长度 ≤ 254」**（豁免：非 ASCII local / 控制字符 local / 无点域名条目 / 裸 TLD / 前导 `mailto:`）；判据与豁免表的权威出处是 `rules-config` 规范，其余文档只引用。**overlay 格式的所有权收在 loader 模块，pipeline 是纯消费者**。
- **overlay 路径不可配置**：恒为 `dirname(RULES_FILE)/noise_senders.overlay`。一个旋钮定两个文件的位置，故它们不可能被指到对方身上；随之删掉「这两条路径是不是同一个文件」那一整套判定，且不设替代机制。
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

- **代码**：`src/pipeline.ts`（结构化入口、共用 canonicalize、集合运算与四态回执、应用腿收紧）、`src/pipeline.test.ts`（self-check）。`src/rules/rulesConfig.ts` **成为 overlay 格式的唯一所有者**（新增归一/校验/读/路径派生/自有键读取；`readNoiseOverlay` 降为 fail-open 包装）。其**行归一语义与本能力生效前逐字节相同**（`trim`+小写），故存量 overlay 的生效降噪集不变；`src/rules/applySafetyRules.ts` 匹配侧的判定逻辑**不改**，只把 `normalizeFromAddress` / `normalizeFromDomain` 由私有改为导出（供判据的性质断言与 `mailRepo` 复用）；`src/repo/mailRepo.ts` 不再自留一份发件人归一，改为 re-export `normalizeFromAddress`——两份实现一旦漂移，`{ text }` 腿的真阳性候选会被静默丢掉。
- **规范**：`rules-config`、`processing-pipeline`。
- **跨仓部署序**：**inbox 先上线、view 后上线**。反序时**经 UI 的**路径在提案阶段即契约不符、此时无写；但应用腿是独立入口，绕过 UI 直调时旧 pilot 会照旧应用 `add` 半边而 view 仍判失败——即「报失败但写已发生」。
- **行为变更（须知）**：
  1. 应用腿对非法项与**非 canonical 项**从「静默归一/丢弃」改为**抛错**——调用方必须先走提案腿。
  2. **「移出」后需重启 daemon 才实际解静音**：overlay 由 CLI 进程写，而规则快照在常驻 daemon 启动时读一次、生产未接热重载（见 design 的已知残留）。回执报的是**文件已改**，不是**已生效**。
  3. **可加入判据 =（匹配侧可达集 − 五项豁免）∩「长度 ≤ 254」**（判据全文见 `rules-config` 规范）。拒的第一类是**匹配侧永不命中**的形态：尖括号包裹（`<a@x.com>`）、local 或域名出了匹配侧字母表（`a b@x.com`、`a@x_y.com`）、**非 ASCII 域名**。第二类是五项政策豁免——它们匹配侧**本来命中**，是被显式减掉的：非 ASCII local（`é@x.com`）、控制字符 local、无点域名条目（`nas`、`localhost`、`router`）、裸 TLD（`com`）、前导 `mailto:`（`mailto:a@x.com` **拒绝而非剥离**，让调用方自己提交裸地址）。无点域名与裸 TLD 那两项的代价是「整机静音某台内网主机」这个形态不提供，替代路径是按地址加（`root@nas`）。**除这五项外一律收**，含无点域 `root@nas` 与数字 TLD `admin@10.0.0.5`：再严一格就把 NAS / 路由器 / 内网 cron 这一整类真实发件人锁在反馈闭环之外，而摘要表头正把它们展示为可加入。
  4. **`{ text }` 腿周围的行为改了**（`matchNoiseCandidates` 的匹配集本身逐字不变）：① 其输出多过一道可加入判据的**过滤**（不可加入的候选不再进提案，否则确认后必在应用腿抛错）；② 新增 overlay 读——**只**用于判定 overlay 可用（读失败即给空提案）与取字节基线；③ 提案受与应用腿同一道的条数闸与字节闸约束，超限**截断**；④ **禁止**据 overlay 过滤提案（那样会剔掉用户点名的真阳性、只留松匹配来的假阳性）；⑤ 候选查询失败不再使 run 失败——记一条只含 kind 的告警、给空提案（干跑腿绝不抛错，一次 DB 抖动不该把健康的服务画成故障）。

## 非目标

- **不新增 trigger、不改 hangar core、不加 Approval/PARK/新 Run 状态、不接 Pi/MCP、不加 `intents:`**。
- **不在 pilot 里做 NL 意图解析**（定型决策：NL→结构化归调用方）。
- **不新增裸域名专用入口 / 不加区分展示**：结构化 `add` 与 overlay 既有行为一致地接受域名条目，而匹配侧对域名是**后缀匹配（含全部子域）**——确认页上 `taobao.com` 与一个普通地址视觉同构、作用域却差一个量级，由人工确认兜底。区分展示属跨仓 UX，另开一条。
- **不做 IDN 支持**（需写入侧与匹配侧同时改 + 存量 overlay 迁移，单独一条）。
- **不做 overlay → `rules.yaml` 固化 / 清理工具**。
- **不改**「不追溯历史邮件」「敏感邮件不降温、不自动已读」的既有语义。
- **不给 view 加 optional 字段兼容层**：用部署序解决。
