// pipeline run() self-check（migration §2.4 / §3.1 / §3.3 / §4.4）。
//
// 非空断言纪律（tasks 2.4）：驱动**真实** run() 全链路（fetch→classify→rules→save→executeActions→
// markProcessed），只注入 fake gmail / fake notifier / in-memory repo / classify spy——**不 stub**
// executeActions / emit / classify seam。断言读真实 emit 的 RunEvent（ctx.events）与真实 repo 状态、
// spy 计到的真实 classify 调用数。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('nf④ apply-feedback: set-union 幂等 + 原子写产文件 + added/already_present + 归一/去重/非串丢弃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'noise-overlay-'));
  const overlay = join(dir, 'noise_senders.overlay');
  const prevEnv = process.env.NOISE_OVERLAY_FILE;
  process.env.NOISE_OVERLAY_FILE = overlay;
  try {
    // 首次 apply：全部新增、原子写产文件。
    const ctx1 = makeCtx('apply-feedback');
    ctx1.input = { add: ['a@x.com', 'b@y.com'] };
    await run(ctx1, {});
    const p1 = ctx1.events.find((e) => e.kind === 'feedback.applied')!.payload as {
      added: string[];
      already_present: string[];
    };
    assert.deepEqual(p1.added, ['a@x.com', 'b@y.com'], '首次全部 added');
    assert.deepEqual(p1.already_present, [], '首次无 already_present');
    assert.deepEqual(readFileSync(overlay, 'utf8').trim().split('\n').sort(), ['a@x.com', 'b@y.com'], 'overlay 文件含并集');

    // 重发同一 add：幂等 → added=[]、already_present=全部、文件不变。
    const ctx2 = makeCtx('apply-feedback');
    ctx2.input = { add: ['a@x.com', 'b@y.com'] };
    await run(ctx2, {});
    const p2 = ctx2.events.find((e) => e.kind === 'feedback.applied')!.payload as {
      added: string[];
      already_present: string[];
    };
    assert.deepEqual(p2.added, [], '重发 → added=[]（set-union 幂等）');
    assert.deepEqual(p2.already_present.sort(), ['a@x.com', 'b@y.com'], '重发 → already_present=全部');
    assert.deepEqual(readFileSync(overlay, 'utf8').trim().split('\n').sort(), ['a@x.com', 'b@y.com'], '文件不变');

    // 增量 apply：部分新增、部分已在；42/空白丢弃、C@Z.COM 归一后与 c 去重。
    const ctx3 = makeCtx('apply-feedback');
    ctx3.input = { add: ['b@y.com', 'c@z.com', 42, '  ', 'C@Z.COM'] };
    await run(ctx3, {});
    const p3 = ctx3.events.find((e) => e.kind === 'feedback.applied')!.payload as {
      added: string[];
      already_present: string[];
    };
    assert.deepEqual(p3.added, ['c@z.com'], '仅 c 新增（非串/空白丢弃、大小写归一去重）');
    assert.deepEqual(p3.already_present, ['b@y.com'], 'b 已在');
    assert.deepEqual(
      readFileSync(overlay, 'utf8').trim().split('\n').sort(),
      ['a@x.com', 'b@y.com', 'c@z.com'],
      'overlay 增量并集',
    );
  } finally {
    if (prevEnv === undefined) {
      delete process.env.NOISE_OVERLAY_FILE;
    } else {
      process.env.NOISE_OVERLAY_FILE = prevEnv;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
