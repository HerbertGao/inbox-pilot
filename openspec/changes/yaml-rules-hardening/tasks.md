## 1. 依赖 + rules-config 加载器（整集并集 / sync 访问器 / 两阶段发布 / 绝不崩泄）

- [x] 1.1 加依赖 `yaml`；`rules/rules.yaml` 放示例（五类名单，`never_mark_read_domains` **留空** + 注释说明可选非决定性；其余示例）
- [x] 1.2 `src/rules/rulesConfig.ts`：读 `rules/rules.yaml`（默认仓库内、可经 env `RULES_FILE` 覆盖）→ `yaml` 解析 → zod schema（五类名单字符串数组、全可选、**非 strict**：未知键含凭据形态键丢弃绝不读取；**禁止枚举被丢弃键名**、至多记数量）。**验证码关键词/敏感类别集不在 schema、保持内置**
- [x] 1.3 **整集并集**：`security_keywords` 有效集 = **整个内置 `SECURITY_PAYMENT_KEYWORDS` ∪ YAML**（非子集；operator 配空/缺词/标量时全部内置词仍生效）；`never_mark_read_domains` = YAML 否则空；其余项 YAML 否则内置默认。`security_keywords` 只驱动不标已读、**禁止变主题→P0**
- [x] 1.4 **sync 访问器 + 同步初始化 + 注入 seam + 两阶段发布**：`getActiveRules()` 同步返回当前 ref；快照模块加载时**同步初始化**，**`security_keywords` 同步默认 = 整个内置 `SECURITY_PAYMENT_KEYWORDS`**（禁初始化为空待异步并集）；`applySafetyRules` 加**可选 `rules` 参（缺省 `getActiveRules()`）**、保持同步；**两阶段**：先逐项校验+替换装配完整候选快照、再一次性原子替换 ref（构建未完成不切 ref）
- [x] 1.5 **绝不崩 + 绝不泄露**：读取/解析抛任意错误（ENOENT/EACCES/EISDIR…）/某项非法 → 逐项回落 + 脱敏日志（**只 kind+项名+zod `issue.path`；禁 `issue.message`/`received`/解析节点/文件内容/任何解析值**，沿用 `classifyEmail.ts` zodIssuePaths）、不崩
- [x] 1.6 测试（**经 `applySafetyRules`、非仅 loader 返回值**）：合法 YAML → 用「内置整集 ∪ YAML」；缺文件/EACCES → 回落不崩；**`security_keywords:[]` / 缺内置词 / 标量 → 对「医院预约」邮件断言 shouldMarkRead=false**；解析失败 → 敏感邮件仍不标已读；凭据值/原始错误不入日志；**首次异步加载前 `getActiveRules().security_keywords` 已是内置整集**

## 2. 热重载（改即生效）+ carry-forward + poll tick 自愈

- [x] 2.1 mtime 轮询重载 → 逐项构建 → 两阶段原子发布；**carry-forward（单一语义）**：字段缺失/非法 → carry-forward 该字段上一次有效值（无则内置默认；**security 上一次有效值 = operator 原始 YAML 列表**，发布时与内置整集重新并集）；整文件坏/删 = 全 carry-forward（不丢 operator 守卫）；**poll tick 自捕获其错误（含 stat 失败）、保持轮询存活**
- [x] 2.2 `startRulesConfigReload(...) → 可停止句柄`（注入路径/时钟/poller seam，可测；优雅关闭停止）
- [x] 2.3 测试（经注入 seam）：改 YAML 后 `getActiveRules()` 反映新值（含「内置整集 ∪ 新词」）；**坏重载/删文件 → carry-forward（含 operator 域名/词）+ 内置整集仍并入、护栏不失效、不崩**；poll tick 抛错后下一 tick 仍能重载

## 3. applySafetyRules 消费名单 + 新增轴精确管线

- [x] 3.1 `applySafetyRules` 改经 `getActiveRules()`（或注入的 `rules` 参）取名单；固定规则（§12.1）判定不变；**`lists.ts` 的 `SENSITIVE_DOMAINS` 清空为 `[]`**；security 用整个内置常量并集
- [x] 3.2 新增轴**精确有序管线**（终末阶段、空默认）：算 `sensitiveGuardFired = 类别轴 ∨ 关键词轴(整集∪YAML) ∨ **验证码关键词轴(主题或正文 VERIFICATION_KEYWORDS、内置)** ∨ 域名轴`（**本期重写不得丢正文验证码轴**，对齐既有 `applySafetyRules.ts` block ③ 四守卫）；**marketing**：`priority==='P2' ∧ ¬sensitiveGuardFired ∧ 命中 → P3`（**只动 P2**）；**floor(vip/import)**：`priority∈{P2,P3} ∧ (vip∨important) → P1`（**显式条件、禁 `max()` 字面量**；P0/P1/P4 no-op；**`important_domains` 复用 `matchesSensitiveDomain` 式子域归一匹配；`vip_senders` 匹配归一后的 `fromEmail`（精确）**）；marketing 在 floor 前；派生 `shouldNotifyNow/shouldIncludeDigest/shouldMarkRead` 从终末 priority，**`shouldMarkRead` 只算一次 + 敏感守卫 false 粘住**、新增轴禁置/重派 true
- [x] 3.3 测试：YAML 覆盖生效；三轴空默认 → 既有用例不变；**P0/P4 + vip/important → 不下调（仍 P0/P4、shouldNotifyNow 不丢）**；**高置信 P1 + marketing → 不下调 P3、不翻 shouldMarkRead**；**敏感 P2 + marketing → 不下调、护栏粘住**；**vip + 广告 → P1**；提升轴 + 敏感轴 → markRead 粘 false；**正文含验证码（主题无）的 P2/非敏感类别 → shouldMarkRead=false（经 applySafetyRules）**；域名轴空 → 敏感邮件仍由内容轴守住

## 4. 稳定性：量化退避（按整轮校核）

- [x] 4.1 `executeActions` in-call 有界重试加指数退避：**起始 ~100ms、每次 ≤500ms、单封总退避（含分类器退避）≤~1s**；批量按整轮校核（N 封顺序、整轮 ≤ `DEFAULT_POLL_TIMEOUT_MS`，超时由 raceWithTimeout 优雅放弃、processedAt 幂等、放弃不自动标已读）；退避延迟本封但不跳过该封其余动作、不阻其他账号
- [x] 4.2 OpenRouter 超时退避：改 **`classifyEmail.ts`**——sleep 落在既有 `retryOnce` 内、第二次 `chat()` 前、**裸 delay 不增 `calls`**（`calls≤2` 保持）；**gate 在传输/可用性分支（`retryOnce` 与内容失败路径共用 → 禁止无条件 sleep；内容重试路径无退避）**；复用「AI 失败→P1 不标已读」降级（验证码/P4 不被下调）；分类器退避计入单封 ≤~1s 预算
- [x] 4.3 测试：动作重试间有退避（注入假时钟）、单封总退避有上限；OpenRouter 超时 → P1 不标已读、calls≤2

## 5. main 接线

- [x] 5.1 `main.ts` 启动 rules-config 初次加载 + 热重载句柄；优雅关闭停止（与 `schedulerTasks` 一并、单一管理）；`.env.example` 加可选 `RULES_FILE` 注释

## 6. 受影响测试迁移 + §19 E2E 确认 + 日志

- [x] 6.1 **迁移清空 `SENSITIVE_DOMAINS` 致失效的 ~9 处域名 fixture（4 文件：`applySafetyRules.test.ts`~5、`processEmail.test.ts`、`imapActions.test.ts`、`imapPoller.test.ts`——re-grep 精确定位）**：单元域名轴用例经 `applySafetyRules` 的注入 `rules` 参传含 operator `never_mark_read_domains` 的快照测（**保域名轴仍被测、不 vacuous**）；仅用域名作便捷触发器的集成测试改用**内容轴触发器**；至少一条单元域名轴测断言不标已读
- [x] 6.2 结构化日志完善（规则命中/重载/退避记脱敏 kind+path，绝不泄露凭据/正文/PII/解析值/丢弃键名）
- [x] 6.3 逐项核对 §19（多数 P0–P5 已落地）：账号、周期处理、分类、P0/P4 推送、P2/P3 标已读、P3 计数、P1/P2 摘要、DB 可查、AI 失败/低置信不标已读、重启不重复；**改 rules.yaml 即时生效**（经 seam 验证）；并发不重入同账号（确认）；**残留缺口诚实**——无测试断言「仅域名可识别、内容轴漏判」的邮件不标已读

## 7. 收尾验证

- [x] 7.1 `pnpm exec tsc --noEmit` 干净 + `pnpm test` 全过（含迁移后域名轴测试）
- [x] 7.2 对照 spec 场景逐条核验：整集并集（security 只增不减、空/标量仍守）/逐项回落/解析失败护栏不失效/凭据+原始错误+丢弃键名不入日志/sync 初始化 security=整集 / 两阶段发布 / carry-forward 坏重载不丢 operator 守卫 + poll tick 自愈 / 管线 marketing 只动 P2 + floor 非 max 不下调 P0P4 + shouldMarkRead 只算一次不翻 / 退避量化按整轮 / OpenRouter calls≤2 / 验证码类别保持内置 / 域名轴经注入 seam 仍被测
