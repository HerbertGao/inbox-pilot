// 离线验收（组 §3.3）：accountService 账号加载 + DB 锚定 call-shape（node:test）。
//
// 关键 seam 纪律：
//   - 用 configSchema.parse 构造 Config 注入 loadImapAccount（不触碰 import 时 frozen config，
//     参照 config.test.ts 直接对 schema parse/safeParse 的范式）。
//   - 锚定 call-shape 用 InMemoryMailRepo.anchorUpsertCalls spy 断言
//     where.id === create.id === accountId 且 authJson === {}——无需真库即在 CI 捕获
//     id≠accountId / authJson=null 回归（FK 列约束真测随 prisma 真测在 T7.2 验证）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configSchema, type Config } from '../config/config.js';
import {
  deriveAccountId,
  ImapConfigError,
  loadImapAccount,
} from './accountService.js';
import { InMemoryMailRepo } from '../repo/inMemoryMailRepo.js';

const DB = 'postgresql://u:p@localhost:5432/db';

function makeConfig(overrides: Record<string, string> = {}): Config {
  return configSchema.parse({ DATABASE_URL: DB, ...overrides });
}

test('loadImapAccount：配置齐全 → 产出连接参数 + 派生 accountId', () => {
  const account = loadImapAccount(
    makeConfig({
      IMAP_HOST: 'imap.example.com',
      IMAP_PORT: '143',
      IMAP_USER: 'me@example.com',
      IMAP_PASSWORD: 'secret',
      IMAP_TLS: 'false',
    }),
  );
  assert.notEqual(account, null);
  assert.equal(account!.accountId, 'imap:me@example.com@imap.example.com');
  assert.equal(account!.host, 'imap.example.com');
  assert.equal(account!.port, 143);
  assert.equal(account!.user, 'me@example.com');
  assert.equal(account!.password, 'secret');
  assert.equal(account!.tls, false);
});

test('loadImapAccount：IMAP_ACCOUNT_ID 显式 → 用作 accountId（覆盖派生）', () => {
  const account = loadImapAccount(
    makeConfig({
      IMAP_HOST: 'imap.example.com',
      IMAP_USER: 'me@example.com',
      IMAP_PASSWORD: 'secret',
      IMAP_ACCOUNT_ID: 'imap:custom-id',
    }),
  );
  assert.equal(account!.accountId, 'imap:custom-id');
});

test('loadImapAccount：派生 accountId 跨调用一致且稳定（去重键命名空间稳定）', () => {
  const cfg = makeConfig({
    IMAP_HOST: 'imap.example.com',
    IMAP_USER: 'me@example.com',
    IMAP_PASSWORD: 'secret',
  });
  const a = loadImapAccount(cfg)!;
  const b = loadImapAccount(cfg)!;
  assert.equal(a.accountId, b.accountId);
  // 同一 (user, host) 派生恒一致（与 loadImapAccount 内部一致）。
  assert.equal(
    a.accountId,
    deriveAccountId(undefined, 'me@example.com', 'imap.example.com'),
  );
  // 不同 (user, host) → 不同命名空间。
  assert.notEqual(
    deriveAccountId(undefined, 'me@example.com', 'imap.example.com'),
    deriveAccountId(undefined, 'other@example.com', 'imap.example.com'),
  );
});

test('loadImapAccount：缺 IMAP_HOST → 返回 null（禁用 IMAP，不报错）', () => {
  assert.equal(loadImapAccount(makeConfig()), null);
  // 有凭据但缺 host 仍返回 null（host 缺即禁用，凭据不触发加载）。
  assert.equal(
    loadImapAccount(
      makeConfig({ IMAP_USER: 'me@example.com', IMAP_PASSWORD: 'secret' }),
    ),
    null,
  );
});

test('loadImapAccount：host 有而缺 IMAP_USER → 抛 ImapConfigError（不返回残缺账号）', () => {
  assert.throws(
    () =>
      loadImapAccount(
        makeConfig({ IMAP_HOST: 'imap.example.com', IMAP_PASSWORD: 'secret' }),
      ),
    ImapConfigError,
  );
});

test('loadImapAccount：host 有而缺 IMAP_PASSWORD → 抛 ImapConfigError（不返回残缺账号）', () => {
  assert.throws(
    () =>
      loadImapAccount(
        makeConfig({ IMAP_HOST: 'imap.example.com', IMAP_USER: 'me@example.com' }),
      ),
    ImapConfigError,
  );
});

test('loadImapAccount：fail-fast 不产出 `imap:undefined@host` 之类残缺 accountId', () => {
  // 凭据缺时必须抛错而非返回残缺账号——断言绝不返回含 undefined 的 accountId。
  let caught: unknown = null;
  try {
    loadImapAccount(makeConfig({ IMAP_HOST: 'imap.example.com' }));
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ImapConfigError);
});

test('ensureAccountAnchor：upsert call-shape where.id === create.id === accountId 且 authJson === {}', async () => {
  const repo = new InMemoryMailRepo();
  const account = loadImapAccount(
    makeConfig({
      IMAP_HOST: 'imap.example.com',
      IMAP_USER: 'me@example.com',
      IMAP_PASSWORD: 'secret',
    }),
  )!;

  await repo.ensureAccountAnchor({
    accountId: account.accountId,
    email: account.user,
  });

  assert.equal(repo.anchorUpsertCalls.length, 1);
  const args = repo.anchorUpsertCalls[0];
  // (a) where.id === create.id === accountId（覆盖 @default(cuid())、FK 成立的硬要求）。
  assert.equal(args.where.id, account.accountId);
  assert.equal(args.create.id, account.accountId);
  assert.equal(args.where.id, args.create.id);
  // (b) authJson 为非空空对象 {}（置 null 会触发 NOT NULL 违约；口令绝不入此行）。
  assert.deepEqual(args.create.authJson, {});
  assert.notEqual(args.create.authJson, null);
  assert.equal(args.create.provider, 'imap');
  assert.equal(args.create.enabled, true);
  // email 为 denormalization（best-effort），upsert update 留空（已存行不改）。
  assert.equal(args.create.email, 'me@example.com');
  assert.deepEqual(args.update, {});
});

test('ensureAccountAnchor：重复启动幂等（不报错、不重置游标）', async () => {
  const repo = new InMemoryMailRepo();
  const anchor = { accountId: 'imap:me@example.com@imap.example.com', email: 'me@example.com' };

  await repo.ensureAccountAnchor(anchor);
  await repo.setCursor(anchor.accountId, '42:100');
  // 第二次启动（崩溃重启路径）：幂等、不抛、不覆盖已存游标。
  await repo.ensureAccountAnchor(anchor);

  assert.equal(repo.anchorUpsertCalls.length, 2);
  assert.equal(await repo.getCursor(anchor.accountId), '42:100');
});

test('getCursor / setCursor：读写 lastSyncCursor（无锚定/未设 → null）', async () => {
  const repo = new InMemoryMailRepo();
  // 未锚定 → null。
  assert.equal(await repo.getCursor('imap:x@y'), null);

  await repo.ensureAccountAnchor({ accountId: 'imap:x@y', email: 'x' });
  // 锚定后未设游标 → null。
  assert.equal(await repo.getCursor('imap:x@y'), null);

  await repo.setCursor('imap:x@y', '7:55');
  assert.equal(await repo.getCursor('imap:x@y'), '7:55');
  // 覆盖写。
  await repo.setCursor('imap:x@y', '7:60');
  assert.equal(await repo.getCursor('imap:x@y'), '7:60');
});
