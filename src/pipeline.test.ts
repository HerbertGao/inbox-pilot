// pipeline run() self-check（migration §2.4 / §3.1 / §3.3 / §4.4）。
//
// 非空断言纪律（tasks 2.4）：驱动**真实** run() 全链路（fetch→classify→rules→save→executeActions→
// markProcessed），只注入 fake gmail / fake notifier / in-memory repo / classify spy——**不 stub**
// executeActions / emit / classify seam。断言读真实 emit 的 RunEvent（ctx.events）与真实 repo 状态、
// spy 计到的真实 classify 调用数。

import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Logger } from 'pino';

import { run, type RunOverrides } from './pipeline.js';
import { InMemoryMailRepo } from './repo/inMemoryMailRepo.js';
import type { MailRepo, DigestCandidate, SenderCount } from './repo/mailRepo.js';
import { toRawEmail } from './providers/gmail/gmailMap.js';
import type { GmailApi, GmailMessage } from './providers/gmail/gmailClient.js';
import { normalizeEmail, type NormalizedEmail } from './normalizer/normalizeEmail.js';
import type { Classification } from './classifier/schema.js';
import type { Notifier, NotifyResult } from './notify/notifier.js';
import type { ProviderActions } from './actions/providerActions.js';
import { ProviderReauthRequired } from './providers/provider.js';
import { GmailActionError } from './providers/gmail/gmailActions.js';
import { applySafetyRules } from './rules/applySafetyRules.js';
import { getActiveRules, reloadRulesConfigForTest, resetRulesConfigForTest } from './rules/rulesConfig.js';

const ACCOUNT_ID = 'gmail:test@example.com';
const NOW = Date.parse('2026-07-07T12:00:00.000Z');
const noop = async (): Promise<void> => {};

const silentLogger = {
  info() {},
  warn() {},
  debug() {},
  error() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  },
} as unknown as Logger;

/** fake ctx：记录真实 emit 的 kind+payload（不 stub emit 逻辑，只捕获）。trigger 可选（多触发路由，缺省 = undefined → poll）。 */
function makeCtx(trigger?: string) {
  const events: Array<{ kind: string; payload?: object }> = [];
  const ctx = {
    input: undefined as unknown,
    config: {} as Record<string, unknown>,
    logger: silentLogger,
    emit(kind: string, payload?: object) {
      events.push({ kind, payload });
    },
    async propose() {
      return undefined;
    },
    trigger,
    events,
  };
  return ctx;
}

/** 一封 text/plain gmail message（默认最旧优先测试用固定 date）。 */
function gmailMsg(id: string, opts: { subject?: string; from?: string; body?: string; date?: string } = {}): GmailMessage {
  return {
    id,
    threadId: `t_${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: opts.subject ?? `subject ${id}` },
        { name: 'From', value: opts.from ?? 'sender@example.test' },
        { name: 'Date', value: opts.date ?? '2026-07-07T11:00:00.000Z' },
      ],
      body: { data: Buffer.from(opts.body ?? 'body', 'utf8').toString('base64url') },
    },
  };
}

/** fake GmailApi + 调用计数（list/get/modify）。 */
function makeGmail(opts: {
  messages?: Record<string, GmailMessage>;
  listPages?: Array<{ ids: string[]; nextPageToken?: string }>;
  listError?: unknown;
  listErrorOnCall?: number;
  getError?: Record<string, unknown>;
}) {
  const obj = {
    listCalls: 0,
    getCalls: 0,
    getIds: [] as string[],
    modifyCalls: 0,
    api: {
      users: {
        messages: {
          async list() {
            obj.listCalls += 1;
            if (opts.listError !== undefined && obj.listCalls === (opts.listErrorOnCall ?? 1)) {
              throw opts.listError;
            }
            if (opts.listPages !== undefined) {
              // 显式多页模式（3.1 翻页测试，单 run）：按调用序取页。
              const page = opts.listPages[obj.listCalls - 1] ?? { ids: [] };
              return {
                data: { messages: page.ids.map((id) => ({ id })), nextPageToken: page.nextPageToken ?? null },
              };
            }
            // 单页模式：每次调用返回全集（跨 run 稳定，dedup 过滤已处理封；避免 listCalls 累积致 re-poll 取空）。
            const ids = Object.keys(opts.messages ?? {});
            return { data: { messages: ids.map((id) => ({ id })), nextPageToken: null } };
          },
          async get(p: { id: string }) {
            obj.getCalls += 1;
            obj.getIds.push(p.id);
            const ge = opts.getError?.[p.id];
            if (ge !== undefined) {
              throw ge;
            }
            const msg = (opts.messages ?? {})[p.id];
            if (msg === undefined) {
              throw new Error(`fake gmail: no message ${p.id}`);
            }
            return { data: msg };
          },
          async modify() {
            obj.modifyCalls += 1;
            return { data: {} };
          },
        },
        labels: {
          async list() {
            return { data: { labels: [] } };
          },
          async create() {
            return { data: { id: 'label_1', name: 'x' } };
          },
        },
      },
    } as GmailApi,
  };
  return obj;
}

/** fake provider（reflect/mark_read）+ 调用计数；可脚本化抛错。 */
function makeProvider(opts?: { reflectError?: unknown; markReadError?: unknown }) {
  const obj = {
    reflectCalls: 0,
    markReadCalls: 0,
    provider: {
      async reflectPriority() {
        obj.reflectCalls += 1;
        if (opts?.reflectError !== undefined) {
          throw opts.reflectError;
        }
      },
      async markRead() {
        obj.markReadCalls += 1;
        if (opts?.markReadError !== undefined) {
          throw opts.markReadError;
        }
      },
    } as ProviderActions,
  };
  return obj;
}

/** fake notifier：按 email 脚本返回三值 + 计调用数（真调、不 stub）。 */
function makeNotifier(script: (email: NormalizedEmail) => NotifyResult) {
  const obj = {
    calls: 0,
    seen: [] as string[],
    notifier: {
      async notify(_d: unknown, email: NormalizedEmail) {
        obj.calls += 1;
        obj.seen.push(email.providerMessageId);
        return script(email);
      },
      async notifyDigest() {
        return { outcome: 'skipped', reason: 'n/a' } as NotifyResult;
      },
    } as Notifier,
  };
  return obj;
}

/** classify spy：计真实调用数（re-poll 复用分类断言，2.4a）。 */
function makeClassify(fn: (email: NormalizedEmail) => Classification) {
  const obj = {
    calls: 0,
    classify: async (email: NormalizedEmail) => {
      obj.calls += 1;
      return fn(email);
    },
  };
  return obj;
}

function classification(over: Partial<Classification> = {}): Classification {
  return {
    priority: 'P4',
    category: 'security',
    should_notify_now: false,
    should_mark_read: false,
    should_include_digest: false,
    confidence: 0.9,
    reason: 'r',
    risk_flags: [],
    ...over,
  };
}

const SENT: NotifyResult = { outcome: 'sent', channel: 'telegram' };
const FAILED: NotifyResult = { outcome: 'failed', channel: 'telegram', error: 'telegram-http-500' };
const SKIPPED: NotifyResult = { outcome: 'skipped', reason: 'no-channel' };

async function seedGmailAccount(repo: MailRepo, refreshToken = 'REFRESH-TOKEN-SECRET-XYZ'): Promise<void> {
  await repo.upsertAccount({
    id: ACCOUNT_ID,
    provider: 'gmail',
    email: 'test@example.com',
    authJson: { refreshToken, scopes: ['https://www.googleapis.com/auth/gmail.modify'] },
    enabled: true,
  });
}

/** 基础 overrides（可覆盖）。gmail/provider 工厂返回**同一** fake（run 单账号）。 */
function baseOverrides(parts: {
  repo: MailRepo;
  gmail: ReturnType<typeof makeGmail>;
  provider: ReturnType<typeof makeProvider>;
  notifier: ReturnType<typeof makeNotifier>;
  classify: ReturnType<typeof makeClassify>;
  extra?: Partial<RunOverrides>;
}): RunOverrides {
  return {
    repo: parts.repo,
    notifier: parts.notifier.notifier,
    classify: parts.classify.classify,
    makeGmail: () => parts.gmail.api,
    makeProvider: () => parts.provider.provider,
    config: {},
    now: () => NOW,
    sleep: noop,
    ...parts.extra,
  };
}

// —— §2.4(a)：批 3 封第 2 封 notify 耗尽 → run completed、第 2 封无 processedAt、re-poll classify=0 ——
test('2.4(a) 第2封 notify 耗尽 → 第2封无 processedAt、re-poll 复用分类 classify=0', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({
    messages: { m1: gmailMsg('m1'), m2: gmailMsg('m2'), m3: gmailMsg('m3') },
  });
  const provider = makeProvider();
  const notifier = makeNotifier((email) => (email.providerMessageId === 'm2' ? FAILED : SENT));
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  const overrides = baseOverrides({ repo, gmail, provider, notifier, classify });

  await run(ctx, overrides); // run 1（首访 3 封）
  assert.equal(classify.calls, 3, '首访 3 封各 classify 一次');
  assert.notEqual((await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt, null, 'm1 sent → markProcessed');
  assert.notEqual((await repo.findByDedupKey(ACCOUNT_ID, 'm3'))?.processedAt, null, 'm3 sent → markProcessed');
  const m2Row = await repo.findByDedupKey(ACCOUNT_ID, 'm2');
  assert.equal(m2Row?.processedAt, null, 'm2 notify 耗尽 → 不 markProcessed（留 unread 供 re-poll）');
  assert.ok(
    ctx.events.some((e) => e.kind === 'notify.failed'),
    'trace 有真实 notify.failed',
  );

  // run 2（re-poll）：m1/m3 已 processed 被 dedup 跳过；m2 重跑复用分类 → classify 不再被调。
  classify.calls = 0;
  await run(ctx, overrides);
  assert.equal(classify.calls, 0, 're-poll 命中已存分类 → 跳 LLM（classify 调用数=0）');
  assert.equal(
    (await repo.findByDedupKey(ACCOUNT_ID, 'm2'))?.processedAt,
    null,
    'm2 仍耗尽 → 仍不 markProcessed',
  );
  assert.equal(await repo.getRepollCount(m2Row!.id), 1, '重跑入口 re-poll 计数 +1');
});

// —— §2.4(b)：notify skipped → 不重试、markProcessed 照常 ——
test('2.4(b) notify skipped → 不重试、markProcessed 照常', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SKIPPED);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify }));
  assert.equal(notifier.calls, 1, 'skipped 直接终结、不进重试');
  assert.notEqual(
    (await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt,
    null,
    'skipped 非耗尽 → markProcessed 照常',
  );
  assert.ok(ctx.events.some((e) => e.kind === 'notify.skipped'));
});

// —— §2.4(c)：reflect 耗尽 → notify 仍被调 且 trace 有真实 reflect.failed（非 action.executed 假绿）——
test('2.4(c) reflect 耗尽 → notify 仍被调、trace 有真实 reflect.failed', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider({ reflectError: new GmailActionError() }); // 瞬时（非 reauth）→ 有界重试耗尽
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify }));
  assert.equal(provider.reflectCalls, 3, 'reflect 有界重试 3 次耗尽');
  assert.equal(notifier.calls, 1, 'reflect 耗尽不阻断 notify（notify 仍被调）');
  assert.ok(ctx.events.some((e) => e.kind === 'reflect.failed'), 'trace 有真实 reflect.failed（非假绿）');
  assert.ok(ctx.events.some((e) => e.kind === 'notify.sent'), 'trace 有真实 notify.sent');
  assert.notEqual((await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt, null, 'notify sent → markProcessed');
});

// —— §2.4(d)：re-poll 计数达 K → dead_letter + markProcessed 停发 ——
test('2.4(d) re-poll 计数达 K → email.dead_letter + markProcessed、notify 停发', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  // 预置 m1 为已存-未处理 + repollCount=K（重跑入口门命中）。
  const seeded = normalizeEmail(toRawEmail(gmailMsg('m1'), ACCOUNT_ID));
  const stored = await repo.saveEmail(seeded);
  const K = 3;
  for (let i = 0; i < K; i += 1) {
    await repo.incrementRepollCount(stored.id);
  }
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(
    ctx,
    baseOverrides({ repo, gmail, provider, notifier, classify, extra: { deadLetterMaxRepolls: K } }),
  );
  const dl = ctx.events.find((e) => e.kind === 'email.dead_letter');
  assert.ok(dl !== undefined, 'emit email.dead_letter');
  assert.equal((dl!.payload as { reason: string }).reason, 'max-attempts', '终态原因 max-attempts');
  assert.equal(notifier.calls, 0, 'dead_letter 停发（notify 不被调）');
  assert.equal(classify.calls, 0, 'dead_letter 在入口 → 不 classify');
  assert.notEqual((await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt, null, 'dead_letter markProcessed 封顶');
});

// —— §2.4(e)：emit payload 无地址/token/正文 ——
test('2.4(e) emit payload 无发件地址/token/正文', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo, 'REFRESH-TOKEN-SECRET-XYZ');
  const gmail = makeGmail({
    messages: { m1: gmailMsg('m1', { from: 'secret-sender@evil.example', body: 'SECRET-BODY-TEXT-123' }) },
  });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify }));
  assert.ok(ctx.events.length > 0, '有真实 emit 事件');
  const blob = JSON.stringify(ctx.events);
  assert.ok(!blob.includes('secret-sender@evil.example'), 'payload 不含发件地址');
  assert.ok(!blob.includes('SECRET-BODY-TEXT-123'), 'payload 不含正文');
  assert.ok(!blob.includes('REFRESH-TOKEN-SECRET-XYZ'), 'payload 不含凭据 token');
  // 每 email 事件 payload 只带非 PII 的 messageRowId/providerMessageId；account.suspended 仅 {accountId, reason}（m6）。
  for (const e of ctx.events) {
    if (e.kind.startsWith('notify') || e.kind.startsWith('reflect') || e.kind.startsWith('mark_read')) {
      assert.deepEqual(
        Object.keys(e.payload ?? {}).sort(),
        ['messageRowId', 'providerMessageId'],
        `${e.kind} payload 仅非 PII 标识`,
      );
    }
    if (e.kind === 'account.suspended') {
      assert.deepEqual(
        Object.keys(e.payload ?? {}).sort(),
        ['accountId', 'reason'],
        'account.suspended payload 仅 {accountId, reason}（accountId 是受认可低敏运营标识、无邮件内容）',
      );
    }
  }
});

// —— §2.1 作用域纪律：良性（get/map/normalize 崩）→ skip 该封 continue（不结束本轮）——
test('2.1 良性单封失败（get 崩）→ 只 skip 该封、其余照常处理', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  // m? 的 get 抛无 status 的普通错误 → classifyReadError=benign → BenignEmailError → skip 该封。
  const gmail = makeGmail({
    messages: { good1: gmailMsg('good1'), bad: gmailMsg('bad') },
    getError: { bad: new Error('malformed response') },
  });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify }));
  assert.equal(gmail.getCalls, 2, '良性 skip 不结束本轮：两封都被尝试 get');
  assert.notEqual((await repo.findByDedupKey(ACCOUNT_ID, 'good1'))?.processedAt, null, 'good1 照常处理');
  assert.equal(await repo.findByDedupKey(ACCOUNT_ID, 'bad'), null, 'bad get 崩 → 无行、skip（下轮 re-poll）');
  assert.equal(notifier.calls, 1, '仅 good1 notify');
});

// —— §2.1 作用域纪律：终态 DB I/O 逃出 catch → 账号级处理（结束本轮），禁止当「skip 一封」——
class ThrowFirstSaveRepo extends InMemoryMailRepo {
  saves = 0;
  override async saveEmail(email: NormalizedEmail) {
    this.saves += 1;
    if (this.saves === 1) {
      throw new Error('DB down (terminal I/O)');
    }
    return super.saveEmail(email);
  }
}

test('2.1 终态 DB I/O（saveEmail 抛）→ 逃出 catch 结束本轮、不当 skip 一封、run 仍 completed', async () => {
  const repo = new ThrowFirstSaveRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1'), m2: gmailMsg('m2') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify })); // run() 捕获非 reauth → 不抛
  assert.equal(gmail.getCalls, 1, 'DB I/O 逃出 → 结束本轮（第二封不再 get），非 skip 一封继续');
  assert.equal(notifier.calls, 0, '结束本轮 → 无动作');
  assert.ok(
    ctx.events.some(
      (e) => e.kind === 'account.suspended' && (e.payload as { reason?: string }).reason === 'terminal-error',
    ),
    'DB I/O → emit account.suspended(reason=terminal-error) 供 trace 审计（区别于「没邮件可做」的 run）',
  );
  assert.equal(
    (await repo.listEnabledAccounts()).length,
    1,
    'DB I/O 非 reauth → **不**持久 disable（账号仍 enabled、下轮 cron 重试）',
  );
});

// —— §3.1：读侧 list 429 → 结束本轮不继续翻页、run completed ——
test('3.1 读侧 list 429 → 结束本轮不继续翻页（不进 get）、run completed 不 suspend', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  // 第 1 页返回 m1 + nextPageToken；第 2 次 list 抛 429 → 结束本轮、丢弃本轮、不继续翻页、不逐封 get。
  const gmail = makeGmail({
    messages: { m1: gmailMsg('m1') },
    listPages: [{ ids: ['m1'], nextPageToken: 'p2' }],
    listError: { status: 429 },
    listErrorOnCall: 2,
  });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify })); // 不抛 = run completed
  assert.equal(gmail.listCalls, 2, '翻到第 2 页遇 429 即停（不继续翻页）');
  assert.equal(gmail.getCalls, 0, '429 结束本轮 → 不逐封 get');
  assert.equal(notifier.calls, 0, '结束本轮 → 无动作');
  assert.ok(!ctx.events.some((e) => e.kind === 'account.suspended'), '429 不 suspend 账号');
  assert.equal((await repo.listEnabledAccounts()).length, 1, '账号仍 enabled（429 非致命）');
});

// —— §3.3：硬 reauth → 单次命中不 3× 重试、持久 disable、listEnabledAccounts 不再返回它 ——
test('3.3 硬 reauth（动作）→ 单次命中不 3× 重试、持久 setAccountEnabled(false)、listEnabledAccounts 不再返回', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider({ reflectError: new ProviderReauthRequired(ACCOUNT_ID) });
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify }));
  assert.equal(provider.reflectCalls, 1, 'reauth 单次命中即抛、不 3× 重试猛打');
  assert.equal(notifier.calls, 0, 'reflect reauth 逃逸 → 后续动作不执行');
  const suspEvt = ctx.events.find((e) => e.kind === 'account.suspended');
  assert.ok(
    suspEvt !== undefined && (suspEvt.payload as { reason?: string }).reason === 'reauth-required',
    'emit account.suspended(reason=reauth-required)',
  );
  // m6：account.suspended payload 仅 {accountId, reason}——accountId 是受认可低敏运营标识,无 subject/body/sender。
  assert.deepEqual(
    Object.keys(suspEvt!.payload ?? {}).sort(),
    ['accountId', 'reason'],
    'account.suspended payload 仅 {accountId, reason}（无邮件内容 PII）',
  );
  assert.equal((await repo.listEnabledAccounts()).length, 0, '持久 disable：listEnabledAccounts 不再返回它');
  assert.equal((await repo.getAccountById(ACCOUNT_ID))?.enabled, false, 'enabled=false 落库');
});

// —— §4.4：hung 调用 → 超时放弃、锁释放、无 unhandledRejection、晚到 resolve 不 emit/不 markProcessed ——
test('4.4 hung 调用 → 超时放弃、锁释放、无 unhandledRejection、晚到 resolve 被 fence 挡住', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  // hung classify：超时后才 resolve（模拟 head-of-line hang）。
  let resolveHung: (c: Classification) => void = () => {};
  const hung = new Promise<Classification>((res) => {
    resolveHung = res;
  });
  const classify = {
    calls: 0,
    classify: async () => {
      classify.calls += 1;
      return hung;
    },
  };
  const ctx = makeCtx();

  const rejections: unknown[] = [];
  const onUnhandled = (r: unknown): void => {
    rejections.push(r);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await run(
      ctx,
      baseOverrides({ repo, gmail, provider, notifier, classify, extra: { perEmailTimeoutMs: 50 } }),
    );
    // run 已 resolve = active-lock 释放（未被 hung 楔死）。
    assert.equal((await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt, null, '超时放弃：未 markProcessed');
    assert.equal(notifier.calls, 0, '超时发生在 classify（executeActions 前）→ 未发 notify');
    assert.ok(!ctx.events.some((e) => e.kind.startsWith('notify')), '超时前无 notify emit');

    // 晚到 resolve：work 继续、但 fence 挡住 saveClassification/executeActions/emit/markProcessed。
    resolveHung(classification({ priority: 'P4' }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(
      (await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt,
      null,
      '晚到 resolve 不 markProcessed（fence）',
    );
    assert.equal(notifier.calls, 0, '晚到 resolve 不发 notify（fence 在 executeActions 前）');
    assert.ok(!ctx.events.some((e) => e.kind.startsWith('notify')), '晚到 resolve 不 emit');
    assert.equal(rejections.length, 0, '无 unhandledRejection（被弃诺吞拒绝）');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

// —— §4.4：per-run 墙钟兜底 → 结束本轮剩余邮件（剩余下轮 re-poll）——
test('4.4 per-run 墙钟兜底 → 结束本轮、不处理任何邮件', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1'), m2: gmailMsg('m2') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  // perRunTimeoutMs=0 + 固定 now → runDeadline 即刻已过 → 结束本轮（不进任何账号处理）。
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify, extra: { perRunTimeoutMs: 0 } }));
  assert.equal(gmail.getCalls, 0, 'per-run 兜底：不处理任何邮件（剩余下轮 re-poll）');
  assert.equal(notifier.calls, 0);
});

// —— M1：dedup 扫描遵守 runDeadline（未竞速 DB 调用不跑过 per-run 墙钟占死 active-lock）——
test('M1 dedup 扫描遇 runDeadline → 提前退出、不进任何 get（已进入账号并取回 list 页后 deadline 过）', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1'), m2: gmailMsg('m2') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  // 时钟键于 list 调用数：list 前 now=NOW（< runDeadline=NOW+1000，进入账号 + 翻页取回）；list 取回后
  // now 跳到 NOW+5000（> runDeadline）→ dedup 扫描首个 id 即 break，一封都不 get。
  const clock = (): number => (gmail.listCalls >= 1 ? NOW + 5000 : NOW);
  await run(
    ctx,
    baseOverrides({ repo, gmail, provider, notifier, classify, extra: { now: clock, perRunTimeoutMs: 1000 } }),
  );
  assert.equal(gmail.listCalls, 1, '已进入账号并取回 list 页（区别于账号级/翻页级提前 break 的 listCalls=0）');
  assert.equal(gmail.getCalls, 0, 'dedup 扫描遇 runDeadline → 提前退出、不进任何 get（剩余下轮 re-poll）');
  assert.equal(notifier.calls, 0);
});

// —— M2：重跑封 get 恒抛良性仍达 dead_letter（门在 get 前）；dead-letter tick 不 get ——
test('M2 重跑封 get 恒抛良性仍达 dead_letter（门在 get 前评估既存行、非 get 后）', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const K = 3;
  // 预置 m1 已存-未处理 + repollCount=K-1：tick1 入口未命中 → +1=K；tick2 入口命中门。
  const seeded = normalizeEmail(toRawEmail(gmailMsg('m1'), ACCOUNT_ID));
  const stored = await repo.saveEmail(seeded);
  for (let i = 0; i < K - 1; i += 1) {
    await repo.incrementRepollCount(stored.id);
  }
  // get 恒抛良性（无 status → benign）：旧「门在 get 后」下 get 抛则永不 dead-letter;新「门在 get 前」仍终态。
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') }, getError: { m1: new Error('benign get failure') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  const overrides = baseOverrides({ repo, gmail, provider, notifier, classify, extra: { deadLetterMaxRepolls: K } });

  await run(ctx, overrides); // tick1：入口 K-1<K → +1=K → get 抛良性 → skip（无 dead_letter）
  assert.ok(!ctx.events.some((e) => e.kind === 'email.dead_letter'), 'tick1：计数未达 K → 未 dead_letter');
  assert.equal(await repo.getRepollCount(stored.id), K, 'tick1：入口计数 +1 达 K（即便 get 恒抛良性）');
  assert.equal(gmail.getCalls, 1, 'tick1：入口未命中 → 仍 get（抛良性）');
  assert.equal((await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt, null, 'tick1：未 markProcessed');

  await run(ctx, overrides); // tick2：入口 K≥K → 门命中 → dead_letter + markProcessed、**不 get**
  const dl = ctx.events.find((e) => e.kind === 'email.dead_letter');
  assert.ok(dl !== undefined, 'tick2：门命中 → emit email.dead_letter（即便 get 恒抛也达终态）');
  assert.equal((dl!.payload as { reason: string }).reason, 'max-attempts', '终态原因 max-attempts');
  assert.equal(gmail.getCalls, 1, 'tick2：门在 get 前命中 → 不再 get（getCalls 仍 1）');
  assert.notEqual((await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt, null, 'tick2：dead_letter markProcessed 封顶');
});

// —— m2b：死信门 stale 短路——既存封超 staleness → dead_letter 不读 getRepollCount（防其 hang/err 使 staleness 终态失效，RC r2）——
test('m2b stale 短路：既存封超 staleness → dead_letter(reason=stale)、**不读** getRepollCount（其恒抛也终态）', async () => {
  // getRepollCount 恒抛：若门未短路（stale 先判）而先读 count，则抛 → 终态 DB I/O 结束本轮 → 永不 dead_letter。
  class ThrowRepollRepo extends InMemoryMailRepo {
    override async getRepollCount(): Promise<number> {
      throw new Error('getRepollCount hung/err');
    }
  }
  const repo = new ThrowRepollRepo();
  await seedGmailAccount(repo);
  // 预置一封已存-未处理（revisit）；receivedAt = email.date（11:00）。now 固定 12:00 + staleness=1ms → 必 stale。
  const seeded = normalizeEmail(toRawEmail(gmailMsg('m1'), ACCOUNT_ID));
  await repo.saveEmail(seeded);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  const overrides = baseOverrides({
    repo,
    gmail,
    provider,
    notifier,
    classify,
    extra: { now: () => NOW, deadLetterStalenessMs: 1 },
  });
  await run(ctx, overrides);
  const dl = ctx.events.find((e) => e.kind === 'email.dead_letter');
  assert.ok(dl !== undefined, 'stale → emit email.dead_letter（即便 getRepollCount 恒抛，证明已短路）');
  assert.equal((dl!.payload as { reason: string }).reason, 'stale', '终态原因 stale（短路未读 count）');
  assert.equal(gmail.getCalls, 0, 'stale 门在 get 前命中 → 不 get');
  assert.notEqual((await repo.findByDedupKey(ACCOUNT_ID, 'm1'))?.processedAt, null, 'dead_letter markProcessed 封顶');
});

// —— m2：读侧 get 5xx → benign 逐封 skip（防单封 poison 饿死整轮，RC r2），run completed 不 suspend ——
test('m2 读侧 get 5xx → benign 逐封 skip（**不** end-round，防单封 poison 饿死整轮，RC r2）、run completed 不 suspend', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  // m1 的 get 恒 5xx（模拟 message-specific 500）；m2 正常。若 5xx→end-round，oldest-first 下 m1 会每 tick
  // 结束整轮、饿死 m2（且 m1 未落库→永不 revisit→死信封不住）；benign skip 则 m1 跳过、m2 仍被处理。
  const gmail = makeGmail({
    messages: { m1: gmailMsg('m1'), m2: gmailMsg('m2') },
    getError: { m1: { status: 500 } },
  });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify })); // 不抛 = run completed
  assert.equal(gmail.getCalls, 2, '5xx benign skip 不 end-round：两封都被尝试 get（单封 poison 不饿死其余）');
  assert.equal(notifier.calls, 1, '好封 m2 仍被处理（5xx 未结束整轮）');
  assert.ok(!ctx.events.some((e) => e.kind === 'account.suspended'), '5xx 非致命 → 不 suspend');
  assert.equal((await repo.listEnabledAccounts()).length, 1, '账号仍 enabled（5xx 非致命）');
});

// —— m3：ctx 断言 —— 缺 logger 抛干净错误；无 propose 被接受 ——
test('m3 ctx 缺 logger → 抛干净的 incompatible-RunContext 错误（非晚点 undefined-is-not-a-function）', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const badCtx = {
    input: undefined,
    config: {},
    emit() {},
    async propose() {
      return undefined;
    },
    // logger 缺失
  } as unknown as Parameters<typeof run>[0];
  await assert.rejects(
    () => run(badCtx, { repo, config: {} }),
    (e) => e instanceof Error && /incompatible RunContext/.test(e.message),
  );
});

test('m3 ctx 无 propose → 被接受（run() 从不用 propose、不误拒）、真实跑完一封', async () => {
  const repo = new InMemoryMailRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider();
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const events: Array<{ kind: string; payload?: object }> = [];
  const ctxNoPropose = {
    input: undefined,
    config: {},
    logger: silentLogger,
    emit(kind: string, payload?: object) {
      events.push({ kind, payload });
    },
    // 无 propose
  } as unknown as Parameters<typeof run>[0];
  await run(ctxNoPropose, baseOverrides({ repo, gmail, provider, notifier, classify }));
  assert.equal(notifier.calls, 1, 'ctx 无 propose 仍正常跑完一封（未误拒）');
  assert.ok(events.some((e) => e.kind === 'notify.sent'), '真实 notify.sent emit');
});

// —— m5：reauth 持久 disable 落库失败 → run 仍 completed、account.suspended 仍 emit ——
class ThrowSetEnabledRepo extends InMemoryMailRepo {
  override async setAccountEnabled(): Promise<void> {
    throw new Error('DB down (setAccountEnabled)');
  }
}

test('m5 reauth 持久 disable 落库失败（setAccountEnabled 抛）→ run 仍 completed、account.suspended 仍 emit', async () => {
  const repo = new ThrowSetEnabledRepo();
  await seedGmailAccount(repo);
  const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
  const provider = makeProvider({ reflectError: new ProviderReauthRequired(ACCOUNT_ID) });
  const notifier = makeNotifier(() => SENT);
  const classify = makeClassify(() => classification({ priority: 'P4' }));
  const ctx = makeCtx();
  // setAccountEnabled 抛不得逃逸（否则 run.failed + 账号未 suspend）：run() 须 resolve（await 不抛）。
  await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify }));
  assert.ok(
    ctx.events.some(
      (e) => e.kind === 'account.suspended' && (e.payload as { reason?: string }).reason === 'reauth-required',
    ),
    'setAccountEnabled 抛仍 emit account.suspended(reauth-required)、run 完成',
  );
});

// ─────────────── §3.5 多触发路由 self-check（add-multi-trigger，驱动真实 run(ctx)、不 stub buildDigest/notifyDigest/emit） ───────────────

/** digest 假 repo：listDigestCandidates 返回脚本候选、记 markDigested；其余 MailRepo 方法 digest 路径不触碰。 */
function digestRepo(candidates: DigestCandidate[]): { repo: MailRepo; markCalls: string[][] } {
  const markCalls: string[][] = [];
  const repo = {
    async listDigestCandidates(): Promise<DigestCandidate[]> {
      return candidates;
    },
    async countRecentSenders(): Promise<SenderCount[]> {
      return [];
    },
    async markDigested(ids: string[]): Promise<void> {
      markCalls.push([...ids]);
    },
  } as unknown as MailRepo;
  return { repo, markCalls };
}

/** digest 假 notifier：记 notifyDigest 文本 + per-email notify 次数（断言 poll 路径不走）；outcomes 脚本、用尽默认 sent。 */
function digestNotifier(outcomes: Array<NotifyResult['outcome']>): {
  notifier: Notifier;
  digestTexts: string[];
  calls: { notify: number };
} {
  const digestTexts: string[] = [];
  const calls = { notify: 0 };
  let i = 0;
  const notifier = {
    async notify(): Promise<NotifyResult> {
      calls.notify += 1;
      return SENT;
    },
    async notifyDigest(text: string): Promise<NotifyResult> {
      digestTexts.push(text);
      const outcome = outcomes[i++] ?? 'sent';
      if (outcome === 'sent') return { outcome: 'sent', channel: 'fake' };
      if (outcome === 'skipped') return { outcome: 'skipped', reason: 'no-channel' };
      return { outcome: 'failed', channel: 'fake', error: 'fake-error' };
    },
  } as Notifier;
  return { notifier, digestTexts, calls };
}

function digestCandidate(over: Partial<DigestCandidate> & { messageRowId: string }): DigestCandidate {
  return {
    priority: 'P1',
    category: 'work',
    subject: 'subj',
    fromEmail: 'a@example.com',
    fromName: 'Alice',
    reason: 'reason',
    ...over,
  };
}

/** 足量满字段 P1 候选（各字段远超 FIELD_CAP=200）→ buildDigest.packLines 必分 ≥2 段。 */
function manyDigestCandidates(n: number): DigestCandidate[] {
  return Array.from({ length: n }, (_, idx) =>
    digestCandidate({
      messageRowId: `r${idx}`,
      subject: 's'.repeat(300),
      fromName: 'n'.repeat(300),
      reason: 'z'.repeat(300),
    }),
  );
}

test('3.5① ctx.trigger=digest → buildDigest+逐段 notifyDigest+markDigested；poll 路径不走', async () => {
  const { repo, markCalls } = digestRepo([digestCandidate({ messageRowId: 'r1' })]);
  const { notifier, digestTexts, calls } = digestNotifier([]);
  const ctx = makeCtx('digest');

  await run(ctx, { repo, notifier, now: () => NOW });

  assert.ok(digestTexts.length >= 1, 'notifyDigest 被调用（摘要推送）');
  assert.deepEqual(markCalls, [['r1']], 'markDigested(该段 row-ids)');
  assert.equal(calls.notify, 0, 'poll 的 per-email notify 未被调用（poll 路径不走）');
  assert.ok(ctx.events.some((e) => e.kind === 'digest.sent'), 'emit digest.sent');
  assert.ok(!ctx.events.some((e) => e.kind.startsWith('notify.')), '无 poll 的 notify.* 事件');
});

test('3.5② ctx.trigger=poll/undefined → 走现有 poll、不发摘要', async () => {
  for (const trig of ['poll', undefined] as const) {
    const repo = new InMemoryMailRepo();
    await seedGmailAccount(repo);
    const gmail = makeGmail({ messages: { m1: gmailMsg('m1') } });
    const provider = makeProvider();
    const notifier = makeNotifier(() => SENT);
    const classify = makeClassify(() => classification({ priority: 'P4' }));
    const ctx = makeCtx(trig);

    await run(ctx, baseOverrides({ repo, gmail, provider, notifier, classify }));

    assert.ok(gmail.listCalls >= 1, `poll 走 gmail list（trigger=${String(trig)}）`);
    assert.ok(gmail.getCalls >= 1, 'poll 逐封 get（走现有 fetch→classify→…）');
    assert.ok(!ctx.events.some((e) => e.kind.startsWith('digest.')), '无 digest.* 事件（不发摘要）');
  }
});

test('3.5③ digest 空（buildDigest→null）→ emit digest.empty、不推、不 mark', async () => {
  const { repo, markCalls } = digestRepo([]);
  const { notifier, digestTexts } = digestNotifier([]);
  const ctx = makeCtx('digest');

  await run(ctx, { repo, notifier, now: () => NOW });

  assert.equal(digestTexts.length, 0, '空 → 不推');
  assert.equal(markCalls.length, 0, '空 → 不 mark');
  assert.ok(ctx.events.some((e) => e.kind === 'digest.empty'), 'emit digest.empty');
});

test('3.5④ digest 段发失败 → 停、不 markDigested 后续段', async () => {
  const candidates = manyDigestCandidates(20);
  const allIds = candidates.map((c) => c.messageRowId);
  const { repo, markCalls } = digestRepo(candidates);
  // seg1 sent、seg2 failed → 停。
  const { notifier, digestTexts } = digestNotifier(['sent', 'failed']);
  const ctx = makeCtx('digest');

  await run(ctx, { repo, notifier, now: () => NOW });

  assert.equal(digestTexts.length, 2, 'seg1(sent) 后 seg2(failed) 即停（后续段不发）');
  assert.equal(markCalls.length, 1, '只 mark seg1（成功段），后续段不 mark');
  const marked = markCalls[0]!;
  assert.ok(marked.length > 0 && marked.length < allIds.length, 'seg1 是非空前缀、未含全部');
  assert.deepEqual(marked, allIds.slice(0, marked.length), 'marked = row-ids 前缀（seg1）');
  assert.ok(ctx.events.some((e) => e.kind === 'digest.failed'), 'emit digest.failed');
});

test('3.1 未知 trigger → run throw（响亮失败、不静默走 poll）', async () => {
  const ctx = makeCtx('bogus-trigger');
  await assert.rejects(run(ctx, {}), /unknown trigger/, '未知 name → throw（供 trace 发现拼错/漏配）');
});

// ─────────────── noise-feedback self-check（interpret 确定性匹配 + apply set-union 幂等，跨 repo 契约 add-view-command-path） ───────────────

/** interpret 假 repo：countRecentSenders 返回脚本候选（其余方法 interpret 路径不触碰）。 */
function senderRepo(senders: SenderCount[]): MailRepo {
  return {
    async countRecentSenders(): Promise<SenderCount[]> {
      return senders;
    },
  } as unknown as MailRepo;
}

test('nf① interpret-feedback: token 命中 → add=命中候选子集（去重、输出⊆候选、不 throw）', async () => {
  const repo = senderRepo([
    { fromEmail: 'noreply@taobao.com', count: 9 },
    { fromEmail: 'push@weibo.com', count: 5 },
    { fromEmail: 'alice@work.example', count: 2 },
  ]);
  const ctx = makeCtx('interpret-feedback');
  // 'jd' 长度 2 < 3 被丢弃 → 只 taobao/weibo（长度≥3）命中候选（证 ≥3 token 门 + 子串匹配）。
  ctx.input = { text: '把 taobao 和 weibo 加进去降噪（jd 太短不算）' };

  await run(ctx, { repo });

  const ev = ctx.events.find((e) => e.kind === 'interpretation.proposed');
  assert.ok(ev, 'emit interpretation.proposed');
  const add = (ev!.payload as { add: string[] }).add;
  assert.deepEqual(add, ['noreply@taobao.com', 'push@weibo.com'], '命中 taobao/weibo、未命中 work');
  const candidateSet = new Set(['noreply@taobao.com', 'push@weibo.com', 'alice@work.example']);
  assert.ok(add.every((a) => candidateSet.has(a)), '输出⊆候选集（零幻觉）');
});

test('nf①b interpret-feedback: 只匹配 digest 展示的 TOP-N（第 6 位候选被 slice 排除）', async () => {
  const repo = senderRepo([
    { fromEmail: 'notifications@github.com', count: 61 }, // TOP-5 内(第 1)
    { fromEmail: 'mon@alibabacloud.com', count: 8 },
    { fromEmail: 'x@cloudflare.com', count: 7 },
    { fromEmail: 'y@pixiv.net', count: 4 },
    { fromEmail: 'z@example.com', count: 3 }, // TOP-5 边界(第 5)
    { fromEmail: 'noreply@github.com', count: 2 }, // 第 6 —— slice(0, NOISE_TOPN) 排除
  ]);
  const ctx = makeCtx('interpret-feedback');
  ctx.input = { text: '把 github 加进降噪' };

  await run(ctx, { repo });

  const add = (ctx.events.find((e) => e.kind === 'interpretation.proposed')!.payload as { add: string[] }).add;
  assert.deepEqual(add, ['notifications@github.com'], '只命中 TOP-5 内的 github;第 6 位 noreply@github.com 被 slice 排除');
});

test('nf② interpret-feedback: 纯中文虚词（无 ascii token≥3）→ add=[]（切分剔除、无副作用）', async () => {
  const repo = senderRepo([{ fromEmail: 'noreply@taobao.com', count: 9 }]);
  const ctx = makeCtx('interpret-feedback');
  ctx.input = { text: '把第一个和那个都加进去吧' };

  await run(ctx, { repo });

  const ev = ctx.events.find((e) => e.kind === 'interpretation.proposed');
  assert.deepEqual((ev!.payload as { add: string[] }).add, [], '中文虚词经 [^a-z0-9]+ 切分被剔除 → 无命中');
});

test('nf③ interpret-feedback: input 非对象/缺 text/非串 → 当空、add=[]', async () => {
  const repo = senderRepo([{ fromEmail: 'noreply@taobao.com', count: 9 }]);
  for (const bad of [undefined, null, 42, { nope: 1 }, { text: 123 }]) {
    const ctx = makeCtx('interpret-feedback');
    ctx.input = bad;
    await run(ctx, { repo });
    const ev = ctx.events.find((e) => e.kind === 'interpretation.proposed');
    assert.deepEqual((ev!.payload as { add: string[] }).add, [], `input=${JSON.stringify(bad)} → add=[]`);
  }
});


// ─────────────── 结构化 remove 路径 + 入口校验（跨仓契约 add-view-feedback-remove） ───────────────
//
// 定型决策：**pilot 不做自然语言意图解析**。方向与地址由调用方给结构化 JSON，pilot 只做归一、校验、
// 集合运算。既有 `{text}` → add 路径（nf①–③）一行未改，本节只覆盖新增的结构化入口与 apply 侧收紧。

/** 沙箱里陪跑的 rules.yaml：反馈闭环**任何**路径都不许碰它，withOverlay 收尾逐字节断言。 */
const RULES_YAML_SENTINEL = 'noise_senders: []\n';

/**
 * 临时 overlay 沙箱：env 指向 tmp 文件、同目录放一份 rules.yaml 哨兵。`seed` 为 null 表示 overlay 文件
 * 不存在（首次 apply 的常态）。哨兵断言放在 `finally` 里——放 try 内会在 `fn` 抛出时被静默跳过。
 */
async function withOverlay(
  seed: string | null,
  fn: (overlay: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'noise-overlay-'));
  const overlay = join(dir, 'noise_senders.overlay');
  const rulesYaml = join(dir, 'rules.yaml');
  writeFileSync(rulesYaml, RULES_YAML_SENTINEL, 'utf8');
  if (seed !== null) {
    writeFileSync(overlay, seed, 'utf8');
  }
  const prevEnv = process.env.NOISE_OVERLAY_FILE;
  const prevRules = process.env.RULES_FILE;
  process.env.NOISE_OVERLAY_FILE = overlay;
  // **必须同时设 RULES_FILE**：否则 `resolveRulesPath()` 仍指向仓内真实 rules.yaml，沙箱里这份就是一个
  // 生产代码从不命名的**诱饵**——那句哨兵断言无论生产代码做什么都不会红（round-3 的路径闸绕过就是从
  // 这个缝里过的）。设了它，哨兵才真正守着「绝不碰人工维护的 rules.yaml」。
  process.env.RULES_FILE = rulesYaml;
  let sentinel: string | undefined;
  try {
    await fn(overlay, dir);
  } finally {
    sentinel = readFileSync(rulesYaml, 'utf8');
    if (prevEnv === undefined) {
      delete process.env.NOISE_OVERLAY_FILE;
    } else {
      process.env.NOISE_OVERLAY_FILE = prevEnv;
    }
    if (prevRules === undefined) {
      delete process.env.RULES_FILE;
    } else {
      process.env.RULES_FILE = prevRules;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  // 断言放在 env 还原与清理**之后**：放 finally 头部时，哨兵一旦触发会把 env 与 tmp 目录泄漏给后续全部用例。
  assert.equal(sentinel, RULES_YAML_SENTINEL, '反馈闭环绝不碰人工维护的 rules.yaml');
}

/** 取某 kind 事件的 payload，并断言该 kind **恰好 emit 一次**（view 数同 kind 个数，≠1 即失败）。 */
function payloadOf(ctx: { events: Array<{ kind: string; payload?: object }> }, kind: string): Record<string, string[]> {
  const hits = ctx.events.filter((e) => e.kind === kind);
  assert.equal(hits.length, 1, `${kind} 必须恰好 emit 一次（实际 ${hits.length} 次）`);
  return hits[0].payload as Record<string, string[]>;
}

/** 回执四桶必须与请求配分：added∪already_present == dedup(add)、removed∪not_present == dedup(remove)、四桶两两不交。 */
function assertReceiptPartition(p: Record<string, string[]>, add: string[], remove: string[]): void {
  assert.deepEqual([...p.added, ...p.already_present].sort(), [...new Set(add)].sort(), 'added ∪ already_present == add');
  assert.deepEqual([...p.removed, ...p.not_present].sort(), [...new Set(remove)].sort(), 'removed ∪ not_present == remove');
  const all = [...p.added, ...p.already_present, ...p.removed, ...p.not_present];
  assert.equal(new Set(all).size, all.length, '四桶两两不交');
}

function nfEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: ACCOUNT_ID,
    provider: 'gmail',
    providerMessageId: 'nf-1',
    subject: '普通主题',
    fromEmail: 'someone@neutral-domain.test',
    date: '2026-07-07T00:00:00.000Z',
    to: [],
    hasAttachments: false,
    headers: {},
    ...overrides,
  };
}

function nfClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    priority: 'P2',
    category: 'newsletter',
    should_notify_now: false,
    should_mark_read: true,
    should_include_digest: true,
    confidence: 0.9,
    reason: 'test',
    risk_flags: [],
    ...overrides,
  };
}

test('nf④ 可逆性（核心）：空 overlay 起 → add → remove 同一地址 → 文件字节回到 add 之前', async () => {
  await withOverlay('keep@a.com\nnoise@b.com\n', async (overlay) => {
    const before = readFileSync(overlay, 'utf8');

    const c1 = makeCtx('apply-feedback');
    c1.input = { add: ['new@c.com'], remove: [] };
    await run(c1, {});
    assert.deepEqual(payloadOf(c1, 'feedback.applied').added, ['new@c.com']);
    assert.equal(readFileSync(overlay, 'utf8'), 'keep@a.com\nnoise@b.com\nnew@c.com\n', '追加在末行');

    const c2 = makeCtx('apply-feedback');
    c2.input = { add: [], remove: ['new@c.com'] };
    await run(c2, {});
    assert.deepEqual(payloadOf(c2, 'feedback.applied').removed, ['new@c.com']);
    assert.equal(readFileSync(overlay, 'utf8'), before, 'add→remove 后 overlay 字节内容回到 add 之前');
  });

  // 字节等价只对 writeNoiseOverlayAtomic 写出的文件成立；人工编辑过的存量文件只保证集合等价。
  await withOverlay('KEEP@A.COM\n\nkeep@a.com', async (overlay) => {
    const c1 = makeCtx('apply-feedback');
    c1.input = { add: ['new@c.com'] };
    await run(c1, {});
    const c2 = makeCtx('apply-feedback');
    c2.input = { remove: ['new@c.com'] };
    await run(c2, {});
    assert.equal(readFileSync(overlay, 'utf8'), 'keep@a.com\n', '非 canonical 存量文件：集合等价（归一 + 去重），非字节等价');
  });
});

test('nf⑤ apply-feedback: add/add 与 remove/remove 各自幂等；四字段恒在（无变更也 emit []、且恰好一次）', async () => {
  await withOverlay('keep@a.com\n', async (overlay) => {
    const mtimeBefore = statSync(overlay).mtimeMs;

    const c0 = makeCtx('apply-feedback');
    c0.input = {};
    await run(c0, {});
    assert.deepEqual(
      payloadOf(c0, 'feedback.applied'),
      { added: [], already_present: [], removed: [], not_present: [] },
      '四字段恒在、无变更即 []（缺一个 view 就落 contract_mismatch）',
    );
    assert.equal(statSync(overlay).mtimeMs, mtimeBefore, '无变更不写');

    const c1 = makeCtx('apply-feedback');
    c1.input = { add: ['x@y.com'] };
    await run(c1, {});
    assert.deepEqual(payloadOf(c1, 'feedback.applied').added, ['x@y.com']);

    const c2 = makeCtx('apply-feedback');
    c2.input = { add: ['x@y.com'] };
    await run(c2, {});
    const p2 = payloadOf(c2, 'feedback.applied');
    assert.deepEqual(p2.added, [], '重发 add → added=[]');
    assert.deepEqual(p2.already_present, ['x@y.com'], '退化为 already_present');
    assertReceiptPartition(p2, ['x@y.com'], []);

    const c3 = makeCtx('apply-feedback');
    c3.input = { remove: ['x@y.com'] };
    await run(c3, {});
    assert.deepEqual(payloadOf(c3, 'feedback.applied').removed, ['x@y.com']);

    const c4 = makeCtx('apply-feedback');
    c4.input = { remove: ['x@y.com'] };
    await run(c4, {});
    const p4 = payloadOf(c4, 'feedback.applied');
    assert.deepEqual(p4.removed, [], '重发 remove → removed=[]');
    assert.deepEqual(p4.not_present, ['x@y.com'], '退化为 not_present');
    assertReceiptPartition(p4, [], ['x@y.com']);
  });
});

test('nf⑥ canonical 是同一个函数：同一未归一串，interpret 的 emit 与 apply 的写入逐字相同', async () => {
  await withOverlay(null, async (overlay) => {
    // interpret 收未归一串 → emit canonical 形态、不 throw。
    const ci = makeCtx('interpret-feedback');
    ci.input = { add: ['  <FOO@Example.COM>  '] };
    await run(ci, { repo: senderRepo([]) });
    const proposed = payloadOf(ci, 'interpretation.proposed').add;
    assert.deepEqual(proposed, ['foo@example.com'], 'trim → 去 <> → 小写');

    // 把 interpret 的输出原样投给 apply → 通过，且写入 bytes 与 emit 逐字相同。
    const ca = makeCtx('apply-feedback');
    ca.input = { add: proposed };
    await run(ca, {});
    assert.deepEqual(payloadOf(ca, 'feedback.applied').added, proposed, '回执与提案逐字相同');
    assert.equal(readFileSync(overlay, 'utf8'), `${proposed[0]}\n`, '确认页展示的 == 实际写入的');
  });
});

test('nf⑦ apply 拒非 canonical：未归一串直投 apply → throw、overlay 未变（interpret 收同一串则不 throw）', async () => {
  await withOverlay('keep@a.com\n', async (overlay) => {
    const before = readFileSync(overlay, 'utf8');
    const mtimeBefore = statSync(overlay).mtimeMs;
    for (const raw of ['  <FOO@Example.COM>  ', 'A@X.com', ' a@x.com', '<a@x.com>']) {
      const ctx = makeCtx('apply-feedback');
      ctx.input = { add: [raw] };
      await assert.rejects(run(ctx, {}), /含不合规项/, `未归一串 ${JSON.stringify(raw)} 必须 throw`);
    }
    assert.equal(readFileSync(overlay, 'utf8'), before, 'overlay 内容未变');
    assert.equal(statSync(overlay).mtimeMs, mtimeBefore, 'overlay 未被写（校验先于写）');
  });
});

test('nf⑧ apply 拒非法项与畸形 input；缺 key 视作 []（部署窗口里旧 view 只发 add）', async () => {
  await withOverlay('keep@a.com\n', async (overlay) => {
    const before = readFileSync(overlay, 'utf8');
    const mtimeBefore = statSync(overlay).mtimeMs;

    const illegal: unknown[] = [
      '', // 空
      'foo@', // 空域名
      '@b.com', // 空 local
      'a@@b.com', // 域名段含 @
      'no-dot', // 无点的裸串不是域名
      'a@x.1', // TLD 非纯字母
      'a@x.c', // TLD 不足 2 位
      'a b@x.com', // local 含空白
      'a@例子.com', // 非 ASCII（IDN v1 拒绝）
      'ctrl\u0001@x.com', // 控制字符（码位转义写，绝不贴字符本身）
      'x'.repeat(300) + '@y.com', // 超长
      1, // 非串
      null,
    ];
    for (const item of illegal) {
      const ctx = makeCtx('apply-feedback');
      ctx.input = { add: [item] };
      await assert.rejects(run(ctx, {}), /含不合规项/, `非法项 ${String(item)} 必须 throw`);
    }

    // key 存在但不是 string[] → throw（当空集会让「忽略畸形输入并回四个空桶」走成功路径）。
    for (const shape of [{ add: 'x' }, { remove: 42 }, { add: null }]) {
      const ctx = makeCtx('apply-feedback');
      ctx.input = shape;
      await assert.rejects(run(ctx, {}), /必须是 string\[\]/, `畸形 ${JSON.stringify(shape)} → throw`);
    }

    assert.equal(readFileSync(overlay, 'utf8'), before, 'overlay 内容未变');
    assert.equal(statSync(overlay).mtimeMs, mtimeBefore, 'overlay 未被写');

    // 缺 remove key → 正常应用，removed/not_present 为 []。
    const ok = makeCtx('apply-feedback');
    ok.input = { add: ['a@x.com'] };
    await run(ok, {});
    const p = payloadOf(ok, 'feedback.applied');
    assert.deepEqual(p.added, ['a@x.com']);
    assert.deepEqual(p.removed, [], '缺 remove key → []');
    assert.deepEqual(p.not_present, [], '缺 remove key → []');
  });
});

test('nf⑨ apply 拒同项冲突：add ∩ remove ≠ ∅ → throw、overlay 未变', async () => {
  await withOverlay('a@x.com\n', async (overlay) => {
    const before = readFileSync(overlay, 'utf8');
    const ctx = makeCtx('apply-feedback');
    ctx.input = { add: ['a@x.com'], remove: ['a@x.com'] };
    await assert.rejects(run(ctx, {}), /同一项同时出现在 add 与 remove/);
    assert.equal(readFileSync(overlay, 'utf8'), before, '拒绝时不写');
  });
});

test('nf⑩ interpret 不 throw：非法项/冲突项只是不出现在 emit 里，无写、run 正常结束', async () => {
  await withOverlay('keep@a.com\n', async (overlay) => {
    const mtimeBefore = statSync(overlay).mtimeMs;
    const ctx = makeCtx('interpret-feedback');
    ctx.input = {
      add: ['foo@', 'ctrl\u0001@x.com', 'a@例子.com', 'both@x.com', 'good@x.com', 1, null],
      remove: ['both@x.com', 'keep@a.com'],
    };
    await run(ctx, { repo: senderRepo([]) });
    const p = payloadOf(ctx, 'interpretation.proposed');
    assert.deepEqual(p.add, ['good@x.com'], '非法项与同项冲突项均不出现在 add');
    assert.deepEqual(p.remove, ['keep@a.com'], '冲突项不出现在 remove；remove 只提议真在名单里的');
    assert.equal(statSync(overlay).mtimeMs, mtimeBefore, 'interpret 全程无写');

    // 畸形 shape 在 interpret 侧也不 throw（fail-loud 由 apply 腿承担）。
    const bad = makeCtx('interpret-feedback');
    bad.input = { add: 'x' };
    await run(bad, { repo: senderRepo([]) });
    assert.deepEqual(payloadOf(bad, 'interpretation.proposed'), { add: [], remove: [] }, '畸形 → 两侧空、不 throw');
  });
});

test('nf⑪ 归一后去重：interpret 侧 A@X.com 与 a@x.com 只算一项；apply 侧同串重复只算一项', async () => {
  await withOverlay(null, async () => {
    const ci = makeCtx('interpret-feedback');
    ci.input = { add: ['A@X.com', 'a@x.com', '  <a@x.com>  '] };
    await run(ci, { repo: senderRepo([]) });
    assert.deepEqual(payloadOf(ci, 'interpretation.proposed').add, ['a@x.com'], '按归一后的值去重');

    const ca = makeCtx('apply-feedback');
    ca.input = { add: ['a@x.com', 'a@x.com'] };
    await run(ca, {});
    const p = payloadOf(ca, 'feedback.applied');
    assert.deepEqual(p.added, ['a@x.com']);
    assertReceiptPartition(p, ['a@x.com', 'a@x.com'], []);
  });
});

test('nf⑫ remove 不在名单 → not_present 命中、removed 为空、文件未变', async () => {
  await withOverlay('keep@a.com\n', async (overlay) => {
    const before = readFileSync(overlay, 'utf8');
    const mtimeBefore = statSync(overlay).mtimeMs;
    const ctx = makeCtx('apply-feedback');
    ctx.input = { remove: ['ghost@nowhere.com'] };
    await run(ctx, {});
    const p = payloadOf(ctx, 'feedback.applied');
    assert.deepEqual(p.removed, []);
    assert.deepEqual(p.not_present, ['ghost@nowhere.com']);
    assert.equal(readFileSync(overlay, 'utf8'), before, '文件未变');
    assert.equal(statSync(overlay).mtimeMs, mtimeBefore, '不产生写');
  });
});

test('nf⑬ apply 后即生效于规则引擎：非敏感 → P3；敏感邮件不被降温、仍不自动已读', async () => {
  await withOverlay(null, async (_overlay, dir) => {
    const ctx = makeCtx('apply-feedback');
    ctx.input = { add: ['nas@home.lan'] };
    await run(ctx, {});
    try {
      reloadRulesConfigForTest(join(dir, 'rules.yaml'));
      assert.ok(getActiveRules().noiseSenders.includes('nas@home.lan'), 'overlay 并入 noiseSenders');

      const quiet = applySafetyRules(
        nfEmail({ fromEmail: 'nas@home.lan', subject: '磁盘巡检完成' }),
        nfClassification({ priority: 'P2' }),
      );
      assert.equal(quiet.priority, 'P3', '非敏感邮件被降噪轴降到 P3');

      const sensitive = applySafetyRules(
        nfEmail({ fromEmail: 'nas@home.lan', subject: '医院预约提醒' }),
        nfClassification({ priority: 'P2' }),
      );
      assert.equal(sensitive.priority, 'P2', '敏感邮件不被降温（sensitiveGuardFired 门控语义不变）');
      assert.equal(sensitive.shouldMarkRead, false, '敏感邮件仍不自动标已读');
    } finally {
      resetRulesConfigForTest(); // 隔离：不把本用例的名单泄漏给同文件后续用例
    }
  });
});

// ─────────────── round-2 review 补的守卫（每条对应一处实测缺陷） ───────────────

test('nf⑭ 集合运算：一次 apply 同时含非空 add 与非空 remove（核心表达式，此前无人守）', async () => {
  await withOverlay('a@x.com\nb@x.com\nc@x.com\n', async (overlay) => {
    const ctx = makeCtx('apply-feedback');
    ctx.input = { add: ['new@x.com', 'a@x.com'], remove: ['b@x.com', 'ghost@x.com'] };
    await run(ctx, {});
    const p = payloadOf(ctx, 'feedback.applied');
    assert.deepEqual(p.added, ['new@x.com']);
    assert.deepEqual(p.already_present, ['a@x.com']);
    assert.deepEqual(p.removed, ['b@x.com']);
    assert.deepEqual(p.not_present, ['ghost@x.com']);
    assertReceiptPartition(p, ['new@x.com', 'a@x.com'], ['b@x.com', 'ghost@x.com']);
    assert.equal(readFileSync(overlay, 'utf8'), 'a@x.com\nc@x.com\nnew@x.com\n', '(existing ∪ add) \\ remove 一次原子写');
  });
});

test('nf⑮ overlay 读失败 → 写路径 fail-closed：apply 抛错不覆盖；提案腿不把「读不到」当「不在名单」', async () => {
  await withOverlay('silenced@boss.com\nkeep@a.com\n', async (overlay) => {
    const before = readFileSync(overlay, 'utf8');
    chmodSync(overlay, 0o000);
    try {
      // 写路径：读不到就拒绝改写，绝不把 [] 当「现有集为空」后全量覆盖。
      const cAdd = makeCtx('apply-feedback');
      cAdd.input = { add: ['new@d.com'] };
      await assert.rejects(run(cAdd, {}), /overlay 读取失败/, 'apply 必须 fail-closed');

      const cRm = makeCtx('apply-feedback');
      cRm.input = { remove: ['silenced@boss.com'] };
      await assert.rejects(run(cRm, {}), /overlay 读取失败/, 'remove 侧同样 fail-closed（否则回执谎报 not_present）');

      // 提案腿不 throw，但**也不提议**：读不到就无法知道 diff，而提议一份 apply 必然拒绝的变更
      // 会让用户确认后拿到 run.failed（契约两个字段表达不了「overlay 不可用」）。响亮失败由 apply 腿承担。
      const ci = makeCtx('interpret-feedback');
      ci.input = { remove: ['silenced@boss.com'] };
      await run(ci, { repo: senderRepo([]) });
      assert.deepEqual(
        payloadOf(ci, 'interpretation.proposed'),
        { add: [], remove: [] },
        '读不到时空提案（确认键置灰），绝不提议一份 apply 会拒的 diff',
      );
    } finally {
      chmodSync(overlay, 0o644);
    }
    assert.equal(readFileSync(overlay, 'utf8'), before, '全程未被改写');
  });
});

test('nf⑯ L = W：loader 认得的每一行都能经产品路径移除，且生效集不因本能力迁移', async () => {
  // 存量行的三种历史形态：`<>` 包裹、嵌套 `<>`、不合可加入判据的裸串——旧 writer 三种都写得出。
  await withOverlay('<alice@example.com>\n<<nested@example.com>>\nroot@nas\nkeep@a.com\n', async (overlay, dir) => {
    try {
      reloadRulesConfigForTest(join(dir, 'rules.yaml'));
      assert.deepEqual(
        getActiveRules().noiseSenders,
        ['<alice@example.com>', '<<nested@example.com>>', 'root@nas', 'keep@a.com'],
        '行归一是 trim+lower、**不剥 <>**：与 master 逐字节同语义，存量惰性行不因本能力转活',
      );

      // 产品路径：interpret 提案 → 把提案**逐字**喂进 apply（不手工构造 apply 输入）。
      // 产品路径：提案 → 逐字喂进 apply。三种存量形态都必须删得掉（L = W）。
      const ci = makeCtx('interpret-feedback');
      ci.input = { remove: ['<alice@example.com>', '<<nested@example.com>>', 'root@nas'] };
      await run(ci, { repo: senderRepo([]) });
      const proposed = payloadOf(ci, 'interpretation.proposed');
      assert.deepEqual(
        proposed.remove.sort(),
        ['<<nested@example.com>>', '<alice@example.com>', 'root@nas'],
        '三种存量形态都进得了提案',
      );

      const ca = makeCtx('apply-feedback');
      ca.input = { add: proposed.add, remove: proposed.remove };
      await run(ca, {});
      assert.equal(payloadOf(ca, 'feedback.applied').removed.length, 3);
      assert.equal(readFileSync(overlay, 'utf8'), 'keep@a.com\n', '真的删掉了');

      // 反向：同样的串走 add 仍被拒（只处理真正的邮箱）。
      const bad = makeCtx('apply-feedback');
      bad.input = { add: ['root@nas'] };
      await assert.rejects(run(bad, {}), /含不合规项/, 'add 侧仍要求可加入');
    } finally {
      resetRulesConfigForTest();
    }
  });
});

test('nf⑰ 存量条目可移除：master 期写进去的不合新规条目不得结构性锁死', async () => {
  await withOverlay('root@nas\nadmin@10.0.0.5\nkeep@a.com\n', async (overlay) => {
    // 产品路径：interpret → 取提案 → **逐字**喂进 apply。手工构造 apply 输入会绕过 interpret，
    // 那正是 round-3 让这条假绿的原因（提案腿当时把存量项静默丢了，而本用例没走它）。
    const ci = makeCtx('interpret-feedback');
    ci.input = { remove: ['root@nas', 'admin@10.0.0.5'] };
    await run(ci, { repo: senderRepo([]) });
    const proposed = payloadOf(ci, 'interpretation.proposed');
    assert.deepEqual(proposed.remove.sort(), ['admin@10.0.0.5', 'root@nas'], '提案腿不得把存量项丢掉');

    const ctx = makeCtx('apply-feedback');
    ctx.input = { add: proposed.add, remove: proposed.remove };
    await run(ctx, {});
    const p = payloadOf(ctx, 'feedback.applied');
    assert.deepEqual(p.removed.sort(), ['admin@10.0.0.5', 'root@nas'], 'remove 只要求归一幂等，不要求可加入');
    assert.equal(readFileSync(overlay, 'utf8'), 'keep@a.com\n');

    // 反向：同样的串走 add 仍必须被拒（只处理真正的邮箱）。
    const bad = makeCtx('apply-feedback');
    bad.input = { add: ['root@nas'] };
    await assert.rejects(run(bad, {}), /含不合规项/, 'add 侧仍要求完整合法性');
  });
});

test('nf⑱ 只处理真正的邮箱：mailto:/comment/括号一律拒；VERP 与 SRS 收', async () => {
  await withOverlay(null, async () => {
    for (const bad of ['mailto:alice@example.com', 'a(b)c@x.com', 'a[b]@x.com', 'a\\b@x.com']) {
      const ctx = makeCtx('apply-feedback');
      ctx.input = { add: [bad] };
      await assert.rejects(run(ctx, {}), /含不合规项/, `${bad} 在匹配侧永不命中，必须拒`);
    }
    const ok = makeCtx('apply-feedback');
    ok.input = { add: ['bounces+1=user.com@sendgrid.net', 'srs0=a=b=user@fwd.net', 'ops!tag@x.com'] };
    await run(ok, {});
    assert.equal(payloadOf(ok, 'feedback.applied').added.length, 3, 'VERP/SRS/atext 特殊字符照收');
  });
});

test('nf⑲ 写侧闸门：条数上限、字节上限、NOISE_OVERLAY_FILE 指向 rules.yaml 一律拒', async () => {
  await withOverlay(null, async (_overlay, dir) => {
    const many = makeCtx('apply-feedback');
    many.input = { add: Array.from({ length: 501 }, (_, i) => `u${i}@x.com`) };
    await assert.rejects(run(many, {}), /条目数超上限/);

    // 路径闸：把 NOISE_OVERLAY_FILE 指到**当前配置的** rules.yaml（故 RULES_FILE 同步指过去）。
    // 无此闸时实测会把人工 YAML 按 overlay 平铺格式整体重写、缩进结构毁掉，而 run 仍是绿的。
    const prevOverlay = process.env.NOISE_OVERLAY_FILE;
    const prevRules = process.env.RULES_FILE;
    process.env.NOISE_OVERLAY_FILE = join(dir, 'rules.yaml');
    process.env.RULES_FILE = join(dir, 'rules.yaml');
    try {
      const evil = makeCtx('apply-feedback');
      evil.input = { add: ['a@x.com'] };
      await assert.rejects(run(evil, {}), /指向了 rules.yaml/, '硬 MUST 要有结构约束，不能只靠注释');
    } finally {
      process.env.NOISE_OVERLAY_FILE = prevOverlay;
      if (prevRules === undefined) {
        delete process.env.RULES_FILE;
      } else {
        process.env.RULES_FILE = prevRules;
      }
    }
  });
});

test('nf⑳ {add:undefined} 属「键在但非 string[]」→ throw（两腿不得对同一 input 给相反语义）', async () => {
  await withOverlay('keep@a.com\n', async (overlay) => {
    const before = readFileSync(overlay, 'utf8');
    const ctx = makeCtx('apply-feedback');
    ctx.input = { add: undefined, remove: ['keep@a.com'] };
    await assert.rejects(run(ctx, {}), /必须是 string\[\]/);
    assert.equal(readFileSync(overlay, 'utf8'), before, '拒绝时不写');

    // 原型链上的 add 不得被当成请求（apply 自称不信调用方）。
    const polluted = Object.create({ add: ['attacker@evil.com'] }) as Record<string, unknown>;
    const proto = makeCtx('apply-feedback');
    proto.input = polluted;
    await run(proto, {});
    assert.deepEqual(payloadOf(proto, 'feedback.applied').added, [], '原型链属性不参与');
    assert.equal(readFileSync(overlay, 'utf8'), before, '未写入');
  });
});

test('nf㉑ 字节闸：写下去会越过 loader 上限 → 抛错不写（越限后 loader 会整份忽略 = 所有降噪失效）', async () => {
  // 种一份逼近 loader 上限的 overlay（每行 24B），再 add 到越限。
  const line = 'u000000000000@example.com';
  const rows = Math.floor((256 * 1024) / (line.length + 1)) - 2;
  const seed = Array.from({ length: rows }, (_, i) => `u${String(i).padStart(12, '0')}@example.com`).join('\n') + '\n';
  await withOverlay(seed, async (overlay) => {
    const before = readFileSync(overlay, 'utf8');
    const ctx = makeCtx('apply-feedback');
    ctx.input = { add: Array.from({ length: 10 }, (_, i) => `extra${i}@example.com`) };
    await assert.rejects(run(ctx, {}), /将超过 loader 上限/);
    assert.equal(readFileSync(overlay, 'utf8'), before, '拒绝时不写');
  });
});

test('nf㉒ 路径闸认文件身份而非路径字符串：硬链别名必须被拒（词法/realpath 都识别不出）', async () => {
  await withOverlay(null, async (_overlay, dir) => {
    const prevOverlay = process.env.NOISE_OVERLAY_FILE;
    // **硬链**别名：路径字符串完全不同、realpath 也不同，只有 dev+ino 认得出是同一个 inode。
    // 两个平台都成立——此前用 realpath 差异构造，在 Linux 上 aliasDir 退化为 dir 自身，CI 里零覆盖。
    const alias = join(dir, 'alias.overlay');
    linkSync(join(dir, 'rules.yaml'), alias);
    process.env.NOISE_OVERLAY_FILE = alias;
    try {
      const ctx = makeCtx('apply-feedback');
      ctx.input = { add: ['a@x.com'] };
      await assert.rejects(run(ctx, {}), /指向了 rules.yaml/, '硬链别名必须被 dev+ino 认出（词法与 realpath 都比不出来）');
    } finally {
      process.env.NOISE_OVERLAY_FILE = prevOverlay;
    }
  });
});

test('nf㉓ 提案腿也不得从原型链取键（此前只有 apply 腿挡住）', async () => {
  await withOverlay('keep@a.com\n', async (overlay) => {
    const mtimeBefore = statSync(overlay).mtimeMs;
    const polluted = Object.create({ add: ['attacker@evil.com'] }) as Record<string, unknown>;
    polluted.text = 'taobao';
    const ci = makeCtx('interpret-feedback');
    ci.input = polluted;
    await run(ci, { repo: senderRepo([{ fromEmail: 'noreply@taobao.com', count: 9 }]) });
    const p = payloadOf(ci, 'interpretation.proposed');
    assert.ok(!p.add.includes('attacker@evil.com'), '原型链上的 add 不得凭空造出提案');
    assert.deepEqual(p.add, ['noreply@taobao.com'], '自有的 text 才是这条 input 的真实意图');
    assert.equal(statSync(overlay).mtimeMs, mtimeBefore, '提案腿无写');
  });
});

test('nf㉔ 提案就是将写入的 diff：超条数/超字节时截断而非提议一份 apply 会拒的变更', async () => {
  await withOverlay(null, async () => {
    const ci = makeCtx('interpret-feedback');
    ci.input = { add: Array.from({ length: 600 }, (_, i) => `u${i}@example.com`) };
    await run(ci, { repo: senderRepo([]) });
    const proposed = payloadOf(ci, 'interpretation.proposed');
    assert.equal(proposed.add.length, 500, '截断到 apply 的条数上限');

    // 把提案逐字喂进 apply —— 必须被接受（这正是「提案 == 将写入的」这条契约）。
    const ca = makeCtx('apply-feedback');
    ca.input = { add: proposed.add, remove: proposed.remove };
    await run(ca, {});
    assert.equal(payloadOf(ca, 'feedback.applied').added.length, 500);
  });
});

test('nf㉕ 路径闸：大小写别名（APFS 默认大小写不敏感）—— realpath 也解不掉，只有 dev+ino 认得出', async () => {
  await withOverlay(null, async (_overlay, dir) => {
    const upper = join(dir, 'RULES.YAML'); // 与 rules.yaml 同一 inode（大小写不敏感盘）
    if (!existsSync(upper)) {
      // 大小写敏感盘（CI 的 Linux）上此别名不成立。硬链版本由 nf㉒ 覆盖，两平台都有网。
      return;
    }
    const prev = process.env.NOISE_OVERLAY_FILE;
    process.env.NOISE_OVERLAY_FILE = upper;
    try {
      const ctx = makeCtx('apply-feedback');
      ctx.input = { add: ['a@x.com'] };
      await assert.rejects(run(ctx, {}), /指向了 rules.yaml/, '大小写别名必须被 dev+ino 认出');
    } finally {
      process.env.NOISE_OVERLAY_FILE = prev;
    }
  });
});

test('nf㉖ 提案就是将写入的 diff：逼近 loader 字节上限时按字节截断（非只按条数）', async () => {
  const line = 'u000000000000@example.com'; // 25B + 换行
  const rows = Math.floor((256 * 1024) / (line.length + 1)) - 6;
  const seed = Array.from({ length: rows }, (_, i) => `u${String(i).padStart(12, '0')}@example.com`).join('\n') + '\n';
  await withOverlay(seed, async () => {
    // 只要 20 条（远低于 500 条上限），但字节预算只放得下少数几条。
    const ci = makeCtx('interpret-feedback');
    ci.input = { add: Array.from({ length: 20 }, (_, i) => `extra${String(i).padStart(8, '0')}@example.com`) };
    await run(ci, { repo: senderRepo([]) });
    const proposed = payloadOf(ci, 'interpretation.proposed');
    assert.ok(proposed.add.length < 20, `字节预算应截断提案（实际提议 ${proposed.add.length} 条）`);

    // 提案逐字喂进 apply 必须被接受 —— 这就是「提案 == 将写入的」。
    const ca = makeCtx('apply-feedback');
    ca.input = { add: proposed.add, remove: proposed.remove };
    await run(ca, {});
    assert.deepEqual(payloadOf(ca, 'feedback.applied').added, proposed.add);
  });
});

test('nf㉗ tmp 用 O_EXCL：预置成 rules.yaml 的硬链时，绝不截断 rules.yaml（O_NOFOLLOW 挡不住硬链）', async () => {
  await withOverlay('keep@a.com\n', async (overlay, dir) => {
    const rulesYaml = join(dir, 'rules.yaml');
    const before = readFileSync(rulesYaml, 'utf8');
    // 无法预知随机后缀 ⇒ 攻击面本身已消除；这里直接验「同名已存在即开失败、不截断」。
    const squat = `${overlay}.${process.pid}.deadbeefdead.tmp`;
    linkSync(rulesYaml, squat);
    try {
      const ctx = makeCtx('apply-feedback');
      ctx.input = { add: ['new@x.com'] };
      await run(ctx, {}); // 随机名绕开了蹲名，正常成功
      assert.equal(readFileSync(rulesYaml, 'utf8'), before, 'rules.yaml 逐字节未变');
      assert.equal(readFileSync(squat, 'utf8'), before, '被蹲的硬链也未被截断');
    } finally {
      rmSync(squat, { force: true });
    }
  });
});

test('nf㉘ apply 的 input 外层必须是普通对象：null / 标量 / 数组一律抛错，不得回四个空桶', async () => {
  await withOverlay('keep@a.com\n', async () => {
    for (const bad of [null, 42, 'x', ['a@x.com'], true]) {
      const ctx = makeCtx('apply-feedback');
      ctx.input = bad;
      await assert.rejects(run(ctx, {}), /input 必须是/, `${JSON.stringify(bad)} 必须抛错`);
    }
  });
});

test('nf㉙ add 侧非 ASCII 在归一前判：U+212A KELVIN 不得小写成 ASCII 后穿过校验', async () => {
  await withOverlay(null, async () => {
    const kelvin = 'a@Kayak.com'; // 小写后是纯 ASCII 的 a@kayak.com
    const ci = makeCtx('interpret-feedback');
    ci.input = { add: [kelvin] };
    await run(ci, { repo: senderRepo([]) });
    assert.deepEqual(payloadOf(ci, 'interpretation.proposed').add, [], '归一前即被非 ASCII 拒');

    const ca = makeCtx('apply-feedback');
    ca.input = { add: [kelvin] };
    await assert.rejects(run(ca, {}), /含不合规项/, 'apply 侧同样拒');
  });
});

test('nf㉚ {text} 腿与结构化腿同纪律：已在名单的候选不显示为「将加入」', async () => {
  await withOverlay('noreply@taobao.com\n', async () => {
    const ci = makeCtx('interpret-feedback');
    ci.input = { text: '把 taobao 加进降噪' };
    await run(ci, { repo: senderRepo([{ fromEmail: 'noreply@taobao.com', count: 9 }]) });
    assert.deepEqual(
      payloadOf(ci, 'interpretation.proposed').add,
      [],
      '已在 overlay 里 → 不是「将加入」（提案就是将写入的 diff）',
    );
  });
});
