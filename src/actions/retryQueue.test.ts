// drainAccountRetries 单测（durable-retry tasks 3.4，node:test）。
//
// 注入假 provider/notifier/时钟/repo/deadline，离线断言 drain 的状态推进与隔离语义：
//   - 到期项被重试至 done；
//   - 持续失败按长程退避推进 retryCount 直至 dead_letter（恰好 6 次、retryCount 达 6）；
//   - 超 staleness 的 notify 直接 dead_letter 不补发；markRead 过 24h 仍重试不进死信；
//   - 永久重建失败（行缺失/JSON 损坏）→ dead_letter 不崩；
//   - 瞬时 DB 错误（selectDueRetries 抛出）→ 保持 retrying、不死信、不推进 retryCount、向上传播；
//   - reauth（第 k 条）→ 重新抛出停整轮、其后未试行不动、行保持 retrying；
//   - 普通瞬时异常逐条隔离不停整轮；
//   - drain 有界（>cap 只处理 cap；超软 deadline 提前退出、剩余下轮）。
//
// 不接真实 provider/网络；不发送邮件。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { drainAccountRetries, type DrainDeps, type DrainDeadline } from './retryQueue.js';
import { ActionType, ActionStatus } from './actionTypes.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import { InMemoryMailRepo, type ActionRow } from '../repo/inMemoryMailRepo.js';
import {
  MAX_DURABLE_ATTEMPTS,
  NOTIFY_STALENESS_MS,
  DRAIN_BATCH_CAP,
  durableBackoffMs,
} from './retryConstants.js';
import type { ProviderActions } from './providerActions.js';
import type { Notifier, NotifyResult } from '../notify/notifier.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { Classification } from '../classifier/schema.js';
import type { MailRepo } from '../repo/mailRepo.js';

const ACCOUNT_ID = 'acct-1';
const NOW = new Date('2026-06-23T00:00:00.000Z');

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    priority: 'P0',
    category: 'security',
    should_notify_now: true,
    should_mark_read: false,
    should_include_digest: false,
    confidence: 0.9,
    reason: '测试分类',
    risk_flags: [],
    ...overrides,
  };
}

function makeDecision(overrides: Partial<FinalDecision> = {}): FinalDecision {
  return {
    priority: 'P0',
    category: 'security',
    confidence: 0.9,
    shouldNotifyNow: true,
    shouldMarkRead: false,
    shouldIncludeDigest: false,
    reason: '测试裁定',
    riskFlags: [],
    appliedRules: [],
    ...overrides,
  };
}

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: ACCOUNT_ID,
    provider: 'gmail',
    providerMessageId: 'pmsg-1',
    subject: '主题',
    fromEmail: 'sender@example.com',
    fromName: '发件人',
    to: ['me@example.com'],
    date: NOW.toISOString(),
    hasAttachments: false,
    headers: {},
    ...overrides,
  };
}

/** 固定时钟（可注入假时刻；不真实推进）。 */
function fixedClock(at: Date = NOW): () => Date {
  return () => at;
}

/** 不超预算的软 deadline（elapsedMs 恒 0 < budget）。 */
function noBudgetPressure(): DrainDeadline {
  return { elapsedMs: () => 0, budgetMs: 60_000 };
}

/**
 * 在 InMemoryMailRepo 里播种一条 `retrying` 动作并返回其 actionRowId（经 repo 自身路径：
 * upsertAccount → saveEmail → saveClassification → recordAction → enqueueRetry，最忠实）。
 */
async function seedRetrying(
  repo: InMemoryMailRepo,
  opts: {
    actionType: (typeof ActionType)[keyof typeof ActionType];
    retryCount: number;
    providerMessageId?: string;
    date?: string;
    classification?: Classification;
    decision?: FinalDecision;
    nextRetryAt?: Date;
  },
): Promise<string> {
  await repo.upsertAccount({
    id: ACCOUNT_ID,
    provider: 'gmail',
    email: 'me@example.com',
    authJson: { refreshToken: 'x', scopes: [] },
  });
  const email = makeEmail({
    providerMessageId: opts.providerMessageId ?? 'pmsg-1',
    date: opts.date ?? NOW.toISOString(),
  });
  const stored = await repo.saveEmail(email);
  await repo.saveClassification(
    stored.id,
    opts.classification ?? makeClassification(),
    opts.decision ?? makeDecision(),
  );
  const { actionRowId } = await repo.recordAction(stored.id, opts.actionType);
  await repo.enqueueRetry(
    actionRowId,
    opts.retryCount,
    opts.nextRetryAt ?? new Date(NOW.getTime() - 1000),
    'seed',
  );
  return actionRowId;
}

function findAction(repo: InMemoryMailRepo, actionRowId: string): ActionRow {
  const row = repo.actions.find((a) => a.id === actionRowId);
  assert.ok(row, `actionRowId ${actionRowId} 应存在`);
  return row;
}

/** 永远成功（reflectPriority/markRead 不抛、notify→sent）的假 provider/notifier。 */
function okProvider(): ProviderActions {
  return {
    async reflectPriority(): Promise<void> {},
    async markRead(): Promise<void> {},
  };
}
function sentNotifier(): Notifier & { calls: number } {
  const n = {
    calls: 0,
    async notify(): Promise<NotifyResult> {
      n.calls += 1;
      return { outcome: 'sent', channel: 'fake' };
    },
    async notifyDigest(): Promise<NotifyResult> {
      return { outcome: 'sent', channel: 'fake' };
    },
  };
  return n;
}

/**
 * 用一个 selectDueRetries 覆盖包裹真实 repo（其余方法忠实委派）。
 * 注意：`{ ...repo }` **不**复制原型方法（InMemoryMailRepo 方法在原型上），故须用 Object.create
 * 继承原型再覆盖单方法，否则 drain 调 updateAction/enqueueRetry 会命中 undefined。
 */
function withSelectDueRetries(
  repo: InMemoryMailRepo,
  override: MailRepo['selectDueRetries'],
): MailRepo {
  const wrapped = Object.create(repo) as MailRepo;
  wrapped.selectDueRetries = override;
  return wrapped;
}

/** 默认 deps（成功 provider/notifier、固定时钟、无预算压力）；可逐字段覆盖。 */
function makeDeps(repo: MailRepo, overrides: Partial<DrainDeps> = {}): DrainDeps {
  return {
    provider: okProvider(),
    notifier: sentNotifier(),
    repo,
    clock: fixedClock(),
    deadline: noBudgetPressure(),
    ...overrides,
  };
}

// ── 1. 到期项被重试至 done ──
test('到期 retrying 动作被重试至 done', async () => {
  const repo = new InMemoryMailRepo();
  const id = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
  });
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo));
  assert.equal(findAction(repo, id).status, ActionStatus.Done);
});

test('到期 notify 动作重试成功落 done', async () => {
  const repo = new InMemoryMailRepo();
  const notifier = sentNotifier();
  const id = await seedRetrying(repo, { actionType: ActionType.Notify, retryCount: 0 });
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { notifier }));
  assert.equal(findAction(repo, id).status, ActionStatus.Done);
  assert.equal(notifier.calls, 1);
});

// ── M1: redispatch 成功但 advanceSuccess(done-写入)瞬时失败 → 向上传播、动作不被重发/重新入队 ──
test('redispatch 成功但 updateAction(done) 抛出 → repo-I/O 向上传播、notify 不重发、行不推进', async () => {
  const repo = new InMemoryMailRepo();
  const notifier = sentNotifier();
  const id = await seedRetrying(repo, { actionType: ActionType.Notify, retryCount: 0 });
  // 包裹 repo：updateAction('done') 抛一次瞬时 repo-I/O 错误（其余方法忠实委派给真实 repo）。
  const wrapped = Object.create(repo) as MailRepo;
  wrapped.updateAction = async (rowId, status, error) => {
    if (status === 'done') {
      throw new Error('transient-db-io');
    }
    return repo.updateAction(rowId, status, error);
  };
  // drain **向上传播** done-写入的 repo-I/O 错误（同 selectDueRetries 抛出语义），绝不当作发送失败重入推进。
  await assert.rejects(
    drainAccountRetries(ACCOUNT_ID, makeDeps(wrapped, { notifier })),
    /transient-db-io/,
  );
  assert.equal(notifier.calls, 1, 'notify 仅发一次、未因 done-写入失败被重发');
  const row = findAction(repo, id);
  assert.equal(row.status, ActionStatus.Retrying, '行保持 retrying（done 写入失败、未落终态）');
  assert.equal(row.retryCount, 0, 'retryCount 未推进（done-写入失败≠发送失败，不重新入队/误死信）');
});

// ── 2. 普通瞬时失败按长程退避推进 retryCount，恰好 6 次后 dead_letter ──
test('持续失败按长程退避推进 retryCount 直至 dead_letter（恰好 6 次、retryCount 达 6）', async () => {
  const repo = new InMemoryMailRepo();
  const id = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
  });
  // 始终瞬时失败的 provider（reflectPriority 抛普通错误）。
  const failingProvider: ProviderActions = {
    async reflectPriority(): Promise<void> {
      throw new Error('transient');
    },
    async markRead(): Promise<void> {},
  };

  // 可推进的假时钟：每轮把 now 推到上一轮 nextRetryAt（使该行仍到期被选中），断言 nextRetryAt
  // = 本轮 now + backoff(retryCount)。
  let nowMs = NOW.getTime();
  const advancingDeps = () =>
    makeDeps(repo, { provider: failingProvider, clock: () => new Date(nowMs) });

  // 逐轮 drain：retryCount 0→1→2→3→4→5（每轮一次推进，保持 retrying），第 6 轮 5→6 落 dead_letter。
  const expectedCounts = [1, 2, 3, 4, 5];
  for (const expected of expectedCounts) {
    const roundNow = nowMs;
    await drainAccountRetries(ACCOUNT_ID, advancingDeps());
    const row = findAction(repo, id);
    assert.equal(row.status, ActionStatus.Retrying, `retryCount=${expected} 仍 retrying`);
    assert.equal(row.retryCount, expected);
    assert.ok(row.nextRetryAt, 'retrying 行应有 nextRetryAt');
    // nextRetryAt = 本轮 now + durableBackoffMs(retryCount)（长程退避落时间维度、不轮内 sleep）。
    assert.equal(
      row.nextRetryAt.getTime(),
      roundNow + durableBackoffMs(expected),
      `nextRetryAt 应为 now + backoff(${expected})`,
    );
    // 推进时钟到本轮 nextRetryAt（下轮该行仍到期）。
    nowMs = row.nextRetryAt.getTime();
  }
  // 此时 retryCount=5；第 6 次 drain → 5+1=6 ≥ MAX(6) → dead_letter（恰好 6 次 drain 重试）。
  assert.equal(MAX_DURABLE_ATTEMPTS, 6);
  await drainAccountRetries(ACCOUNT_ID, advancingDeps());
  const dead = findAction(repo, id);
  assert.equal(dead.status, ActionStatus.DeadLetter);
  assert.equal(dead.nextRetryAt, null, 'dead_letter 清空 nextRetryAt');
  // max-attempts 死亡落**推进后**的 retryCount=MAX(6)（触发死亡的那次计数），非 MAX-1。
  assert.equal(dead.retryCount, MAX_DURABLE_ATTEMPTS, 'dead_letter 行记 retryCount=MAX(6)');
});

// ── 3. notify staleness 上界 ──
test('超 staleness 的 notify 直接 dead_letter 不补发', async () => {
  const repo = new InMemoryMailRepo();
  const notifier = sentNotifier();
  // receivedAt = now - (staleness + 1h) → 超界。
  const stale = new Date(NOW.getTime() - NOTIFY_STALENESS_MS - 3_600_000);
  const id = await seedRetrying(repo, {
    actionType: ActionType.Notify,
    retryCount: 2, // 非零：锁定「staleness 死亡不推进 retryCount」（区别于 max-attempts 死亡 +1）。
    date: stale.toISOString(),
  });
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { notifier }));
  const dead = findAction(repo, id);
  assert.equal(dead.status, ActionStatus.DeadLetter);
  assert.equal(notifier.calls, 0, '超 staleness 不补发（notify 未被调用）');
  assert.equal(dead.retryCount, 2, 'staleness 死亡记当前 retryCount（未推进，非 max-attempts）');
});

test('markRead 过 24h 仍重试不进死信（无 staleness 上界）', async () => {
  const repo = new InMemoryMailRepo();
  // receivedAt = now - 48h（远超 24h），但 markRead 无 staleness 上界。
  const old = new Date(NOW.getTime() - 48 * 3_600_000);
  const id = await seedRetrying(repo, {
    actionType: ActionType.MarkRead,
    retryCount: 0,
    date: old.toISOString(),
    classification: makeClassification({ should_mark_read: true }),
    decision: makeDecision({ shouldMarkRead: true }),
  });
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo));
  // markRead 成功 → done（绝不因 staleness 进 dead_letter）。
  assert.equal(findAction(repo, id).status, ActionStatus.Done);
});

test('markRead 过 24h 持续失败仍重试推进（不因 staleness 进死信）', async () => {
  const repo = new InMemoryMailRepo();
  const old = new Date(NOW.getTime() - 48 * 3_600_000);
  const id = await seedRetrying(repo, {
    actionType: ActionType.MarkRead,
    retryCount: 0,
    date: old.toISOString(),
  });
  const failingProvider: ProviderActions = {
    async reflectPriority(): Promise<void> {},
    async markRead(): Promise<void> {
      throw new Error('transient');
    },
  };
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { provider: failingProvider }));
  const row = findAction(repo, id);
  // 仍 retrying（推进 retryCount），不因 24h 进死信。
  assert.equal(row.status, ActionStatus.Retrying);
  assert.equal(row.retryCount, 1);
});

// ── 4. 永久重建失败 → dead_letter 不崩 ──
test('永久重建失败（缺分类行）→ dead_letter 不崩', async () => {
  const repo = new InMemoryMailRepo();
  await repo.upsertAccount({
    id: ACCOUNT_ID,
    provider: 'gmail',
    email: 'me@example.com',
    authJson: { refreshToken: 'x', scopes: [] },
  });
  const stored = await repo.saveEmail(makeEmail());
  // 不调 saveClassification → selectDueRetries 重建得 rebuild.ok===false（永久）。
  const { actionRowId } = await repo.recordAction(stored.id, ActionType.Notify);
  // 非零 retryCount：锁定「永久重建失败死亡不推进 retryCount」。
  await repo.enqueueRetry(actionRowId, 3, new Date(NOW.getTime() - 1000), 'seed');

  await assert.doesNotReject(drainAccountRetries(ACCOUNT_ID, makeDeps(repo)));
  const dead = findAction(repo, actionRowId);
  assert.equal(dead.status, ActionStatus.DeadLetter);
  assert.equal(dead.retryCount, 3, '永久重建失败死亡记当前 retryCount（未推进）');
});

// ── 5. 瞬时 DB 错误（selectDueRetries 抛出）→ 保持 retrying、不死信、不推进、向上传播 ──
test('瞬时 DB 错误（selectDueRetries 抛出）→ 向上传播、行保持 retrying 不推进不死信', async () => {
  const repo = new InMemoryMailRepo();
  const id = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 2,
  });
  // 包一层 repo：selectDueRetries 抛瞬时 DB I/O 错误（pool 超时模拟），其余透传。
  const flakyRepo = withSelectDueRetries(repo, () =>
    Promise.reject(new Error('pool timeout')),
  );

  await assert.rejects(
    drainAccountRetries(ACCOUNT_ID, makeDeps(flakyRepo)),
    /pool timeout/,
  );
  const row = findAction(repo, id);
  // 行未被触碰：仍 retrying、retryCount 仍 2（不死信、不推进）。
  assert.equal(row.status, ActionStatus.Retrying);
  assert.equal(row.retryCount, 2);
});

// ── 6. reauth（第 k 条）→ 重新抛出停整轮、其后未试行不动、行保持 retrying ──
test('reauth 第 k 条 → 重新抛出停整轮、其后未试行不动、该行保持 retrying', async () => {
  const repo = new InMemoryMailRepo();
  // 三条到期 reflectPriority（不同 providerMessageId → 不同行）；按 nextRetryAt 升序处理。
  const id1 = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
    providerMessageId: 'pmsg-a',
    nextRetryAt: new Date(NOW.getTime() - 3000),
  });
  const id2 = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
    providerMessageId: 'pmsg-b',
    nextRetryAt: new Date(NOW.getTime() - 2000),
  });
  const id3 = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
    providerMessageId: 'pmsg-c',
    nextRetryAt: new Date(NOW.getTime() - 1000),
  });

  // 第 1 条成功，第 2 条抛 reauth，第 3 条永不被试。
  let call = 0;
  const reauthOn2: ProviderActions = {
    async reflectPriority(): Promise<void> {
      call += 1;
      if (call === 2) {
        throw new ProviderReauthRequired(ACCOUNT_ID);
      }
    },
    async markRead(): Promise<void> {},
  };

  await assert.rejects(
    drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { provider: reauthOn2 })),
    (err: unknown) => err instanceof ProviderReauthRequired,
  );
  // 第 1 条 done；第 2 条（抛 reauth 当前行）保持 retrying、不推进、不死信；第 3 条未试、保持 retrying。
  assert.equal(findAction(repo, id1).status, ActionStatus.Done);
  const row2 = findAction(repo, id2);
  assert.equal(row2.status, ActionStatus.Retrying, '当前 reauth 行保持 retrying');
  assert.equal(row2.retryCount, 0, '当前 reauth 行不推进 retryCount');
  assert.equal(findAction(repo, id3).status, ActionStatus.Retrying, '其后未试行不动');
});

test('reauth 包进 .cause 仍被穿透重抛（防御性 unwrap）', async () => {
  const repo = new InMemoryMailRepo();
  const id = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
  });
  const wrappedReauth: ProviderActions = {
    async reflectPriority(): Promise<void> {
      const wrapper = new Error('wrapped');
      (wrapper as { cause?: unknown }).cause = new ProviderReauthRequired(ACCOUNT_ID);
      throw wrapper;
    },
    async markRead(): Promise<void> {},
  };
  // 必须重抛**unwrap 后的** ProviderReauthRequired（非外层 wrapper）——否则上游 instanceof 漏判、不 suspend。
  await assert.rejects(
    drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { provider: wrappedReauth })),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
  // 当前行保持 retrying（不被当瞬时失败推进）。
  const row = findAction(repo, id);
  assert.equal(row.status, ActionStatus.Retrying);
  assert.equal(row.retryCount, 0);
});

// ── 7. 普通瞬时异常逐条隔离不停整轮 ──
test('普通瞬时异常逐条隔离、不停整轮（其余行照常推进）', async () => {
  const repo = new InMemoryMailRepo();
  const id1 = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
    providerMessageId: 'pmsg-a',
    nextRetryAt: new Date(NOW.getTime() - 3000),
  });
  const id2 = await seedRetrying(repo, {
    actionType: ActionType.ReflectPriority,
    retryCount: 0,
    providerMessageId: 'pmsg-b',
    nextRetryAt: new Date(NOW.getTime() - 2000),
  });

  // 第 1 条抛普通错误（瞬时），第 2 条成功——drain 不应被第 1 条阻断。
  let call = 0;
  const failFirst: ProviderActions = {
    async reflectPriority(): Promise<void> {
      call += 1;
      if (call === 1) {
        throw new Error('transient-1');
      }
    },
    async markRead(): Promise<void> {},
  };

  await assert.doesNotReject(drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { provider: failFirst })));
  // 第 1 条：瞬时失败推进（retrying、retryCount=1）；第 2 条：done（未被阻断）。
  const row1 = findAction(repo, id1);
  assert.equal(row1.status, ActionStatus.Retrying);
  assert.equal(row1.retryCount, 1);
  assert.equal(findAction(repo, id2).status, ActionStatus.Done);
});

// ── 8. drain 有界：条数 cap ──
test('drain 条数有界：selectDueRetries 用 DRAIN_BATCH_CAP 作 limit', async () => {
  const repo = new InMemoryMailRepo();
  // 播种一条到期项，使 selectDueRetries 后的处理路径（含 updateAction 委派）真被走到。
  await seedRetrying(repo, { actionType: ActionType.ReflectPriority, retryCount: 0 });
  let capturedLimit = -1;
  const captureRepo = withSelectDueRetries(repo, (accountId, now, limit) => {
    capturedLimit = limit;
    return repo.selectDueRetries(accountId, now, limit);
  });
  await drainAccountRetries(ACCOUNT_ID, makeDeps(captureRepo));
  assert.equal(capturedLimit, DRAIN_BATCH_CAP);
});

test('drain 有界：>cap 时只处理 cap 条（其余下轮）', async () => {
  const repo = new InMemoryMailRepo();
  // 播种 cap+5 条到期 reflectPriority。
  const ids: string[] = [];
  for (let i = 0; i < DRAIN_BATCH_CAP + 5; i += 1) {
    ids.push(
      await seedRetrying(repo, {
        actionType: ActionType.ReflectPriority,
        retryCount: 0,
        providerMessageId: `pmsg-${i}`,
        nextRetryAt: new Date(NOW.getTime() - (DRAIN_BATCH_CAP + 5 - i) * 1000),
      }),
    );
  }
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo));
  const doneCount = repo.actions.filter((a) => a.status === ActionStatus.Done).length;
  assert.equal(doneCount, DRAIN_BATCH_CAP, '本轮至多处理 DRAIN_BATCH_CAP 条');
});

// ── 9. drain 软 deadline 提前退出（剩余下轮） ──
test('drain 超软 deadline 提前退出、剩余项保持 retrying（下轮续）', async () => {
  const repo = new InMemoryMailRepo();
  const ids: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(
      await seedRetrying(repo, {
        actionType: ActionType.ReflectPriority,
        retryCount: 0,
        providerMessageId: `pmsg-${i}`,
        nextRetryAt: new Date(NOW.getTime() - (5 - i) * 1000),
      }),
    );
  }
  // 假 deadline：前两条预算内（elapsed 0,1），第三条起超预算（elapsed ≥ budget）。
  let probe = 0;
  const deadline: DrainDeadline = {
    budgetMs: 100,
    elapsedMs: () => {
      const v = probe < 2 ? probe * 10 : 1000; // 第 3 次起 ≥ budget。
      probe += 1;
      return v;
    },
  };
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { deadline }));
  const doneCount = repo.actions.filter((a) => a.status === ActionStatus.Done).length;
  const retryingCount = repo.actions.filter((a) => a.status === ActionStatus.Retrying).length;
  assert.equal(doneCount, 2, '只处理软 deadline 内的 2 条');
  assert.equal(retryingCount, 3, '剩余 3 条保持 retrying（下轮续）');
});

// ── 10. notify failed → 当瞬时失败推进 retryCount ──
test('notify 返回 failed → 当瞬时失败推进 retryCount（保持 retrying）', async () => {
  const repo = new InMemoryMailRepo();
  const id = await seedRetrying(repo, { actionType: ActionType.Notify, retryCount: 1 });
  const failedNotifier: Notifier = {
    async notify(): Promise<NotifyResult> {
      return { outcome: 'failed', channel: 'fake', error: 'http-500' };
    },
    async notifyDigest(): Promise<NotifyResult> {
      return { outcome: 'failed', channel: 'fake', error: 'http-500' };
    },
  };
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { notifier: failedNotifier }));
  const row = findAction(repo, id);
  assert.equal(row.status, ActionStatus.Retrying);
  assert.equal(row.retryCount, 2);
});

test('notify 返回 skipped（无渠道）→ 当成功落 done（不反复入队）', async () => {
  const repo = new InMemoryMailRepo();
  const id = await seedRetrying(repo, { actionType: ActionType.Notify, retryCount: 0 });
  const skippedNotifier: Notifier = {
    async notify(): Promise<NotifyResult> {
      return { outcome: 'skipped', reason: 'no-channel' };
    },
    async notifyDigest(): Promise<NotifyResult> {
      return { outcome: 'skipped', reason: 'no-channel' };
    },
  };
  await drainAccountRetries(ACCOUNT_ID, makeDeps(repo, { notifier: skippedNotifier }));
  assert.equal(findAction(repo, id).status, ActionStatus.Done);
});
