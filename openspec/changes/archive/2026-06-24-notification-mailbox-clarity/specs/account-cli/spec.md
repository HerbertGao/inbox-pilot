## 新增需求

### 需求:接入可选展示别名 --label
`account add`（IMAP 与 Gmail **两子命令**）必须接受可选 `--label <名>`,把展示别名写入 `MailAccount.label`（见 account-registry「账号可选展示别名 label」）；未给则 `label=NULL`。

`--label` 处理:
- **值缺位守卫**:`--label` 后续 token 以 `-` 开头时会被参数解析当布尔（落 `bools`，同 `--process-from`）→ 必须检测（`bools` 含 `label`）并以 `--label 需要值参数 <名>` + 用法错误（退出码 2）拒绝;**禁止**静默落 NULL。
- **校验**（同 account-registry 钉死规则）:`.trim()` 后非空、拒 `\p{Cc}`/`\p{Cf}`/U+2028/U+2029/U+2066–U+2069、≤ 64 码元;失败 → 用法错误（退出码 2）、**不**建账号 / 不触达 repo 写。
- account-id 主键仍严格 ASCII,**不**被 `--label` 影响。
- `--label` 仅在新接入（create 分支）生效;对**既有**账号的 `add`（走 update,含 Gmail re-auth）**不**改其 label（同 `--process-from`）。改既有别名无本期入口（`account set-label` 为 `[out-of-scope]` 后续,同 `set-process-from`先例）;既有/未设 label 的账号通知走 `email` 回落。
- CLI 成功/错误行回显 `label` 必须经 `JSON.stringify` 转义（与 account-id 既有 `JSON.stringify(id)` 同模式,校验+转义双层）;`label` **不**进结构化日志字段。
- `account add --json` 机器可读输出白名单 `{id, provider, email, enabled}` **保持不变**——`label` **仅**入人类可读输出,**不**加进 `--json`（不破坏既有机器契约）。

#### 场景:add --label 写入中文别名
- **当** 运维执行 `account add --gmail … --label 公司邮箱`
- **那么** 新账号行 `label` 必须为「公司邮箱」,且此后该账号的通知优先渲染此别名

#### 场景:--label 值缺位被拒
- **当** 运维执行 `account add … --label`（无值,或下一 token 如 `--gmail` 以 `-` 开头）
- **那么** 必须以 `--label 需要值参数` + 用法错误（退出码 2）拒绝,**禁止**静默落 NULL label

#### 场景:非法 label 被拒、不建账号
- **当** `--label` 值含 `\p{Cc}`/`\p{Cf}`/U+2028/U+2029/bidi 隔离符,或 trim 后空,或超 64 码元
- **那么** 必须以用法错误（退出码 2）拒绝,且**禁止**建账号 / 触达 repo 写

#### 场景:既有账号 add --label 不改 label
- **当** 对已存在账号执行 `account add … --label <名>`（走 update 分支,含 Gmail re-auth）
- **那么** 既有 `label` 必须不被改动（label 仅 create 分支写；改既有别名无本期入口、通知走 email 回落）

#### 场景:--label 不放松 account-id ASCII
- **当** 同一命令给出中文 `--label` 与 account-id
- **那么** account-id 仍必须经既有严格 ASCII 校验（`--label` 不影响主键校验）

#### 场景:--json 输出不含 label
- **当** `account add … --json`
- **那么** 机器可读输出字段必须仍为 `{id, provider, email, enabled}`（`label` 不进 `--json`）
