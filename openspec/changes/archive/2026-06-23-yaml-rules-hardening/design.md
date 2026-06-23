## 上下文

规则引擎名单当前硬编码在 `src/rules/lists.ts`（`VERIFICATION_KEYWORDS` / `SECURITY_PAYMENT_KEYWORDS` /
`SENSITIVE_CATEGORIES` / `SENSITIVE_DOMAINS`），`applySafetyRules.ts` 直接 import；`applySafetyRules` 是**同步纯函数**。
`SECURITY_PAYMENT_KEYWORDS` 含承载硬约束的医院/保险/支付/合同/安全/账单词（`lists.ts:30-33` 明示）。OpenRouter 降级路径
在 `classifyEmail.ts`（timeout→transport→fallback model→`safeDefault()` P1 不标已读），**非** `openrouterClient.ts`（后者只是 20s
per-request SDK timeout、不重试）。`executeActions` 有界重试为进程内内存计数、**无退避、无 retryCount 列**，`durable 跨重启属 P6`。
`scheduler.ts` 已有 per-account `isPolling` 锁 + `DEFAULT_POLL_TIMEOUT_MS=5min` 单轮超时。Node 无 stdlib YAML。§19 多数已落地。

## 目标 / 非目标

**目标：**
- `security_keywords`/`never_mark_read_domains`/`vip_senders`/`important_domains`/`marketing_keywords` 经 rules.yaml 可配、
  **改即生效**，缺失/非法/不可读**逐项回落（首次启动内置默认 / 运行期重载 carry-forward 上一次有效值）、绝不崩、护栏不失效**；**承载硬约束的关键词只增不减**。
- 在既有有界重试上补**有紧上限的指数退避**；OpenRouter 超时**复用既有降级**（AI 失败→P1 不标已读不变）。
- 达成 §19 全部验收（多数已落地，E2E 坐实）。

**非目标：**
- durable 跨重启重试（需 sweep + retryCount 列/单调键，非 §19 必需；未 markProcessed 邮件由 restart 重跑兜底——见决策 5）；
  多实例锁；精确 latest-wins；规则学习/向量库/GUI；改 §12.1 固定规则安全语义；项目维护域名白名单；
  把验证码关键词/敏感类别集做成 YAML 可配（守 P0 固定规则与类别轴硬约束、保持内置）。

## 决策

### 决策 1（核心张力）：域名轴非决定性、内置默认清空；诚实承认残留缺口略扩
硬约束「敏感邮件不自动标已读」由**内容轴**落地（关键词轴确定性兜底 + 类别轴概率性广覆盖），**不依赖域名白名单**（CLAUDE.md）。
- `never_mark_read_domains` 为 YAML 可配的**可选、非决定性补充**；**内置默认清空**（用户决策）——项目不携带任何域名默认、不维护域名白名单。
- **诚实边界（修正过度宣称）**：清空内置域名默认**不削弱**关键词轴/类别轴对其覆盖集的保护，但**确实略扩残留缺口**——此前由示例域名
  （bank.com 等）兜住的「域名可识别、但无关键词命中且 LLM 判非敏感类别」的邮件，现会被标已读。这是 no-whitelist 取舍下 best-effort 的
  扩大（CLAUDE.md 已接受其代价）。断言只能钉「命中关键词/类别的敏感邮件不标已读」，**不能**钉「仅域名可识别、内容轴漏判」者——故
  内容轴是决定性保证。spec/proposal 措辞统一为此诚实表述，**不**再宣称「清空域名 guard-neutral / 有断言钉住」。

### 决策 2：`rules-config` 加载器——可配置集定义、并集、sync 访问器、原子发布、绝不崩/绝不泄露
- **可配置集**：仅五类名单（security/never_mark_read_domains/vip/important/marketing）。**验证码关键词 + 敏感类别集不可 YAML 配**
  （守 §12.1 主题→P0 与类别轴）。`security_keywords` 只驱动不标已读，**禁止**变成主题→P0（那是验证码固定规则）。
- **security 关键词 = 整个内置常量并集（只增不减）**：有效 security 集 = **整个 `SECURITY_PAYMENT_KEYWORDS` 常量 ∪ YAML**（该常量**全部**承载硬约束、
  **非子集**——`lists.ts` 注释明示）。operator 配空/缺词/标量时全部内置词仍生效。`never_mark_read_domains` 非决定性、可替换（YAML 否则空）。
- **sync 访问器 + 同步初始化（security 默认 = 整集）**：`getActiveRules()` 同步返回当前快照 ref；快照**模块加载时同步初始化**，其中
  **`security_keywords` 同步默认 = 整个内置 `SECURITY_PAYMENT_KEYWORDS`**（即「内置整集 ∪ 空」，**禁止**初始化为空待异步并集——否则首次异步加载完成前的
  处理窗口 security 守卫失效）；其余轴默认空。`applySafetyRules` 保持同步。
- **测试注入 seam**：`applySafetyRules` 新增可选 `rules` 参（缺省 `= getActiveRules()`）——纯函数与现有调用点不变，单测经该参注入快照测域名轴等。
- **两阶段构建后原子发布（消除「半成品 vs 部分发布」歧义）**：每次**先逐项校验+替换装配出完整候选快照**（某项非法→构建阶段以「上一次有效值/内置默认」替换该项），
  **再一次性原子替换 ref**；逐项替换属**构建阶段**、ref 切换只在装配完成后——「不发布半成品」= 不在装配中途切 ref，与逐项回落不矛盾。
- **绝不崩 + 绝不泄露**：读取/解析抛任意错误（含 ENOENT/EACCES/EISDIR）/某项非法 → 逐项回落 + 脱敏日志（**只 kind+项名+zod `issue.path`，禁记
  `issue.message`/`received`/解析节点/文件内容/任何解析值**——沿用 `classifyEmail.ts` zodIssuePaths 纪律）、不崩。zod **非 strict**：未知键（含凭据形态键）丢弃、
  绝不读取；**禁止枚举被丢弃键名**（键本身可能是密钥）、至多记数量。

### 决策 3：热重载用 **mtime 轮询**，carry-forward 上一次有效值、poll tick 自愈
「改即生效」用小间隔 mtime 轮询（不用 fs.watch——跨平台事件不一致）。**重载语义单一（carry-forward，消除歧义）**：逐项构建候选快照时，某字段在新
YAML 缺失/zod 非法 → **carry-forward 该字段上一次有效值**（无则内置默认；**security 的上一次有效值 = operator 原始 YAML 列表**，发布时与内置整集重新求并集
→ 内置词永不丢、operator 已加词在坏重载中存活）；整文件解析失败/被删 = 所有字段都 carry-forward 的退化情形（**不**回落空/builtin 丢 operator 守卫）。
合法字段更新；两阶段原子发布（决策 2）。**poll tick 自愈**：每次 mtime tick **自捕获**其错误（含 `fs.stat` 失败）、记日志、**保持轮询存活**——一次 tick 出错
绝不使后续重载永久失效。`// ponytail: mtime 秒级——同秒两连改可能漏第二次、下次任意变更追上`。为可测，重载触发须有**可注入 seam**（注入路径/时钟/poller、
单测直调重载、不依赖真 timing），满足 §19「改即生效」可验证。

### 决策 4：YAML 解析依赖用 `yaml`
Node 无 stdlib YAML。引入 `yaml`（维护活跃、纯解析）。备选 JSON（stdlib `JSON.parse` + `fs.watchFile`、零依赖）——弃：§12.2 既定 rules.yaml 格式，
YAML 对手写名单（注释、无引号逗号）更友好。`// ponytail: 单依赖；若极简化可换 JSON+fs.watchFile 零依赖，但偏离 §12.2 格式`。

### 决策 5：稳定性补**有紧上限退避**、OpenRouter 降级在 classifyEmail.ts、durable 仍延后
- **退避（量化 + 按整轮校核）**：`executeActions` in-call 有界重试加指数退避——起始 ~100ms、每次 ≤500ms、**单封总退避（含分类器退避）封顶 ≤~1s**。
  **批量预算按整轮算（非仅单封）**：一轮 poll 顺序处理 N 封、整轮受 `DEFAULT_POLL_TIMEOUT_MS`(5min) 约束；单封封顶须使常规批量稳落超时内。
  **诚实更正 raceWithTimeout 语义**：超时**只停等待 + 释放信号量名额**——在途 poll **继续在途并按 `FinalDecision` 完成**（不强行中断），故超时本身
  **不发起任何标已读**、所有标已读仍经 `FinalDecision`（敏感邮件 `shouldMarkRead=false` 仍成立、**无不安全标已读**），per-mail `processedAt` 幂等保已完成不重处理 →
  退避/超时交互属**可用性**非安全（**不**宣称「超时放弃本轮、什么都不标」）。退避**延迟本封完成**，不宣称「不阻断 markProcessed」。**分类器退避与动作退避按单封求和**（同受 ≤~1s 封顶）。
- **OpenRouter 超时**：降级在 **`classifyEmail.ts`**（timeout→transport→`safeDefault` P1 不标已读），**非** `openrouterClient.ts`。退避 sleep 须落在既有
  `retryOnce` 内、第二次 `chat()` 之前，是**裸 delay、不增 `calls`**（`calls≤2` 结构保持）；降级语义不变（验证码/P4 不被下调）。
- **durable 跨重启重试延后**：需 sweep + retryCount 列/单调键（`mail_actions` 仅 status 枚举、无计数，**无法**由 status 派生重试预算），非 §19 必需；
  未 markProcessed 邮件由 restart 重跑兜底。`// ponytail: in-call 有界重试 + 退避足够；durable 队列留后续`。proposal/spec 统一为「本期只补 backoff、durable 延后」。

### 决策 6：新增轴的**精确有序管线**——urgency-floor（非 max 字面量）、marketing 只动 P2、shouldMarkRead 只算一次
三轴作为既有引擎**终末阶段**、按精确顺序施加于已裁定 `priority`、**绝不**碰 P0/P4 或翻回标已读。`Priority` 是**字符串枚举**（P0/P4 非数值最大），**禁用
`max()` 字面量算术**（`max('P0','P1')='P1'` 会把 P0 下调）。管线：
1. block ①（既有）裁定 priority；2. 算 **四轴** `sensitiveGuardFired = 类别 ∨ 关键词(整集∪YAML) ∨ 验证码关键词(主题**或正文** VERIFICATION_KEYWORDS、内置) ∨ 域名`（与 safety-rules spec 及既有 `applySafetyRules.ts` block ③ 一致——**含正文验证码轴**，本期重写不得丢）；
3. **marketing**：`priority==='P2' ∧ ¬sensitiveGuardFired ∧ 命中 marketing → P3`（**只动 P2、绝不碰 P0/P1/P4/敏感**——含高置信 P1 也不动，修正 N1）；
4. **floor(vip/important)**：`priority∈{'P2','P3'} ∧ (vip∨important) → P1`；`∈{P0,P1,P4}` no-op（urgency-floor 显式条件、非 max）。marketing 在 floor 前 → vip+广告→P1；
5. 派生：`shouldNotifyNow=priority∈{P0,P4}`；`shouldIncludeDigest=priority∈{P1,P2}`；**`shouldMarkRead=(priority∈{P2,P3}) ∧ ¬sensitiveGuardFired`——只算一次、
   敏感守卫 false 粘住**；新增轴绝不直接置 markRead=true、绝不从被自己改动的 priority 重派生 true（floor 抬到 P1→markRead 自然 false 安全；marketing 只在 P2 非敏感下调→始终一致）。
三轴内置默认空——未配则全 no-op、行为不变。

## 风险 / 权衡

- **配置错误/空名单削弱护栏** → 决策 2：security 关键词并集（硬约束词不可删）+ 逐项回落 + 同步初始化 + 构造顺序（先建后发布）+ 重载保留上一次有效快照；
  有断言钉「非法/空/garbage reload 下敏感邮件（命中关键词/类别）仍不标已读」。
- **凭据入日志** → 非 strict 丢弃未知键 + 成功/失败路径绝不记任何解析值/文件内容（决策 2）。
- **退避撑爆轮超时** → 紧上限 + 总退避 << poll 超时（决策 5）。
- **新增轴下调 P0/P4** → floor-only + marketing 仅在非强制时（决策 6），spec 有 scenario。
- **域名空扩大残留缺口** → 决策 1 诚实承认；决定性在内容轴。
- **重载丢 operator 守卫** → 重载保留上一次有效快照（决策 3）。

## 迁移计划

无 schema 迁移。`lists.ts` 的 `SENSITIVE_DOMAINS` 删除（内置域名默认清空后零消费者——引擎域名轴改消费 `rulesConfig` 的 `neverMarkReadDomains`）；**受影响测试迁移**：清空域名默认致约 **9 处**用 `SENSITIVE_DOMAINS[..]` 作 fixture 的断言失效
（跨 **4 文件**：`applySafetyRules.test.ts`(~5)、`processEmail.test.ts`、`imapActions.test.ts`、`imapPoller.test.ts`——开工 re-grep 精确定位）。**单元域名轴**用例
经 `applySafetyRules` 的新增可选 `rules` 参注入快照（含 operator `never_mark_read_domains`）测——保证域名轴**仍被测、不变 vacuous**；仅用域名作「不标已读」
便捷触发器的集成测试改用**内容轴触发器**（敏感类别/关键词）。须至少一条**单元**域名轴测经注入 seam 断言不标已读。
部署：放 `rules/rules.yaml`（或用内置默认即不放）→ 改文件即生效。**回滚（区分重启 vs 运行期，对齐统一 fallback 规则）**：**重启且无 rules.yaml → 内置默认**
（首次启动语义、无上一次有效值）；**运行期删/改坏文件 → carry-forward 上一次有效值**（不丢 operator 守卫）直到重启；**显式重置某轴** = 写一个含空数组的**合法**文件
（operator 主动清空，区别于「误删/改坏」的 carry-forward）。
**注**：主规范（`openspec/specs/`）的同步在归档（`openspec-cn archive`）时落地，与变更本地 delta 一致——与既往各期一致，非本期 propose 缺陷。

## 待解决问题

无阻塞项。决策 1（清空域名）已由用户落定；durable 重试（决策 5）、域名穷举白名单均记入非目标。
