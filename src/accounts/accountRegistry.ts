// 账号注册表加载（spec account-registry「需求:从注册表加载多账号」「统一 authJson 凭据模型」、
// design 决策 1/2）。
//
// `loadEnabledAccounts(repo)`：读所有 enabled `MailAccount` 行 → 按 provider 解 authJson →
// 产出 `Account`（accountId = MailAccount.id，凭据从 authJson 解出、仅在内存）。
//   - provider ∉ {imap,gmail} → 跳过 + 记错（不中断其余账号加载）。
//   - imap 缺 host/user/password、gmail 缺 refreshToken、authJson 非预期对象 → 跳过 + 记错。
//   - 无 enabled 账号 → 返回 []（服务正常启动、仅不轮询）。
//
// 凭据纪律（spec「凭据不入日志」）：**跳过日志只记 `{accountId, provider, reason}`**——绝不记
// authJson 值、绝不记 `JSON.parse` 错误对象（其 `.message` 会回显含凭据的输入子串，key-redact
// 清不掉字符串内嵌的凭据）。产出的 `Account` 对象凭据在顶层字段、距本对象 ≤1 层、绝不整体记录。

import { logger } from '../logger.js';
import type { MailRepo, StoredAccount } from '../repo/mailRepo.js';
import type { Account, ImapAccount, GmailAccount } from '../providers/provider.js';

/** 跳过原因 kind（结构化、零凭据插值；记日志只用 kind、不用任何输入值/错误对象）。 */
type SkipReason =
  | 'unknown-provider'
  | 'authjson-not-object'
  | 'authjson-parse-failed'
  | 'imap-incomplete-credentials'
  | 'gmail-incomplete-credentials';

/**
 * 加载所有 enabled 账号并解出凭据。无效行跳过 + 记错（只 `{accountId, provider, reason}`）。
 * 无 enabled 账号 → []（调用方据此「服务正常启动、不轮询」）。
 */
export async function loadEnabledAccounts(repo: MailRepo): Promise<Account[]> {
  const rows = await repo.listEnabledAccounts();
  const accounts: Account[] = [];
  for (const row of rows) {
    const account = parseAccount(row);
    if (account !== null) {
      accounts.push(account);
    }
  }
  return accounts;
}

/** 把一行 StoredAccount 解为 Account；无效返回 null（已记跳过日志）。 */
function parseAccount(row: StoredAccount): Account | null {
  if (row.provider !== 'imap' && row.provider !== 'gmail') {
    skip(row, 'unknown-provider');
    return null;
  }

  // authJson 可能是已解析对象（Prisma Json 列直返对象 / InMemory 直存对象）或字符串（边界兜底）。
  const authJson = coerceAuthJson(row);
  if (authJson === undefined) {
    // coerceAuthJson 内已记对应跳过日志（parse-failed / not-object）。
    return null;
  }

  if (row.provider === 'imap') {
    return parseImap(row, authJson);
  }
  return parseGmail(row, authJson);
}

/**
 * 归一 authJson 为非空对象（非数组）。
 * - 字符串 → JSON.parse（失败记 'authjson-parse-failed'、**绝不记 parse 错误对象/值**）。
 * - 标量 / 数组 / null → 记 'authjson-not-object'。
 * - 对象 → 直接返回。
 */
function coerceAuthJson(row: StoredAccount): Record<string, unknown> | undefined {
  let value: unknown = row.authJson;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // 绝不把 JSON.parse 的错误对象传给 logger（其 .message 回显含凭据的输入子串）。
      skip(row, 'authjson-parse-failed');
      return undefined;
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    skip(row, 'authjson-not-object');
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseImap(row: StoredAccount, authJson: Record<string, unknown>): Account | null {
  const host = authJson.host;
  const user = authJson.user;
  const password = authJson.password;
  if (!isNonEmptyString(host) || !isNonEmptyString(user) || !isNonEmptyString(password)) {
    skip(row, 'imap-incomplete-credentials');
    return null;
  }
  const port = typeof authJson.port === 'number' && Number.isFinite(authJson.port) ? authJson.port : 993;
  const tls = typeof authJson.tls === 'boolean' ? authJson.tls : true;
  // processFrom 显式枚举进字面量（本字面量非 `...row` 展开，不写则下游 spread 凭空丢失水位线）。
  const imap: ImapAccount = { accountId: row.id, host, port, user, password, tls, processFrom: row.processFrom };
  return { provider: 'imap', ...imap };
}

function parseGmail(row: StoredAccount, authJson: Record<string, unknown>): Account | null {
  const refreshToken = authJson.refreshToken;
  if (!isNonEmptyString(refreshToken)) {
    skip(row, 'gmail-incomplete-credentials');
    return null;
  }
  // processFrom 显式枚举进字面量（同 parseImap：本字面量非 `...row` 展开）。
  const gmail: GmailAccount = { accountId: row.id, refreshToken, processFrom: row.processFrom };
  const scopes = authJson.scopes;
  if (Array.isArray(scopes) && scopes.every((s) => typeof s === 'string')) {
    gmail.scopes = scopes as string[];
  }
  return { provider: 'gmail', ...gmail };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 跳过 + 记错：**只记 `{accountId, provider, reason}`**（accountId 是低敏运营标识，可入日志）。 */
function skip(row: StoredAccount, reason: SkipReason): void {
  logger.warn(
    { kind: 'account-registry-skip', accountId: row.id, provider: row.provider, reason },
    '账号注册表加载跳过该行（凭据/provider 不合规），其余账号正常加载',
  );
}
