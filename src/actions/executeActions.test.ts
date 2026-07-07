// executeActions self-check（migration §1.2 gut+restructure）：notify-only 三值 + 有界重试 + 耗尽 +
// reauth 致命通道 + reflect/mark_read typed-but-unwired（'none'）。非空断言 seam：真调 executeActions、
// 真实计 fake notifier 调用数（不 stub executeActions 自身）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executeActions } from './executeActions.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import type { ProviderActions } from './providerActions.js';
import type { Notifier, NotifyResult } from '../notify/notifier.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

const noSleep = async (): Promise<void> => {};

function makeEmail(): NormalizedEmail {
  return {
    accountId: 'gmail:me@example.com',
    provider: 'gmail',
    providerMessageId: 'm1',
    subject: 's',
    fromEmail: 'a@b.com',
    to: [],
    date: '2026-07-07T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
  };
}

function makeDecision(over: Partial<FinalDecision> = {}): FinalDecision {
  return {
    priority: 'P0',
    category: 'security',
    confidence: 0.9,
    shouldNotifyNow: true,
    shouldMarkRead: false,
    shouldIncludeDigest: false,
    reason: 'r',
    riskFlags: [],
    appliedRules: [],
    ...over,
  };
}

/** fake notifier：按脚本返回三值（或抛），并计 notify 调用数。 */
function makeNotifier(script: () => NotifyResult | Promise<NotifyResult>): Notifier & { calls: number } {
  const n = {
    calls: 0,
    async notify(): Promise<NotifyResult> {
      n.calls += 1;
      return script();
    },
    async notifyDigest(): Promise<NotifyResult> {
      return { outcome: 'skipped', reason: 'n/a' };
    },
  };
  return n;
}

test('notify sent → notify=sent、notifyExhausted=false、调用一次、reflect/markRead=none(unwired)', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const r = await executeActions(makeEmail(), makeDecision(), { notifier, sleep: noSleep });
  assert.equal(r.notify, 'sent');
  assert.equal(r.notifyExhausted, false);
  assert.equal(notifier.calls, 1, 'sent 一次即返回、不重试');
  assert.equal(r.reflect, 'none', 'reflect §1 unwired');
  assert.equal(r.markRead, 'none', 'markRead §1 unwired');
});

test('notify skipped（无渠道降级）→ skipped、不重试、不耗尽', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'skipped', reason: 'no-channel' }));
  const r = await executeActions(makeEmail(), makeDecision(), { notifier, sleep: noSleep });
  assert.equal(r.notify, 'skipped');
  assert.equal(r.notifyExhausted, false);
  assert.equal(notifier.calls, 1, 'skipped 直接终结、不进重试');
});

test('notify failed 全程 → failed、notifyExhausted=true、有界重试 3 次', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'failed', channel: 'telegram', error: 'telegram-http-500' }));
  const r = await executeActions(makeEmail(), makeDecision(), { notifier, sleep: noSleep });
  assert.equal(r.notify, 'failed');
  assert.equal(r.notifyExhausted, true, 'notify 耗尽 → run() 跳 markProcessed（design D3）');
  assert.equal(notifier.calls, 3, 'MAX_ATTEMPTS=3 有界重试');
});

test('shouldNotifyNow=false → notify=none、不调 notifier', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const r = await executeActions(makeEmail(), makeDecision({ shouldNotifyNow: false }), { notifier, sleep: noSleep });
  assert.equal(r.notify, 'none');
  assert.equal(r.notifyExhausted, false);
  assert.equal(notifier.calls, 0);
});

test('notifier 抛 ProviderReauthRequired → 致命通道 re-throw（不当发送态吞掉、不重试）', async () => {
  const notifier = makeNotifier(() => {
    throw new ProviderReauthRequired('gmail:me@example.com');
  });
  await assert.rejects(
    () => executeActions(makeEmail(), makeDecision(), { notifier, sleep: noSleep }),
    (e) => e instanceof ProviderReauthRequired,
  );
  assert.equal(notifier.calls, 1, 'reauth 单次命中即抛、不 3× 重试');
});

// —— §4.1/§4.2：reflect_priority（始终、幂等）+ mark_read（仅 shouldMarkRead、幂等）接入 + 顺序 ——

/** fake provider（reflect/mark_read）+ 计调用数 + 可脚本化抛错 + 顺序 log。 */
function makeProvider(opts?: { reflectThrows?: () => unknown; markReadThrows?: () => unknown; log?: string[] }) {
  const obj = {
    reflectCalls: 0,
    markReadCalls: 0,
    provider: {
      async reflectPriority() {
        obj.reflectCalls += 1;
        opts?.log?.push('reflect');
        const e = opts?.reflectThrows?.();
        if (e !== undefined) {
          throw e;
        }
      },
      async markRead() {
        obj.markReadCalls += 1;
        opts?.log?.push('mark_read');
        const e = opts?.markReadThrows?.();
        if (e !== undefined) {
          throw e;
        }
      },
    } as ProviderActions,
  };
  return obj;
}

test('reflect_priority 始终执行（即便 shouldNotifyNow=false、shouldMarkRead=false）→ reflect=ok', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const p = makeProvider();
  const r = await executeActions(
    makeEmail(),
    makeDecision({ shouldNotifyNow: false, shouldMarkRead: false }),
    { notifier, provider: p.provider, sleep: noSleep },
  );
  assert.equal(r.reflect, 'ok', 'reflect 始终执行（标签是分类可见性、不被门控）');
  assert.equal(p.reflectCalls, 1);
  assert.equal(r.notify, 'none', 'shouldNotifyNow=false → notify none');
  assert.equal(r.markRead, 'none', 'shouldMarkRead=false → mark_read none');
  assert.equal(p.markReadCalls, 0);
});

test('mark_read 仅 shouldMarkRead=true 执行 → markRead=ok；否则 none', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const yes = makeProvider();
  const rYes = await executeActions(
    makeEmail(),
    makeDecision({ shouldNotifyNow: false, shouldMarkRead: true }),
    { notifier, provider: yes.provider, sleep: noSleep },
  );
  assert.equal(rYes.markRead, 'ok');
  assert.equal(yes.markReadCalls, 1);
  const no = makeProvider();
  const rNo = await executeActions(
    makeEmail(),
    makeDecision({ shouldNotifyNow: false, shouldMarkRead: false }),
    { notifier, provider: no.provider, sleep: noSleep },
  );
  assert.equal(rNo.markRead, 'none');
  assert.equal(no.markReadCalls, 0);
});

test('动作顺序 reflect_priority → notify（§4.2）+ M4 ⊥ 守卫：both-true 时 mark_read NOT executed', async () => {
  const log: string[] = [];
  const notifier: Notifier = {
    async notify(): Promise<NotifyResult> {
      log.push('notify');
      return { outcome: 'sent', channel: 'telegram' };
    },
    async notifyDigest(): Promise<NotifyResult> {
      return { outcome: 'skipped', reason: 'n/a' };
    },
  };
  const p = makeProvider({ log });
  // 合成**不变量违反**面（both shouldNotifyNow ∧ shouldMarkRead——applySafetyRules 保证真实决策绝不同真）：
  // M4 消费点守卫下 mark_read **不执行**（notify-due 封绝不清 unread、防丢推送），notify 仍尝试；观测 reflect→notify 顺序。
  const r = await executeActions(makeEmail(), makeDecision({ shouldNotifyNow: true, shouldMarkRead: true }), {
    notifier,
    provider: p.provider,
    sleep: noSleep,
  });
  assert.deepEqual(log, ['reflect', 'notify'], 'reflect→notify;mark_read 被 M4 ⊥ 守卫跳过');
  assert.equal(p.markReadCalls, 0, 'notify-due 封 provider.markRead 不被调（防清 is:unread 丢推送）');
  assert.equal(r.markRead, 'none', 'mark_read gated off by !shouldNotifyNow');
  assert.equal(r.notify, 'sent', 'notify 仍尝试');
});

// —— M3：per-email 超时 fence+abort → 动作重试循环立即止损，不耗尽全部 3 次尝试 ——
test('M3 pre-aborted signal → executeNotify 未发即 failed、不调 notifier（不耗尽 3 次）', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const ac = new AbortController();
  ac.abort();
  const r = await executeActions(makeEmail(), makeDecision({ shouldNotifyNow: true }), {
    notifier,
    sleep: noSleep,
    signal: ac.signal,
  });
  assert.equal(r.notify, 'failed', 'aborted 未发 → failed（调用方跳 markProcessed → 下轮 re-poll）');
  assert.equal(r.notifyExhausted, true);
  assert.equal(notifier.calls, 0, 'aborted 在首次尝试前止损、绝不调 notifier');
});

test('M3 pre-aborted signal → executeProviderAction(reflect/mark_read) 立即 failed、provider 不被调', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const p = makeProvider();
  const ac = new AbortController();
  ac.abort();
  const r = await executeActions(
    makeEmail(),
    makeDecision({ shouldNotifyNow: false, shouldMarkRead: true }),
    { notifier, provider: p.provider, sleep: noSleep, signal: ac.signal },
  );
  assert.equal(r.reflect, 'failed', 'aborted → reflect 立即 failed');
  assert.equal(p.reflectCalls, 0, 'reflect 一次都不调（<3，不耗尽）');
  assert.equal(r.markRead, 'failed', 'aborted → mark_read 立即 failed');
  assert.equal(p.markReadCalls, 0, 'mark_read 一次都不调（<3，不耗尽）');
});

test('reflect 瞬时耗尽 → reflect=failed、不阻断 notify（notify 仍 sent）', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const p = makeProvider({ reflectThrows: () => new Error('transient') });
  const r = await executeActions(makeEmail(), makeDecision(), { notifier, provider: p.provider, sleep: noSleep });
  assert.equal(r.reflect, 'failed', 'reflect 有界重试耗尽 → failed');
  assert.equal(p.reflectCalls, 3, 'MAX_ATTEMPTS=3 有界重试');
  assert.equal(r.notify, 'sent', 'reflect 耗尽不阻断 notify');
  assert.equal(notifier.calls, 1);
});

test('mark_read 瞬时耗尽 → markRead=failed', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const p = makeProvider({ markReadThrows: () => new Error('transient') });
  const r = await executeActions(
    makeEmail(),
    makeDecision({ shouldNotifyNow: false, shouldMarkRead: true }),
    { notifier, provider: p.provider, sleep: noSleep },
  );
  assert.equal(r.markRead, 'failed');
  assert.equal(p.markReadCalls, 3);
});

test('reflect 抛 ProviderReauthRequired → executeActions re-throw、notify 不被调（reflect 在前）', async () => {
  const notifier = makeNotifier(() => ({ outcome: 'sent', channel: 'telegram' }));
  const p = makeProvider({ reflectThrows: () => new ProviderReauthRequired('gmail:me@example.com') });
  await assert.rejects(
    () => executeActions(makeEmail(), makeDecision(), { notifier, provider: p.provider, sleep: noSleep }),
    (e) => e instanceof ProviderReauthRequired,
  );
  assert.equal(p.reflectCalls, 1, 'reauth 单次命中即抛、不 3× 重试');
  assert.equal(notifier.calls, 0, 'reflect reauth 逃逸 → notify/后续动作不执行');
});
