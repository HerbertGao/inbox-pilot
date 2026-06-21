// 离线验收（组 §6.2）：调度器不重入锁（node:test，无真实 cron timing）。
//
// 测 createGuardedPoll 的进程内不重入锁：
//   - 上一轮在途时再次调用被跳过（不并发）——注入「可手动 resolve 的」假 poll，断言第二次
//     调用在第一轮 resolve 前不再发起 poll（callCount 不增），第一轮 resolve 后下一次又能发起。
//   - 一轮 poll 抛异常后，下一次调用仍能正常发起（锁在 finally 释放、未被永久占用）。
//
// 不依赖真实 timer：直接构造 guardedPoll 并手动并发/串行调用，断言取锁/释放语义。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildCronExpression, createGuardedPoll } from './scheduler.js';

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

test('createGuardedPoll：上一轮未结束时再次触发被跳过（不并发）', async () => {
  let callCount = 0;
  let pending = deferred();
  const poll = (): Promise<void> => {
    callCount += 1;
    return pending.promise;
  };
  const guarded = createGuardedPoll(poll);

  // 第一次触发：发起一轮 poll（在途、未 resolve）。
  const first = guarded();
  assert.equal(callCount, 1, '第一次触发应发起一轮 poll');

  // 第二次触发（上一轮仍在途）：必须被跳过，不再发起 poll、不并发。
  await guarded();
  assert.equal(callCount, 1, '上一轮在途时第二次触发应被跳过（callCount 不增）');

  // 结束第一轮，锁释放。
  pending.resolve();
  await first;

  // 锁释放后，下一次触发应能正常发起新一轮 poll。
  pending = deferred();
  const third = guarded();
  assert.equal(callCount, 2, '上一轮结束后下一次触发应能正常发起');
  pending.resolve();
  await third;
});

test('createGuardedPoll：一轮轮询抛异常后，下一次触发仍能正常发起（锁在 finally 释放）', async () => {
  let callCount = 0;
  let shouldThrow = true;
  const poll = async (): Promise<void> => {
    callCount += 1;
    if (shouldThrow) {
      throw new Error('boom: 一轮轮询整体抛异常');
    }
  };
  const guarded = createGuardedPoll(poll);

  // 第一轮整体抛异常——guardedPoll 内部 catch+finally，不外泄、不崩；锁须在 finally 释放。
  await guarded();
  assert.equal(callCount, 1, '第一轮应已发起（即便抛异常）');

  // 第二次触发：锁未被永久占用，仍能正常发起新一轮。
  shouldThrow = false;
  await guarded();
  assert.equal(callCount, 2, '上一轮抛异常后下一次触发仍能正常发起（锁未被永久占用）');
});

test('createGuardedPoll：连续多轮（每轮按序完成）均能逐次发起', async () => {
  let callCount = 0;
  const poll = async (): Promise<void> => {
    callCount += 1;
  };
  const guarded = createGuardedPoll(poll);

  // 每轮立即完成（无重叠）——三次串行触发应各自发起。
  await guarded();
  await guarded();
  await guarded();
  assert.equal(callCount, 3, '无重叠的串行触发应逐次发起');
});

test('buildCronExpression：N<60 → 每 N 秒；60 整除 → 每 M 分钟；越界 → 回退每 60 秒', () => {
  assert.equal(buildCronExpression(180), '0 */3 * * * *');
  assert.equal(buildCronExpression(30), '*/30 * * * * *');
  assert.equal(buildCronExpression(1), '*/1 * * * * *');
  assert.equal(buildCronExpression(60), '0 */1 * * * *');
  // 非 60 整除的分钟、>=3600、或非法值 → 合法回退表达式（不写出 cron 会拒绝的串）。
  assert.equal(buildCronExpression(90), '*/60 * * * * *');
  assert.equal(buildCronExpression(7200), '*/60 * * * * *');
  assert.equal(buildCronExpression(0), '*/60 * * * * *');
});
