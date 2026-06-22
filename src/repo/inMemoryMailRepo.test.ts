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

import { InMemoryMailRepo } from './inMemoryMailRepo.js';
import { DIGEST_TYPE_DAILY } from './mailRepo.js';
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
