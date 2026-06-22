// 离线验收（组 E §5.2）：per-account 调度（不依赖真实 cron timing）。
//
// 测 createAccountGuard / Semaphore + buildCronExpression：
//   - 多账号并发：各自 guard 共享信号量，可同时在途（受 cap 约束）。
//   - 故障隔离：一账号抛异常（含 ProviderReauthRequired）不影响其他账号。
//   - reauth-suspend：ProviderReauthRequired → 该账号 suspended（后续 tick 跳过、不再 poll）+ enabled 置 false。
//   - 并发不超上限：cap 个名额、第 cap+1 个排队，同时在途数 == cap。
//   - 单账号不重入：同账号上一轮在途时第二次触发被跳过。
//   - 挂死 poll 受超时约束：超时后名额被释放，排队账号得以推进（不永久占名额）。
//
// 不依赖真实 timer：直接构造 guard 并手动并发/串行调用 + deferred poll，断言取锁/释放/并发/超时语义。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCronExpression,
  createAccountGuard,
  Semaphore,
  PollTimeoutError,
} from './scheduler.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import type { MailRepo } from '../repo/mailRepo.js';

/** 构造一个可外部手动 resolve/reject 的 deferred（模拟一轮在途的轮询）。 */
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

/** 让 microtask 队列排空（使 await 链上的同步分支跑完）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** 记录 setAccountEnabled 调用的假 repo（只实现 guard 用到的方法）。 */
function fakeRepo(): {
  repo: Pick<MailRepo, 'setAccountEnabled'>;
  calls: Array<{ id: string; enabled: boolean }>;
  failNext: () => void;
} {
  const calls: Array<{ id: string; enabled: boolean }> = [];
  let fail = false;
  return {
    calls,
    failNext: () => {
      fail = true;
    },
    repo: {
      async setAccountEnabled(id: string, enabled: boolean): Promise<void> {
        calls.push({ id, enabled });
        if (fail) {
          fail = false;
          throw Object.assign(new Error('db down'), { code: 'P1001' });
        }
      },
    },
  };
}

test('buildCronExpression：N<60 → 每 N 秒；60 整除 → 每 M 分钟；越界 → 回退每 60 秒', () => {
  assert.equal(buildCronExpression(180), '0 */3 * * * *');
  assert.equal(buildCronExpression(30), '*/30 * * * * *');
  assert.equal(buildCronExpression(1), '*/1 * * * * *');
  assert.equal(buildCronExpression(60), '0 */1 * * * *');
  assert.equal(buildCronExpression(90), '*/60 * * * * *');
  assert.equal(buildCronExpression(7200), '*/60 * * * * *');
  assert.equal(buildCronExpression(0), '*/60 * * * * *');
});

// ——————————————————————————————————————————————————————————
// Semaphore
// ——————————————————————————————————————————————————————————

test('Semaphore：name额耗尽后排队，release 唤醒队首（FIFO）', async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // 取走唯一名额

  let secondAcquired = false;
  const second = sem.acquire().then(() => {
    secondAcquired = true;
  });
  await flush();
  assert.equal(secondAcquired, false, '名额耗尽时第二个 acquire 应排队（未拿到）');

  sem.release(); // 还名额 → 唤醒队首
  await second;
  assert.equal(secondAcquired, true, 'release 后排队的 acquire 应被唤醒');
});

test('Semaphore：permits<=0 归一为至少 1（不永久死锁）', async () => {
  const sem = new Semaphore(0);
  await sem.acquire(); // 若未归一为 1 则永久挂起 → 测试超时失败
  sem.release();
});

// ——————————————————————————————————————————————————————————
// createAccountGuard：多账号并发
// ——————————————————————————————————————————————————————————

test('createAccountGuard：多账号在 cap 内可同时在途（并发轮询）', async () => {
  const sem = new Semaphore(4);
  const { repo } = fakeRepo();
  const pendingA = deferred();
  const pendingB = deferred();
  let aInFlight = false;
  let bInFlight = false;

  const guardA = createAccountGuard({
    accountId: 'a',
    poll: () => {
      aInFlight = true;
      return pendingA.promise;
    },
    semaphore: sem,
    repo,
  });
  const guardB = createAccountGuard({
    accountId: 'b',
    poll: () => {
      bInFlight = true;
      return pendingB.promise;
    },
    semaphore: sem,
    repo,
  });

  const ra = guardA();
  const rb = guardB();
  await flush();
  assert.equal(aInFlight && bInFlight, true, '两账号应可同时在途（并发）');

  pendingA.resolve();
  pendingB.resolve();
  await Promise.all([ra, rb]);
});

// ——————————————————————————————————————————————————————————
// 故障隔离：一账号抛异常（含 ProviderReauthRequired）不影响其他
// ——————————————————————————————————————————————————————————

test('createAccountGuard：一账号抛普通异常不崩、不影响其他账号', async () => {
  const sem = new Semaphore(4);
  const { repo, calls } = fakeRepo();
  let bRan = false;

  const guardA = createAccountGuard({
    accountId: 'a',
    poll: async () => {
      throw Object.assign(new Error('imap connect failed'), { code: 'ECONNREFUSED' });
    },
    semaphore: sem,
    repo,
  });
  const guardB = createAccountGuard({
    accountId: 'b',
    poll: async () => {
      bRan = true;
    },
    semaphore: sem,
    repo,
  });

  await guardA(); // 不抛（内部 catch）
  await guardB();
  assert.equal(bRan, true, '一账号异常后其他账号照常轮询');
  assert.equal(calls.length, 0, '普通异常不应 setAccountEnabled（不 suspend、保持 enabled）');

  // a 下一 tick 仍能重试（普通异常不 suspend）。
  let aRetried = false;
  const guardA2 = createAccountGuard({
    accountId: 'a',
    poll: async () => {
      aRetried = true;
    },
    semaphore: sem,
    repo,
  });
  await guardA2();
  assert.equal(aRetried, true, '普通异常后该账号下 tick 仍重试（不被 suspend）');
});

test('createAccountGuard：一账号抛 ProviderReauthRequired 不影响其他账号', async () => {
  const sem = new Semaphore(4);
  const { repo } = fakeRepo();
  let bRan = false;

  const guardA = createAccountGuard({
    accountId: 'a',
    poll: async () => {
      throw new ProviderReauthRequired('a');
    },
    semaphore: sem,
    repo,
  });
  const guardB = createAccountGuard({
    accountId: 'b',
    poll: async () => {
      bRan = true;
    },
    semaphore: sem,
    repo,
  });

  await guardA();
  await guardB();
  assert.equal(bRan, true, 'reauth 账号失败后其他账号照常轮询');
});

// ——————————————————————————————————————————————————————————
// reauth-suspend：suspended（后续 tick 跳过）+ enabled 置 false
// ——————————————————————————————————————————————————————————

test('createAccountGuard：ProviderReauthRequired → suspended（后续 tick 不再 poll）+ enabled=false', async () => {
  const sem = new Semaphore(4);
  const { repo, calls } = fakeRepo();
  let pollCount = 0;

  const guard = createAccountGuard({
    accountId: 'gmail:user@example.com',
    poll: async () => {
      pollCount += 1;
      throw new ProviderReauthRequired('gmail:user@example.com');
    },
    semaphore: sem,
    repo,
  });

  await guard();
  assert.equal(pollCount, 1, '首轮应已发起 poll（随后抛 reauth）');
  assert.deepEqual(
    calls,
    [{ id: 'gmail:user@example.com', enabled: false }],
    'reauth → setAccountEnabled(id, false) 持久化暂停',
  );

  // 后续 tick：suspended → 直接跳过、不再 poll（不每 tick 重打 Google）。
  await guard();
  await guard();
  assert.equal(pollCount, 1, 'suspended 后后续 tick 不再 poll（跳过）');
});

test('createAccountGuard：reauth 先置进程内 suspended、再写 DB；DB 写失败仍 suspended', async () => {
  const sem = new Semaphore(4);
  const { repo, failNext } = fakeRepo();
  failNext(); // setAccountEnabled 抛错（DB 写失败可容忍）
  let pollCount = 0;

  const guard = createAccountGuard({
    accountId: 'a',
    poll: async () => {
      pollCount += 1;
      throw new ProviderReauthRequired('a');
    },
    semaphore: sem,
    repo,
  });

  await guard(); // setAccountEnabled 抛错被吞（只记日志）
  assert.equal(pollCount, 1);

  // DB 写失败但进程内已 suspended：后续 tick 仍跳过、不再 poll。
  await guard();
  assert.equal(pollCount, 1, 'DB 写失败也已先置 suspended，后续 tick 仍跳过');
});

// ——————————————————————————————————————————————————————————
// 并发不超上限（共享信号量）
// ——————————————————————————————————————————————————————————

test('createAccountGuard：同时在途数不超过并发上限（共享信号量）', async () => {
  const cap = 2;
  const sem = new Semaphore(cap);
  const { repo } = fakeRepo();
  let inFlight = 0;
  let maxInFlight = 0;
  const pendings: Array<ReturnType<typeof deferred>> = [];

  const makeGuard = (id: string) =>
    createAccountGuard({
      accountId: id,
      poll: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const d = deferred();
        pendings.push(d);
        return d.promise.finally(() => {
          inFlight -= 1;
        });
      },
      semaphore: sem,
      repo,
    });

  // 4 账号同时触发，cap=2 → 同时在途至多 2。
  const runs = [makeGuard('a')(), makeGuard('b')(), makeGuard('c')(), makeGuard('d')()];
  await flush();
  assert.equal(maxInFlight, cap, '同时在途数应正好等于 cap（不超上限）');
  assert.equal(inFlight, cap, '其余账号应在排队（未在途）');

  // 逐个完成在途的，唤醒排队者；全程 maxInFlight 不超过 cap。
  while (pendings.length > 0) {
    const d = pendings.shift()!;
    d.resolve();
    await flush();
    assert.ok(maxInFlight <= cap, '全程同时在途数不得超过 cap');
  }
  await Promise.all(runs);
  assert.equal(maxInFlight, cap, '全程峰值并发 == cap');
});

// ——————————————————————————————————————————————————————————
// 单账号不重入
// ——————————————————————————————————————————————————————————

test('createAccountGuard：同账号上一轮在途时第二次触发被跳过（不重入）', async () => {
  const sem = new Semaphore(4);
  const { repo } = fakeRepo();
  let callCount = 0;
  const pending = deferred();

  const guard = createAccountGuard({
    accountId: 'a',
    poll: () => {
      callCount += 1;
      return pending.promise;
    },
    semaphore: sem,
    repo,
  });

  const first = guard();
  await flush();
  assert.equal(callCount, 1, '首轮应发起 poll');

  await guard(); // 上一轮在途 → 跳过（acquire 后见 isPolling、release 名额、跳过）
  assert.equal(callCount, 1, '同账号上一轮在途时第二次触发应被跳过（不重入）');

  pending.resolve();
  await first;

  // 上一轮结束后，下一次触发能正常发起。
  const pending2 = deferred();
  const guard2 = createAccountGuard({
    accountId: 'a',
    poll: () => {
      callCount += 1;
      return pending2.promise;
    },
    semaphore: sem,
    repo,
  });
  const third = guard2();
  await flush();
  assert.equal(callCount, 2, '上一轮结束后下一次触发应能正常发起');
  pending2.resolve();
  await third;
});

// ——————————————————————————————————————————————————————————
// 挂死 poll 受超时约束（不永久占名额）
// ——————————————————————————————————————————————————————————

test('createAccountGuard：挂死 poll 受单轮超时约束、超时后释放名额（不永久占名额）', async () => {
  const sem = new Semaphore(1); // cap=1：挂死 poll 若不释放名额则后续账号永远饿死
  const { repo } = fakeRepo();
  const hung = deferred(); // 永不 resolve（模拟挂死）

  const guardHung = createAccountGuard({
    accountId: 'hung',
    poll: () => hung.promise,
    semaphore: sem,
    repo,
    timeoutMs: 20, // 极短超时
  });

  const hungRun = guardHung(); // 取走唯一名额、超时后释放

  // 超时后名额释放，另一账号可推进。
  let otherRan = false;
  const guardOther = createAccountGuard({
    accountId: 'other',
    poll: async () => {
      otherRan = true;
    },
    semaphore: sem,
    repo,
  });

  await hungRun; // guard 内部超时 → catch → finally 释放名额（不外抛）
  await guardOther();
  assert.equal(otherRan, true, '挂死 poll 超时释放名额后，排队账号得以推进（不永久占名额）');
});

test('createAccountGuard：超时释放名额但 isPolling 锁由真实 poll 持有——同账号第二 tick 仍被跳过（跨超时不重入）', async () => {
  const sem = new Semaphore(4);
  const { repo } = fakeRepo();
  let callCount = 0;
  const hung = deferred(); // 真实 poll 挂死过超时

  const guard = createAccountGuard({
    accountId: 'a',
    poll: () => {
      callCount += 1;
      return hung.promise;
    },
    semaphore: sem,
    repo,
    timeoutMs: 20,
  });

  // 第一 tick：发起 poll、超时后界定本轮（名额释放），但真实 poll 仍在途、持 isPolling 锁。
  await guard();
  assert.equal(callCount, 1, '首轮已发起 poll');

  // 第二 tick（真实 poll 仍在途）：必须被判重入、跳过——不发起对同账号的第二次并发 poll。
  await guard();
  assert.equal(callCount, 1, '真实 poll 仍在途时第二 tick 被跳过（跨超时不重入、无双重 poll）');

  // 真实 poll 终于 settle → 释放 isPolling 锁。
  hung.resolve();
  await flush();

  // 之后的 tick 可正常发起。
  const next = deferred();
  const guard2 = createAccountGuard({
    accountId: 'a',
    poll: () => {
      callCount += 1;
      return next.promise;
    },
    semaphore: sem,
    repo,
  });
  const r = guard2();
  await flush();
  assert.equal(callCount, 2, '真实 poll settle 后下一 tick 可正常发起');
  next.resolve();
  await r;
});

test('createAccountGuard：挂死 poll 超时释放名额——其他账号在同账号仍在途时仍可推进', async () => {
  const sem = new Semaphore(1); // cap=1：挂死 poll 若不释放名额则他账号永远饿死
  const { repo } = fakeRepo();
  const hung = deferred(); // 永不在超时前 resolve

  const guardHung = createAccountGuard({
    accountId: 'hung',
    poll: () => hung.promise,
    semaphore: sem,
    repo,
    timeoutMs: 20,
  });
  await guardHung(); // 超时 → 名额释放（真实 poll 仍在途、持自身 isPolling 锁）

  let otherRan = false;
  const guardOther = createAccountGuard({
    accountId: 'other',
    poll: async () => {
      otherRan = true;
    },
    semaphore: sem,
    repo,
  });
  await guardOther();
  assert.equal(otherRan, true, '挂死 poll 超时释放名额后、他账号推进（信号量名额未被挂死 poll 永占）');
});

test('PollTimeoutError：超时错误是非致命（不 suspend、保持 enabled）', async () => {
  const sem = new Semaphore(1);
  const { repo, calls } = fakeRepo();
  const hung = deferred();

  const guard = createAccountGuard({
    accountId: 'a',
    poll: () => hung.promise,
    semaphore: sem,
    repo,
    timeoutMs: 20,
  });

  await guard();
  assert.equal(calls.length, 0, '超时是瞬时异常，不应 setAccountEnabled（不 suspend）');
  assert.ok(new PollTimeoutError() instanceof Error, 'PollTimeoutError 是 Error');
});

// ——————————————————————————————————————————————————————————
// FIX A：poll() **同步**抛（gmail 构造期同步 throw）——锁与信号量名额必须在每条退出路径释放
// ——————————————————————————————————————————————————————————

test('createAccountGuard：poll() 同步抛 → 账号不被永久锁死（下一 tick 仍能 poll）', async () => {
  const sem = new Semaphore(1);
  const { repo } = fakeRepo();
  let throwSync = true;
  let ran = false;

  const guard = createAccountGuard({
    accountId: 'a',
    // 同步 throw（非 async）：模拟 createGmailClient/createGmailPoller 构造期同步抛。
    poll: (): Promise<void> => {
      if (throwSync) {
        throw Object.assign(new Error('sync construct boom'), { code: 'ECONSTRUCT' });
      }
      ran = true;
      return Promise.resolve();
    },
    semaphore: sem,
    repo,
  });

  await guard(); // 同步抛被兜底（不外抛、不永久锁死）。
  throwSync = false;
  await guard(); // 锁已在同步抛路径释放 → 下一 tick 能正常发起。
  assert.equal(ran, true, '同步抛后账号未被永久锁死（下一 tick 仍能 poll）');
});

test('createAccountGuard：poll() 同步抛不泄漏信号量名额（cap=1 下他账号仍能 poll）', async () => {
  const sem = new Semaphore(1); // cap=1：若同步抛泄漏名额，他账号将永远饿死。
  const { repo } = fakeRepo();

  const guardSync = createAccountGuard({
    accountId: 'a',
    poll: (): Promise<void> => {
      throw new Error('sync construct boom');
    },
    semaphore: sem,
    repo,
  });
  await guardSync(); // 同步抛 → 名额必须在该路径释放。

  let otherRan = false;
  const guardOther = createAccountGuard({
    accountId: 'b',
    poll: async () => {
      otherRan = true;
    },
    semaphore: sem,
    repo,
  });
  await guardOther();
  assert.equal(otherRan, true, '同步抛释放名额后他账号可推进（名额未泄漏）');
});

test('createAccountGuard：poll() 同步抛 ProviderReauthRequired → 仍 suspend（后续 tick 跳过 + enabled=false）', async () => {
  const sem = new Semaphore(4);
  const { repo, calls } = fakeRepo();
  let pollCount = 0;

  const guard = createAccountGuard({
    accountId: 'gmail:user@example.com',
    poll: (): Promise<void> => {
      pollCount += 1;
      throw new ProviderReauthRequired('gmail:user@example.com'); // 同步抛 reauth。
    },
    semaphore: sem,
    repo,
  });

  await guard();
  assert.equal(pollCount, 1, '首轮已发起 poll（随后同步抛 reauth）');
  assert.deepEqual(
    calls,
    [{ id: 'gmail:user@example.com', enabled: false }],
    '同步抛 reauth 仍经 handlePollError → setAccountEnabled(false)',
  );

  await guard();
  assert.equal(pollCount, 1, '同步抛 reauth 后 suspended，后续 tick 跳过、不再 poll');
});

// ——————————————————————————————————————————————————————————
// N1：late-reject-after-timeout——真实 poll 在超时**之后**才 reject
// ——————————————————————————————————————————————————————————

test('createAccountGuard：poll 在超时后才 reject → 无 unhandledRejection、isPolling 在 settle 时释放', async () => {
  const sem = new Semaphore(4);
  const { repo, calls } = fakeRepo();
  let callCount = 0;
  const late = deferred(); // 真实 poll 在超时后才 reject。
  const nextResolve = deferred(); // 第二轮（settle 后）正常完成。

  // 监听 unhandledRejection：late-reject 必须被 guard 的 pollPromise.then(()=>{},()=>{}) 吞掉。
  let unhandled = false;
  const onUnhandled = (): void => {
    unhandled = true;
  };
  process.on('unhandledRejection', onUnhandled);

  // **同一 guard 实例**（共享其 isPolling 锁）——以真正断言「真实 poll 晚于超时 settle 时释放锁」。
  const guard = createAccountGuard({
    accountId: 'a',
    poll: () => {
      callCount += 1;
      return callCount === 1 ? late.promise : nextResolve.promise;
    },
    semaphore: sem,
    repo,
    timeoutMs: 20,
  });

  try {
    await guard(); // 超时界定本轮（catch PollTimeoutError、不 suspend），真实 poll 仍在途、持 isPolling 锁。
    assert.equal(callCount, 1, '首轮已发起 poll');
    assert.equal(calls.length, 0, '超时非致命：不 suspend');

    // 真实 poll 终于 reject（晚于超时）。其 reject 由 guard 内部 then(()=>{},()=>{}) 吞掉。
    late.reject(Object.assign(new Error('late boom'), { code: 'ELATE' }));
    await flush();
    await new Promise((r) => setImmediate(r)); // 让可能的 unhandledRejection 落地。
    assert.equal(unhandled, false, 'late-reject 不应产生 unhandledRejection');

    // isPolling 在真实 poll settle（late-reject）时已由 pollPromise.finally 释放 → 同一 guard 的
    // 下一 tick 可正常发起（callCount 增到 2）。
    const r = guard();
    await flush();
    assert.equal(callCount, 2, 'late-reject settle 后 isPolling 已释放，同一 guard 下一 tick 可发起');
    nextResolve.resolve();
    await r;
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
