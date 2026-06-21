// 定时轮询调度（spec「需求:定时轮询调度与单账号不重入」、design 决策 5）。
//
// 职责：用 node-cron 按 POLL_INTERVAL_SECONDS 周期触发 IMAP 轮询，并保证**单账号轮询不重入**：
//   - cron 回调进入任何 await 前**同步**获取进程内 isPolling 锁；上一轮尚未结束则跳过本次触发。
//   - 锁**必须在 finally 释放**（含轮询抛异常的路径），否则一次异常永久锁死该账号、再不轮询。
//
// 设计：把「不重入锁包裹的 poll runner」（createGuardedPoll）与「cron 接线」（startScheduler）拆开——
//   - createGuardedPoll 返回一个无参 runner，封装同步取锁 + finally 释放，**不依赖真实 timer**，
//     使 6.2 单测能注入假 poll 函数、并发调用断言不重入、抛异常后下一次仍能发起（无需真 cron timing）。
//   - startScheduler 仅做 cron 接线（按 POLL_INTERVAL_SECONDS 构造 cron 表达式）+ 把 runner 挂为回调。
//
// 定位（design 决策 5）：进程内锁只解决**单进程内**重入；跨实例兜底是去重键（DB unique）。
// `// ponytail: 单进程布尔锁；多实例改 DB advisory lock / 把 unique 约束当唯一权威（后续阶段）。`

import cron, { type ScheduledTask } from 'node-cron';

import { logger } from '../logger.js';

/**
 * 无参的「一轮轮询」runner（同步取锁 + finally 释放后的产物）。
 * cron 回调每次触发即调用它；其返回的 Promise 仅供测试 await（cron 不 await 回调返回值）。
 */
export type GuardedPoll = () => Promise<void>;

/**
 * 把一个「执行一轮轮询」的 async 函数包成**不重入**的 runner（spec「慢轮询不重入」「轮询抛异常不锁死」）。
 *
 * 不重入语义：
 *   - 回调体在进入任何 await **之前**同步检查并置位 isPolling 锁——故两次「同步连续」或「上一轮
 *     在途时」的触发，第二次会立即命中锁、记一条 skip 日志并直接返回（不并发发起 poll）。
 *   - 锁在 finally 释放（含 poll reject 路径），使下一次触发总能正常发起（不被一次异常永久锁死）。
 *   - poll 抛出的异常在此被 catch+log（脱敏摘要）——调度不应因单轮异常崩进程；锁仍在 finally 释放。
 *
 * @param poll 执行一轮轮询的函数（prod 注入绑定了 account+repo 的 pollAccount 闭包；测试注入假体）。
 */
export function createGuardedPoll(poll: () => Promise<void>): GuardedPoll {
  // 进程内不重入锁。回调在首个 await 前同步读写它，故无竞态（Node 单线程、无抢占）。
  let isPolling = false;

  return async function guardedPoll(): Promise<void> {
    // —— 同步取锁（进入任何 await 前）——上一轮未结束则跳过本次触发，不并发。
    if (isPolling) {
      logger.info(
        { kind: 'imap-poll-skipped-reentrant' },
        '上一轮轮询尚未结束，跳过本次触发（单账号不重入）',
      );
      return;
    }
    isPolling = true;

    try {
      await poll();
    } catch (err) {
      // 单轮整体异常：记脱敏摘要，不崩进程（连接/网络异常下轮重试）；锁仍在 finally 释放。
      logger.warn(
        {
          kind: 'imap-poll-round-failed',
          errorName: err instanceof Error ? err.name : 'unknown',
          errorCode: (err as { code?: unknown })?.code,
        },
        '本轮轮询整体抛出异常（已记录、不锁死后续触发）',
      );
    } finally {
      // 必须在 finally 释放（含异常路径）——否则一次异常永久锁死该账号。
      isPolling = false;
    }
  };
}

/**
 * 由 POLL_INTERVAL_SECONDS 构造 node-cron 表达式（6 段，含秒位）。
 * - N < 60：秒位用步进 N、其余位通配（每 N 秒）。
 * - N 为 60 的整数倍且 < 3600：秒位 0、分位步进 M=N/60（每 M 分钟整点）。
 * - 其余（含 >= 3600 或非整除）：回退到「每 60 秒」并记一条信息日志——保持简单且正确（绝不写出
 *   会被 cron 拒绝的非法表达式；MVP 单账号轮询不需要更复杂的周期表达力）。
 */
export function buildCronExpression(intervalSeconds: number): string {
  const n = Math.floor(intervalSeconds);
  if (Number.isFinite(n) && n >= 1 && n < 60) {
    return `*/${n} * * * * *`;
  }
  if (Number.isFinite(n) && n >= 60 && n < 3600 && n % 60 === 0) {
    return `0 */${n / 60} * * * *`;
  }
  // 兜底：保证表达式合法。N 越界/非整除分钟时退化为每 60 秒。
  logger.info(
    { kind: 'imap-poll-interval-fallback', intervalSeconds },
    'POLL_INTERVAL_SECONDS 不在简单周期范围内，调度回退为每 60 秒',
  );
  return '*/60 * * * * *';
}

/**
 * 启动定时轮询调度：按 intervalSeconds 构造 cron 表达式，每次触发调用不重入 runner。
 * 返回 node-cron 的 ScheduledTask——调用方（main.ts 优雅关闭）须 `task.stop()` 停止调度。
 *
 * @param poll           执行一轮轮询的函数（prod：() => pollAccount(account, repo)）。
 * @param intervalSeconds 轮询周期（config.POLL_INTERVAL_SECONDS）。
 */
export function startScheduler(
  poll: () => Promise<void>,
  intervalSeconds: number,
): ScheduledTask {
  const guarded = createGuardedPoll(poll);
  const expression = buildCronExpression(intervalSeconds);
  logger.info(
    { kind: 'imap-scheduler-started', intervalSeconds, expression },
    'IMAP 轮询调度器已启动',
  );
  // cron 不 await 回调返回值——guarded 内部已自行 catch+finally，异常不外泄、锁必释放。
  return cron.schedule(expression, () => {
    void guarded();
  });
}
