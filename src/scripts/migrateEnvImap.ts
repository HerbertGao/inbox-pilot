// 一次性迁移：P3 的 env-IMAP 单账号 → MailAccount 注册表行（tasks 7.1、design 决策 8）。
//
// 直接读 config（即 process.env 的 IMAP_*），**不**经已在 group B 移除的 `loadImapAccount`——
// 直接读更稳健（脚本不依赖被删的加载器，且 IMAP_* 仍在 config 中可解析，见下方 ponytail 备注）。
//
// 连续性保证（硬约束「重启不重复处理」）：MailAccount.id 必须 = P3 实际 accountId =
// `deriveAccountId(IMAP_ACCOUNT_ID, user, host)`——若操作者设过 IMAP_ACCOUNT_ID 则沿用该显式值，
// 否则确定性 `imap:<user>@<host>`。如此去重键 `(accountId, providerMessageId)` 与游标命名空间
// 与迁移前 `mail_messages.accountId` 完全一致，历史邮件不被重处理。
//
// 幂等：经 upsertAccount（主键 upsert）写一行——重跑命中同一行、不分裂、安全。
//
// 凭据纪律（logger.ts 安全约定 + spec「凭据不入日志」）：env 凭据写入 authJson（整体 redact），
// **绝不**把口令 / authJson 整体记入日志；脱敏日志只记 `{accountId, email}`（accountId/email
// 视作低敏运营标识，见 design 风险条）。
//
// ponytail: 迁移后 IMAP_* env 变量即不再被用作账号凭据来源（账号已落 MailAccount.authJson），
// 对已迁移部署而言可从环境移除；config.ts 仍保留这些键供本脚本与迁移中部署解析（group A 已标弃用），
// 待一轮兼容期后在未来版本从 config 删除（此处不删，删则破坏 config 测试 + 拖累未迁移部署）。

import { config } from '../config/config.js';
import { logger } from '../logger.js';
import { deriveAccountId } from '../accounts/accountService.js';
import { PrismaMailRepo, type MailRepo } from '../repo/mailRepo.js';

/**
 * env-IMAP 迁移所需的最小输入（直接取自 config / process.env 的 IMAP_*）。
 * 单独成型使迁移核心 `migrateEnvImap` 离线可测（注入内存 repo + 显式 env 形状，不连真 DB）。
 */
export type EnvImapInput = {
  host?: string;
  port: number;
  user?: string;
  password?: string;
  tls: boolean;
  accountId?: string;
};

/** 迁移结果（供调用方/测试断言）。 */
export type MigrateResult =
  | { migrated: false; reason: 'no-imap-host' }
  | { migrated: true; accountId: string; email: string };

/**
 * 迁移核心（可注入 repo + env 输入，离线可测）：
 *   - IMAP_HOST 未设 → 记「无可迁移」并干净返回（不写任何行）。
 *   - 否则经 upsertAccount 写一条 `provider='imap'` 行：
 *       id    = deriveAccountId(IMAP_ACCOUNT_ID, user, host)（= P3 实际 accountId，连续性保证）
 *       email = user@host（best-effort denormalization）
 *       authJson = { host, port, user, password, tls }（env 凭据；整体 redact、绝不明文入日志）
 *   - 幂等：upsert 主键命中同一行（重跑安全）。
 *
 * 凭据绝不入日志（只记脱敏 {accountId, email}）。
 */
export async function migrateEnvImap(
  repo: MailRepo,
  env: EnvImapInput,
): Promise<MigrateResult> {
  const host = env.host;
  if (host === undefined || host.length === 0) {
    // IMAP_HOST 未设：无 P3 env 账号可迁移——干净退出（不写、不报错）。
    logger.info('migrateEnvImap: 未设 IMAP_HOST，无可迁移的 env-IMAP 账号');
    return { migrated: false, reason: 'no-imap-host' };
  }

  // user：best-effort（缺省回落空串，仍构造确定性 id / email）；password 缺省回落空串。
  // 这些是 P3 env 单账号的同一形状，迁移忠实搬运（不另做校验——加载期由 accountRegistry 校验跳过）。
  const user = env.user ?? '';
  const password = env.password ?? '';

  // 连续性：id = P3 实际 accountId（honor IMAP_ACCOUNT_ID）——getting it wrong reprocesses history。
  const accountId = deriveAccountId(env.accountId, user, host);
  // email：NOT NULL，best-effort。user 已是完整邮箱（含 @）则原样用，避免 me@x.com@host 的重复。
  const email = user.includes('@') ? user : `${user}@${host}`;

  // 凭据写 authJson（整体 redact）；upsert 幂等（主键命中同一行、不分裂）。
  await repo.upsertAccount({
    id: accountId,
    provider: 'imap',
    email,
    authJson: { host, port: env.port, user, password, tls: env.tls },
    enabled: true,
  });

  // 脱敏日志：只记 {accountId, email}，绝不记 authJson / 口令。
  logger.info({ accountId, email }, 'migrateEnvImap: 已将 env-IMAP 账号迁入 MailAccount 注册表');
  return { migrated: true, accountId, email };
}

/** 从 config（process.env 的 IMAP_*）取迁移输入（真身入口用）。 */
function envInputFromConfig(): EnvImapInput {
  return {
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    user: config.IMAP_USER,
    password: config.IMAP_PASSWORD,
    tls: config.IMAP_TLS,
    accountId: config.IMAP_ACCOUNT_ID,
  };
}

// 真身入口：`tsx src/scripts/migrateEnvImap.ts` / `node dist/scripts/migrateEnvImap.js`。
// import.meta 主模块判定（ESM）：仅当本文件被直接运行时执行迁移（被 import 时不跑，使测试纯净）。
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const repo = new PrismaMailRepo();
  try {
    await migrateEnvImap(repo, envInputFromConfig());
    process.exit(0);
  } catch (err) {
    // 凭据纪律：**绝不**记 err.message/cause（Prisma 写失败 message 可回显内嵌 authJson 的 IMAP
    // 口令）——只记固定 kind 串 + 标量 code。
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined;
    logger.error(
      { kind: 'migrate-env-imap-failed', code },
      'migrateEnvImap 失败（只记 code，不记 message——可能内嵌凭据）',
    );
    process.exit(1);
  }
}
