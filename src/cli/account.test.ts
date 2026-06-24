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

test('account add：含裸位置参数 → 参数错误（防机密误作位置参数落 argv/history）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'h', 'STRAY_SECRET'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '裸位置参数 → 参数错误');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '未建任何行');
  assert.ok(!err.join('\n').includes('STRAY_SECRET'), '不回显位置参数值');
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

test('account add --imap：createAccount 因存储/网络失败（非重复）→ 报「新增失败」非「已存在」、不泄露', async () => {
  const repo = new InMemoryMailRepo();
  // 写入抛错但该 id 并不存在（getAccountById 返回 null）：模拟 DB/网络写失败，非重复。
  repo.createAccount = async () => {
    throw new Error('postgresql://u:SECRET_PW@h/db connection refused');
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '--email', 'me@example.com', '--host', 'h'],
    deps,
  );
  assert.equal(code, EXIT_FAILURE);
  const text = err.join('\n');
  assert.ok(text.includes('新增失败'), '非重复写失败 → 报「新增失败」');
  assert.ok(!text.includes('已存在'), '不误报「已存在」');
  assert.ok(!text.includes('SECRET_PW'), '不泄露原始 error（含连接串口令）');
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

test('account add：无 provider 标志 → 打开交互菜单（注入 promptChoice 选 imap）→ 建行（反转旧 USAGE 契约）', async () => {
  const repo = new InMemoryMailRepo();
  const choicePrompts: string[] = [];
  const { deps } = makeDeps(repo, {
    promptChoice: async (label, choices) => {
      choicePrompts.push(`${label}:${choices.join(',')}`);
      return 'imap';
    },
  });
  const code = await runAccountCli(['add', '--email', 'me@example.com', '--host', 'h'], deps);
  assert.equal(code, EXIT_OK, '无 provider → 菜单选 imap → 建行（不再 EXIT_USAGE）');
  assert.equal(choicePrompts.length, 1, '触发了一次 provider 选择菜单');
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1, '据菜单所选 provider 建 imap 行');
  assert.equal(rows[0]!.provider, 'imap');
  assert.equal(rows[0]!.id, 'imap:me@example.com@h');
});

test('裸 account（无子命令） / runAccountCli([]) → USAGE 退出 2（菜单仅在 add 无 provider 时触发）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  // 无子命令（command === undefined）：仍打印 USAGE、退出 2，绝不触发交互菜单。
  assert.equal(await runAccountCli([], deps), EXIT_USAGE);
  assert.equal((await repo.listEnabledAccounts()).length, 0, '裸命令不建任何行');
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

test('F-C：disable a b（多余位置参数）→ EXIT_USAGE、不静默只禁用 a 丢弃 b', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'a',
    provider: 'gmail',
    email: 'a@gmail.com',
    authJson: { refreshToken: GMAIL_RT, scopes: [] },
  });
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(['disable', 'a', 'b'], deps);
  assert.equal(code, EXIT_USAGE, '多余位置参数 → 参数错误');
  assert.ok(err.join('\n').includes('一个 id'), '提示需且仅需一个 id');
  // a 未被静默禁用（恰好一个 id 校验在写之前拒绝）。
  const row = await repo.getAccountById('a');
  assert.equal(row?.enabled, true, '校验失败时不静默禁用 a');
});

test('disable --json x（任意 flag）→ EXIT_USAGE、精确报「不接受任何 flag」（防 <id> 被 --json 吞掉误报缺 id）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(['disable', '--json', 'x'], deps);
  assert.equal(code, EXIT_USAGE, 'disable 带 flag → 参数错误');
  assert.ok(err.join('\n').includes('不接受任何 flag'), '精确报「不接受任何 flag」');
});

test('disable --foo（未知 flag）→ EXIT_USAGE、精确报「不接受任何 flag」', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(['disable', '--foo'], deps);
  assert.equal(code, EXIT_USAGE, 'disable 带未知 flag → 参数错误');
  assert.ok(err.join('\n').includes('不接受任何 flag'), '精确报「不接受任何 flag」');
});

// ——————————————————————————————————————————————————————————
// 未知命令 / help
// ——————————————————————————————————————————————————————————

test('未知命令 → 参数错误 + 用法', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  assert.equal(await runAccountCli(['bogus'], deps), EXIT_USAGE);
});

// ——————————————————————————————————————————————————————————
// 顶层脱敏错误边界：未捕获的 repo 异常 → EXIT_FAILURE + 固定文案、不泄露原始 error
// ——————————————————————————————————————————————————————————

test('runAccountCli：命令抛出（如 list 的 repo 故障）→ EXIT_FAILURE + 脱敏文案、不泄露连接串/凭据', async () => {
  const repo = new InMemoryMailRepo();
  // list 路径无内层 try/catch；repo 故障须由顶层边界脱敏接住（含连接串口令子串）。
  repo.listAccounts = async () => {
    throw new Error('postgresql://u:SECRET_PW@h/db connection lost');
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(['list'], deps);
  assert.equal(code, EXIT_FAILURE, '未捕获异常 → 业务失败退出（不崩、不静默成功）');
  const text = err.join('\n');
  assert.ok(text.includes('命令执行失败'), '顶层脱敏文案');
  assert.ok(!text.includes('SECRET_PW'), '不把原始 error（含连接串口令子串）打到 stderr');
});

// ——————————————————————————————————————————————————————————
// §2 account-id 校验（最终值锚定）：非法显式 id / 派生路径注入被拒，错误信息不回显原始控制字符
// ——————————————————————————————————————————————————————————

test('§2.3 --account-id 含控制字符（\\n）→ 拒绝（EXIT_USAGE）、错误信息不含原始控制字符、不建行', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--account-id', 'evil\nINJECTED'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '含换行的 --account-id → 参数错误');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '非法 id 不建任何行');
  const text = err.join('\n');
  // 错误信息绝不含原始控制字符（须经转义渲染）：捕获行内不出现裸 \n 注入的「INJECTED」独立行。
  assert.ok(!text.includes('evil\nINJECTED'), '错误信息不原样回显含裸控制字符的违规值');
  // JSON.stringify 转义后 \n 变为字面量 \\n，故转义形态可出现。
  assert.ok(text.includes('evil\\nINJECTED'), '违规值经 JSON 转义渲染（\\n 字面量）');
});

test('§2.4 --account-id "" 空串 → 拒绝（EXIT_USAGE）（?? 视 "" 为已定义、不走派生，空显式 id 须被拒）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--account-id', ''],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '空串 --account-id → 参数错误');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '空 id 不建任何行');
});

test('§2.5 --host 含控制字符（\\n）无显式 --account-id → 派生 id 终值校验被拒（EXIT_USAGE）、create 未调用', async () => {
  const repo = new InMemoryMailRepo();
  let createCalled = false;
  repo.createAccount = async () => {
    createCalled = true;
    throw new Error('should-not-be-called');
  };
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--imap', '-e', 'me@ex.com', '-H', 'h\nINJECTED'], deps);
  assert.equal(code, EXIT_USAGE, '含控制字符的 --host 经派生终值校验被拒');
  assert.equal(createCalled, false, '在任何写之前被拒（create 未调用）');
});

test('§2.6 --email=a=b -H h → 派生 imap:a=b@h 被接受（= 在字符集内）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--imap', '--email=a=b', '-H', 'h'], deps);
  assert.equal(code, EXIT_OK, '含 = 的合法派生 id 被接受');
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 'imap:a=b@h');
});

// ——————————————————————————————————————————————————————————
// §4 --json 输出：账号新增结果走字段白名单、绝无凭据字段
// ——————————————————————————————————————————————————————————

test('§4.3 account add --imap --json → stdout 输出可解析、仅白名单字段、绝无 authJson/password/token/refresh', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--json'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  // stdout 应只含一行可解析 JSON 对象（数据走 stdout、人类行走 stderr）。
  const stdout = out.join('\n');
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), ['email', 'enabled', 'id', 'provider']);
  assert.equal(parsed.id, 'imap:me@ex.com@h');
  assert.equal(parsed.provider, 'imap');
  assert.equal(parsed.email, 'me@ex.com');
  assert.equal(parsed.enabled, true);
  // 绝无任何凭据字段 / 凭据值子串。
  for (const forbidden of ['authJson', 'password', 'token', 'refresh']) {
    assert.ok(!stdout.toLowerCase().includes(forbidden), `--json 输出不含 ${forbidden}`);
  }
  assert.ok(!stdout.includes(IMAP_PW), '--json 输出不含口令值');
});

// ——————————————————————————————————————————————————————————
// §5.2 --tls / --no-tls 冲突解析（查 values + bools 两桶、消除静默忽略）
// ——————————————————————————————————————————————————————————

test('§5.2 --tls true + --no-tls（值分歧）→ EXIT_USAGE', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--tls', 'true', '--no-tls'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '--tls true 与 --no-tls 真实值分歧 → 参数错误');
  assert.equal((await repo.listEnabledAccounts()).length, 0);
});

test('§5.2 --tls false + --no-tls（一致对）→ 接受、tls=false', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--tls', 'false', '--no-tls'],
    deps,
  );
  assert.equal(code, EXIT_OK, '一致对被接受');
  const auth = (await repo.listEnabledAccounts())[0]!.authJson as Record<string, unknown>;
  assert.equal(auth.tls, false);
});

test('§5.2 值缺位的 --tls --no-tls → 不被静默忽略、由 --no-tls 置 tls=false', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  // 值缺位的 --tls（下一 token --no-tls 以 - 开头）落入 bools；须两桶都查、不静默保留 TLS。
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--tls', '--no-tls'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  const auth = (await repo.listEnabledAccounts())[0]!.authJson as Record<string, unknown>;
  assert.equal(auth.tls, false, '值缺位 --tls --no-tls → --no-tls 优先 tls=false（不静默忽略）');
});

test('§5.2 --no-tls 单独 → tls=false', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--no-tls'], deps);
  assert.equal(code, EXIT_OK);
  const auth = (await repo.listEnabledAccounts())[0]!.authJson as Record<string, unknown>;
  assert.equal(auth.tls, false);
});

// ——————————————————————————————————————————————————————————
// §6.7 --password-stdin：无 TTY 完成接入、含合法首尾空格的口令逐字保留（仅减一个尾换行）
// ——————————————————————————————————————————————————————————

test('§6.7 --password-stdin（注入 stdin read 返回 "  p@ss \\n"）→ 口令逐字保留 "  p@ss "（仅减一尾换行）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps } = makeDeps(repo, {
    stdin: { isTTY: false, read: async () => '  p@ss \n' },
    // promptHidden 不应被调用（走 stdin 来源）；若被调用返回哨兵值便于断言失败。
    promptHidden: async () => 'SHOULD_NOT_BE_USED',
  });
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--password-stdin'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  const rows = await repo.listEnabledAccounts();
  assert.equal(rows.length, 1);
  const auth = rows[0]!.authJson as Record<string, unknown>;
  // 首尾空格逐字保留，仅剥一个尾随换行。
  assert.equal(auth.password, '  p@ss ', '口令逐字保留首尾空格、仅减一尾换行');
});

// ——————————————————————————————————————————————————————————
// F1：机密 flag 在路由前对**所有**子命令统一拒绝（不止 add）；F7：归一词根匹配（分隔符/大小写变体）
// ——————————————————————————————————————————————————————————

test('F1：list --password SECRET → 路由前拒绝（参数错误、不回显机密值）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(['list', '--password', 'SECRET'], deps);
  assert.equal(code, EXIT_USAGE, 'list 子命令也拒绝机密 flag');
  assert.ok(!err.join('\n').includes('SECRET'), '不回显机密值');
});

test('F1：disable <id> --password SECRET → 路由前拒绝（不禁用、不回显机密值）', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: GMAIL_RT, scopes: [] },
  });
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['disable', 'gmail:user@gmail.com', '--password', 'SECRET'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, 'disable 子命令也拒绝机密 flag');
  assert.ok(!err.join('\n').includes('SECRET'), '不回显机密值');
  // 行仍为 enabled=true（未被禁用，因路由前已拒）。
  const row = await repo.getAccountById('gmail:user@gmail.com');
  assert.equal(row?.enabled, true, '路由前拒绝 → 未执行禁用');
});

test('F7：归一词根匹配 → --refreshToken / --access-token / --client-secret 经 argv 均拒绝', async () => {
  const repo = new InMemoryMailRepo();
  for (const flag of ['--refreshToken', '--access-token', '--client-secret', '--PASSWORD', '--pw']) {
    const { deps } = makeDeps(repo);
    const code = await runAccountCli(
      ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', flag, 'X'],
      deps,
    );
    assert.equal(code, EXIT_USAGE, `${flag} 经 argv → 拒绝`);
  }
  assert.equal((await repo.listEnabledAccounts()).length, 0);
});

test('F-A：复合机密 flag 名（分段命中机密词根）经 argv 均拒绝（封堵 exact-Set.has 复合名漏洞）', async () => {
  const repo = new InMemoryMailRepo();
  // 复合/分隔符/大小写变体：任一分段命中机密词根 → 拒绝（exact normalize+Set.has 会漏掉这些）。
  const forbidden = [
    '--password',
    '--imap-password',
    '--imapPassword',
    '--db-password',
    '--access-token',
    '--refreshToken',
    '--client-secret',
    '--PW',
    '--user_secret',
    // F-3：无边界粘连机密名（单段，分段检测漏掉、子串带兜住）。
    '--mypassword',
    '--apikey',
    '--api-key',
    '--oauthtoken',
    '--passphrase',
    '--credential',
  ];
  for (const flag of forbidden) {
    const { deps, err } = makeDeps(repo);
    const code = await runAccountCli(
      ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', flag, 'LEAKED'],
      deps,
    );
    assert.equal(code, EXIT_USAGE, `${flag}（含机密分段）经 argv → 拒绝`);
    assert.ok(!err.join('\n').includes('LEAKED'), `${flag}：不回显机密值`);
  }
  assert.equal((await repo.listEnabledAccounts()).length, 0, '任一机密 flag 都不建行');
});

test('F-A：非机密 flag（含 password-stdin/password-file 白名单 + 普通 flag）不被分段检测误拒', async () => {
  const repo = new InMemoryMailRepo();
  // --password-stdin / --password-file 走口令来源放行；其余非机密 flag 不含机密分段、均放行。
  // 用 --json + 各 flag 单跑 add，断言不因机密检测被 EXIT_USAGE 误拒（缺值类 flag 走各自校验路径）。

  // 白名单：--password-stdin（裸布尔、走 stdin 来源）→ 建行成功。
  {
    const { deps } = makeDeps(repo, {
      stdin: { isTTY: false, read: async () => 'pw\n' },
      promptHidden: async () => 'SHOULD_NOT_BE_USED',
    });
    const code = await runAccountCli(
      ['add', '--imap', '-e', 'a@ex.com', '-H', 'h1', '--password-stdin'],
      deps,
    );
    assert.equal(code, EXIT_OK, '--password-stdin 白名单放行');
  }

  // 普通非机密 flag 串（--account-id/--no-tls/--port/--json/--update 等）：不被机密检测拦截。
  {
    const { deps } = makeDeps(repo);
    const code = await runAccountCli(
      ['add', '--imap', '-e', 'b@ex.com', '-H', 'h2', '-p', '143', '--no-tls', '--account-id', 'imap:custom-b', '--json'],
      deps,
    );
    assert.equal(code, EXIT_OK, '普通非机密 flag 串不被机密检测误拒');
    const row = await repo.getAccountById('imap:custom-b');
    assert.equal(row?.id, 'imap:custom-b');
  }
});

test('F-3：子串带不过度拒绝 → 合法 flag（含子串接近词根的 --account-id 等）不被以机密为由拒绝', async () => {
  const repo = new InMemoryMailRepo();
  // 这些归一名均不含任一长机密词根子串：经子串带后仍不触发「禁经命令行参数」机密拒绝。
  // 注：用 `list`（机密守卫在路由前对所有子命令统一跑）隔离机密守卫行为，不掺各 flag 自身校验路径。
  const allowed = [
    '--account-id',
    '--no-tls',
    '--update',
    '--json',
    '--email',
    '--host',
    '--port',
    '--password-stdin',
    '--password-file',
  ];
  for (const flag of allowed) {
    const { deps, err } = makeDeps(repo);
    await runAccountCli(['list', flag, 'X'], deps);
    // 不因机密守卫被拒（不出现机密拒绝文案）；各 flag 自身合法性由其它测试覆盖。
    assert.ok(
      !err.join('\n').includes('禁经命令行参数'),
      `${flag} 不应被以机密为由拒绝`,
    );
  }
});

test('F7：归一不误伤 → --password-stdin / --password-file 仍放行（非机密词根）', async () => {
  const repo = new InMemoryMailRepo();
  // --password-stdin 走 stdin 来源、不被机密词根集误拒。
  const { deps } = makeDeps(repo, {
    stdin: { isTTY: false, read: async () => 'pw\n' },
    promptHidden: async () => 'SHOULD_NOT_BE_USED',
  });
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--password-stdin'],
    deps,
  );
  assert.equal(code, EXIT_OK, '--password-stdin 不被机密词根集误拒');
  assert.equal((await repo.listEnabledAccounts()).length, 1);
});

// ——————————————————————————————————————————————————————————
// F2：值缺位的 --password-file（落 bools）不得绕过来源互斥 → 显式拒绝；带值的 --password-stdin 拒绝
// ——————————————————————————————————————————————————————————

test('F2：值缺位的 --password-file（如 --password-file --password-stdin）→ 拒绝、不静默读 stdin', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo, {
    // 若被误读 stdin 则会建行；这里断言不建行。
    stdin: { isTTY: false, read: async () => 'LEAK\n' },
    promptHidden: async () => 'SHOULD_NOT_BE_USED',
  });
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--password-file', '--password-stdin'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '值缺位的 --password-file → 参数错误');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '未静默读 stdin 建行');
  assert.ok(err.join('\n').includes('--password-file'), '提示指明 --password-file 需路径');
});

test('F2：带值的 --password-stdin（如 --password-stdin=foo）→ 拒绝（应为裸布尔）', async () => {
  const repo = new InMemoryMailRepo();
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--password-stdin=foo'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '带值的 --password-stdin → 参数错误');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '未建行');
  assert.ok(err.join('\n').includes('--password-stdin'), '提示指明 --password-stdin 不接受值');
});

// ——————————————————————————————————————————————————————————
// set-process-from <id> <YYYY-MM-DD>：成功 / 缺日期 / 带 flag / 非法日期 / 未来日期 / 未知 id
// ——————————————————————————————————————————————————————————

/** 未来日期串（相对 now 的下一年元旦，UTC 零点；用于「未来日期 → EXIT_USAGE」断言）。 */
function futureDateStr(): string {
  return `${new Date().getUTCFullYear() + 1}-01-01`;
}

test('set-process-from <id> <YYYY-MM-DD>：成功 → EXIT_OK，setProcessFrom 入参为 (id, UTC 零点 Date)，成功行经 JSON.stringify 转义回显', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: 'gmail:user@gmail.com',
    provider: 'gmail',
    email: 'user@gmail.com',
    authJson: { refreshToken: GMAIL_RT, scopes: [] },
  });
  // 包裹 setProcessFrom 捕获入参（仍委托真身使行被更新）。
  const calls: Array<{ id: string; date: Date }> = [];
  const orig = repo.setProcessFrom.bind(repo);
  repo.setProcessFrom = async (id: string, date: Date) => {
    calls.push({ id, date });
    return orig(id, date);
  };

  const { deps, out } = makeDeps(repo);
  const code = await runAccountCli(
    ['set-process-from', 'gmail:user@gmail.com', '2026-03-15'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  assert.equal(calls.length, 1, 'setProcessFrom 被调一次');
  assert.equal(calls[0]!.id, 'gmail:user@gmail.com', 'id 入参原样');
  assert.equal(
    calls[0]!.date.toISOString(),
    '2026-03-15T00:00:00.000Z',
    'date 入参为该日 UTC 零点',
  );
  // 既有行水位线被更新为该 UTC 零点。
  const row = await repo.getAccountById('gmail:user@gmail.com');
  assert.equal(row?.processFrom?.toISOString(), '2026-03-15T00:00:00.000Z');
  // 成功行经 JSON.stringify(id) 转义回显。
  assert.ok(
    out.join('\n').includes(JSON.stringify('gmail:user@gmail.com')),
    'id 经 JSON.stringify 转义回显',
  );
});

test('set-process-from <id>（缺日期、仅 1 位置参）→ EXIT_USAGE、不触达 repo 写', async () => {
  const repo = new InMemoryMailRepo();
  let called = false;
  repo.setProcessFrom = async () => {
    called = true;
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(['set-process-from', 'some-id'], deps);
  assert.equal(code, EXIT_USAGE, '缺日期 → 参数错误');
  assert.equal(called, false, '未触达 setProcessFrom');
  assert.ok(err.join('\n').includes('两个参数'), '提示需两个位置参数');
});

test('set-process-from <id> <date> --json（带任意 flag）→ EXIT_USAGE（set-process-from 拒所有 flag）', async () => {
  const repo = new InMemoryMailRepo();
  let called = false;
  repo.setProcessFrom = async () => {
    called = true;
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['set-process-from', 'some-id', '2026-03-15', '--json'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '带 flag → 参数错误');
  assert.equal(called, false, '未触达 setProcessFrom');
  assert.ok(err.join('\n').includes('不接受任何 flag'), '精确报「不接受任何 flag」');
});

test('set-process-from <id> <非法日期 2026-13-99> → EXIT_USAGE、不触达 repo 写', async () => {
  const repo = new InMemoryMailRepo();
  let called = false;
  repo.setProcessFrom = async () => {
    called = true;
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['set-process-from', 'some-id', '2026-13-99'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '非法日期 → 参数错误');
  assert.equal(called, false, '未触达 setProcessFrom');
  assert.ok(err.join('\n').includes('非法'), '提示日期非法');
});

test('set-process-from <id> <未来日期> → EXIT_USAGE、不触达 repo 写', async () => {
  const repo = new InMemoryMailRepo();
  let called = false;
  repo.setProcessFrom = async () => {
    called = true;
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['set-process-from', 'some-id', futureDateStr()],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '未来日期 → 参数错误');
  assert.equal(called, false, '未触达 setProcessFrom');
  assert.ok(err.join('\n').includes('未来'), '提示不能是未来日期');
});

test('set-process-from <未知 id> <合法日期> → EXIT_FAILURE（setProcessFrom 抛、脱敏不泄露）', async () => {
  const repo = new InMemoryMailRepo();
  // 未知 id：真身 setProcessFrom 抛（未知 accountId）。
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['set-process-from', 'no-such-id', '2026-03-15'],
    deps,
  );
  assert.equal(code, EXIT_FAILURE, '未知 id → 业务失败');
  const text = err.join('\n');
  assert.ok(text.includes('设置失败'), '报「设置失败」');
  // id 经 JSON.stringify 转义回显。
  assert.ok(text.includes(JSON.stringify('no-such-id')), 'id 经 JSON.stringify 转义回显');
});

// ——————————————————————————————————————————————————————————
// add --process-from <date>：合法播种 processFrom / 非法拒绝 / value-less（FIX2 回归）
// ——————————————————————————————————————————————————————————

test('add --imap ... --process-from <合法日期> → createAccount 入参含 processFrom = 该 UTC 零点 Date', async () => {
  const repo = new InMemoryMailRepo();
  const calls: Array<{ id: string; processFrom: Date | undefined }> = [];
  const orig = repo.createAccount.bind(repo);
  repo.createAccount = async (input) => {
    calls.push({ id: input.id, processFrom: input.processFrom });
    return orig(input);
  };
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--process-from', '2026-03-15'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  assert.equal(calls.length, 1, 'createAccount 被调一次');
  assert.equal(
    calls[0]!.processFrom?.toISOString(),
    '2026-03-15T00:00:00.000Z',
    'createAccount 入参 processFrom 为该日 UTC 零点',
  );
});

test('add --imap --update ... --process-from <合法日期> → upsertAccount 入参含 processFrom = 该 UTC 零点 Date', async () => {
  const repo = new InMemoryMailRepo();
  const calls: Array<{ id: string; processFrom: Date | undefined }> = [];
  const orig = repo.upsertAccount.bind(repo);
  repo.upsertAccount = async (input) => {
    calls.push({ id: input.id, processFrom: input.processFrom });
    return orig(input);
  };
  const { deps } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '--update', '-e', 'me@ex.com', '-H', 'h', '--process-from', '2026-03-15'],
    deps,
  );
  assert.equal(code, EXIT_OK);
  assert.equal(calls.length, 1, 'upsertAccount 被调一次');
  assert.equal(
    calls[0]!.processFrom?.toISOString(),
    '2026-03-15T00:00:00.000Z',
    'upsertAccount 入参 processFrom 为该日 UTC 零点',
  );
});

test('add --imap ... --process-from <非法日期> → EXIT_USAGE、不触达 repo 写', async () => {
  const repo = new InMemoryMailRepo();
  let createCalled = false;
  repo.createAccount = async () => {
    createCalled = true;
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--process-from', '2026-13-99'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, '非法 --process-from → 参数错误');
  assert.equal(createCalled, false, '非法日期不触达 repo 写');
  assert.ok(err.join('\n').includes('--process-from 非法'), '提示 --process-from 非法');
});

test('FIX2 回归：add --gmail --process-from（value-less、无日期）→ EXIT_USAGE，在跑 OAuth 前即拒、不建行', async () => {
  const repo = new InMemoryMailRepo();
  let oauthCalled = false;
  const { deps, err } = makeDeps(repo, {
    runOAuth: async () => {
      oauthCalled = true;
      throw new Error('should-not-run');
    },
  });
  const code = await runAccountCli(['add', '--gmail', '--process-from'], deps);
  assert.equal(code, EXIT_USAGE, 'value-less --process-from → 参数错误（不再静默忽略）');
  assert.equal(oauthCalled, false, '在跑 OAuth 前即拒');
  assert.equal((await repo.listEnabledAccounts()).length, 0, '未建任何行');
  assert.ok(err.join('\n').includes('--process-from 需要日期参数'), '提示 --process-from 需要日期参数');
});

test('FIX2 回归：add --imap ... --process-from（value-less、无日期）→ EXIT_USAGE、不触达 repo 写', async () => {
  const repo = new InMemoryMailRepo();
  let createCalled = false;
  repo.createAccount = async () => {
    createCalled = true;
  };
  const { deps, err } = makeDeps(repo);
  const code = await runAccountCli(
    ['add', '--imap', '-e', 'me@ex.com', '-H', 'h', '--process-from'],
    deps,
  );
  assert.equal(code, EXIT_USAGE, 'value-less --process-from → 参数错误（不再静默忽略）');
  assert.equal(createCalled, false, '未触达 repo 写');
  assert.ok(err.join('\n').includes('--process-from 需要日期参数'), '提示 --process-from 需要日期参数');
});
