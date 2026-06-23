# rules-config 规范

## 目的
待定 - 由变更 yaml-rules-hardening 创建。归档后请更新目的。

## 需求

### 需求:从 rules.yaml 加载可配置名单并校验
系统**必须**提供 `rules-config` 加载器：读取 `rules/rules.yaml`（路径可经 env `RULES_FILE` 覆盖），用 `yaml` 解析、zod 校验为
**五类可配置名单**——`vip_senders`、`important_domains`、`marketing_keywords`、`security_keywords`、`never_mark_read_domains`
（各为字符串数组、全可选）。**验证码关键词与敏感类别集不在可配置之列**（保持内置、不经 YAML 覆盖，守 §12.1 与类别轴硬约束）。
zod schema **非 strict**：未知键（含任何凭据/账号/app secret 形态的键）**必须**被静默丢弃、绝不读取/消费；**禁止**在日志中枚举被丢弃的
键名（键本身可能是 operator 误粘的密钥），至多记数量。

**入口归一**：每个 YAML 列表项**必须**在 ingest 时归一——`trim` + 转小写 + 丢弃空串。引擎只对 email 侧（主题/正文/发件域/发件人）做小写归一，
故列表项也**必须**在加载时归一，否则 operator 写大小写/含空白的项（如 `security_keywords: ["Wire Transfer"]`、`important_domains: ["Example.COM"]`、
`vip_senders: ["CEO@x.com"]`）会**静默不匹配**——对 `security_keywords` 即 safety false-green（operator 以为加了守卫词、实则不生效）。归一对内置整集无害
（内置词已小写、并集只增不减），且方向单调趋安全（大小写不敏感只会让更多邮件命中敏感/验证码/域名轴 = 更多保护）。

#### 场景:加载合法 rules.yaml
- **当** `rules/rules.yaml` 存在且五类名单 schema 合法
- **那么** 加载器**必须**返回这五类名单（security 见并集语义）供 `applySafetyRules` 使用

#### 场景:只配可配置名单不配凭据、不枚举丢弃键名
- **当** rules.yaml 含凭据/账号/app secret 形态的键或 `verification`/`sensitive_categories` 键
- **那么** 加载器**必须**丢弃它们、**禁止**消费、**禁止**在日志枚举其键名（至多记一个数量）

#### 场景:大小写/空白列表项 ingest 归一
- **当** operator 配 `security_keywords: ["Wire Transfer", "  ", "Statement"]`（大小写 + 空白 + 空串）
- **那么** 有效集**必须**含归一后的 `"wire transfer"` 与 `"statement"`、**不含**空串；经 `applySafetyRules` 对主题「Wire Transfer Confirmation」的 P2 邮件断言 `shouldMarkRead=false`（operator 增配的 security 词在大小写不一致时仍生效）

### 需求:security_keywords 与整个内置常量并集（只能增不能减）
有效 security 关键词集**必须** = **整个内置 `SECURITY_PAYMENT_KEYWORDS` 常量 ∪ YAML 提供的词**（该常量**全部**承载硬约束，**不是**其某子集）。
operator 的 YAML **只能新增、绝不能删除**任何内置词。即便 operator 配 `security_keywords: []`、不含某些内置词、或配成标量（非数组、该项回落），
**全部内置 security 词必须仍生效**。`never_mark_read_domains`（可选非决定性域名轴）则为「YAML 提供否则空」（内置默认空、可替换）。

#### 场景:operator 不删内置 security 词
- **当** operator 配 `security_keywords: [自定义词]`、`[]`、不含某内置词、或标量
- **那么** 有效集**必须**仍含整个内置 `SECURITY_PAYMENT_KEYWORDS`，operator 词只叠加

### 需求:缺失/非法/不可读 YAML 逐项回落且绝不崩、不泄露、护栏不失效
系统**必须**在 `rules/rules.yaml` 不存在、为空、解析失败、某项 schema 非法、或读取/解析抛任何错误（含 ENOENT/EACCES/EISDIR 等 fs 错误）时，
**逐项回落到该项的「上一次有效值」；无上一次有效值（首次启动）时回落内置默认**（统一规则——首次启动用内置默认、运行期重载用 carry-forward，
见「热重载」需求；两者无矛盾）、记**脱敏**结构化日志、**绝不**崩进程、**绝不**让规则引擎裸奔。**日志只记 `kind` + 项名 + zod `issue.path`（连接后的路径）**——
**禁止**记录 `issue.message`/`issue.received`/被解析的节点/文件内容/任何解析出的值（防凭据/PII 经错误对象入日志，沿用 `classifyEmail.ts` 的 zodIssuePaths 纪律）。
**「无名单」绝不等同「放行标已读」**——硬约束护栏由内置 security 词（整集）+ 类别轴守住（即便所有 YAML 项回落）。

**文件大小上限（有界同步解析）**：rules.yaml 经热重载每 tick 同步 `readFileSync`+`parseYaml`；为防 operator 误指一个超大文件同步阻塞 event loop，
加载器**必须**在读取前以 `statSync` 比对字节数与上限（`MAX_RULES_FILE_BYTES`，256KB——远超五类可选字符串数组的常规体量），超限**必须**视为加载失败
（`kind=too-large`）→ 全 carry-forward（不读不解析、护栏不失效、不崩）、记脱敏日志。`// ponytail: 256KB 上限；如需巨表可上调或改流式解析`。

#### 场景:文件超大 → carry-forward、不阻塞、不崩
- **当** rules.yaml 超过 `MAX_RULES_FILE_BYTES`（256KB）
- **那么** 加载器**必须**在 `readFileSync` 前即判超限、全 carry-forward（内置 security 整集仍在、护栏不失效）、记 `cause=too-large` 脱敏日志、**禁止**读取/解析该文件、**禁止**崩

#### 场景:文件缺失/不可读 → 回落、服务正常、不崩
- **当** rules.yaml 不存在或读取抛 EACCES/EISDIR 等任意 fs 错误
- **那么** 全部回落（统一规则：首次启动内置默认 / 运行期重载 carry-forward 上一次有效值）、记日志、服务正常（**禁止**因 fs 错误崩进程）

#### 场景:某项非法 → 仅该项回落、其余生效
- **当** `security_keywords` 合法但 `vip_senders` 形态非法
- **那么** `vip_senders` 回落（上一次有效值，首次则内置默认）、`security_keywords` 生效（与内置整集并集）、不崩

#### 场景:解析失败/空名单不让护栏失效
- **当** rules.yaml 解析失败、或 `security_keywords` 配空
- **那么** 敏感邮件（命中关键词/类别）**必须**仍不标已读（内置 security 整集 + 类别轴守住）

#### 场景:凭据形态值/原始错误绝不入日志
- **当** rules.yaml 含凭据形态值并触发任意（成功/失败/类型不符）日志路径
- **那么** 日志**禁止**含该值、zod `issue.message`/`received`、或文件内容（只 kind+项名+`issue.path`）

### 需求:有效快照同步初始化（含 security 整集）、sync 访问器、构建后原子发布
`applySafetyRules` 是同步纯函数——加载器**必须**暴露**同步**访问器 `getActiveRules()` 返回当前内存有效快照引用；快照**必须在模块加载时同步初始化**，
其中 **`security_keywords` 同步默认值 = 整个内置 `SECURITY_PAYMENT_KEYWORDS`**（即「内置整集 ∪ 空」，**禁止**初始化为空待异步并集——否则首次异步加载完成前的
处理窗口内 security 守卫失效）；vip/important/marketing/域名默认为空。异步加载/重载在后台进行。
**构建后原子发布（两阶段、消除「半成品 vs 部分发布」歧义）**：每次（初次/重载）**先逐项校验+替换构建出一个完整候选快照**（某项非法/缺失 →
在此构建阶段以「上一次有效值或内置默认」替换该项，见重载需求），**再一次性原子替换 ref**；**绝不**在构建未完成时替换 ref。「不发布半成品」=
ref 切换只发生在完整快照装配完成之后；逐项替换属构建阶段、非半成品发布。`applySafetyRules` 保持同步、读当前 ref。

#### 场景:首次加载前 security 守卫已武装
- **当** `applySafetyRules`（或某轮 poll）在初次异步加载完成前被调用
- **那么** `getActiveRules().security_keywords` **必须**已是整个内置 `SECURITY_PAYMENT_KEYWORDS`（同步初始化），一封含内置词的敏感邮件仍不标已读

#### 场景:构建未完成不发布
- **当** 一次（重）加载在逐项构建/校验中途出错
- **那么** **禁止**替换 ref；保持当前有效快照不变

### 需求:rules.yaml 热重载（改即生效）、carry-forward 上一次有效值、poll tick 自愈
系统**必须**使 `rules/rules.yaml` 改动无需重启即生效：mtime 轮询检测变更后重载 → 逐项构建 → 原子发布。**重载语义单一明确（消除歧义）**：
逐项构建候选快照时，**某字段在新 YAML 中缺失或 zod 非法 → carry-forward 该字段的上一次有效值**（无上一次则内置默认；security 的上一次有效值定义为
**operator 原始 YAML 列表**，发布时与内置整集重新求并集，故内置词永不丢、operator 已加词在坏重载中存活）；合法字段更新。整体文件解析失败/被删 =
所有字段都 carry-forward 的退化情形（**不**回落到空/builtin 而丢掉 operator 已生效守卫）。**poll tick 自愈**：mtime 轮询的每次 tick **必须**自捕获其
自身错误（含 `fs.stat` 失败），记脱敏日志、**保持轮询存活**——一次 tick 出错**绝不**使后续重载永久失效。`// ponytail: mtime 秒级——同秒两连改可能漏第二次、下次任意变更追上`。
为可测，重载触发须有**可注入 seam**（注入路径/时钟/poller、单测直调重载、不依赖真 timing）。

#### 场景:改 YAML 后下一封邮件即用新名单
- **当** 运行期编辑 rules.yaml 新增一个 `security_keywords` 词、触发重载
- **那么** 无需重启，下一封邮件即用「内置整集 ∪ 新词」（经可注入 seam 验证）

#### 场景:坏重载 carry-forward 不丢 operator 守卫
- **当** 运行期把某字段改非法、或整文件改坏、或删文件
- **那么** 该字段（或全部）carry-forward 上一次有效值（含 operator 已配域名/security 词）、内置 security 整集仍并入、记错、不崩、护栏不失效

#### 场景:poll tick 出错不致后续重载永久失效
- **当** 某次 mtime 轮询 tick 抛错（如 stat 失败）
- **那么** 该 tick 自捕获、记日志、轮询继续，下一 tick 仍能重载有效文件
