// Provider 抽象（spec account-registry「需求:Provider 抽象统一两种 provider」、design 决策 3）。
//
// 两层 seam：
//   - **poller**（scheduler 面向，per-account/per-poll 构造）：`poll()` 取新邮件 → 收敛 →
//     processEmail，注入本轮 repo + ProviderActions。本文件定义其类型 `MailProvider`。
//   - **`ProviderActions`**（动作 sink，executeActions 持有，由 `pollOnce` 在本轮连接内构造注入）：
//     `markRead` / `reflectPriority`——定义在 src/actions/providerActions.ts（沿用 P3 seam）。
//
// 本文件还放：账号级致命错误 `ProviderReauthRequired`、IMAP 连接参数 `ImapAccount`、统一 `Account`。
//
// 凭据纪律（spec「凭据不入日志」）：凭据字段（password/refreshToken）距任何被记录对象 ≤1 层、
// 解出凭据的对象绝不整体入日志；`ProviderReauthRequired` 只携 `{accountId, kind}`，绝不挂原始
// GaxiosError 作 `cause`（否则 cause 链泄露 token，key-redact 清不掉字符串内嵌凭据）。

/**
 * scheduler 面向的 poller seam（per-account/per-poll 构造）。
 * `poll()`：取新邮件 → NormalizedEmail → processEmail（注入本轮 repo + ProviderActions）。
 * IMAP 由 pollAccount/pollOnce 实现，Gmail 由 gmailPoller 实现（后续组）。
 */
export type MailProvider = {
  /** 执行一轮轮询。失败语义见各实现；账号级致命错误抛 ProviderReauthRequired。 */
  poll(): Promise<void>;
};

/**
 * 账号级致命错误 kind（需重授权）。区别于发送态瞬时失败：
 *   - `reauth-required`：token 撤销 / scope 漂移 / refresh 失败等账号级失效。
 */
export type ProviderReauthKind = 'reauth-required';

/**
 * 账号级致命错误：需重授权（token 撤销 / scope 403 / refresh 失败）。
 *
 * **只携 `{accountId, kind}`**——绝不把原始 GaxiosError 挂作 `cause`（cause 链会重新内嵌
 * `refresh_token`/`client_secret`/bearer 子串，pino 的 key-redact 清不掉字符串内嵌凭据，见
 * logger.ts 安全约定）。上游（executeActions 重抛 → scheduler per-account guard）按 instanceof /
 * kind 判定，suspend 该账号 + setAccountEnabled(false)，不当发送态瞬时失败吞掉。
 */
export class ProviderReauthRequired extends Error {
  readonly accountId: string;
  readonly kind: ProviderReauthKind;
  constructor(accountId: string, kind: ProviderReauthKind = 'reauth-required') {
    // message 只放固定 kind 串（零凭据插值）；不接受 cause（防 token 泄露）。
    super(kind);
    this.name = 'ProviderReauthRequired';
    this.accountId = accountId;
    this.kind = kind;
  }
}

/**
 * IMAP 账号连接参数（从 `MailAccount.authJson` 解出；口令仅在内存）。
 * 字段名 `password` 在 logger redact 名单——但**禁止整体记录本对象**（深层嵌套会逃逸 `*.password`
 * 的单层覆盖），凭据字段须距任何被记录对象 ≤1 层。
 * 从 accountService 迁来此处：createRealImapConnection / pollAccount 仍消费同一形状。
 */
export type ImapAccount = {
  /** = MailAccount.id（去重键命名空间 + 游标落点）。 */
  accountId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
};

/**
 * Gmail 账号连接参数（从 `MailAccount.authJson` 解出；refreshToken 仅在内存）。
 * 字段名 `refreshToken` 在 logger redact 名单——但同 ImapAccount，**禁止整体记录本对象**。
 */
export type GmailAccount = {
  /** = MailAccount.id（`gmail:<email>`）。 */
  accountId: string;
  /** OAuth refresh token（运行期换 access token、不长存 access token）。 */
  refreshToken: string;
  /** 授权 scope（恰等 `{gmail.modify}`，见 gmail-integration）。 */
  scopes?: string[];
};

/**
 * 统一账号判别联合（registry 加载产物）。`provider` 判别字段；凭据字段距本对象 ≤1 层
 * （`password`/`refreshToken` 直接在 ImapAccount/GmailAccount 顶层）——**绝不整体记录**
 * （registry 加载日志只记 `{accountId, provider}`）。
 */
export type Account =
  | ({ provider: 'imap' } & ImapAccount)
  | ({ provider: 'gmail' } & GmailAccount);
