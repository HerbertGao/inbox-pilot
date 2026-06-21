// 账号加载（design 决策 1：env 是配置真相源，DB 仅存一行锚定）。
//
// 从 config 读单 IMAP 账号，产出供轮询/标已读使用的连接参数与一个**跨重启稳定**的
// accountId（去重键依赖）。accountId 取 IMAP_ACCOUNT_ID（若配置），否则确定性派生
// `imap:<user>@<host>`（含 user，会进日志——要干净 id 就设 IMAP_ACCOUNT_ID）。
//
// 配置完整性（spec「需求:IMAP 账号加载与持久化锚定」§配置完整性）：
//   - IMAP_HOST 缺失 → 返回 null（IMAP 为可选 provider，禁用而非崩溃）。
//   - IMAP_HOST 已设而 IMAP_USER/IMAP_PASSWORD 缺失 → fail-fast 抛配置错误
//     （不静默降级、不产出 `imap:undefined@host` 之类残缺 accountId）。
// 该跨字段校验属 **accountService 层**，不在 config 层（config 仅解析 optional）。
//
// 口令仅在此内存对象（字段名 password，已在 logger redact 名单），绝不写入 DB 锚定行。

import type { Config } from '../config/config.js';
import { config as defaultConfig } from '../config/config.js';

/** 加载出的 IMAP 账号连接参数（口令仅在内存，字段名 password 受 logger redact）。 */
export type ImapAccount = {
  accountId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
};

/** IMAP 配置不完整（host 有而凭据缺）时抛出，fail-fast 终止该账号加载。 */
export class ImapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImapConfigError';
  }
}

/**
 * 从 config 加载至多一个 IMAP 账号。
 * - IMAP_HOST 缺失 → 返回 null（禁用 IMAP，正常启动其余部分）。
 * - IMAP_HOST 已设但凭据缺 → 抛 ImapConfigError（不返回残缺账号）。
 * - 配置齐全 → 返回 ImapAccount，accountId 跨重启稳定。
 */
export function loadImapAccount(config: Config = defaultConfig): ImapAccount | null {
  const host = config.IMAP_HOST;
  if (host === undefined) {
    // IMAP 为可选 provider：缺 host 即禁用，不报错（调用方记一条信息日志、正常启动）。
    return null;
  }

  const user = config.IMAP_USER;
  const password = config.IMAP_PASSWORD;
  if (user === undefined || password === undefined) {
    // host 已设而凭据缺：fail-fast，绝不产出残缺 accountId 或反复发起注定失败的连接。
    throw new ImapConfigError(
      'IMAP_HOST 已设置，但 IMAP_USER / IMAP_PASSWORD 缺失：拒绝产出残缺 IMAP 账号（请补全凭据或清空 IMAP_HOST 以禁用 IMAP）',
    );
  }

  return {
    accountId: deriveAccountId(config.IMAP_ACCOUNT_ID, user, host),
    host,
    port: config.IMAP_PORT,
    user,
    password,
    tls: config.IMAP_TLS,
  };
}

/**
 * accountId 派生：显式 IMAP_ACCOUNT_ID 优先，否则确定性派生 `imap:<user>@<host>`。
 * 确定性 = 同一 (user, host) 跨调用/跨重启恒一致（去重键命名空间稳定）。
 */
export function deriveAccountId(
  explicitId: string | undefined,
  user: string,
  host: string,
): string {
  return explicitId ?? `imap:${user}@${host}`;
}
