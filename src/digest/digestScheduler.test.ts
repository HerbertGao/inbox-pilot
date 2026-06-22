// 离线验收（组 E §5.5）：digestScheduler——解析时刻 + 共享锁互斥 + 逐段提交 + 构造期/运行期错误隔离。
// 不依赖真实 cron timing：
//   - parseDigestTimes：合法多时刻各一项；重复 `12:30,12:30` 及含空格 `"12:30, 12:30 "` → 一项；非法/空跳过；
//     显式空 → []；缺省（undefined）→ 默认两时刻。
//   - startDigestSchedulers：合法多时刻各起一 cron；非法 timezone → 构造 try/catch 跳过该任务、不崩、返回其余任务。
//   - createSharedLockRunner：跨任务互斥（A 运行中、B 触发被跳过）；保护体首行同步抛 → finally 仍释放锁（不泄漏）；
//     回调抛错被吞（自身 catch）、finally 释放锁、不漏 promise。
//   - runDigestOnce：逐段提交（seg1 sent→mark seg1、seg2 failed→不 mark seg2 及其后、seg1 不重发）；
//     无候选不调用 notify、记 digest-empty。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_DIGEST_TIMES,
  parseDigestTimes,
  startDigestSchedulers,
  createSharedLockRunner,
  runDigestOnce,
  type DigestSchedulerOptions,
} from './digestScheduler.js';
import { FIELD_CAP } from './buildDigest.js';
import type { DigestCandidate, MailRepo } from '../repo/mailRepo.js';
import type { Notifier, NotifyResult } from '../notify/notifier.js';

/** 让 microtask 队列排空（使 await 链上的同步分支跑完）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** 构造一个可外部手动 resolve/reject 的 deferred（模拟一轮在途的编排）。 */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  repo: Pick<MailRepo, 'listDigestCandidates' | 'markDigested'>;
  markCalls: string[][];
} {
  const markCalls: string[][] = [];
  return {
    markCalls,
    repo: {
      async listDigestCandidates(): Promise<DigestCandidate[]> {
        return candidates;
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

// ─────────────────────────────── parseDigestTimes（§5.1, §5.5） ───────────────────────────────

test('parseDigestTimes：缺省（undefined）→ 默认两时刻 12:30 / 21:30', () => {
  const times = parseDigestTimes(undefined);
  assert.equal(times.length, 2);
  assert.deepEqual(
    times.map((t) => [t.hour, t.minute, t.expr]),
    [
      [12, 30, '30 12 * * *'],
      [21, 30, '30 21 * * *'],
    ],
  );
  assert.equal(DEFAULT_DIGEST_TIMES, '12:30,21:30');
});

test('parseDigestTimes：显式空串 → [] （不调度，区别于缺省）', () => {
  assert.deepEqual(parseDigestTimes(''), []);
});

test('parseDigestTimes：合法多时刻各起一项、cron 表达式 `M H * * *`', () => {
  const times = parseDigestTimes('8:5,12:30,21:30');
  assert.deepEqual(
    times.map((t) => t.expr),
    ['5 8 * * *', '30 12 * * *', '30 21 * * *'],
  );
});

test('parseDigestTimes：接受 `9:5` 与 `09:05`（不强制零补）且二者去重为同一', () => {
  const times = parseDigestTimes('9:5,09:05');
  assert.equal(times.length, 1);
  assert.deepEqual([times[0]!.hour, times[0]!.minute], [9, 5]);
});

test('parseDigestTimes：重复时刻 `12:30,12:30` → 一项', () => {
  assert.equal(parseDigestTimes('12:30,12:30').length, 1);
});

test('parseDigestTimes：含空格 `"12:30, 12:30 "` → 一项（先 trim、去重键由整数派生）', () => {
  const times = parseDigestTimes('12:30, 12:30 ');
  assert.equal(times.length, 1);
  assert.deepEqual([times[0]!.hour, times[0]!.minute], [12, 30]);
});

test('parseDigestTimes：非法/空 token 跳过、其余合法照常（25:00 / abc / 尾逗号空 token）', () => {
  const times = parseDigestTimes('25:00,abc,12:30,,9:99,12:60,1:2:3,+9:5');
  assert.deepEqual(
    times.map((t) => t.expr),
    ['30 12 * * *'],
  );
});

test('parseDigestTimes：全非法 → []', () => {
  assert.deepEqual(parseDigestTimes('25:00,abc,99:99'), []);
});

test('parseDigestTimes：边界 0:0 与 23:59 合法', () => {
  const times = parseDigestTimes('0:0,23:59');
  assert.deepEqual(
    times.map((t) => t.expr),
    ['0 0 * * *', '59 23 * * *'],
  );
});

// ─────────────────────────── startDigestSchedulers（§5.4, §5.5） ───────────────────────────

function baseOptions(over: Partial<DigestSchedulerOptions>): DigestSchedulerOptions {
  const { repo } = fakeRepo([]);
  const { notifier } = fakeNotifier([]);
  return {
    timesString: '12:30,21:30',
    timezone: 'Asia/Shanghai',
    repo,
    notifier,
    now: FIXED_NOW,
    ...over,
  };
}

test('startDigestSchedulers：合法多时刻各起一 cron task；可 stop()', () => {
  const tasks = startDigestSchedulers(baseOptions({ timesString: '12:30,21:30' }));
  assert.equal(tasks.length, 2);
  for (const t of tasks) {
    assert.equal(typeof t.stop, 'function');
    t.stop();
  }
});

test('startDigestSchedulers：重复时刻 `12:30,12:30` → 一个 task', () => {
  const tasks = startDigestSchedulers(baseOptions({ timesString: '12:30,12:30' }));
  assert.equal(tasks.length, 1);
  tasks.forEach((t) => t.stop());
});

test('startDigestSchedulers：含空格 `"12:30, 12:30 "` → 一个 task', () => {
  const tasks = startDigestSchedulers(baseOptions({ timesString: '12:30, 12:30 ' }));
  assert.equal(tasks.length, 1);
  tasks.forEach((t) => t.stop());
});

test('startDigestSchedulers：显式空串 → [] （不调度）', () => {
  const tasks = startDigestSchedulers(baseOptions({ timesString: '' }));
  assert.deepEqual(tasks, []);
});

test('startDigestSchedulers：缺省（undefined）→ 默认两 task', () => {
  const tasks = startDigestSchedulers(baseOptions({ timesString: undefined }));
  assert.equal(tasks.length, 2);
  tasks.forEach((t) => t.stop());
});

test('startDigestSchedulers：全非法 token → [] （服务照常、不抛）', () => {
  const tasks = startDigestSchedulers(baseOptions({ timesString: '25:00,abc' }));
  assert.deepEqual(tasks, []);
});

test('startDigestSchedulers：非法 timezone → 构造 try/catch 跳过该任务、不崩、返回其余任务', () => {
  // 非法 IANA 时区 → cron.schedule 构造期同步抛 RangeError；本地 try/catch 接住、跳过、不冒泡。
  let tasks: ReturnType<typeof startDigestSchedulers> = [];
  assert.doesNotThrow(() => {
    tasks = startDigestSchedulers(
      baseOptions({ timesString: '12:30,21:30', timezone: 'Not/AZone' }),
    );
  });
  // 两个任务都用同一非法 timezone → 都构造失败 → 返回 []，但**未抛、未崩**（轮询/health 存活）。
  assert.deepEqual(tasks, []);
});

// ─────────────────────── createSharedLockRunner：跨任务互斥 + finally 释放（§5.2, §5.5） ───────────────────────

test('共享锁跨任务互斥：A 运行中、B 触发被跳过；A 完成后 B 可再运行', async () => {
  const gate = deferred();
  let runs = 0;
  // 单一共享锁 + run；模拟两个 cron 任务回调都调用同一 runOnce（startDigestSchedulers 即如此接线）。
  const { runOnce } = createSharedLockRunner(async () => {
    runs += 1;
    await gate.promise; // A 持锁在途，直到 gate resolve。
  });

  const a = runOnce(); // 任务 A 触发：取锁、进入 run、卡在 gate。
  await flush();
  const b = runOnce(); // 任务 B 触发：A 持锁未释放 → 同步看到 running=true、跳过（不进入 run）。
  await flush();
  assert.equal(runs, 1, 'B 被共享锁挡住、不进入 run（跨任务互斥）');

  gate.resolve(); // A 完成 → finally 释放锁。
  await a;
  await b;

  // 用**原** runOnce 验证第一个 runner 确实释放了锁（新建 runner 会让断言空过）。
  // gate 已 resolve，故再次进入 run 会立即跑完。
  await runOnce();
  assert.equal(runs, 2, '锁释放后同一 runOnce 可再次进入 run');
});

test('保护体首行同步抛 → finally 仍释放锁（不泄漏）；下次触发可再运行', async () => {
  let calls = 0;
  let throwFirst = true;
  const { runOnce } = createSharedLockRunner(async () => {
    calls += 1;
    if (throwFirst) {
      throwFirst = false;
      // 保护体首行同步抛——createSharedLockRunner 内 await run() 处 reject，finally 仍跑、释放锁。
      throw new Error('boom-sync');
    }
  });

  // 首次：run 抛 → runOnce 的 promise reject（createSharedLockRunner 不吞、由调用方处理；finally 释放锁）。
  await assert.rejects(runOnce(), /boom-sync/);

  // 锁未泄漏 → 第二次触发可进入 run（calls 递增到 2）。
  await runOnce();
  assert.equal(calls, 2, 'finally 已释放锁，第二次触发进入 run（锁不泄漏）');
});

test('runOnce 不并发：同步取锁先于首个 await（同一 tick 内第二次调用被跳过）', async () => {
  const gate = deferred();
  let runs = 0;
  const { runOnce } = createSharedLockRunner(async () => {
    runs += 1;
    await gate.promise;
  });
  const p1 = runOnce();
  const p2 = runOnce(); // 同步取锁——p1 已置 running、p2 同步看到、立即 return（不进入 run）。
  await flush();
  assert.equal(runs, 1);
  gate.resolve();
  await Promise.all([p1, p2]);
});

// ─────────────────────── runDigestOnce：逐段提交 + digest-empty（§5.3, §5.5） ───────────────────────

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

  await runDigestOnce({ repo, notifier, now: FIXED_NOW });

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
});

test('逐段提交：全部 sent → 每段各自 mark（每段发成功即 mark 该段），合计覆盖全部 row-ids', async () => {
  const candidates = manyCandidates(20);
  const allIds = candidates.map((c) => c.messageRowId);
  const { repo, markCalls } = fakeRepo(candidates);
  // 全 sent（outcomes 用尽后默认 sent，覆盖任意段数）。
  const { notifier, sentTexts } = fakeNotifier([]);

  await runDigestOnce({ repo, notifier, now: FIXED_NOW });

  // ≥2 段：每段各发一次、各 mark 一次。
  assert.ok(sentTexts.length >= 2, '足量候选分多段');
  assert.equal(markCalls.length, sentTexts.length, '每段各自 mark（mark 次数 == 段数）');
  // 各段 mark 的 row-ids 拼起来 == 全部 row-ids（顺序保持）。
  assert.deepEqual(markCalls.flat(), allIds, '所有段合计覆盖全部 row-ids、不重不漏');
});

test('首段即 skipped（无渠道降级）→ 不 mark 任何段、停本轮', async () => {
  const candidates: DigestCandidate[] = [candidate({ messageRowId: 'r1' })];
  const { repo, markCalls } = fakeRepo(candidates);
  const { notifier, sentTexts } = fakeNotifier(['skipped']);

  await runDigestOnce({ repo, notifier, now: FIXED_NOW });

  assert.equal(sentTexts.length, 1);
  assert.equal(markCalls.length, 0, 'skipped（非 sent）→ 不 mark、停本轮');
});

test('无候选（buildDigest → null）：不调用 notify、记 digest-empty、不 mark', async () => {
  const { repo, markCalls } = fakeRepo([]); // 空候选 → buildDigest 返回 null。
  let notifyCalled = false;
  const notifier: Pick<Notifier, 'notifyDigest'> = {
    async notifyDigest(): Promise<NotifyResult> {
      notifyCalled = true;
      return { outcome: 'sent', channel: 'fake' };
    },
  };

  await runDigestOnce({ repo, notifier, now: FIXED_NOW });

  assert.equal(notifyCalled, false, 'null → 不调用 notify');
  assert.equal(markCalls.length, 0, 'null → 不 mark');
});

test('运行期 repo 抛错被 catch、不外泄、不崩（runDigestOnce 自身不抛）', async () => {
  const repo: Pick<MailRepo, 'listDigestCandidates' | 'markDigested'> = {
    async listDigestCandidates(): Promise<DigestCandidate[]> {
      throw Object.assign(new Error('db down'), { code: 'P1001' });
    },
    async markDigested(): Promise<void> {},
  };
  const { notifier } = fakeNotifier([]);
  // 自身 catch → 不抛。
  await assert.doesNotReject(runDigestOnce({ repo, notifier, now: FIXED_NOW }));
});

test('运行期抛错经共享锁 runOnce → finally 释放锁、不漏 promise（回调内自吞）', async () => {
  let calls = 0;
  const repo: Pick<MailRepo, 'listDigestCandidates' | 'markDigested'> = {
    async listDigestCandidates(): Promise<DigestCandidate[]> {
      calls += 1;
      throw new Error('boom');
    },
    async markDigested(): Promise<void> {},
  };
  const { notifier } = fakeNotifier([]);
  const { runOnce } = createSharedLockRunner(() =>
    runDigestOnce({ repo, notifier, now: FIXED_NOW }),
  );

  // runDigestOnce 自吞 → runOnce 不 reject；锁经 finally 释放 → 第二次仍可进入。
  await assert.doesNotReject(runOnce());
  await assert.doesNotReject(runOnce());
  assert.equal(calls, 2, '锁未泄漏：两次都进入 run');
});
