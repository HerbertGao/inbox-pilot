## 新增需求

### 需求:账号可选展示别名 label
系统必须为每个账号提供一个**可空**的展示别名 `MailAccount.label`（`String?`），供通知等面向运维的渲染。`label` 与主键 `id` **严格区分**:`id` 仍是确定性生成的**严格 ASCII**（防日志注入、结构化日志字段,**不放松**）；`label` 允许**中文/可见 Unicode** 字形。

`label` 校验规则**规范层钉死**（不留「控制字符」泛指——下游流入 Telegram 通知行与运维输出，denylist 必须明确）:必须**拒绝** — Unicode 通用类 `\p{Cc}`（C0/C1 控制,含 `\n`/`\r`/`\t`/NUL/DEL/U+0085）、`\p{Cf}`（格式字符,含零宽 U+200B / BOM U+FEFF / bidi 嵌入·覆盖 U+202A–U+202E）、行分隔 U+2028/U+2029、bidi 隔离符 U+2066–U+2069；并在 **`.trim()` 后判空**（纯空白 → 拒）；长度 **≤ 64 码元（UTF-16 code units）**。违反 → 用法错误（退出码 2）。仅拒 `\n`/`\r` **不足**:RTL-override（U+202E）等在通知客户端视觉重排、伪装来源邮箱,击穿「可辨来源」目标。

`label` 为 NULL 时,下游渲染回落到账号 `email`（稳定必有；**不**用 accountId-strip——自定义 account-id 未必含邮箱、且 prefix-only id strip 后为空）。`label`/派生的 `accountLabel` **绝不**写入结构化日志字段（仅入通知 payload 的白名单结构字段）。

数据库迁移新增可空列 `label`,**禁止**回填存量账号（存量 `label=NULL`、渲染走 `email` 回落）。`label` **仅**在账号**行创建**分支写入（同 `processFrom`）；`update`/re-auth **不**改该列。

#### 场景:label 允许中文、拒控制/格式/bidi 字符
- **当** 设置 `label` 为含中文的可见字符串（如「公司邮箱」）
- **那么** 必须接受；若含 `\p{Cc}` / `\p{Cf}` / U+2028 / U+2029 / U+2066–U+2069（如换行、零宽空格 U+200B、RTL-override U+202E）或 `.trim()` 后为空或超 64 码元,必须以用法错误（退出码 2）拒绝

#### 场景:label 不放松主键 ASCII
- **当** 设置中文 `label`
- **那么** 账号主键 `id` 仍必须是严格 ASCII（`label` 是独立列,主键约束**不**被 label 影响）

#### 场景:NULL label 回落账号 email
- **当** 账号 `label` 为 NULL 且渲染其来源标签
- **那么** 必须回落到账号 `email`（**禁止**渲染空来源；**禁止**依赖 accountId-strip 作主回落）

#### 场景:迁移默认 NULL 不回填
- **当** 迁移在已有账号库上执行
- **那么** 存量账号 `label` 必须为 NULL,**禁止**自动赋值

#### 场景:label 仅 create 写、update 保留
- **当** 对已存在账号执行写操作（re-auth / update）
- **那么** 既有 `label` 必须不被改动（仅行创建分支写 label；同 `processFrom`）
