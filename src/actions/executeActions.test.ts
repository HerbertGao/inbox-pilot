// executeActions 单测（组 C §3.2）：reflectPriority 始终调 + 两类错误通道（node:test）。
//
// 单元级直测 executeActions（绕过 processEmail）：先 saveEmail 拿 messageRowId、再调 executeActions，
// 用 InMemoryMailRepo 断言 mail_actions 行类型/终态、用可控假 provider 断言调用顺序与门控。
//
// 覆盖（逐条对应 §3.2 intent）：
//   - P0/P4（shouldMarkRead=false）→ reflectPriority 调、markRead 不调；
//   - P2/P3（shouldMarkRead=true）→ 顺序 reflectPriority → markRead →（notify 仅 shouldNotifyNow）；
//   - reflectPriority **发送态**失败（瞬时）→ 不阻断 markRead、不抛、仍记 failed；
//   - reflectPriority/markRead 抛 **ProviderReauthRequired** → executeActions 重抛、且 in-flight 行
//     为 failed（非 orphan pending）；终态落库失败向上传播。
//   - 不接真实 provider/网络；不发送邮件。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executeActions, type SleepFn } from './executeActions.js';
import { ActionType } from './actionTypes.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import { InMemoryMailRepo } from '../repo/inMemoryMailRepo.js';
import type { ProviderActions } from './providerActions.js';
import type { Notifier, NotifyResult } from '../notify/notifier.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'acct-1',
    provider: 'gmail',
    providerMessageId: 'msg-1',
    subject: '主题',
    fromEmail: 'sender@example.com',
    fromName: '发件人',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    textBody: '正文',
    htmlBody: undefined,
    hasAttachments: false,
    headers: {},
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
    reason: '测试裁定',
    riskFlags: [],
    appliedRules: [],
    ...overrides,
  };
}

/** 顺序记录型假 provider：把每次调用追加进 calls，便于断言 reflectPriority 先于 markRead。 */
function makeOrderedProvider(): ProviderActions & { calls: string[] } {
  const provider = {
    calls: [] as string[],
    async reflectPriority(): Promise<void> {
      provider.calls.push('reflectPriority');
    },
    async markRead(): Promise<void> {
      provider.calls.push('markRead');
    },
  };
  return provider;
}

/** 假时钟 sleep（组 C 退避）：不真实等待，记录每次退避 ms 以断言退避被调用、求和有上限。 */
function makeSleepSpy(): SleepFn & { calls: number[] } {
  const calls: number[] = [];
  const fn = (async (ms: number): Promise<void> => {
    calls.push(ms);
  }) as SleepFn & { calls: number[] };
  fn.calls = calls;
  return fn;
}

/** 永远返回 sent 的假 notifier（记调用次数）。 */
function makeSentNotifier(): Notifier & { calls: number } {
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

async function seedRow(repo: InMemoryMailRepo, email: NormalizedEmail): Promise<string> {
  const stored = await repo.saveEmail(email);
  return stored.id;
}

// ——————————————————————————————————————————————————————————
// P0/P4（shouldMarkRead=false）→ reflectPriority 调、markRead 不调
// ——————————————————————————————————————————————————————————

for (const priority of ['P0', 'P4'] as const) {
  test(`${priority}（shouldMarkRead=false）→ reflectPriority 调、markRead 不调`, async () => {
    const repo = new InMemoryMailRepo();
    const provider = makeOrderedProvider();
    const notifier = makeSentNotifier();
    const email = makeEmail();
    const decision = makeDecision({
      priority,
      shouldMarkRead: false,
      shouldNotifyNow: true,
    });
    const rowId = await seedRow(repo, email);

    await executeActions(email, decision, rowId, { repo, provider, notifier });

    assert.deepEqual(provider.calls, ['reflectPriority'], 'shouldMarkRead=false 不应调 markRead');
    const actions = repo.getActions(rowId);
    const reflect = actions.find((a) => a.actionType === ActionType.ReflectPriority);
    assert.equal(reflect?.status, 'done', 'reflect_priority 应落 done');
    assert.ok(!actions.some((a) => a.actionType === ActionType.MarkRead), '不应有 mark_read 行');
    // P0/P4 shouldNotifyNow=true → 有 notify(done)。
    assert.equal(
      actions.find((a) => a.actionType === ActionType.Notify)?.status,
      'done',
    );
  });
}

// ——————————————————————————————————————————————————————————
// P2/P3（shouldMarkRead=true）→ 顺序 reflectPriority → markRead →（notify）
// ——————————————————————————————————————————————————————————

test('P2（shouldMarkRead=true, shouldNotifyNow=false）→ 顺序 reflectPriority → markRead、无 notify', async () => {
  const repo = new InMemoryMailRepo();
  const provider = makeOrderedProvider();
  const notifier = makeSentNotifier();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: true, shouldNotifyNow: false });
  const rowId = await seedRow(repo, email);

  await executeActions(email, decision, rowId, { repo, provider, notifier });

  assert.deepEqual(provider.calls, ['reflectPriority', 'markRead'], 'reflectPriority 必须先于 markRead');
  assert.equal(notifier.calls, 0, 'shouldNotifyNow=false 不应推送');
  const actions = repo.getActions(rowId);
  // mail_actions 行也按 reflect_priority → mark_read 顺序记录。
  const types = actions.map((a) => a.actionType);
  assert.deepEqual(types, [ActionType.ReflectPriority, ActionType.MarkRead]);
  assert.equal(actions[0]?.status, 'done');
  assert.equal(actions[1]?.status, 'done');
});

test('P3（shouldMarkRead=true, shouldNotifyNow=true）→ 顺序 reflectPriority → markRead → notify', async () => {
  const repo = new InMemoryMailRepo();
  const provider = makeOrderedProvider();
  const notifier = makeSentNotifier();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P3', shouldMarkRead: true, shouldNotifyNow: true });
  const rowId = await seedRow(repo, email);

  await executeActions(email, decision, rowId, { repo, provider, notifier });

  assert.deepEqual(provider.calls, ['reflectPriority', 'markRead']);
  assert.equal(notifier.calls, 1);
  const types = repo.getActions(rowId).map((a) => a.actionType);
  assert.deepEqual(types, [ActionType.ReflectPriority, ActionType.MarkRead, ActionType.Notify]);
});

// ——————————————————————————————————————————————————————————
// reflectPriority 发送态失败（瞬时）→ 不阻断 markRead、不抛、记 failed
// ——————————————————————————————————————————————————————————

test('reflectPriority 发送态失败（瞬时）→ 不阻断 markRead、不抛、reflect_priority 落 failed', async () => {
  const repo = new InMemoryMailRepo();
  let markReadCalled = false;
  const provider: ProviderActions = {
    async reflectPriority(): Promise<void> {
      throw new Error('label API 429'); // 瞬时发送态失败（非 ProviderReauthRequired）
    },
    async markRead(): Promise<void> {
      markReadCalled = true;
    },
  };
  const notifier = makeSentNotifier();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: true });
  const rowId = await seedRow(repo, email);

  // 不抛。
  await executeActions(email, decision, rowId, { repo, provider, notifier });

  assert.ok(markReadCalled, 'reflectPriority 发送态失败不应阻断 markRead');
  const actions = repo.getActions(rowId);
  assert.equal(
    actions.find((a) => a.actionType === ActionType.ReflectPriority)?.status,
    'failed',
    'reflect_priority 瞬时失败落 failed',
  );
  assert.equal(
    actions.find((a) => a.actionType === ActionType.MarkRead)?.status,
    'done',
    'markRead 仍照常 done',
  );
});

test('reflectPriority 发送态失败摘要脱敏、不含正文', async () => {
  const repo = new InMemoryMailRepo();
  const provider: ProviderActions = {
    async reflectPriority(): Promise<void> {
      throw new Error('transient label error'); // 不含正文
    },
    async markRead(): Promise<void> {},
  };
  const notifier = makeSentNotifier();
  const email = makeEmail({ textBody: 'SENTINEL_BODY' });
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: true });
  const rowId = await seedRow(repo, email);

  await executeActions(email, decision, rowId, { repo, provider, notifier });

  const reflect = repo.getActions(rowId).find((a) => a.actionType === ActionType.ReflectPriority)!;
  assert.equal(reflect.status, 'failed');
  assert.ok(!(reflect.error ?? '').includes('SENTINEL_BODY'), 'error 摘要不应含正文');
});

// ——————————————————————————————————————————————————————————
// ProviderReauthRequired（致命）：reflectPriority 抛 → 重抛、行 failed 非 pending、markRead 不调
// ——————————————————————————————————————————————————————————

test('reflectPriority 抛 ProviderReauthRequired → executeActions 重抛、reflect_priority 行 failed 非 pending、markRead 不调', async () => {
  const repo = new InMemoryMailRepo();
  let markReadCalled = false;
  const provider: ProviderActions = {
    async reflectPriority(): Promise<void> {
      throw new ProviderReauthRequired('acct-1');
    },
    async markRead(): Promise<void> {
      markReadCalled = true;
    },
  };
  const notifier = makeSentNotifier();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: true });
  const rowId = await seedRow(repo, email);

  await assert.rejects(
    executeActions(email, decision, rowId, { repo, provider, notifier }),
    (err: unknown) => err instanceof ProviderReauthRequired,
  );

  assert.ok(!markReadCalled, 'reflectPriority 抛致命错误后不应调 markRead');
  const reflect = repo.getActions(rowId).find((a) => a.actionType === ActionType.ReflectPriority)!;
  assert.equal(reflect.status, 'failed', 'in-flight reflect_priority 行应为 failed');
  assert.notEqual(reflect.status, 'pending', '不得留 orphan pending 行');
  // 行 error 为 reauth kind（脱敏固定串，无凭据）。
  assert.equal(reflect.error, 'reauth-required');
});

test('markRead 抛 ProviderReauthRequired（reflectPriority 先成功）→ 重抛、mark_read 行 failed 非 pending', async () => {
  const repo = new InMemoryMailRepo();
  const provider: ProviderActions = {
    async reflectPriority(): Promise<void> {},
    async markRead(): Promise<void> {
      throw new ProviderReauthRequired('acct-1');
    },
  };
  const notifier = makeSentNotifier();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: true });
  const rowId = await seedRow(repo, email);

  await assert.rejects(
    executeActions(email, decision, rowId, { repo, provider, notifier }),
    (err: unknown) => err instanceof ProviderReauthRequired,
  );

  const actions = repo.getActions(rowId);
  assert.equal(
    actions.find((a) => a.actionType === ActionType.ReflectPriority)?.status,
    'done',
    'reflect_priority 先成功 done',
  );
  const markRead = actions.find((a) => a.actionType === ActionType.MarkRead)!;
  assert.equal(markRead.status, 'failed', 'in-flight mark_read 行应为 failed');
  assert.notEqual(markRead.status, 'pending', '不得留 orphan pending 行');
});

// ——————————————————————————————————————————————————————————
// 终态落库失败向上传播（updateAction 持久故障 → executeActions 不吞）
// ——————————————————————————————————————————————————————————
// 与既有 markRead 契约一致：reflectPriority/markRead 的 done-写入在重试 try 内（动作幂等，
// done-写入失败重试重打无害），故 done-I/O 故障经耗尽分支的 updateAction(failed) 向上传播——
// 当 failed-写入自身也持久故障（真正的终态落库失败）时，executeActions 不吞、向上传播。

// ——————————————————————————————————————————————————————————
// 组 C 退避（4.1/4.3）：动作重试间退避（注入假时钟）、单封总退避有上限、不跳过其余动作
// ——————————————————————————————————————————————————————————

// reflectPriority 瞬时失败两次、第三次成功 → 重试间退避两次（指数 100→200）、注入假时钟。
test('动作重试间有退避（注入假时钟）：100ms→200ms 指数、每次 ≤500ms', async () => {
  const repo = new InMemoryMailRepo();
  let attempts = 0;
  const provider: ProviderActions = {
    async reflectPriority(): Promise<void> {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient 429'); // 前两次瞬时失败、第三次成功
      }
    },
    async markRead(): Promise<void> {},
  };
  const notifier = makeSentNotifier();
  const sleep = makeSleepSpy();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: false, shouldNotifyNow: false });
  const rowId = await seedRow(repo, email);

  await executeActions(email, decision, rowId, { repo, provider, notifier, sleep });

  // 两次失败 → 两次退避（第三次尝试成功、其后不退避）。
  assert.equal(sleep.calls.length, 2, '两次失败之间应退避两次');
  assert.equal(sleep.calls[0], 100, '首次退避 ~100ms 起始');
  assert.equal(sleep.calls[1], 200, '指数翻倍 → 200ms');
  // 每次退避 ≤500ms 封顶。
  assert.ok(sleep.calls.every((ms) => ms <= 500), '每次退避 ≤500ms');
  // reflect_priority 最终成功 done（重试耗尽前成功）。
  const reflect = repo.getActions(rowId).find((a) => a.actionType === ActionType.ReflectPriority);
  assert.equal(reflect?.status, 'done');
});

// 单封总退避有上限（≤~750ms 动作份额）：三个动作全部瞬时失败、退避总和封顶。
test('单封总退避有上限（动作份额 ≤~750ms）：三动作全失败、退避求和不超封顶', async () => {
  const repo = new InMemoryMailRepo();
  const provider: ProviderActions = {
    async reflectPriority(): Promise<void> {
      throw new Error('always fail');
    },
    async markRead(): Promise<void> {
      throw new Error('always fail');
    },
  };
  // 通知器永远 failed（纳入有界重试 + 退避）。
  const notifier: Notifier = {
    async notify(): Promise<NotifyResult> {
      return { outcome: 'failed', channel: 'fake', error: 'always fail' };
    },
    async notifyDigest(): Promise<NotifyResult> {
      return { outcome: 'sent', channel: 'fake' };
    },
  };
  const sleep = makeSleepSpy();
  const email = makeEmail();
  // 三动作都触发：reflect（始终）+ markRead（shouldMarkRead）+ notify（shouldNotifyNow）。
  const decision = makeDecision({ priority: 'P3', shouldMarkRead: true, shouldNotifyNow: true });
  const rowId = await seedRow(repo, email);

  await executeActions(email, decision, rowId, { repo, provider, notifier, sleep });

  // 退避总和受单封封顶约束（动作份额 750ms）；与分类器 250ms 求和 ≤~1s。
  const totalBackoff = sleep.calls.reduce((sum, ms) => sum + ms, 0);
  assert.ok(totalBackoff <= 750, `单封动作退避总和应 ≤~750ms，实际 ${totalBackoff}`);
  // 每次退避 ≤500ms。
  assert.ok(sleep.calls.every((ms) => ms <= 500), '每次退避 ≤500ms');
  // 三动作均耗尽落 failed（退避延迟本封但不跳过其余动作）。
  const actions = repo.getActions(rowId);
  assert.equal(actions.find((a) => a.actionType === ActionType.ReflectPriority)?.status, 'failed');
  assert.equal(actions.find((a) => a.actionType === ActionType.MarkRead)?.status, 'failed');
  assert.equal(actions.find((a) => a.actionType === ActionType.Notify)?.status, 'failed');
  // 预算耗尽后退避降为 0，但后续动作仍照常发起（不跳过）——三动作行齐全即证。
  assert.equal(actions.length, 3, '退避不跳过该封其余动作');
});

// 退避延迟本封但不跳过其余动作：reflect 失败耗尽（退避）后 markRead 仍照常发起并成功。
test('退避延迟本封但不跳过该封其余动作：reflect 失败后 markRead 仍发起', async () => {
  const repo = new InMemoryMailRepo();
  let markReadCalled = false;
  const provider: ProviderActions = {
    async reflectPriority(): Promise<void> {
      throw new Error('transient fail'); // 耗尽 → failed（退避）
    },
    async markRead(): Promise<void> {
      markReadCalled = true;
    },
  };
  const notifier = makeSentNotifier();
  const sleep = makeSleepSpy();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: true });
  const rowId = await seedRow(repo, email);

  await executeActions(email, decision, rowId, { repo, provider, notifier, sleep });

  assert.ok(sleep.calls.length >= 1, 'reflect 失败应触发退避');
  assert.ok(markReadCalled, '退避不应跳过该封其余动作（markRead 仍发起）');
  assert.equal(
    repo.getActions(rowId).find((a) => a.actionType === ActionType.MarkRead)?.status,
    'done',
  );
});

// 无渠道降级（skipped）不进退避路径、不消耗退避预算。
test('无渠道降级（notify skipped）→ 不退避、不消耗预算', async () => {
  const repo = new InMemoryMailRepo();
  const provider = makeOrderedProvider();
  const notifier: Notifier = {
    async notify(): Promise<NotifyResult> {
      return { outcome: 'skipped', channel: 'none', reason: 'no-channel' };
    },
    async notifyDigest(): Promise<NotifyResult> {
      return { outcome: 'sent', channel: 'fake' };
    },
  };
  const sleep = makeSleepSpy();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P0', shouldMarkRead: false, shouldNotifyNow: true });
  const rowId = await seedRow(repo, email);

  await executeActions(email, decision, rowId, { repo, provider, notifier, sleep });

  assert.equal(sleep.calls.length, 0, 'skipped 不进退避路径');
  assert.equal(
    repo.getActions(rowId).find((a) => a.actionType === ActionType.Notify)?.status,
    'skipped',
  );
});

test('reflect_priority 终态落库持久失败（updateAction 全抛）→ 向上传播、markRead 不发起', async () => {
  class ThrowOnReflectUpdateRepo extends InMemoryMailRepo {
    async updateAction(
      id: string,
      status: 'done' | 'failed' | 'skipped',
      error?: string,
    ): Promise<void> {
      // reflect_priority 的任何终态写入都抛（模拟持久 DB I/O 故障）。
      const row = this.actions.find((a) => a.id === id);
      if (row?.actionType === ActionType.ReflectPriority) {
        throw new Error('fake DB write failure');
      }
      return super.updateAction(id, status, error);
    }
  }
  const repo = new ThrowOnReflectUpdateRepo();
  const provider = makeOrderedProvider();
  const notifier = makeSentNotifier();
  const email = makeEmail();
  const decision = makeDecision({ priority: 'P2', shouldMarkRead: true });
  const rowId = await seedRow(repo, email);

  await assert.rejects(
    executeActions(email, decision, rowId, { repo, provider, notifier }),
    /fake DB write failure/,
  );
  // markRead 未发起（终态落库故障在 reflectPriority 处即向上抛）；reflectPriority 因 done-写入
  // 在重试 try 内被当作瞬时失败重试（动作幂等、重打无害），故可能被调多次、但绝不到 markRead。
  assert.ok(provider.calls.every((c) => c === 'reflectPriority'), '只应调 reflectPriority、不到 markRead');
  assert.ok(!provider.calls.includes('markRead'), '终态落库故障后不应发起 markRead');
});
