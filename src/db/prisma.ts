import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * DB 侧语句超时（anti-wedge，design D7）：run() 的 raceTimeout 只封 gmail/notify 调用，**不**封
 * loadEnabledAccounts / findByDedupKey dedup 扫描 / setAccountEnabled 等未竞速的 prisma 查询——某个
 * hung 的 Postgres 查询会楔死整个 run 永占 active-lock（reaper 只回收崩溃）。给连接串附
 * `statement_timeout` 让**每一条**查询都在 DB 侧有上界（无需逐调用点包 raceTimeout）。
 */
const DB_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * 给 Postgres 连接串附 `options=-c statement_timeout=<ms>`（libpq options；Prisma postgres 连接串支持
 * `options` 参数）。合并既有查询串（`?schema=...` 等保留）；已含 statement_timeout 则幂等不重复附加。
 * 空格/等号在 URL 查询值里须 percent-encode（`%20`/`%3D`）——避免 URLSearchParams 把空格编成 `+`
 * （tokio-postgres 不把 `+` 当空格）而破坏 options 值。
 */
export function withStatementTimeout(url: string): string {
  if (url.includes('statement_timeout')) {
    return url; // 已设，不重复附加。
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}options=-c%20statement_timeout%3D${DB_STATEMENT_TIMEOUT_MS}`;
}

const databaseUrl = process.env.DATABASE_URL;

// Singleton PrismaClient cached on globalThis to avoid leaking connections
// across dev hot-reloads. Lazy connection: no $connect() at module load or
// startup — the connection is established on first query, so service startup
// does not depend on database reachability. DATABASE_URL 存在时附 statement_timeout；
// 缺省（如离线测试）则走 schema env、构造行为不变。
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient(
    databaseUrl !== undefined ? { datasourceUrl: withStatementTimeout(databaseUrl) } : undefined,
  );

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
