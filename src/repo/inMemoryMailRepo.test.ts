// 离线自测（daily-digest task 2.5）：InMemoryMailRepo 的摘要候选查询 + 去重落库。
//
// 覆盖：候选过滤（未 mark / 排除未 processed / 缺分类行排除 / P0 与 P4 候选被排除 / 不受邮件年龄影响）
// + 确定性排序（fixture 用各异 receivedAt，避同刻并列时 in-memory(seq) vs prisma(cuid id) 排序差异）
// + markDigested 后不返回 + 重复 markDigested 同 (rowId,'daily') 不抛（钉「无唯一约束下 createMany 重插安全」）
// + 不破坏读侧去重。
//
// 谓词/排序与 PrismaMailRepo 一致（in-memory 实现镜像 prisma），故离线断言忠实。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prisma } from '../db/prisma.js';
import { InMemoryMailRepo } from './inMemoryMailRepo.js';
import { DIGEST_TYPE_DAILY, PrismaMailRepo, type AccountWriteInput } from './mailRepo.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'acct-1',
    provider: 'gmail',
    providerMessageId: 'msg-1',
    subject: '普通主题',
    fromEmail: 'sender@example.com',
    fromName: '发件人',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    textBody: '正文（不应进摘要投影）',
    htmlBody: '<p>正文</p>',
    hasAttachments: false,
    headers: {},
    ...overrides,
  };
}

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    priority: 'P2',
    category: 'work',
    should_notify_now: false,
    should_mark_read: true,
    should_include_digest: true,
    confidence: 0.9,
    reason: '测试分类原因',
    risk_flags: [],
    ...overrides,
  };
}

function makeDecision(overrides: Partial<FinalDecision> = {}): FinalDecision {
  return {
    priority: 'P2',
    category: 'work',
    confidence: 0.9,
    shouldNotifyNow: false,
    shouldMarkRead: true,
    shouldIncludeDigest: true,
    reason: '裁定原因',
    riskFlags: [],
    appliedRules: [],
    ...overrides,
  };
}

/**
 * 落一封邮件并（可选）分类 + 标已处理，返回 messageRowId。
 * priority/category/reason 来自 FinalDecision（裁定后最终值）。
 */
async function seedEmail(
  repo: InMemoryMailRepo,
  opts: {
    providerMessageId: string;
    accountId?: string; // 默认 'acct-1'（= makeEmail 默认）；水位线用例跨多账号时显式传
    date?: string;
    fromName?: string | null;
    fromEmail?: string;
    subject?: string;
    priority?: FinalDecision['priority'];
    reason?: string;
    classify?: boolean; // 默认 true；false → 不落分类行（缺分类行场景）
    processed?: boolean; // 默认 true；false → 不标已处理
  },
): Promise<string> {
  const emailOverrides: Partial<NormalizedEmail> = {
    providerMessageId: opts.providerMessageId,
  };
  if (opts.accountId !== undefined) emailOverrides.accountId = opts.accountId;
  if (opts.date !== undefined) emailOverrides.date = opts.date;
  if (opts.subject !== undefined) emailOverrides.subject = opts.subject;
  if (opts.fromEmail !== undefined) emailOverrides.fromEmail = opts.fromEmail;
  if (opts.fromName === null) {
    // fromName 缺省：构造一个不含 fromName 的 email（覆盖默认）。
    delete (emailOverrides as { fromName?: unknown }).fromName;
    const base = makeEmail(emailOverrides);
    delete (base as { fromName?: unknown }).fromName;
    const { id } = await repo.saveEmail(base);
    if (opts.classify !== false) {
      const priority = opts.priority ?? 'P2';
      await repo.saveClassification(
        id,
        makeClassification({ priority, reason: opts.reason ?? '裁定原因' }),
        makeDecision({ priority, reason: opts.reason ?? '裁定原因' }),
      );
    }
    if (opts.processed !== false) await repo.markProcessed(id);
    return id;
  }
  if (opts.fromName !== undefined) emailOverrides.fromName = opts.fromName;
  const { id } = await repo.saveEmail(makeEmail(emailOverrides));
  if (opts.classify !== false) {
    const priority = opts.priority ?? 'P2';
    await repo.saveClassification(
      id,
      makeClassification({ priority, reason: opts.reason ?? '裁定原因' }),
      makeDecision({ priority, reason: opts.reason ?? '裁定原因' }),
    );
  }
  if (opts.processed !== false) await repo.markProcessed(id);
  return id;
}

/**
 * 落一个账号行（水位线用例用）。processFrom 经 setProcessFrom 落具体值（含可早可晚双向）。
 * createAccount 默认 seed `new Date()`；传 processFrom 时再用 setProcessFrom 覆盖到确定值，
 * 使断言不依赖 wall-clock。不传 processFrom ⇒ 保留 createAccount 的默认 seed（接入瞬时）。
 */
async function seedAccount(
  repo: InMemoryMailRepo,
  opts: { id: string; provider?: 'imap' | 'gmail'; processFrom?: Date | null },
): Promise<void> {
  await repo.createAccount({
    id: opts.id,
    provider: opts.provider ?? 'gmail',
    email: `${opts.id}@example.com`,
    authJson: { refreshToken: 'tok', scopes: ['s'] },
  });
  // processFrom === null：把账号水位线显式置回 NULL（createAccount 已 seed 瞬时，需清回「不设下界」）。
  // 生产中 NULL 水位线账号经迁移默认 NULL（行存在但该列从未 seed）；setProcessFrom 只收 Date、置不回 NULL，
  // getAccountById 返回 {...row} 浅拷贝改它不动内部 Map——故就地改内部 Map 的 live 行还原该「行存在 + NULL」态。
  if (opts.processFrom === null) {
    const internal = (
      repo as unknown as { accountsById: Map<string, { processFrom: Date | null }> }
    ).accountsById;
    const liveRow = internal.get(opts.id);
    if (liveRow) liveRow.processFrom = null;
  } else if (opts.processFrom !== undefined) {
    await repo.setProcessFrom(opts.id, opts.processFrom);
  }
}

// 注：以下用例（尤其「重复 markDigested 不抛」与各 listDigestCandidates 用例）跑的是 InMemoryMailRepo —— 内存 JS 镜像，
// 非 PrismaMailRepo。Prisma 的 createMany（无唯一约束下重插容忍）与 findMany（digestItems 为空 + 嵌套 classifications take:1）
// 的 SQL 行为靠「结构等价 + schema」保证，真实 DB 验证延后到部署期（约定见 src/repo/mailRepo.ts）。
test('listDigestCandidates: 仅返回已处理、有分类、P1/P2/P3、未 mark 的邮件', async () => {
  const repo = new InMemoryMailRepo();
  const p1 = await seedEmail(repo, { providerMessageId: 'p1', priority: 'P1', date: '2026-06-01T00:00:00.000Z' });
  const p2 = await seedEmail(repo, { providerMessageId: 'p2', priority: 'P2', date: '2026-06-02T00:00:00.000Z' });
  const p3 = await seedEmail(repo, { providerMessageId: 'p3', priority: 'P3', date: '2026-06-03T00:00:00.000Z' });

  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(
    out.map((c) => c.messageRowId),
    [p1, p2, p3],
  );
  // 投影字段齐全、无 bodyText/htmlBody。
  const first = out[0]!;
  assert.equal(first.priority, 'P1');
  assert.equal(first.category, 'work');
  assert.equal(typeof first.subject, 'string');
  assert.equal(typeof first.fromEmail, 'string');
  assert.equal(first.reason, '裁定原因');
  assert.ok(!('bodyText' in first));
  assert.ok(!('htmlBody' in first));
});

test('listDigestCandidates: 排除未 processed 的邮件', async () => {
  const repo = new InMemoryMailRepo();
  await seedEmail(repo, { providerMessageId: 'np', priority: 'P1', processed: false });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.equal(out.length, 0);
});

test('listDigestCandidates: 缺分类行的已处理邮件被排除', async () => {
  const repo = new InMemoryMailRepo();
  const noCls = await seedEmail(repo, { providerMessageId: 'nocls', classify: false });
  const ok = await seedEmail(repo, { providerMessageId: 'ok', priority: 'P2' });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [ok]);
  assert.ok(!out.some((c) => c.messageRowId === noCls));
});

test('listDigestCandidates: P0 与 P4 候选被排除（只保留 P1/P2/P3）', async () => {
  const repo = new InMemoryMailRepo();
  const p0 = await seedEmail(repo, { providerMessageId: 'p0', priority: 'P0', date: '2026-06-01T00:00:00.000Z' });
  const p4 = await seedEmail(repo, { providerMessageId: 'p4', priority: 'P4', date: '2026-06-02T00:00:00.000Z' });
  const p1 = await seedEmail(repo, { providerMessageId: 'p1', priority: 'P1', date: '2026-06-03T00:00:00.000Z' });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [p1]);
  assert.ok(!out.some((c) => c.messageRowId === p0 || c.messageRowId === p4));
});

test('listDigestCandidates: 不受邮件年龄影响（很旧的邮件仍入候选）', async () => {
  const repo = new InMemoryMailRepo();
  // 远早于 24h 窗口的旧邮件（停机积压场景）。
  const old = await seedEmail(repo, { providerMessageId: 'old', priority: 'P1', date: '2020-01-01T00:00:00.000Z' });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [old]);
});

test('listDigestCandidates: 确定性排序（优先级档 P1<P2<P3、同档 receivedAt 升序）', async () => {
  const repo = new InMemoryMailRepo();
  // 故意乱序插入；fixture 各异 receivedAt 以避同刻并列下 seq/cuid 排序差异。
  const p2late = await seedEmail(repo, { providerMessageId: 'a', priority: 'P2', date: '2026-06-10T00:00:00.000Z' });
  const p1early = await seedEmail(repo, { providerMessageId: 'b', priority: 'P1', date: '2026-06-05T00:00:00.000Z' });
  const p3 = await seedEmail(repo, { providerMessageId: 'c', priority: 'P3', date: '2026-06-01T00:00:00.000Z' });
  const p2early = await seedEmail(repo, { providerMessageId: 'd', priority: 'P2', date: '2026-06-08T00:00:00.000Z' });
  const p1late = await seedEmail(repo, { providerMessageId: 'e', priority: 'P1', date: '2026-06-06T00:00:00.000Z' });

  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  // 期望：P1(05) P1(06) P2(08) P2(10) P3(01) —— 档优先、同档 receivedAt 升序。
  assert.deepEqual(
    out.map((c) => c.messageRowId),
    [p1early, p1late, p2early, p2late, p3],
  );
});

test('listDigestCandidates: markDigested 后该邮件不再返回（读侧存在性去重）', async () => {
  const repo = new InMemoryMailRepo();
  const a = await seedEmail(repo, { providerMessageId: 'a', priority: 'P1', date: '2026-06-01T00:00:00.000Z' });
  const b = await seedEmail(repo, { providerMessageId: 'b', priority: 'P2', date: '2026-06-02T00:00:00.000Z' });

  await repo.markDigested([a], DIGEST_TYPE_DAILY, new Date());
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [b]);
});

test('markDigested: 重复 mark 同 (rowId, daily) 不抛（无唯一约束下 createMany 重插安全）', async () => {
  const repo = new InMemoryMailRepo();
  const a = await seedEmail(repo, { providerMessageId: 'a', priority: 'P1' });
  await repo.markDigested([a], DIGEST_TYPE_DAILY, new Date());
  // 重插不抛（钉住「无唯一约束」假设；若后续加唯一约束须改 skipDuplicates）。
  await assert.doesNotReject(() => repo.markDigested([a], DIGEST_TYPE_DAILY, new Date()));
  // 仍被读侧存在性去重排除（≥1 行即排除，重复行无害）。
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.equal(out.length, 0);
});

test('markDigested: 不同 digestType 不互相去重（按 digestType 分命名空间）', async () => {
  const repo = new InMemoryMailRepo();
  const a = await seedEmail(repo, { providerMessageId: 'a', priority: 'P1' });
  await repo.markDigested([a], 'weekly', new Date());
  // 'weekly' 已 mark，但 'daily' 候选仍应包含它（按 digestType 分命名空间，不破坏读侧去重）。
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [a]);
});

test('listDigestCandidates: fromName 缺省时不带 fromName 字段', async () => {
  const repo = new InMemoryMailRepo();
  await seedEmail(repo, { providerMessageId: 'nf', priority: 'P1', fromName: null });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.equal(out.length, 1);
  assert.ok(!('fromName' in out[0]!));
});

// ───────────────────────── 摘要水位线下界（task 6.4，design 决策 2/9）─────────────────────────
// 「按账号 receivedAt 下界」而非固定年龄窗：排除接入前历史积压（receivedAt < processFrom），含界纳入，
// 停机期间收到（receivedAt >= processFrom）仍入。受测谓词 passesWatermark 是两 repo 单一真源（5.1），
// 故 InMemory 覆盖即覆盖两 repo 的判定逻辑（passesWatermark 五分支另由 watermark.test.ts 钉死）。

test('listDigestCandidates 水位线: 接入前积压排除（receivedAt < processFrom）', async () => {
  const repo = new InMemoryMailRepo();
  const WATERMARK = new Date('2026-06-10T00:00:00.000Z');
  await seedAccount(repo, { id: 'acct-w', processFrom: WATERMARK });
  // 接入前半年的历史积压：receivedAt 远早于水位线 → 排除（即便 processedAt != null）。
  await seedEmail(repo, {
    providerMessageId: 'old-backlog',
    accountId: 'acct-w',
    priority: 'P1',
    date: '2026-01-01T00:00:00.000Z',
  });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), []);
});

test('listDigestCandidates 水位线: 停机期间收到（receivedAt > processFrom）仍入摘要', async () => {
  const repo = new InMemoryMailRepo();
  const WATERMARK = new Date('2026-06-10T00:00:00.000Z');
  await seedAccount(repo, { id: 'acct-w', processFrom: WATERMARK });
  // 停机期间收到（receivedAt 在水位线之后）：按收到时间下界、不受「固定年龄窗」误删 → 纳入。
  const fresh = await seedEmail(repo, {
    providerMessageId: 'downtime-arrived',
    accountId: 'acct-w',
    priority: 'P1',
    date: '2026-06-15T00:00:00.000Z',
  });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [fresh]);
});

test('listDigestCandidates 水位线: 边界 receivedAt == processFrom 含界纳入', async () => {
  const repo = new InMemoryMailRepo();
  const WATERMARK = new Date('2026-06-10T08:30:00.000Z');
  await seedAccount(repo, { id: 'acct-w', processFrom: WATERMARK });
  // 同刻（同一毫秒）：边界含界（receivedAt >= processFrom）→ 纳入。
  const onBoundary = await seedEmail(repo, {
    providerMessageId: 'on-boundary',
    accountId: 'acct-w',
    priority: 'P2',
    date: '2026-06-10T08:30:00.000Z',
  });
  // 早 1ms：排除（确认边界判定是 >= 而非 >）。
  await seedEmail(repo, {
    providerMessageId: 'just-before',
    accountId: 'acct-w',
    priority: 'P2',
    date: '2026-06-10T08:29:59.999Z',
  });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [onBoundary]);
});

test('listDigestCandidates 水位线: 缺 Date 头 ⇒ receivedAt 回落、按回落值判下界', async () => {
  const repo = new InMemoryMailRepo();
  // InMemory 的 receivedAt = new Date(row.email.date)（与 prisma MailMessage.receivedAt 同一映射）。
  // email.date 不可解析（空串）⇒ new Date('') = Invalid Date ⇒ getTime() = NaN ⇒ NaN >= x 恒 false ⇒ 排除。
  // 这建模 spec「缺 Date 头回落 receivedAt」+「运维须盖到接入处理之后」：回落 receivedAt 早于/不可比时被下界排除。
  const WATERMARK = new Date('2026-06-10T00:00:00.000Z');
  await seedAccount(repo, { id: 'acct-w', processFrom: WATERMARK });
  await seedEmail(repo, {
    providerMessageId: 'no-date-header',
    accountId: 'acct-w',
    priority: 'P1',
    date: '', // 不可解析 → receivedAt 回落（NaN）→ 被水位线下界排除
  });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), []);

  // 对照：NULL 水位线账号下，同样缺 Date 头的邮件不受下界约束 → 仍入（不被静默丢）。
  await seedAccount(repo, { id: 'acct-null', processFrom: null });
  const nullAcctNoDate = await seedEmail(repo, {
    providerMessageId: 'no-date-null-acct',
    accountId: 'acct-null',
    priority: 'P1',
    date: '',
  });
  const out2 = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out2.map((c) => c.messageRowId), [nullAcctNoDate]);
});

test('listDigestCandidates 水位线: 同一调用混入 NULL 账号 + 非 NULL 账号，各自正确', async () => {
  const repo = new InMemoryMailRepo();
  const WATERMARK = new Date('2026-06-10T00:00:00.000Z');
  // 非 NULL 账号：水位线挡其接入前积压、放行停机期间邮件。
  await seedAccount(repo, { id: 'acct-wm', processFrom: WATERMARK });
  const wmOld = await seedEmail(repo, {
    providerMessageId: 'wm-old',
    accountId: 'acct-wm',
    priority: 'P1',
    date: '2026-01-01T00:00:00.000Z', // < 水位线 → 排除
  });
  const wmFresh = await seedEmail(repo, {
    providerMessageId: 'wm-fresh',
    accountId: 'acct-wm',
    priority: 'P2',
    date: '2026-06-20T00:00:00.000Z', // >= 水位线 → 纳入
  });
  // NULL 账号（行存在、processFrom 为 NULL）：不设下界——同样很旧的邮件仍入（不被混入的水位线误删）。
  await seedAccount(repo, { id: 'acct-null', processFrom: null });
  const nullOld = await seedEmail(repo, {
    providerMessageId: 'null-old',
    accountId: 'acct-null',
    priority: 'P3',
    date: '2026-01-01T00:00:00.000Z', // NULL 不设下界 → 纳入
  });

  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  const ids = new Set(out.map((c) => c.messageRowId));
  // 非 NULL 账号：旧的排除、新的纳入。
  assert.ok(!ids.has(wmOld), 'acct-wm 接入前积压被水位线排除');
  assert.ok(ids.has(wmFresh), 'acct-wm 停机期邮件纳入');
  // NULL 账号：旧的也纳入（不受混入的非 NULL 水位线波及）。
  assert.ok(ids.has(nullOld), 'NULL 账号旧邮件不设下界、纳入');
  assert.equal(out.length, 2);
});

test('listDigestCandidates 水位线: 候选 accountId 不在 processFrom map 中（disabled/并发删窗）不被静默丢（task 6.5）', async () => {
  // 闭合 design 决策 9 的残缺：纯函数单测只覆盖分支逻辑，未覆盖 map-build/lookup——
  // 当候选的 accountId 在 accountsById 中缺失（prisma 路径下：disabled 账号被 enabled-only map 漏掉，
  // 或两次 findMany 之间账号被并发删除），map.get(accountId) ⇒ undefined ⇒ passesWatermark 放行、不丢候选。
  // InMemory 同构：accountsById.get(accountId)?.processFrom ⇒ undefined（无账号行）⇒ 放行。
  const repo = new InMemoryMailRepo();
  // 故意**不** seedAccount —— 邮件的 accountId 'orphan-acct' 在 accountsById 中无对应行。
  const orphan = await seedEmail(repo, {
    providerMessageId: 'orphan-msg',
    accountId: 'orphan-acct',
    priority: 'P1',
    date: '2026-01-01T00:00:00.000Z', // 即便很旧：缺失 accountId ⇒ undefined ⇒ 放行（不被静默丢）
  });
  const out = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);
  assert.deepEqual(out.map((c) => c.messageRowId), [orphan]);
});

// ───────────────────────── 播种 / re-auth 水位线（task 6.6，design 决策 7）─────────────────────────
// seed-on-create / preserve-on-update / 只有 setProcessFrom 改既有。InMemory 须经 get-before-set 保留。

test('InMemory createAccount 播种 processFrom = 接入瞬时（new Date()）', async () => {
  const repo = new InMemoryMailRepo();
  const before = Date.now();
  await repo.createAccount({
    id: 'imap:u@h',
    provider: 'imap',
    email: 'u@h',
    authJson: { host: 'h', port: 993, user: 'u', password: 'p', tls: true },
  });
  const after = Date.now();
  const row = await repo.getAccountById('imap:u@h');
  assert.ok(row?.processFrom instanceof Date, 'createAccount seed 出 Date（非 NULL）');
  const t = row!.processFrom!.getTime();
  // 精确瞬时（new Date()）：落在 create 调用前后的 wall-clock 窗口内；非容器时区零点。
  assert.ok(t >= before && t <= after, 'processFrom 为接入瞬时、落在调用窗口内');
});

test('InMemory upsertAccount(create 分支) 首次接入 + 显式 processFrom 播种该值', async () => {
  const repo = new InMemoryMailRepo();
  // Gmail 首次接入未给 --process-from：upsert 走 create 分支 seed new Date()。
  const before = Date.now();
  await repo.upsertAccount({
    id: 'gmail:a@b',
    provider: 'gmail',
    email: 'a@b',
    authJson: { refreshToken: 'r', scopes: ['s'] },
  });
  const after = Date.now();
  const r1 = await repo.getAccountById('gmail:a@b');
  assert.ok(r1?.processFrom instanceof Date);
  assert.ok(r1!.processFrom!.getTime() >= before && r1!.processFrom!.getTime() <= after);

  // 另一账号显式给 processFrom：create 分支用 input.processFrom（非默认瞬时）。
  const explicit = new Date('2026-06-01T00:00:00.000Z');
  await repo.upsertAccount({
    id: 'gmail:c@d',
    provider: 'gmail',
    email: 'c@d',
    authJson: { refreshToken: 'r', scopes: ['s'] },
    processFrom: explicit,
  });
  const r2 = await repo.getAccountById('gmail:c@d');
  assert.equal(r2?.processFrom?.getTime(), explicit.getTime());
});

test('InMemory Gmail re-auth(upsert update 分支)经 get-before-set 保留既有 processFrom、不被 input 重置', async () => {
  const repo = new InMemoryMailRepo();
  const T0 = new Date('2026-06-05T12:34:56.000Z');
  // 首次接入并把水位线压到确定值 T0。
  await repo.upsertAccount({
    id: 'gmail:a@b',
    provider: 'gmail',
    email: 'a@b',
    authJson: { refreshToken: 'r0', scopes: ['s'] },
  });
  await repo.setProcessFrom('gmail:a@b', T0);

  // re-auth：同 id 再 upsert（走 update 分支），并**故意**在 input 携带一个不同的 processFrom，
  // 断言 get-before-set 一律忽略 input、保留 existing.T0（决策 7：update 不重置水位线）。
  await repo.upsertAccount({
    id: 'gmail:a@b',
    provider: 'gmail',
    email: 'a@b',
    authJson: { refreshToken: 'r1-rotated', scopes: ['s'] },
    processFrom: new Date('2020-01-01T00:00:00.000Z'), // 应被忽略
  });
  const row = await repo.getAccountById('gmail:a@b');
  assert.equal(row?.processFrom?.getTime(), T0.getTime(), 're-auth 保留 T0、忽略 input.processFrom');
  // 凭据确已轮转（确认 update 分支真的跑了、不是 no-op）。
  assert.deepEqual(row?.authJson, { refreshToken: 'r1-rotated', scopes: ['s'] });
});

test('InMemory IMAP --update(upsert update 分支)同样保留既有 processFrom', async () => {
  const repo = new InMemoryMailRepo();
  const T0 = new Date('2026-06-07T00:00:00.000Z');
  // IMAP 默认 add 经 createAccount 建行，再压水位线到 T0。
  await repo.createAccount({
    id: 'imap:u@h',
    provider: 'imap',
    email: 'u@h',
    authJson: { host: 'h', port: 993, user: 'u', password: 'p0', tls: true },
  });
  await repo.setProcessFrom('imap:u@h', T0);
  // IMAP --update 走 upsertAccount 的 update 分支（同 id 已存在）：保留 T0、忽略 input。
  await repo.upsertAccount({
    id: 'imap:u@h',
    provider: 'imap',
    email: 'u@h',
    authJson: { host: 'h', port: 993, user: 'u', password: 'p1', tls: true },
    processFrom: new Date('2020-01-01T00:00:00.000Z'), // 应被忽略
  });
  const row = await repo.getAccountById('imap:u@h');
  assert.equal(row?.processFrom?.getTime(), T0.getTime());
});

test('InMemory setProcessFrom 是唯一改既有行水位线的路径（无条件覆盖、可双向）', async () => {
  const repo = new InMemoryMailRepo();
  await repo.createAccount({
    id: 'imap:u@h',
    provider: 'imap',
    email: 'u@h',
    authJson: { host: 'h', port: 993, user: 'u', password: 'p', tls: true },
  });
  const forward = new Date('2026-06-20T00:00:00.000Z');
  await repo.setProcessFrom('imap:u@h', forward);
  assert.equal((await repo.getAccountById('imap:u@h'))?.processFrom?.getTime(), forward.getTime());
  // 双向：前移到更早日期（无单调守卫，spec「无条件覆盖」）。
  const backward = new Date('2026-06-01T00:00:00.000Z');
  await repo.setProcessFrom('imap:u@h', backward);
  assert.equal((await repo.getAccountById('imap:u@h'))?.processFrom?.getTime(), backward.getTime());
});

// Prisma 行创建/更新分支离线断言（task 6.6 的「Prisma 两路径」）。本项目无 Prisma 集成测试 harness
// （tsx --test 不连真库），且 tsx 的 ESM loader 不暴露 node:test 的 mock.module。改用「运行时替换共享
// prisma 单例的 mailAccount delegate」捕获 create/upsert 的 args——PrismaMailRepo 经 `import { prisma }`
// 持同一引用，替换后 lazy PrismaClient 永不发起真查询（无 DB、无网络、无新依赖）。断言：create 分支写
// processFrom（Date）、upsert.create 写 processFrom（Date）、upsert.update **省略** processFrom（= 列不动 = re-auth 保留）。
test('Prisma create/upsert 分支: create 含 processFrom、upsert.update 省略 processFrom（re-auth 保留）', async () => {
  const calls: Array<{ op: 'create' | 'upsert' | 'update'; args: Record<string, unknown> }> = [];
  const original = (prisma as { mailAccount: unknown }).mailAccount;
  (prisma as { mailAccount: unknown }).mailAccount = {
    create: async (args: Record<string, unknown>) => {
      calls.push({ op: 'create', args });
      return {};
    },
    upsert: async (args: Record<string, unknown>) => {
      calls.push({ op: 'upsert', args });
      return {};
    },
    update: async (args: Record<string, unknown>) => {
      calls.push({ op: 'update', args });
      return {};
    },
  };
  try {
    const repo = new PrismaMailRepo();
    const explicit = new Date('2026-06-01T00:00:00.000Z');

    // ① createAccount（IMAP 默认 add 的独立行创建）——默认 seed 精确瞬时。
    const imapInput: AccountWriteInput = {
      id: 'imap:u@h',
      provider: 'imap',
      email: 'u@h',
      authJson: { host: 'h', port: 993, user: 'u', password: 'p', tls: true },
    };
    await repo.createAccount(imapInput);

    // ② upsertAccount（Gmail 接入 / --update）——显式 processFrom 走 create 分支。
    await repo.upsertAccount({
      id: 'gmail:a@b',
      provider: 'gmail',
      email: 'a@b',
      authJson: { refreshToken: 'r', scopes: ['s'] },
      processFrom: explicit,
    });

    const createCall = calls.find((c) => c.op === 'create')!;
    assert.ok(createCall, 'createAccount 路由到 prisma.mailAccount.create');
    const createData = (createCall.args as { data: { processFrom: unknown } }).data;
    assert.ok(createData.processFrom instanceof Date, 'createAccount 行写 processFrom（Date、非 NULL）');

    const upsertCall = calls.find((c) => c.op === 'upsert')!;
    assert.ok(upsertCall, 'upsertAccount 路由到 prisma.mailAccount.upsert');
    const upsertArgs = upsertCall.args as {
      create: { processFrom?: unknown };
      update: Record<string, unknown>;
    };
    // create 分支写显式 processFrom。
    assert.ok(upsertArgs.create.processFrom instanceof Date, 'upsert.create 写 processFrom（Date）');
    assert.equal(
      (upsertArgs.create.processFrom as Date).getTime(),
      explicit.getTime(),
      'upsert.create 用显式 processFrom 值',
    );
    // update 分支**一律不含** processFrom —— Prisma 语义 = 列不动 = re-auth 保留既有水位线。
    assert.ok(
      !('processFrom' in upsertArgs.update),
      'upsert.update 省略 processFrom（re-auth 不重置水位线）',
    );
  } finally {
    // 还原共享单例 delegate（隔离：不污染其余用例 / 其它测试文件的同进程 import）。
    (prisma as { mailAccount: unknown }).mailAccount = original;
  }
});

// ─────────────── countRecentSenders（noise-discovery 决策 5：Top-N 频率快照数据源） ───────────────
// 与 listDigestCandidates 的关键区别：含所有优先级（P0–P4）、不经 digestItems 去重、不读分类档（纯按
// receivedAt 窗 + processedAt 聚合归一 fromEmail 计数）。窗口由调用方传 since（buildDigest 派生 now-N天）。

test('countRecentSenders: 含 P0/P4（不像 listDigestCandidates 丢弃告警类）', async () => {
  const repo = new InMemoryMailRepo();
  const since = new Date('2026-06-01T00:00:00.000Z');
  await seedEmail(repo, { providerMessageId: 'p0', priority: 'P0', fromEmail: 'alert@nas.local', date: '2026-06-10T00:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'p4', priority: 'P4', fromEmail: 'code@bank.com', date: '2026-06-10T01:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'p2', priority: 'P2', fromEmail: 'news@list.com', date: '2026-06-10T02:00:00.000Z' });

  const counts = await repo.countRecentSenders(since);
  const byAddr = new Map(counts.map((c) => [c.fromEmail, c.count]));
  // P0/P4 必须计入（listDigestCandidates 会把它们丢弃 → 此处证明未复用它）。
  assert.equal(byAddr.get('alert@nas.local'), 1, 'P0 应计入');
  assert.equal(byAddr.get('code@bank.com'), 1, 'P4 应计入');
  assert.equal(byAddr.get('news@list.com'), 1, 'P2 应计入');
});

test('countRecentSenders: 不经 digestItems 去重（已摘要邮件仍计数）', async () => {
  const repo = new InMemoryMailRepo();
  const since = new Date('2026-06-01T00:00:00.000Z');
  const a = await seedEmail(repo, { providerMessageId: 'a', priority: 'P2', fromEmail: 'noisy@x.com', date: '2026-06-05T00:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'b', priority: 'P2', fromEmail: 'noisy@x.com', date: '2026-06-06T00:00:00.000Z' });
  // 把其中一封标记已进摘要 → listDigestCandidates 会排除它，但 countRecentSenders 必须仍计数。
  await repo.markDigested([a], DIGEST_TYPE_DAILY, new Date());

  const counts = await repo.countRecentSenders(since);
  assert.equal(counts.find((c) => c.fromEmail === 'noisy@x.com')?.count, 2, '已摘要的邮件不应被去重排除');
});

test('countRecentSenders: 发件人归一（显示名/大小写裂变收敛为同一裸地址）', async () => {
  const repo = new InMemoryMailRepo();
  const since = new Date('2026-06-01T00:00:00.000Z');
  await seedEmail(repo, { providerMessageId: 'v1', fromEmail: 'Alice <Boss@Corp.com>', date: '2026-06-05T00:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'v2', fromEmail: 'boss@corp.com', date: '2026-06-06T00:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'v3', fromEmail: '<BOSS@corp.com>', date: '2026-06-07T00:00:00.000Z' });

  const counts = await repo.countRecentSenders(since);
  assert.equal(counts.length, 1, '三种变体应归一为一条');
  assert.deepEqual(counts[0], { fromEmail: 'boss@corp.com', count: 3 });
});

test('countRecentSenders: 窗口外（receivedAt < since）与未处理邮件被排除', async () => {
  const repo = new InMemoryMailRepo();
  const since = new Date('2026-06-10T00:00:00.000Z');
  await seedEmail(repo, { providerMessageId: 'old', fromEmail: 'old@x.com', date: '2026-06-01T00:00:00.000Z' }); // 窗外
  await seedEmail(repo, { providerMessageId: 'unproc', fromEmail: 'pending@x.com', date: '2026-06-15T00:00:00.000Z', processed: false }); // 未处理
  await seedEmail(repo, { providerMessageId: 'in', fromEmail: 'in@x.com', date: '2026-06-15T00:00:00.000Z' });

  const counts = await repo.countRecentSenders(since);
  assert.deepEqual(counts, [{ fromEmail: 'in@x.com', count: 1 }], '仅窗内已处理邮件计入');
});

test('countRecentSenders: 降序 + 空/非法发件人丢弃 + 无邮件返回 []', async () => {
  const repo = new InMemoryMailRepo();
  const since = new Date('2026-06-01T00:00:00.000Z');
  assert.deepEqual(await repo.countRecentSenders(since), [], '无邮件 → []');

  await seedEmail(repo, { providerMessageId: 'h1', fromEmail: 'hi@x.com', date: '2026-06-05T00:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'h2', fromEmail: 'hi@x.com', date: '2026-06-05T01:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'l1', fromEmail: 'lo@x.com', date: '2026-06-05T02:00:00.000Z' });
  await seedEmail(repo, { providerMessageId: 'junk', fromEmail: 'not-an-address', date: '2026-06-05T03:00:00.000Z' }); // 非法 → 丢弃

  const counts = await repo.countRecentSenders(since);
  assert.deepEqual(counts, [
    { fromEmail: 'hi@x.com', count: 2 },
    { fromEmail: 'lo@x.com', count: 1 },
  ], '降序 + 非法地址丢弃');
});
