// 账号 onboarding CLI 离线单测（6.3，node:test）。注入 InMemoryMailRepo + 桩 prompt/OAuth + 捕获
// stdout/stderr；全离线、不连真 DB、不跑真 OAuth。
//
// 覆盖 tasks 6.3：
//   - account list 输出不含凭据；
//   - account add --imap 建行 id==派生/`--account-id`、email 非空、凭据写 authJson、不回显口令、
//     口令不取自 argv；
//   - 同 id 拒绝（默认 reject-on-exists）；--update 显式确认才更新；
//   - provider 校验（必须且仅一个 --imap/--gmail）；
//   - add --gmail upsert（re-auth/恢复路径，同 id 不拒绝）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  runAccountCli,
  EXIT_OK,
  EXIT_FAILURE,
  EXIT_USAGE,
  type CliDeps,
} from './account.js';
import { InMemoryMailRepo } from '../repo/inMemoryMailRepo.js';
import type { GmailAuthResult, GmailOAuthAppCredentials } from '../providers/gmail/oauth.js';

const IMAP_PW = 'SUPER_SECRET_PW';
const GMAIL_RT = 'SUPER_SECRET_RT';

/** 构造可注入 deps：捕获 stdout/stderr，桩 prompt/OAuth/gmailApp。 */
function makeDeps(
  repo: InMemoryMailRepo,
  overrides: Partial<CliDeps> & { promptValue?: string } = {},
): { deps: CliDeps; out: string[]; err: string[]; promptCalls: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const promptCalls: string[] = [];
  const deps: CliDeps = {
    repo,
    println: (l) => out.push(l),
    errln: (l) => err.push(l),
    promptHidden: async (label) => {
      promptCalls.push(label);
      return overrides.promptValue ?? IMAP_PW;
    },
    runOAuth: async (_app: GmailOAuthAppCredentials): Promise<GmailAuthResult> => ({
      email: 'user@gmail.com',
      refreshToken: GMAIL_RT,
      scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    }),
    gmailApp: () => ({ available: true, clientId: 'CID', clientSecret: 'CSEC' }),
    ...stripPromptValue(overrides),
  };
  return { deps, out, err, promptCalls };
}

function stripPromptValue(o: Partial<CliDeps> & { promptValue?: string }): Partial<CliDeps> {
  const { promptValue: _pv, ...rest } = o;
  return rest;
}

// ——————————————————————————————————————————————————————————
// account list：不含凭据
// ——————————————————————————————————————————————————————————

test('account list：输出含 id/provider/email/enabled，不含任何凭据明文', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'imap:me@example.com@imap.example.com',
    provider: 'imap',
    email: 'me@example.com',
    authJson: { host: 'imap.example.com', port: 993, user: 'me@example.com', password: IMAP_PW, tls: true },
  });
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: GMAIL_RT, scopes: [] },
  });

  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(['list'], deps);
  assert.equal(code, EXIT_OK);

  const text = out.join('\n');
  assert.ok(text.includes('imap:me@example.com@imap.example.com'), 'list 含 imap id');
  assert.ok(text.includes('gmail:user@gmail.com'), 'list 含 gmail id');
  assert.ok(text.includes('me@example.com') && text.includes('user@gmail.com'), 'list 含 email');
  assert.ok(text.includes('imap') && text.includes('gmail'), 'list 含 provider');
  // 绝不含任何凭据明文。
  assert.ok(!text.includes(IMAP_PW), 'list 不含 IMAP 口令');
  assert.ok(!text.includes(GMAIL_RT), 'list 不含 refresh token');
  assert.ok(!text.includes('authJson'), 'list 不打印 authJson');
});

test('account list：显示被禁用（enabled=false）的账号（运营者可见、据此重授权）', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: GMAIL_RT, scopes: [] },
  });
  await repo.setAccountEnabled('gmail:user@gmail.com', false); // reauth-suspend / 手动禁用

  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(['list'], deps);
  assert.equal(code, EXIT_OK);
  const text = out.join('\n');
  assert.ok(text.includes('gmail:user@gmail.com'), 'list 仍显示被禁用账号');
  assert.ok(text.includes('false'), 'enabled=false 可见');
  assert.ok(!text.includes(GMAIL_RT), 'list 不含 refresh token');
});

// ——————————————————————————————————————————————————————————
// account add --imap：建行 + 派生 id + email 非空 + 凭据写 authJson + 不回显 + 口令经 prompt
// ——————————————————————————————————————————————————————————

test('account add --imap：建行 id==派生、email 非空、凭据写 authJson、口令经 prompt 不回显', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, out, promptCalls } = makeDeps(repo);

  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'imap.example.com'],
    deps,
  );
  assert.equal(code, EXIT_OK);

  // 口令经交互 prompt 读取（一次）。
  assert.equal(promptCalls.length, 1, '口令经交互 prompt 读取');

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  // id == 确定性派生 imap:<user>@<host>。
  assert.equal(row.id, 'imap:me@example.com@imap.example.com');
  assert.equal(row.provider, 'imap');
  // email 非空。
  assert.ok(row.email.length > 0, 'email 非空');
  assert.equal(row.email, 'me@example.com');
  // 凭据写入 authJson。
  const auth = row.authJson as Record<string, unknown>;
  assert.equal(auth.password, IMAP_PW, '口令写 authJson');
  assert.equal(auth.host, 'imap.example.com');
  assert.equal(auth.user, 'me@example.com');
  assert.equal(auth.tls, true);
  assert.equal(auth.port, 993);

  // 不回显口令：任何 stdout 行都不含口令明文。
  assert.ok(!out.join('\n').includes(IMAP_PW), '口令不回显到 stdout');
});

test('account add --imap：--account-id 覆盖派生 id（对齐 legacy）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'imap.example.com', '--account-id', 'imap:legacy-custom'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows[0]!.id, 'imap:legacy-custom');
});

test('account add --imap：--email=a=b（值含 =）按首个 = 拆分、email==a=b（非机密内联 = flag 正常）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  // --email=a=b：首个 = 拆 key=email、value=a=b（值保留后续 =）；--host=h 亦内联。
  const code = await runAccountCli(['add', '--imap', '--email=a=b', '--host=h'], deps);
  assert.equal(code, EXIT_OK);
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.email, 'a=b', '--email=a=b 按首个 = 拆分 → email==a=b');
  assert.equal(row.id, 'imap:a=b@h', '派生 id 用 user(=email)@host');
  const auth = row.authJson as Record<string, unknown>;
  assert.equal(auth.user, 'a=b', 'user==a=b（值含 =）');
  assert.equal(auth.host, 'h', '内联 --host=h 正常解析');
});

test('account add --imap：--tls false + --port 自定义写入 authJson', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'h', '--port', '143', '--tls', 'false'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  const auth = (await repo.listEnabledAccounts())[0]!.authJson as Record<string, unknown>;
  assert.equal(auth.tls, false);
  assert.equal(auth.port, 143);
});

// ——————————————————————————————————————————————————————————
// 口令不取自 argv（硬约束）
// ——————————————————————————————————————————————————————————

test('account add --imap：口令经 argv --password 传入 → 拒绝（参数错误、不建行）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'h', '--password', 'LEAKED_VIA_ARGV'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '机密经 argv → 参数错误退出');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '未建任何行');
  // 错误提示不回显口令值。
  assert.ok(!err.join('\n').includes('LEAKED_VIA_ARGV'), '错误提示不回显 argv 口令值');
});

test('account add --imap：口令经 argv --password=value（等号内联）→ 同样拒绝（不建行、不回显）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'h', '--password=hunter2'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '--password=value 经 argv → 参数错误退出');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '未建任何行');
  assert.ok(!err.join('\n').includes('hunter2'), '错误提示不回显 argv 口令值');
});

test('account add --imap：--secret/--token/--refresh-token 经 argv 同样拒绝', async () => {
  const repo = new InMemoryMailRepo();
  for (const flag of ['--secret', '--token', '--refresh-token']) {
    const { deps } = makeDeps(repo);
    const code = await runAccountCli(
      ['add', '--imap', '--email', 'me@example.com', '--host', 'h', flag, 'X'],
      deps,
    );
    assert.equal(code, EXIT_USAGE, `${flag} 经 argv → 拒绝`);
  }
  assert.equal((await repo.listEnabledAccounts()).length, 0);
});

// ——————————————————————————————————————————————————————————
// 同 id 拒绝（默认 reject-on-exists）/ --update 显式确认
// ——————————————————————————————————————————————————————————

test('account add --imap：同派生 id 已存在 → 默认拒绝、不静默覆盖', async () => {
  const repo = new InMemoryMailRepo();
  await repo.createAccount({
    id: 'imap:me@example.com@imap.example.com',
    provider: 'imap',
    email: 'me@example.com',
    authJson: { host: 'imap.example.com', port: 993, user: 'me@example.com', password: 'OLD_PW', tls: true },
  });

  const { deps, err } = makeDeps(repo, { promptValue: 'NEW_PW' });
  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'imap.example.com'],
    deps,
  );
  assert.equal(code, EXIT_FAILURE, '同 id 默认拒绝');
  assert.ok(err.join('\n').includes('已存在'), '提示账号已存在');
  // 凭据未被覆盖（仍是 OLD_PW）。
  const auth = (await repo.listEnabledAccounts())[0]!.authJson as Record<string, unknown>;
  assert.equal(auth.password, 'OLD_PW', '不静默覆盖凭据');
});

test('account add --imap --update：同 id 显式确认 → 更新凭据（不分裂、命中同一行）', async () => {
  const repo = new InMemoryMailRepo();
  await repo.createAccount({
    id: 'imap:me@example.com@imap.example.com',
    provider: 'imap',
    email: 'me@example.com',
    authJson: { host: 'imap.example.com', port: 993, user: 'me@example.com', password: 'OLD_PW', tls: true },
  });

  const { deps } = makeDeps(repo, { promptValue: 'NEW_PW' });
  const code = await runAccountCli(
    ['add', '--imap', '--update', '--email', 'me@example.com', '--host', 'imap.example.com'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1, '同 id upsert 命中同一行、不分裂');
  assert.equal((rows[0]!.authJson as Record<string, unknown>).password, 'NEW_PW', '凭据已更新');
});

// ——————————————————————————————————————————————————————————
// provider 校验
// ——————————————————————————————————————————————————————————

test('account add：缺 provider → 参数错误', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--email', 'me@example.com', '--host', 'h'], deps);
  assert.equal(code, EXIT_USAGE);
  assert.equal((await repo.listEnabledAccounts()).length, 0);
});

test('account add：同时 --imap --gmail → 参数错误', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--imap', '--gmail'], deps);
  assert.equal(code, EXIT_USAGE);
});

test('account add --imap：缺 --host → 参数错误', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--imap', '--email', 'me@example.com'], deps);
  assert.equal(code, EXIT_USAGE);
});

test('account add --imap：缺 --email → 参数错误', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--imap', '--host', 'h'], deps);
  assert.equal(code, EXIT_USAGE);
});

// ——————————————————————————————————————————————————————————
// account add --gmail：upsert（re-auth/恢复路径，不拒绝），存 refresh token，不回显
// ——————————————————————————————————————————————————————————

test('account add --gmail：跑 OAuth → 建行 id=gmail:<email>、存 refresh token、enabled=true、不回显', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(['add', '--gmail'], deps);
  assert.equal(code, EXIT_OK);

  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.id, 'gmail:user@gmail.com');
  assert.equal(row.provider, 'gmail');
  assert.equal(row.email, 'user@gmail.com');
  assert.equal(row.enabled, true);
  assert.equal((row.authJson as Record<string, unknown>).refreshToken, GMAIL_RT, 'refresh token 写 authJson');
  // 不回显 refresh token。
  assert.ok(!out.join('\n').includes(GMAIL_RT), 'refresh token 不回显');
});

test('account add --gmail：同 id 已存在 → upsert 新 refresh token（不拒绝、re-auth）', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: 'OLD_RT', scopes: [] },
  });

  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--gmail'], deps);
  assert.equal(code, EXIT_OK, '同 id 不拒绝（区别于 --imap）');
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1, 'upsert 命中同一行、不分裂');
  assert.equal((rows[0]!.authJson as Record<string, unknown>).refreshToken, GMAIL_RT, '覆盖为新 refresh token');
});

test('account add --gmail：re-auth 一个被禁用账号 → 打印「正在重新启用」提示（getAccountById 实现）', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: 'OLD_RT', scopes: [] },
  });
  await repo.setAccountEnabled('gmail:user@gmail.com', false); // 此前被禁用 / reauth-suspend

  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(['add', '--gmail'], deps);
  assert.equal(code, EXIT_OK);
  const text = out.join('\n');
  assert.ok(text.includes('重新启用'), 're-auth 翻转禁用行时打印重新启用提示');
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1, 're-auth upsert 置 enabled=true');
  assert.equal((rows[0]!.authJson as Record<string, unknown>).refreshToken, GMAIL_RT, '覆盖为新 refresh token');
});

test('account add --gmail：re-auth 一个已启用账号 → 不打印「正在重新启用」提示', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: 'OLD_RT', scopes: [] },
  }); // enabled=true

  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(['add', '--gmail'], deps);
  assert.equal(code, EXIT_OK);
  assert.ok(!out.join('\n').includes('重新启用'), '已启用账号 re-auth 不误报重新启用');
});

test('account add --gmail：onboarding 不可用（缺 app 凭据）→ 业务失败、不跑 OAuth', async () => {
  const repo = new InMemoryMailRepo();
  let oauthCalled = false;
  const { deps, err } = makeDeps(repo, {
    gmailApp: () => ({ available: false }),
    runOAuth: async () => {
      oauthCalled = true;
      throw new Error('should-not-run');
    },
  });
  const code = await runAccountCli(['add', '--gmail'], deps);
  assert.equal(code, EXIT_FAILURE);
  assert.equal(oauthCalled, false, '不可用时不跑 OAuth');
  assert.ok(err.join('\n').includes('onboarding'), '提示 onboarding 不可用');
});

test('account add --gmail：OAuth 失败 → 业务失败、只记固定 kind、不泄露', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo, {
    runOAuth: async () => {
      throw new Error('gmail-oauth-no-refresh-token');
    },
  });
  const code = await runAccountCli(['add', '--gmail'], deps);
  assert.equal(code, EXIT_FAILURE);
  assert.equal((await repo.listEnabledAccounts()).length, 0, '失败不建行');
  assert.ok(err.join('\n').includes('gmail-oauth-no-refresh-token'), '记固定 kind 串');
});

// ——————————————————————————————————————————————————————————
// account disable：置 enabled=false + staleness 提示
// ——————————————————————————————————————————————————————————

test('account disable <id>：置 enabled=false + 提示重启', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: GMAIL_RT, scopes: [] },
  });

  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(['disable', 'gmail:user@gmail.com'], deps);
  assert.equal(code, EXIT_OK);
  assert.equal((await repo.listEnabledAccounts()).length, 0, '已禁用、不再加载');
  const text = out.join('\n');
  assert.ok(text.includes('重启'), '提示未重启不生效 / 应重启');
});

test('account disable：缺 id → 参数错误', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  assert.equal(await runAccountCli(['disable'], deps), EXIT_USAGE);
});

// ——————————————————————————————————————————————————————————
// 未知命令 / help
// ——————————————————————————————————————————————————————————

test('未知命令 → 参数错误 + 用法', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  assert.equal(await runAccountCli(['bogus'], deps), EXIT_USAGE);
});
