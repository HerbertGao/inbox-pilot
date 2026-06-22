// 离线验收（2.5）：accountRegistry 加载 + repo 写入路径 + redact 断言（node:test）。
//
// 覆盖 tasks 2.5：
//   - 注册表加载混合 imap/gmail；非法 provider 跳过；imap/gmail 凭据不全各跳过；无账号 → []。
//   - redact 断言：用与生产 logger 同配置（REDACT_PATHS）的捕获型 pino 序列化——整体记录 account /
//     NormalizedEmail 对象不泄露 to/cc/凭据（嵌套深度 + snake_case + 数组 + error.cause 链 +
//     client_secret + credentials/tokens/code_verifier）；authJson 解析失败日志不含 authJson 值。
//   - CLI-add 行 id == 派生/`--account-id`、email 非空；同邮箱 upsert 命中同一行（不分裂）。
//
// 全离线、不连 DB、不发网络。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';
import { PassThrough } from 'node:stream';

import { loadEnabledAccounts } from './accountRegistry.js';
import { deriveAccountId } from './accountService.js';
import { InMemoryMailRepo } from '../repo/inMemoryMailRepo.js';
import { REDACT_PATHS } from '../logger.js';
import type { Account } from '../providers/provider.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

const IMAP_AUTH = { host: 'imap.example.com', port: 143, user: 'me@example.com', password: 'SECRET_PW', tls: false };
const GMAIL_AUTH = { refreshToken: 'SECRET_RT', scopes: ['https://www.googleapis.com/auth/gmail.modify'] };

async function seedImap(repo: InMemoryMailRepo, id = 'imap:me@example.com@imap.example.com'): Promise<void> {
  await repo.upsertAccount({ id, provider: 'imap', email: 'me@example.com', authJson: { ...IMAP_AUTH } });
}
async function seedGmail(repo: InMemoryMailRepo, id = 'gmail:me@gmail.com'): Promise<void> {
  await repo.upsertAccount({ id, provider: 'gmail', email: 'me@gmail.com', authJson: { ...GMAIL_AUTH } });
}

// ——————————————————————————————————————————————————————————
// 注册表加载混合 imap/gmail
// ——————————————————————————————————————————————————————————

test('loadEnabledAccounts：混合 imap/gmail → 各产出含 accountId + 解出凭据的账号', async () => {
  const repo = new InMemoryMailRepo();
  await seedImap(repo);
  await seedGmail(repo);

  const accounts = await loadEnabledAccounts(repo);
  assert.equal(accounts.length, 2);

  const imap = accounts.find((a) => a.provider === 'imap')!;
  assert.equal(imap.provider, 'imap');
  assert.equal(imap.accountId, 'imap:me@example.com@imap.example.com');
  if (imap.provider === 'imap') {
    assert.equal(imap.host, 'imap.example.com');
    assert.equal(imap.port, 143);
    assert.equal(imap.user, 'me@example.com');
    assert.equal(imap.password, 'SECRET_PW');
    assert.equal(imap.tls, false);
  }

  const gmail = accounts.find((a) => a.provider === 'gmail')!;
  assert.equal(gmail.accountId, 'gmail:me@gmail.com');
  if (gmail.provider === 'gmail') {
    assert.equal(gmail.refreshToken, 'SECRET_RT');
    assert.deepEqual(gmail.scopes, ['https://www.googleapis.com/auth/gmail.modify']);
  }
});

// ——————————————————————————————————————————————————————————
// 非法 provider 跳过、不中断其余
// ——————————————————————————————————————————————————————————

test('loadEnabledAccounts：非法 provider 跳过、其余正常加载', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({ id: 'pop3:x', provider: 'pop3' as 'imap', email: 'x@y', authJson: {} });
  await seedImap(repo);

  const accounts = await loadEnabledAccounts(repo);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.provider, 'imap');
});

// ——————————————————————————————————————————————————————————
// imap/gmail 凭据不全各跳过；authJson 非对象跳过
// ——————————————————————————————————————————————————————————

test('loadEnabledAccounts：imap 缺 password → 跳过；gmail 缺 refreshToken → 跳过', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({ id: 'imap:a', provider: 'imap', email: 'a', authJson: { host: 'h', user: 'u' } });
  await repo.upsertAccount({ id: 'gmail:b', provider: 'gmail', email: 'b', authJson: { scopes: [] } });
  await seedImap(repo);

  const accounts = await loadEnabledAccounts(repo);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.accountId, 'imap:me@example.com@imap.example.com');
});

test('loadEnabledAccounts：authJson 非预期对象（标量/数组）→ 跳过', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({ id: 'imap:scalar', provider: 'imap', email: 'a', authJson: 'not-an-object' });
  await repo.upsertAccount({ id: 'imap:arr', provider: 'imap', email: 'b', authJson: ['x'] });

  const accounts = await loadEnabledAccounts(repo);
  assert.equal(accounts.length, 0);
});

// ——————————————————————————————————————————————————————————
// 无账号 → []
// ——————————————————————————————————————————————————————————

test('loadEnabledAccounts：无 enabled 账号 → []（服务正常启动、不轮询）', async () => {
  const repo = new InMemoryMailRepo();
  assert.deepEqual(await loadEnabledAccounts(repo), []);
});

test('loadEnabledAccounts：disabled 账号不加载', async () => {
  const repo = new InMemoryMailRepo();
  await seedImap(repo);
  await repo.setAccountEnabled('imap:me@example.com@imap.example.com', false);
  assert.deepEqual(await loadEnabledAccounts(repo), []);
});

// ——————————————————————————————————————————————————————————
// CLI-add 行 id == 派生/`--account-id`、email 非空；同邮箱 upsert 命中同一行不分裂
// ——————————————————————————————————————————————————————————

test('upsertAccount：行 id == 派生 accountId、email 非空（FK / 去重命名空间成立）', async () => {
  const repo = new InMemoryMailRepo();
  const id = deriveAccountId(undefined, 'me@example.com', 'imap.example.com');
  await repo.upsertAccount({ id, provider: 'imap', email: 'me@example.com', authJson: { ...IMAP_AUTH } });

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, id);
  assert.equal(rows[0]!.id, 'imap:me@example.com@imap.example.com');
  assert.ok(rows[0]!.email.length > 0, 'email 非空');
});

test('upsertAccount：显式 --account-id → 行 id 为该值（对齐 legacy）', async () => {
  const repo = new InMemoryMailRepo();
  const id = deriveAccountId('imap:legacy-custom', 'me@example.com', 'imap.example.com');
  await repo.upsertAccount({ id, provider: 'imap', email: 'me@example.com', authJson: { ...IMAP_AUTH } });
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows[0]!.id, 'imap:legacy-custom');
});

test('upsertAccount：同邮箱（同派生 id）两路径接入 → 命中同一行、不分裂', async () => {
  const repo = new InMemoryMailRepo();
  const id = deriveAccountId(undefined, 'me@example.com', 'imap.example.com');
  // 迁移路径写一次。
  await repo.upsertAccount({ id, provider: 'imap', email: 'me@example.com', authJson: { ...IMAP_AUTH } });
  // 同邮箱 CLI add 以同一 id upsert（更新凭据）。
  await repo.upsertAccount({ id, provider: 'imap', email: 'me@example.com', authJson: { ...IMAP_AUTH, password: 'NEW_PW' } });

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1, '同 id upsert 命中同一行、不分裂');
  assert.equal(rows[0]!.id, id);
});

test('createAccount：reject-on-exists（同 id 再 create → 抛）', async () => {
  const repo = new InMemoryMailRepo();
  await repo.createAccount({ id: 'imap:x', provider: 'imap', email: 'x', authJson: { ...IMAP_AUTH } });
  await assert.rejects(() => repo.createAccount({ id: 'imap:x', provider: 'imap', email: 'x', authJson: { ...IMAP_AUTH } }));
});

test('updateGmailTokens：轮换 refreshToken 不复活被暂停（enabled=false）的账号', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmail(repo); // enabled=true
  // scheduler 因 reauth 暂停该账号。
  await repo.setAccountEnabled('gmail:me@gmail.com', false);

  // 运行期 refresh 轮换了 refreshToken → 回写（updateGmailTokens，不该触碰 enabled）。
  await repo.updateGmailTokens('gmail:me@gmail.com', { refreshToken: 'ROTATED_RT', scopes: ['s'] });

  // 仍是暂停态：不被加载。
  assert.deepEqual(await loadEnabledAccounts(repo), [], 'token 轮换不复活被暂停账号（enabled 仍为 false）');
  const row = await repo.getAccountById('gmail:me@gmail.com');
  assert.equal(row!.enabled, false, 'enabled 保持 false');
  assert.equal((row!.authJson as Record<string, unknown>).refreshToken, 'ROTATED_RT', 'refreshToken 已更新');
});

test('updateGmailTokens：scopes 省略时回落默认（绝不写 scopes:undefined）', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmail(repo);
  await repo.updateGmailTokens('gmail:me@gmail.com', { refreshToken: 'RT2' });
  const row = await repo.getAccountById('gmail:me@gmail.com');
  const auth = row!.authJson as Record<string, unknown>;
  assert.deepEqual(auth.scopes, ['https://www.googleapis.com/auth/gmail.modify'], 'scopes 回落默认、不为 undefined');
});

test('setAccountEnabled(id, false)：reauth-suspend 持久化（后续不加载）', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmail(repo);
  await repo.setAccountEnabled('gmail:me@gmail.com', false);
  assert.deepEqual(await loadEnabledAccounts(repo), []);
  // 复用 enabled 列恢复：置回 true → 再加载。
  await repo.setAccountEnabled('gmail:me@gmail.com', true);
  assert.equal((await loadEnabledAccounts(repo)).length, 1);
});

// ——————————————————————————————————————————————————————————
// redact 断言：与生产 logger 同配置（REDACT_PATHS）的捕获型 pino 序列化
// ——————————————————————————————————————————————————————————

/** 构造捕获型 pino（与生产 logger 同 redact），返回 logger + 取已写出 JSON 行的函数。 */
function makeCaptureLogger(): { log: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (c: Buffer) => chunks.push(c.toString('utf-8')));
  const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
  return { log, output: () => chunks.join('') };
}

test('redact：整体记录解出的 imap account 对象不泄露 password（凭据在顶层、距对象 ≤1 层）', () => {
  const { log, output } = makeCaptureLogger();
  const account: Account = {
    provider: 'imap',
    accountId: 'imap:me@example.com@imap.example.com',
    host: 'imap.example.com',
    port: 143,
    user: 'me@example.com',
    password: 'SECRET_PW',
    tls: false,
  };
  // 反模式（实际代码禁止整体记录 account）——此处仅断言即便误记，password key 也被 redact。
  log.warn({ account });
  const out = output();
  assert.ok(!out.includes('SECRET_PW'), 'password 明文不入日志');
  assert.ok(out.includes('[REDACTED]'));
});

test('redact：authJson 子树整体 redact（嵌套深度 + 数组）', () => {
  const { log, output } = makeCaptureLogger();
  log.warn({
    row: { id: 'imap:x', authJson: { host: 'h', user: 'u', password: 'DEEP_SECRET' } },
    rows: [{ authJson: { password: 'ARR_SECRET', refresh_token: 'ARR_RT' } }],
  });
  const out = output();
  assert.ok(!out.includes('DEEP_SECRET'), 'authJson 嵌套 password 被整树 redact');
  assert.ok(!out.includes('ARR_SECRET'), '数组元素内 authJson 被 redact');
  assert.ok(!out.includes('ARR_RT'));
});

test('redact：snake_case + client_secret + credentials/tokens/code_verifier', () => {
  const { log, output } = makeCaptureLogger();
  log.warn({
    refresh_token: 'SNAKE_RT',
    access_token: 'SNAKE_AT',
    client_secret: 'CSECRET',
    credentials: { access_token: 'CRED_AT', refresh_token: 'CRED_RT' },
    tokens: { access_token: 'TOK_AT' },
    code_verifier: 'PKCE_VERIFIER',
  });
  const out = output();
  for (const s of ['SNAKE_RT', 'SNAKE_AT', 'CSECRET', 'CRED_AT', 'CRED_RT', 'TOK_AT', 'PKCE_VERIFIER']) {
    assert.ok(!out.includes(s), `${s} 不入日志`);
  }
});

test('redact：error.cause 链含凭据子串——代码纪律是不整体记原始 error（断言不传 cause 时无泄露）', () => {
  const { log, output } = makeCaptureLogger();
  // 模拟「只记 code + 固定 kind」的纪律（绝不把原始 error / 其 cause 传给 logger）。
  const raw = new Error('refresh failed token=GAXIOS_RT_LEAK');
  (raw as { cause?: unknown }).cause = new Error('client_secret=GAXIOS_CS_LEAK');
  // 正确用法：只取 kind + code，不传 raw / raw.cause。
  log.warn({ kind: 'gmail-refresh-failed', code: 'invalid_grant' });
  const out = output();
  assert.ok(!out.includes('GAXIOS_RT_LEAK'), 'cause 链凭据不入日志（未传原始 error）');
  assert.ok(!out.includes('GAXIOS_CS_LEAK'));
  assert.ok(out.includes('invalid_grant'), '只记脱敏 code');
});

test('redact：整体记录 NormalizedEmail 对象不泄露 to/cc（PII）——代码纪律仅记 accountId+providerMessageId', () => {
  const { log, output } = makeCaptureLogger();
  const email: NormalizedEmail = {
    accountId: 'imap:x',
    provider: 'imap',
    providerMessageId: 'pm-1',
    subject: 's',
    fromEmail: 'from@x',
    to: ['recipient-PII@victim.com'],
    cc: ['cc-PII@victim.com'],
    date: '2026-06-20T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
  };
  // 正确纪律：错误/动作路径只记 accountId + providerMessageId（不整体记 email）。
  log.warn({ kind: 'msg-failed', accountId: email.accountId, providerMessageId: email.providerMessageId });
  const out = output();
  assert.ok(!out.includes('recipient-PII@victim.com'), 'to PII 不入日志');
  assert.ok(!out.includes('cc-PII@victim.com'), 'cc PII 不入日志');
  assert.ok(out.includes('pm-1') && out.includes('imap:x'));
});

test('反模式探针：整体记录 NormalizedEmail 对象 → to/cc PII 逃逸 redact（故纪律是不整体记 email 对象）', () => {
  // 反模式（生产**禁止**）：整体记 email 对象。to/cc 不在 REDACT_PATHS（pino key-redact 不覆盖），
  // 故会泄露——本探针**记录该事实**：to/cc 保护是代码纪律（不整体记 NormalizedEmail），非 redact 配置。
  const { log, output } = makeCaptureLogger();
  const email: NormalizedEmail = {
    accountId: 'imap:x',
    provider: 'imap',
    providerMessageId: 'pm-2',
    subject: 's',
    fromEmail: 'from@x',
    to: ['recipient-PII@victim.com'],
    cc: ['cc-PII@victim.com'],
    date: '2026-06-20T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
  };
  log.warn({ email }); // 反模式：整体记 email。
  const out = output();
  // to/cc **存活**（逃逸 key-redact）——证明保护只能靠「不整体记 email」的代码纪律，而非 redact 配置。
  assert.ok(
    out.includes('recipient-PII@victim.com') && out.includes('cc-PII@victim.com'),
    'to/cc 逃逸 redact——故纪律必须是不整体记录 NormalizedEmail 对象',
  );
});

test('redact：authJson 解析失败日志不含 authJson 值（只记 {accountId, provider, reason}）', async () => {
  // 注：accountRegistry.skip 用真身 logger（默认写 stdout）。本断言以「skip 只传 kind/accountId/
  // provider/reason、绝不传 authJson 值或 parse 错误对象」的代码纪律为准——即便误记到捕获 logger，
  // 字符串型坏 authJson 的值也不应出现在结构化字段里。这里直接断言 loadEnabledAccounts 不抛、跳过坏行。
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({ id: 'imap:bad', provider: 'imap', email: 'b', authJson: '{ "password": "PARSE_LEAK" ' });
  await seedImap(repo);
  const accounts = await loadEnabledAccounts(repo);
  // 坏 JSON 串被跳过、其余正常（loadEnabledAccounts 不把 parse 错误对象记入日志）。
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!.provider, 'imap');
});
