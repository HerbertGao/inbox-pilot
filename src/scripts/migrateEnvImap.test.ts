// env-IMAP 迁移离线单测（tasks 7.2，node:test）。注入 InMemoryMailRepo + 显式 env 输入；
// 全离线、不连真 DB。
//
// 覆盖 tasks 7.2 验证意图：
//   - 迁移后该行 id == deriveAccountId(IMAP_ACCOUNT_ID, user, host)（IMAP_ACCOUNT_ID 设/未设两种）
//     → 去重键/游标命名空间 == 迁移前 mail_messages.accountId（不重处理历史）；
//   - 重跑迁移幂等（upsert 命中同一行、不分裂）；
//   - 同邮箱后续 `account add --imap --account-id <id>` 对齐同一 id（不分裂）；
//   - IMAP_HOST 未设 → 不迁移、不建行；
//   - 凭据写 authJson（口令不丢）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrateEnvImap, type EnvImapInput } from './migrateEnvImap.js';
import { deriveAccountId } from '../accounts/accountService.js';
import { InMemoryMailRepo } from '../repo/inMemoryMailRepo.js';

const IMAP_PW = 'SUPER_SECRET_PW';

/** P3 env 单账号的典型形状（user@host 无 legacy IMAP_ACCOUNT_ID）。 */
function baseEnv(overrides: Partial<EnvImapInput> = {}): EnvImapInput {
  return {
    host: 'imap.example.com',
    port: 993,
    user: 'me@example.com',
    password: IMAP_PW,
    tls: true,
    accountId: undefined,
    ...overrides,
  };
}

// ——————————————————————————————————————————————————————————
// id == deriveAccountId：IMAP_ACCOUNT_ID 未设（确定性 imap:<user>@<host>）
// ——————————————————————————————————————————————————————————

test('迁移（无 IMAP_ACCOUNT_ID）：行 id == deriveAccountId(undefined,user,host) == imap:<user>@<host>', async () => {
  const repo = new InMemoryMailRepo();
  const env = baseEnv();
  const result = await migrateEnvImap(repo, env);

  const expectedId = deriveAccountId(undefined, env.user!, env.host!);
  assert.equal(expectedId, 'imap:me@example.com@imap.example.com');

  assert.deepEqual(result, {
    migrated: true,
    accountId: expectedId,
    // user 含 @（完整邮箱）→ email 原样用 user（不再 doubled me@x.com@host）。
    email: 'me@example.com',
  });

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  // 去重键/游标命名空间锚点：行 id 必须 == 迁移前 mail_messages.accountId（= deriveAccountId）。
  assert.equal(row.id, expectedId, '行 id == P3 实际 accountId（去重键连续）');
  assert.equal(row.provider, 'imap');
  assert.ok(row.email.length > 0, 'email 非空');
  assert.equal(row.enabled, true);

  // 凭据写 authJson（口令不丢）。
  const auth = row.authJson as Record<string, unknown>;
  assert.equal(auth.host, 'imap.example.com');
  assert.equal(auth.port, 993);
  assert.equal(auth.user, 'me@example.com');
  assert.equal(auth.password, IMAP_PW, '口令写 authJson');
  assert.equal(auth.tls, true);
});

test('迁移：user 不含 @ → email 回落 user@host（旧 best-effort 形态）', async () => {
  const repo = new InMemoryMailRepo();
  const result = await migrateEnvImap(repo, baseEnv({ user: 'bareuser' }));
  assert.equal(result.migrated, true);
  assert.equal(result.migrated && result.email, 'bareuser@imap.example.com', 'user 无 @ → user@host');
});

// ——————————————————————————————————————————————————————————
// id == deriveAccountId：IMAP_ACCOUNT_ID 已设（honor 显式 legacy 值）
// ——————————————————————————————————————————————————————————

test('迁移（有 IMAP_ACCOUNT_ID）：行 id == 该 legacy 显式值（honor、不派生）', async () => {
  const repo = new InMemoryMailRepo();
  const legacyId = 'legacy-custom-account-id';
  const env = baseEnv({ accountId: legacyId });
  const result = await migrateEnvImap(repo, env);

  const expectedId = deriveAccountId(legacyId, env.user!, env.host!);
  assert.equal(expectedId, legacyId, 'deriveAccountId 沿用显式 IMAP_ACCOUNT_ID');

  assert.equal(result.migrated, true);
  assert.equal(result.migrated && result.accountId, legacyId);

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  // 连续性硬约束：legacy 账号 id 由迁移独占设为 P3 实际 accountId（= IMAP_ACCOUNT_ID）。
  assert.equal(rows[0]!.id, legacyId, '行 id == legacy IMAP_ACCOUNT_ID（去重键连续，不重处理历史）');
});

// ——————————————————————————————————————————————————————————
// 重跑幂等（upsert 命中同一行、不分裂）
// ——————————————————————————————————————————————————————————

test('迁移重跑：幂等（upsert 命中同一行、不分裂）', async () => {
  const repo = new InMemoryMailRepo();
  const env = baseEnv();

  const r1 = await migrateEnvImap(repo, env);
  const r2 = await migrateEnvImap(repo, env);

  assert.equal(r1.migrated, true);
  assert.equal(r2.migrated, true);
  assert.equal(r1.migrated && r1.accountId, r2.migrated && r2.accountId, '两次 id 一致');

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1, '重跑不分裂，仍只有一行');
});

test('迁移重跑：游标在两次迁移间保持（upsert 不重置已播种游标）', async () => {
  const repo = new InMemoryMailRepo();
  const env = baseEnv();

  const r1 = await migrateEnvImap(repo, env);
  assert.equal(r1.migrated, true);
  const accountId = r1.migrated ? r1.accountId : '';
  // 模拟迁移后轮询写过游标。
  await repo.setCursor(accountId, 'cursor-after-poll');

  // 重跑迁移（重启再迁移）：游标不应被重置。
  await migrateEnvImap(repo, env);
  assert.equal(await repo.getCursor(accountId), 'cursor-after-poll', '重跑迁移不重置游标');
});

// ——————————————————————————————————————————————————————————
// 同邮箱后续 CLI add --account-id 对齐同一 id（不分裂）
// ——————————————————————————————————————————————————————————

test('迁移后 CLI add --account-id 对齐：同一 id upsert 命中同一行、不分裂', async () => {
  const repo = new InMemoryMailRepo();
  const legacyId = 'legacy-custom-account-id';
  const env = baseEnv({ accountId: legacyId });
  await migrateEnvImap(repo, env);

  // 后续 `account add --imap --account-id legacy-custom-account-id`（写入路径同 upsert，同一 id）。
  const cliId = deriveAccountId(legacyId, env.user!, env.host!);
  assert.equal(cliId, legacyId);
  await repo.upsertAccount({
    id: cliId,
    provider: 'imap',
    email: 'me@example.com',
    authJson: { host: env.host, port: env.port, user: env.user, password: 'ROTATED_PW', tls: env.tls },
    enabled: true,
  });

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1, 'CLI add --account-id 对齐同一 id、不分裂');
  assert.equal(rows[0]!.id, legacyId);
  // 同一行被 CLI 更新（凭据轮换），命名空间不变。
  assert.equal((rows[0]!.authJson as Record<string, unknown>).password, 'ROTATED_PW');
});

// ——————————————————————————————————————————————————————————
// IMAP_HOST 未设 → 不迁移、不建行
// ——————————————————————————————————————————————————————————

test('迁移：IMAP_HOST 未设 → 不迁移、不建任何行', async () => {
  const repo = new InMemoryMailRepo();
  const result = await migrateEnvImap(repo, baseEnv({ host: undefined }));
  assert.deepEqual(result, { migrated: false, reason: 'no-imap-host' });
  assert.equal((await repo.listEnabledAccounts()).length, 0, '无可迁移 → 不建行');
});

test('迁移：IMAP_HOST 空串 → 不迁移、不建任何行', async () => {
  const repo = new InMemoryMailRepo();
  const result = await migrateEnvImap(repo, baseEnv({ host: '' }));
  assert.deepEqual(result, { migrated: false, reason: 'no-imap-host' });
  assert.equal((await repo.listEnabledAccounts()).length, 0);
});
