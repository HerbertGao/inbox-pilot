// 离线验收：runDigestOnce——一轮编排（逐段提交 + 运行期错误隔离）。
// DIGEST_TIMES/node-cron 调度 + 进程内共享锁已退役（add-multi-trigger，调度移到 app.yaml + hangar daemon），
// 对应的 parseDigestTimes / startDigestSchedulers / createSharedLockRunner 测试随之删除。
//   - runDigestOnce：逐段提交（seg1 sent→mark seg1、seg2 failed→不 mark seg2 及其后、seg1 不重发）；
//     全 sent → 每段各自 mark；首段 skipped → 不 mark、停；无候选 → 不调 notify + emit digest.empty；
//     repo 抛错 → catch 自吞 + emit digest.failed（不外泄、不崩）。
//   - 审计经**注入的 emit seam**（生产由 pipeline runDigest 传 ctx.emit）——断言 emit 的 kind。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runDigestOnce } from './digestScheduler.js';
import { FIELD_CAP } from './buildDigest.js';
import type { DigestCandidate, MailRepo, SenderCount } from '../repo/mailRepo.js';
import type { Notifier, NotifyResult } from '../notify/notifier.js';

/** emit seam 记录器：捕获 runDigestOnce 的审计 kind+payload（生产为 ctx.emit）。 */
function recordEmit(): { emit: (kind: string, payload?: object) => void; events: Array<{ kind: string; payload?: object }> } {
  const events: Array<{ kind: string; payload?: object }> = [];
  return { events, emit: (kind, payload) => events.push({ kind, payload }) };
}

/** 构造一个 DigestCandidate fixture（默认 P1/work）。 */
function candidate(over: Partial<DigestCandidate> & { messageRowId: string }): DigestCandidate {
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

/**
 * 假 repo：`listDigestCandidates` 返回脚本化候选；`markDigested` 记录每次调用的 row-ids。
 * （buildDigest 经 listDigestCandidates 产出 segments，使我们无需 mock buildDigest 即可驱动逐段编排。）
 */
function fakeRepo(candidates: DigestCandidate[]): {
  repo: Pick<MailRepo, 'listDigestCandidates' | 'countRecentSenders' | 'markDigested'>;
  markCalls: string[][];
} {
  const markCalls: string[][] = [];
  return {
    markCalls,
    repo: {
      async listDigestCandidates(): Promise<DigestCandidate[]> {
        return candidates;
      },
      // Top-N 频率快照：编排测试不关心 Top-N 内容，返回 [] → buildDigest 省略该区块（不影响 mark/segments 断言）。
      async countRecentSenders(): Promise<SenderCount[]> {
        return [];
      },
      async markDigested(messageRowIds: string[]): Promise<void> {
        markCalls.push([...messageRowIds]);
      },
    },
  };
}

/** 假 notifier：按 outcomes 脚本逐次返回；记录被发送的文本。outcomes 用尽后默认 sent。 */
function fakeNotifier(outcomes: Array<NotifyResult['outcome']>): {
  notifier: Pick<Notifier, 'notifyDigest'>;
  sentTexts: string[];
} {
  const sentTexts: string[] = [];
  let i = 0;
  return {
    sentTexts,
    notifier: {
      async notifyDigest(text: string): Promise<NotifyResult> {
        sentTexts.push(text);
        const outcome = outcomes[i++] ?? 'sent';
        if (outcome === 'sent') return { outcome: 'sent', channel: 'fake' };
        if (outcome === 'skipped') return { outcome: 'skipped', reason: 'no-channel' };
        return { outcome: 'failed', channel: 'fake', error: 'fake-error' };
      },
    },
  };
}

const FIXED_NOW = () => new Date('2026-06-22T00:00:00Z');

/**
 * 构造足量"满字段"P1 候选（每行各字段截到 FIELD_CAP、行 ≈ 620 UTF-16 单位），
 * 使 packLines 必分 ≥2 段。row-id 顺序 r0,r1,...（与候选顺序一致，buildDigest 沿用 repo 序）。
 */
function manyCandidates(n: number): DigestCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    candidate({
      messageRowId: `r${i}`,
      subject: 's'.repeat(FIELD_CAP + 100),
      fromName: 'n'.repeat(FIELD_CAP + 100),
      reason: 'z'.repeat(FIELD_CAP + 100),
    }),
  );
}

test('逐段提交：seg1 sent → mark seg1；后续段 failed → 不 mark 后续段及其后；后续不重发', async () => {
  // 足量满字段候选 → ≥2 段。
  const candidates = manyCandidates(20);
  const allIds = candidates.map((c) => c.messageRowId);
  const { repo, markCalls } = fakeRepo(candidates);
  // 第一段 sent，第二段 failed → 停。
  const { notifier, sentTexts } = fakeNotifier(['sent', 'failed']);
  const { emit, events } = recordEmit();

  await runDigestOnce({ repo, notifier, now: FIXED_NOW, emit });

  // 至少发到第二段（≥2 段才有意义）；发到首个 failed 即停。
  assert.equal(sentTexts.length, 2, '发 seg1(sent) 后发 seg2(failed) 即停（后续段不发）');
  // 只 mark 了第一段（成功段）。
  assert.equal(markCalls.length, 1, '只 mark seg1（成功段），seg2 及其后不 mark');
  const marked = markCalls[0]!;
  // 被 mark 的是全部 row-ids 的一个**非空前缀**（seg1 的 row-ids、按 build 序在最前）。
  assert.ok(marked.length > 0 && marked.length < allIds.length, 'seg1 是非空前缀、未含全部');
  assert.deepEqual(marked, allIds.slice(0, marked.length), 'marked 是 row-ids 的前缀（= seg1）');
  // seg2 及其后的 row-ids 未被 mark（下轮重试、不丢件）。
  const unmarked = allIds.slice(marked.length);
  for (const id of unmarked) {
    assert.ok(!marked.includes(id), `${id}（seg2+）未被 mark`);
  }
  // 审计：seg1 → digest.sent；seg2 非 sent → digest.failed。
  assert.deepEqual(
    events.map((e) => e.kind),
    ['digest.sent', 'digest.failed'],
    'emit：seg1 sent → digest.sent，seg2 failed → digest.failed',
  );
});

test('逐段提交：全部 sent → 每段各自 mark（每段发成功即 mark 该段），合计覆盖全部 row-ids', async () => {
  const candidates = manyCandidates(20);
  const allIds = candidates.map((c) => c.messageRowId);
  const { repo, markCalls } = fakeRepo(candidates);
  // 全 sent（outcomes 用尽后默认 sent，覆盖任意段数）。
  const { notifier, sentTexts } = fakeNotifier([]);
  const { emit, events } = recordEmit();

  await runDigestOnce({ repo, notifier, now: FIXED_NOW, emit });

  // ≥2 段：每段各发一次、各 mark 一次。
  assert.ok(sentTexts.length >= 2, '足量候选分多段');
  assert.equal(markCalls.length, sentTexts.length, '每段各自 mark（mark 次数 == 段数）');
  // 各段 mark 的 row-ids 拼起来 == 全部 row-ids（顺序保持）。
  assert.deepEqual(markCalls.flat(), allIds, '所有段合计覆盖全部 row-ids、不重不漏');
  // 每段一条 digest.sent。
  assert.equal(events.filter((e) => e.kind === 'digest.sent').length, sentTexts.length, '每段一条 digest.sent');
});

test('首段即 skipped（无渠道降级）→ 不 mark 任何段、停本轮、emit digest.failed', async () => {
  const candidates: DigestCandidate[] = [candidate({ messageRowId: 'r1' })];
  const { repo, markCalls } = fakeRepo(candidates);
  const { notifier, sentTexts } = fakeNotifier(['skipped']);
  const { emit, events } = recordEmit();

  await runDigestOnce({ repo, notifier, now: FIXED_NOW, emit });

  assert.equal(sentTexts.length, 1);
  assert.equal(markCalls.length, 0, 'skipped（非 sent）→ 不 mark、停本轮');
  assert.deepEqual(events.map((e) => e.kind), ['digest.failed'], 'skipped → emit digest.failed');
});

test('无候选（buildDigest → null）：不调用 notify、emit digest.empty、不 mark', async () => {
  const { repo, markCalls } = fakeRepo([]); // 空候选 → buildDigest 返回 null。
  let notifyCalled = false;
  const notifier: Pick<Notifier, 'notifyDigest'> = {
    async notifyDigest(): Promise<NotifyResult> {
      notifyCalled = true;
      return { outcome: 'sent', channel: 'fake' };
    },
  };
  const { emit, events } = recordEmit();

  await runDigestOnce({ repo, notifier, now: FIXED_NOW, emit });

  assert.equal(notifyCalled, false, 'null → 不调用 notify');
  assert.equal(markCalls.length, 0, 'null → 不 mark');
  assert.deepEqual(events.map((e) => e.kind), ['digest.empty'], 'null → emit digest.empty');
});

test('运行期 repo 抛错被 catch、emit digest.failed、不外泄、不崩（runDigestOnce 自身不抛）', async () => {
  const repo: Pick<MailRepo, 'listDigestCandidates' | 'countRecentSenders' | 'markDigested'> = {
    async listDigestCandidates(): Promise<DigestCandidate[]> {
      throw Object.assign(new Error('db down'), { code: 'P1001' });
    },
    async countRecentSenders(): Promise<SenderCount[]> {
      return [];
    },
    async markDigested(): Promise<void> {},
  };
  const { notifier } = fakeNotifier([]);
  const { emit, events } = recordEmit();
  // 自身 catch → 不抛。
  await assert.doesNotReject(runDigestOnce({ repo, notifier, now: FIXED_NOW, emit }));
  // 脱敏审计：只放行 errorName + 标量 errorCode（不含原始 error/PII）。
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, 'digest.failed');
  assert.deepEqual(events[0]!.payload, { errorName: 'Error', errorCode: 'P1001' });
});
