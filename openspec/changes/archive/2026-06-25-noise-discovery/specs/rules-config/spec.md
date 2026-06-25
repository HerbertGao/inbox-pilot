## 修改需求

### 需求:从 rules.yaml 加载可配置名单并校验
系统**必须**提供 `rules-config` 加载器：读取 `rules/rules.yaml`（路径可经 env `RULES_FILE` 覆盖），用 `yaml` 解析、zod 校验为
**六类可配置名单**——`vip_senders`、`important_domains`、`marketing_keywords`、`security_keywords`、`never_mark_read_domains`、`noise_senders`
（各为字符串数组、全可选）。`noise_senders` 与现有五类**同等待遇**（独立逐项校验、carry-forward、ingest 归一、深冻结）。**验证码关键词与敏感类别集不在可配置之列**（保持内置、不经 YAML 覆盖，守 §12.1 与类别轴硬约束）。
zod schema **非 strict**：未知键（含任何凭据/账号/app secret 形态的键）**必须**被静默丢弃、绝不读取/消费；**禁止**在日志中枚举被丢弃的
键名（键本身可能是 operator 误粘的密钥），至多记数量。

**入口归一**：每个 YAML 列表项**必须**在 ingest 时归一——`trim` + 转小写 + 丢弃空串。引擎只对 email 侧（主题/正文/发件域/发件人）做小写归一，
故列表项也**必须**在加载时归一，否则 operator 写大小写/含空白的项（如 `security_keywords: ["Wire Transfer"]`、`important_domains: ["Example.COM"]`、
`vip_senders: ["CEO@x.com"]`、`noise_senders: ["NAS@home.LAN"]`）会**静默不匹配**——对 `security_keywords` 即 safety false-green（operator 以为加了守卫词、实则不生效）。归一对内置整集无害（内置词已小写、并集只增不减），且方向单调趋安全（大小写不敏感只会让更多邮件命中敏感/验证码/域名轴 = 更多保护）。

#### 场景:加载合法 rules.yaml
- **当** `rules/rules.yaml` 存在且六类名单 schema 合法
- **那么** 加载器**必须**返回这六类名单（security 见并集语义）供 `applySafetyRules` 使用

#### 场景:只配可配置名单不配凭据、不枚举丢弃键名
- **当** rules.yaml 含凭据/账号/app secret 形态的键或 `verification`/`sensitive_categories` 键
- **那么** 加载器**必须**丢弃它们、**禁止**消费、**禁止**在日志枚举其键名（至多记一个数量）

#### 场景:大小写/空白列表项 ingest 归一
- **当** operator 配 `security_keywords: ["Wire Transfer", "  ", "Statement"]`（大小写 + 空白 + 空串）
- **那么** 有效集**必须**含归一后的 `"wire transfer"` 与 `"statement"`、**不含**空串；经 `applySafetyRules` 对主题「Wire Transfer Confirmation」的 P2 邮件断言 `shouldMarkRead=false`

#### 场景:加载并归一 noise_senders
- **当** operator 配 `noise_senders: ["NAS@home.LAN", "  ", "hkss.example.com"]`
- **那么** 有效集**必须**含归一后的 `"nas@home.lan"`（发件人）与 `"hkss.example.com"`（域）、**不含**空串；缺失/非法/标量时该项逐项回落（首次内置默认空 / 运行期 carry-forward 上一次有效值），**禁止**因 noise_senders 非法连累其余五类
