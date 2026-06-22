// 账号 id 派生（design 决策 2「accountId == MailAccount.id，单一解析器」）。
//
// `MailAccount` 是唯一账号真相源（不再从 env 读账号凭据；env-single `loadImapAccount` 已移除——
// 账号经 accountRegistry 从 DB enabled 行加载、凭据从 authJson 解出）。本文件只保留**确定性 id 派生**
// （CLI add 用，防命名空间分裂）：
//   - imap → `--account-id`（若给，对齐既有/自定义 id）否则确定性 `imap:<user>@<host>`。
//   - gmail → `gmail:<getProfile 邮箱仅小写>`（见 gmail-integration，后续组）。
//
// `ImapAccount` 连接参数类型已迁至 src/providers/provider.ts（createRealImapConnection /
// pollAccount 仍消费同一形状）。

/**
 * IMAP accountId 派生：显式 id（`--account-id`，对齐既有/自定义 id）优先，否则确定性派生
 * `imap:<user>@<host>`。确定性 = 同一 (user, host) 跨调用/跨重启恒一致（去重键命名空间稳定）。
 * CLI add 以此 id **主键 upsert**（同邮箱重加自然命中同一行、不分裂）。
 */
export function deriveAccountId(
  explicitId: string | undefined,
  user: string,
  host: string,
): string {
  return explicitId ?? `imap:${user}@${host}`;
}
