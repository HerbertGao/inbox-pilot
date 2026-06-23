## 为什么

规则引擎的名单硬编码在 `src/rules/lists.ts`——operator 想加一个 VIP 发件人、营销关键词、敏感域名都得改代码重新部署。
P6 把**可配置名单**做成 `rules/rules.yaml`、**改即生效**（PROJECT_INIT §12.2），并补齐 §19 验收所需的稳定性收尾
（动作重试退避、OpenRouter 超时降级、日志完善），完成 MVP。

## 变更内容

- 新增 `rules/rules.yaml` + **加载器 `rules-config`**（zod 校验）：`vip_senders` / `important_domains` /
  `marketing_keywords` / `security_keywords` / `never_mark_read_domains` 五类名单喂给 `applySafetyRules`。
  **验证码关键词与敏感类别集保持内置、不经 YAML 配**（守 §12.1 主题→P0 与类别轴硬约束）。
  **热重载**（mtime 轮询）：缺失/非法/不可读 → **逐项回落（首次启动内置默认 / 运行期重载 carry-forward 上一次有效值）+ 记错 + 不崩 + 护栏不失效**。
- **security 关键词 = 整个内置常量并集（只增不减）**：有效 `security_keywords` = **整个内置 `SECURITY_PAYMENT_KEYWORDS` 常量 ∪ YAML**
  （该常量全部承载硬约束、非子集）——operator 配空/缺词/标量时全部内置词**必须仍生效**（YAML 不能删）。`applySafetyRules` 新增可选 `rules` 参（缺省
  `getActiveRules()`）使纯函数可注入测试快照。
- **`applySafetyRules` 改经 `getActiveRules()` 同步访问器消费名单**（取代直接 import 唯一来源）；同步纯函数语义不变；
  快照模块加载时同步初始化为内置默认（首次异步加载前也绝不裸奔）。固定规则安全语义不变。
- **域名轴政策**：`never_mark_read_domains` 为**可选、非决定性**补充，**内置默认清空**（用户决策：项目不携带域名默认、不维护白名单）；
  决定性不标已读全在内容轴（关键词并集 + 类别轴）。**诚实边界**：清空域名默认不削弱内容轴保护，但**略扩残留缺口**（此前由示例域名兜住、
  内容轴漏判的敏感邮件落入缺口）——no-whitelist 取舍下 best-effort 的扩大（CLAUDE.md 已接受）。
- **新增轴精确有序管线**（终末阶段、加性、空默认）：`marketing_keywords` 只把 **P2 非敏感**邮件下调 P3（**绝不**碰 P0/P1/P4/敏感，含高置信 P1）；
  `vip_senders`/`important_domains` **urgency-floor**（显式条件 `P2/P3→P1`、P0/P1/P4 no-op；**禁用 `max()` 字面量**——P0/P4 非数值最大）；
  `shouldMarkRead` 只算一次、敏感守卫 false 粘住、新增轴**禁止**翻回 true。marketing 在 floor 前（vip+广告→P1）。
- **动作重试退避**：`executeActions` 既有 in-call 有界重试加**有紧上限的指数退避**（单封总退避 << 单轮 poll 超时，防撑爆轮超时）。
  **durable 跨重启重试本期延后**（需 sweep + retryCount 列；未 markProcessed 邮件由 restart 重跑兜底——见 design 决策 5）。
- **OpenRouter 超时降级**：降级路径在 **`classifyEmail.ts`**（非 openrouterClient.ts）；本期只在既有 2 步状态机两次 model 调用间加一次
  退避 sleep、**保持 `calls≤2`**、复用既有「AI 失败 → P1 不标已读」降级（验证码/P4 不被下调）。
- **结构化日志完善**（绝不记凭据/正文/PII/解析值）+ **§19 全部验收 E2E 确认**。

## 功能 (Capabilities)

### 新增功能
- `rules-config`: YAML 规则配置——加载五类可配置名单、zod 校验、热重载、缺失/非法/不可读逐项回落（首次内置默认/重载 carry-forward）且不崩、护栏不失效、
  承载硬约束的关键词并集（只增不减）、sync 访问器 + 同步初始化 + 原子发布。

### 修改功能
- `safety-rules`: 引擎经 `getActiveRules()` 消费可配置名单（硬约束关键词并集、内置默认 fallback）；域名轴内置默认空、非决定性；
  **新增 floor-only 提升/营销轴**（绝不下调固定优先级、绝不翻回标已读）。固定规则安全语义不变。
- `processing-pipeline`: 动作执行补**有紧上限的指数退避**（不撑爆轮超时；durable 跨重启延后）。

## 非目标（不纳入本期 MVP）

- **durable 跨重启重试 / 投递队列**：需 sweep + retryCount 列/单调键，非 §19 必需（design 决策 5）。
- **把验证码关键词/敏感类别集做成 YAML 可配**：守 §12.1 与类别轴硬约束，保持内置。
- **项目维护的穷举域名白名单**：与 no-whitelist 硬约束冲突——域名轴永远可选非决定性。
- 多实例 DB 锁；精确 latest-wins/supersede；规则学习/向量库/GUI；改 §12.1 固定规则安全语义。
- **单账号同步互斥锁本身**：已在 `scheduler.ts`（P3/P4），本期仅 §19 确认。
- **YAML 配账号/凭据/app secret**：rules.yaml 只配规则名单（未知键一律丢弃）。

## 影响

- **新增**：`src/rules/rulesConfig.ts`（加载/校验/并集/热重载/同步初始化/fallback）+ 测试；`rules/rules.yaml`（示例，域名留空）。
- **修改**：`src/rules/applySafetyRules.ts`（经 getActiveRules 消费 + 可选 `rules` 参 + 新增轴管线，**保留正文验证码守卫轴**）、
  `src/rules/lists.ts`（SENSITIVE_DOMAINS 清空、内置默认作 fallback、注明**整个 `SECURITY_PAYMENT_KEYWORDS` 常量全部承载硬约束**为并集基底）、
  `src/actions/executeActions.ts`（退避）、`src/classifier/classifyEmail.ts`（`retryOnce` 内第二次调用前一次裸 delay）、logger 完善、
  `main.ts`（启动加载 + 热重载句柄 + 优雅关闭）、`.env.example`（可选 `RULES_FILE`）、**受影响测试迁移**（`SENSITIVE_DOMAINS` fixture，4 文件、开工 re-grep 精确定位）。
- **依赖**：新增 `yaml`（Node 无 stdlib YAML）。
- **数据**：无 schema 迁移。
