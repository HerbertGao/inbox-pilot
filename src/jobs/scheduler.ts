// 定时轮询调度（spec account-registry「需求:per-account 调度与故障隔离」「需重授权账号必须真正暂停」、
// design 决策 7）。
//
// 职责：用 node-cron 按 POLL_INTERVAL_SECONDS 周期为**每个 enabled 账号**独立触发轮询，并保证：
//   - **单账号不重入**：每账号一把进程内 isPolling 锁（同步取 + finally 释放）。上一轮未结束则跳过本次。
//   - **故障隔离**：任一账号 poll 异常被 catch+记错（只 code+kind、**不记传播对象/cause**），不崩进程、
//     不拖累其他账号；锁与信号量名额在 finally 释放。
//   - **需重授权暂停**：仅当错误是 `ProviderReauthRequired`（instanceof）→ **先**置进程内 suspended 标志
//     （本进程后续 tick 跳过该账号）、**再** try `setAccountEnabled(id,false)`（持久化、下次启动不加载）。
//     先置标志再写 DB——DB 写失败可容忍（本轮已停轮询、下次重启重载会再 suspend）。瞬时 429 / 一般
//     轮询异常**只记日志、保持 enabled、下 tick 重试**（不 suspend、不每 tick 紧打 Google）。
//   - **全局并发上限**：共享信号量（默认 ≤4，`// ponytail: cap≥账号数则无 tick 饿死`）。**先 acquire
//     信号量、再取 per-account 锁**——避免排队账号持锁等待致其下个 tick 误判重入（排队 tick 跳过可接受）。
//   - **单轮 poll 超时**：超时界定本轮 + 释放信号量名额（googleapis 无连接可 destroy；部分完成靠 per-mail
//     processedAt 幂等保一致，`// ponytail: AbortSignal 取消为 best-effort、本期仅以超时释放名额，不强制
//     中断底层 HTTP——部分完成的工作下轮经 DB 预去重不重复）。
//
// 设计：把各可注入小件（Semaphore / 单账号 guard / 超时）与「cron 接线」拆开，使单测能注入假 poll、
// 假 repo、合成 ProviderReauthRequired，断言并发上限/不重入/隔离/suspend/超时，不依赖真 cron timing。
//
// 定位（design 决策 7）：进程内锁 + suspended 标志只解决**单进程内**重入/暂停；跨实例兜底是去重键（DB
// unique）+ enabled 持久暂停。`// ponytail: 单进程；多实例改 DB advisory lock / 公平轮转留后续。`

import cron, { type ScheduledTask } from 'node-cron';

import { logger } from '../logger.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import type { MailRepo } from '../repo/mailRepo.js';

/** 默认全局并发上限（同时进行的轮询数）。// ponytail: cap≥账号数则无 tick 饿死。 */
export const DEFAULT_CONCURRENCY = 4;

/** 默认单轮 poll 超时（ms）：界定本轮 + 释放信号量名额，防挂死 poll 永占名额、饿死队列。 */
export const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

/**
 * 无参的「一轮轮询」runner（同步取锁 + finally 释放后的产物）。
 * cron 回调每次触发即调用它；其返回的 Promise 仅供测试 await（cron 不 await 回调返回值）。
 */
export type GuardedPoll = () => Promise<void>;

/**
 * 计数信号量（全局并发上限）：acquire 在名额可用前排队、release 唤醒队首（FIFO）。
 * Node 单线程、无抢占——计数与等待队列的读写无竞态。
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    // 至少 1（≤0 会永久死锁所有 poll）；非整数向下取整。
    this.available = Math.max(1, Math.floor(permits));
  }

  /** 取一个名额；无名额则排队等待（resolve 时已持有名额）。 */
  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 还一个名额：有等待者则直接把名额转交队首（不增计数），否则计数 +1。 */
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next(); // 名额直接转交（available 不变，相当于「转手」给等待者）。
      return;
    }
    this.available += 1;
  }
}

/** 单账号 guard 的注入点（测试注入假 poll / 假 repo / 控制超时 / 注入 sleep）。 */
export type AccountGuardDeps = {
  /** = MailAccount.id（去重键命名空间 + 运营标识，可入日志）。 */
  readonly accountId: string;
  /** 执行一轮该账号轮询（prod：构造 poller 并 poll()；测试：假体）。 */
  readonly poll: () => Promise<void>;
  /** 共享信号量（全局并发上限）；多账号共用同一实例。 */
  readonly semaphore: Semaphore;
  /** 持久化暂停 seam（reauth-suspend 写 enabled=false）。 */
  readonly repo: Pick<MailRepo, 'setAccountEnabled'>;
  /** 单轮 poll 超时（ms）。默认 DEFAULT_POLL_TIMEOUT_MS。 */
  readonly timeoutMs?: number;
};

/**
 * 单账号 guard：返回一个不重入 runner（同步取锁前先 acquire 信号量），它对一轮 poll 施加超时、
 * 故障隔离、reauth-suspend。
 *
 * 控制流（spec「先 acquire 信号量再取 per-account 锁」「排队 tick 跳过可接受」）：
 *   1. **suspended** 直接跳过（不 acquire 信号量、不 poll）——需重授权账号本进程后续 tick 全跳过。
 *   2. **先 acquire 信号量**（可能排队）——排队期间**不**持 per-account 锁；故排队的本账号 tick 不会因
 *      持锁被误判重入，但若上一轮仍在跑则会在步骤 3 被跳过（排队 tick 跳过可接受）。
 *   3. acquire 后**同步**检查 per-account isPolling 锁：已在跑（同账号不重入）→ release 信号量、跳过。
 *      否则置 isPolling=true。
 *   4. **发起一次** poll；isPolling 锁的释放绑定到**真实** poll settle（pollPromise.finally，
 *      late-safe——即便晚于超时）。再对该 pollPromise 施加单轮超时（raceWithTimeout）；超时/异常被 catch。
 *   5. `ProviderReauthRequired` → **先**置进程内 suspended、**再** try setAccountEnabled(false)；
 *      其余异常（含 429 / 超时）只记日志、保持 enabled。
 *   6. finally：**仅** release 信号量名额（isPolling 锁归 pollPromise.finally）——超时释放名额让他账号
 *      推进；真实 poll 继续在途并独占其 isPolling 锁直至 settle，故**跨超时仍保不重入**（挂死 poll
 *      永久持其自身锁、不轮询也不饿死他账号）。
 *
 * suspended 一旦置位，后续 tick 直接跳过（不 acquire 信号量、不再 poll）——不每 tick 重列重 get 重 403。
 */
export function createAccountGuard(deps: AccountGuardDeps): GuardedPoll {
  const { accountId, poll, semaphore, repo } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  // 进程内不重入锁 + 需重授权暂停标志。Node 单线程、回调在 acquire 后同步读写它们，无竞态。
  let isPolling = false;
  let suspended = false;

  return async function guardedAccountPoll(): Promise<void> {
    // —— suspended：本进程后续 tick 直接跳过（不 acquire、不 poll）——
    if (suspended) {
      logger.info(
        { kind: 'account-poll-skipped-suspended', accountId },
        '该账号已标记需重授权（suspended），跳过本次触发（恢复需 CLI 重授权 + 重启）',
      );
      return;
    }

    // —— 先 acquire 信号量、再取 per-account 锁（spec 顺序）。排队期间不持锁、不阻塞他账号取名额。——
    await semaphore.acquire();

    // acquire 成功后**同步**检查 per-account 锁：同账号上一轮在途 → release 名额、跳过（不并发同账号）。
    if (isPolling) {
      semaphore.release();
      logger.info(
        { kind: 'account-poll-skipped-reentrant', accountId },
        '上一轮轮询尚未结束，跳过本次触发（单账号不重入）',
      );
      return;
    }
    isPolling = true;

    // —— 只发起一次 poll；isPolling 锁由**真实** poll settle 时释放（即便晚于超时）——
    // 超时只界定本轮 + 释放信号量名额（见下方 finally），**不**提前释放 isPolling 锁；否则真实
    // poll 仍在途时下一 tick 会发起对同账号的第二次并发 poll（违反不重入 → 重复动作/通知）。
    //
    // **poll() 的同步构造（createGmailClient/createGmailProvider/createGmailPoller 等）可同步抛**——
    // 那时尚无 pollPromise，下方的 pollPromise.finally / raceWithTimeout 都不会跑，若不在此兜底则
    // isPolling 锁永不释放（账号永久锁死）、信号量名额泄漏（cap 饿死）。故把 poll() 的发起包进 try：
    // 同步抛 → 立即释放锁 + 名额，并仍经 handlePollError 分流（同步抛的 ProviderReauthRequired 照常
    // suspend），然后返回（不进入下方异步路径）。
    let pollPromise: Promise<void>;
    try {
      pollPromise = poll();
    } catch (syncErr) {
      isPolling = false;
      semaphore.release();
      await handlePollError(syncErr, accountId, repo, () => {
        suspended = true;
      });
      return;
    }
    // 真实 poll settle（成功/失败/即便晚于超时）→ 释放 isPolling 锁（late-safe）。挂死的 poll
    // 则永久持其自身 isPolling 锁（可接受：它不在轮询、也不饿死他账号——信号量名额已在 finally 释放）。
    void pollPromise.then(
      () => {},
      () => {},
    ).finally(() => {
      isPolling = false;
    });

    try {
      // race 的是**已发起**的 pollPromise（非重新 poll()）——超时 → 界定本轮 + 释放名额，但真实
      // poll 继续在途并独占其 isPolling 锁直至 settle，故跨超时仍保不重入。
      await raceWithTimeout(pollPromise, timeoutMs);
    } catch (err) {
      await handlePollError(err, accountId, repo, () => {
        suspended = true;
      });
    } finally {
      // 仅释放信号量名额（含超时/异常/suspend 路径）——挂死 poll 不永占名额、不饿死队列。
      // isPolling 锁**不**在此释放（其归属上面的 pollPromise.finally；真实 poll settle 才释放，
      // 即便晚于本超时——跨超时不重入由此保住）。
      semaphore.release();
    }
  };
}

/** 单轮 poll 超时固定 kind 串（脱敏；零凭据插值）。 */
export class PollTimeoutError extends Error {
  constructor() {
    super('poll-timeout');
    this.name = 'PollTimeoutError';
  }
}

/**
 * 给一个**已发起**的 poll promise 套单轮超时：poll 完成则正常返回；超时则 reject PollTimeoutError
 * （界定本轮 + 让调用方在 finally 释放信号量名额）。**接受已发起的 promise**（非 `() => poll()`）——
 * 故超时只是停止等待该轮，**不**重新发起 poll；真实 poll 继续在途、由调用方的 pollPromise.finally
 * 释放其 isPolling 锁（跨超时不重入）。
 * `// ponytail: googleapis 无连接可 destroy、AbortSignal 取消 best-effort——本期仅以超时释放名额、不强制
 *  中断底层 HTTP；部分完成的工作下轮经 DB 预去重/processedAt 幂等不重复。`
 */
async function raceWithTimeout(pollPromise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PollTimeoutError()), timeoutMs);
  });
  try {
    await Promise.race([pollPromise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 单账号 poll 异常分流（spec「需重授权账号必须真正暂停」「故障隔离」）：
 *   - `ProviderReauthRequired`（instanceof）→ **先**置进程内 suspended、**再** try setAccountEnabled(false)；
 *     DB 写失败可容忍（本轮已停、下次启动重载会再 suspend），只记 code+kind。
 *   - 其余（含瞬时 429 / 超时 / 一般轮询异常）→ 只记日志、保持 enabled、下 tick 重试（不 suspend）。
 *
 * **绝不记传播的错误对象/cause**（只 code+kind+accountId）——见 logger 安全约定。
 */
async function handlePollError(
  err: unknown,
  accountId: string,
  repo: Pick<MailRepo, 'setAccountEnabled'>,
  markSuspended: () => void,
): Promise<void> {
  if (err instanceof ProviderReauthRequired) {
    // (1) 先置进程内 suspended（本轮已停轮询；不依赖 DB 写成功）。
    markSuspended();
    logger.warn(
      { kind: 'account-poll-reauth-suspend', accountId, reauthKind: err.kind },
      '账号轮询抛 ProviderReauthRequired：标记需重授权（进程内 suspended + 持久 enabled=false）',
    );
    // (2) 再 try 持久化暂停（DB 写失败可容忍——只记 code+kind，不记原始 Prisma 错误）。
    try {
      await repo.setAccountEnabled(accountId, false);
    } catch (dbErr) {
      logger.warn(
        {
          kind: 'account-poll-suspend-persist-failed',
          accountId,
          code: (dbErr as { code?: unknown })?.code,
        },
        'reauth-suspend 持久化 enabled=false 失败（已进程内 suspended、本轮已停；下次启动重载再 suspend）',
      );
    }
    return;
  }
  // 瞬时/一般异常（含 429 / 超时）：只记 code+kind，保持 enabled、下 tick 重试。
  logger.warn(
    {
      kind: 'account-poll-round-failed',
      accountId,
      errorName: err instanceof Error ? err.name : 'unknown',
      errorCode: (err as { code?: unknown })?.code,
    },
    '账号本轮轮询失败（瞬时/一般异常，保持 enabled、下 tick 重试；已记录、不崩进程）',
  );
}

/**
 * 由 POLL_INTERVAL_SECONDS 构造 node-cron 表达式（6 段，含秒位）。
 * - N < 60：秒位用步进 N、其余位通配（每 N 秒）。
 * - N 为 60 的整数倍且 < 3600：秒位 0、分位步进 M=N/60（每 M 分钟整点）。
 * - 其余（含 >= 3600 或非整除）：回退到「每 60 秒」并记一条信息日志——保持简单且正确（绝不写出
 *   会被 cron 拒绝的非法表达式）。
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

/** startAccountSchedulers 的注入点（main 接线 + 测试注入）。 */
export type SchedulerOptions = {
  /** 轮询周期（config.POLL_INTERVAL_SECONDS）。 */
  readonly intervalSeconds: number;
  /** 全局并发上限（默认 DEFAULT_CONCURRENCY）。 */
  readonly concurrency?: number;
  /** 单轮 poll 超时（默认 DEFAULT_POLL_TIMEOUT_MS）。 */
  readonly timeoutMs?: number;
};

/** 一个被调度的账号条目（accountId + 其一轮 poll 闭包）。 */
export type ScheduledAccount = {
  /** = MailAccount.id（运营标识，可入日志）。 */
  readonly accountId: string;
  /** 执行一轮该账号轮询（main 构造：按 provider 建 poller 并 poll()）。 */
  readonly poll: () => Promise<void>;
};

/**
 * 为每个账号启动 per-account 调度（共享信号量 + 单轮超时 + reauth-suspend）。
 *
 * 每账号一个 cron task（同 expression），各自 createAccountGuard（独立 isPolling/suspended）；所有账号
 * **共用同一 Semaphore**（全局并发上限的实质落地——N 个独立 cron 各自触发不会自动遵守全局上限）。
 *
 * @returns ScheduledTask[]——调用方（main 优雅关闭）须对每个 `task.stop()`。无账号 → []（不调度）。
 */
export function startAccountSchedulers(
  accounts: ScheduledAccount[],
  repo: Pick<MailRepo, 'setAccountEnabled'>,
  options: SchedulerOptions,
): ScheduledTask[] {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const semaphore = new Semaphore(concurrency);
  const expression = buildCronExpression(options.intervalSeconds);

  if (accounts.length === 0) {
    logger.info(
      { kind: 'scheduler-no-accounts' },
      '无 enabled 账号：不启动任何轮询调度（/health 仍可用）',
    );
    return [];
  }

  logger.info(
    {
      kind: 'scheduler-started',
      accountCount: accounts.length,
      concurrency,
      intervalSeconds: options.intervalSeconds,
      expression,
    },
    'per-account 轮询调度器已启动（共享信号量 + 单轮超时 + reauth-suspend）',
  );

  const tasks: ScheduledTask[] = [];
  for (const account of accounts) {
    const guarded = createAccountGuard({
      accountId: account.accountId,
      poll: account.poll,
      semaphore,
      repo,
      timeoutMs: options.timeoutMs,
    });
    // cron 不 await 回调返回值——guarded 内部已自行 catch+finally，异常不外泄、锁/名额必释放。
    tasks.push(cron.schedule(expression, () => void guarded()));
  }
  return tasks;
}
