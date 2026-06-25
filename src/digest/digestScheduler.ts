// digestScheduler（daily-digest 决策 6/7）：解析 DIGEST_TIMES → 去重时刻 → 各起一个每日 cron 任务，
// 一轮编排做「逐段提交」，并以**进程内共享锁**跨任务互斥、运行期/构造期错误隔离。
//
// 决策 6（DIGEST_TIMES 解析 + cron + 时区）：
//   - 默认在本层兜底：`undefined`（env 缺省）→ 默认 `12:30,21:30`；`''`（显式空）→ 空列表 → 不调度。
//   - token：按 `,` 切、**先 trim**，解析两整数 `H:M`（接受 `9:5`/`09:05`，范围 0–23:0–59），空/越界/
//     非两段数字 → **在 cron.schedule 之前**记错跳过；不把非法表达式交给 node-cron。
//   - 去重键由解析出的整数派生（`${H} ${M}`），故 `"12:30"` 与 `" 12:30 "` 视同一；去重后各 cron `M H * * *`。
//   - `cron.schedule(expr, fn, { timezone })`——`timezone` 显式传（容器 TZ 兜底）。**每个 cron.schedule 的
//     构造各自 try/catch**：非法 timezone（非 IANA）/表达式在**构造期同步抛**（在运行期回调 try/catch 之外），
//     必须被本地接住 → 记脱敏 kind、跳过该任务，**不冒泡到 main setup → process.exit(1)**（保轮询 + /health 存活）。
//
// 决策 7（跨任务互斥用进程内共享锁，不靠 node-cron noOverlap）：
//   - **一个**进程内共享 `digestRunning` 布尔，由 `startDigestSchedulers` 一次构造、**全部** digest 任务闭包共用
//     （切勿每任务各起一个，否则跨任务互斥失效）。回调顶端**同步** `if (digestRunning) return; digestRunning = true;`
//     （先于首个 await、**紧邻 try**、其间无可同步抛语句），`finally` 释放。
//   - 一轮编排（逐段提交）：build → 逐段 `if ((await notifyDigest(seg.text)).outcome !== 'sent') return;` 再
//     `markDigested(seg.messageRowIds)`——**每段发成功即 mark 该段**、遇首个非 sent 即停。build 为 null → 记
//     `digest-empty` 返回。catch 记**脱敏** kind/code（**绝不**记原始 error/cause/正文/收件人 PII/凭据）、finally 释放锁。

import cron, { type ScheduledTask } from 'node-cron';

import { buildDigest } from './buildDigest.js';
import { logger } from '../logger.js';
import type { Notifier } from '../notify/notifier.js';
import { DIGEST_TYPE_DAILY, type MailRepo } from '../repo/mailRepo.js';

/** env 缺省（undefined）时的默认时刻列表（决策 6）。显式 `''` 不走此默认 → 不调度。 */
export const DEFAULT_DIGEST_TIMES = '12:30,21:30';

/** 解析出的一个合法时刻：整数 H/M + 由其派生的 cron 表达式（`M H * * *`）。 */
export type DigestTime = {
  readonly hour: number;
  readonly minute: number;
  /** cron 表达式 `M H * * *`（5 段每日触发）。 */
  readonly expr: string;
};

/**
 * 解析 + 去重 DIGEST_TIMES（决策 6）。
 * @param timesString `string | undefined`——`undefined`（env 缺省）→ 用 DEFAULT_DIGEST_TIMES；
 *   `''`（显式空）→ 空字符串 → 切出空/非法 token、最终返回 `[]`（不调度）。
 *
 * 每 token **先 trim** 再解析两整数 `H:M`（接受 `9:5` 与 `09:05`；范围 0–23:0–59）；空/越界/非两段数字 →
 * 记一条**脱敏** warn（只 kind，不回显原始 token 之外的内容——token 来自 env 配置、非邮件 PII，可记于 kind 旁）后跳过。
 * **去重键由解析出的整数派生**（`${H} ${M}`），故 `"12:30"` 与 `" 12:30 "` 折叠为一个任务。
 */
export function parseDigestTimes(timesString: string | undefined): DigestTime[] {
  // undefined（env 缺省）→ 默认；'' 与显式值原样进入解析（'' → 一个空 token → 被跳过 → []）。
  const source = timesString === undefined ? DEFAULT_DIGEST_TIMES : timesString;

  const seen = new Set<string>();
  const result: DigestTime[] = [];

  for (const rawToken of source.split(',')) {
    const token = rawToken.trim();
    const parsed = parseHourMinute(token);
    if (parsed === undefined) {
      // 空/非法 token：在 cron.schedule 之前记错跳过（不中断其余、不把非法表达式交给 node-cron）。
      logger.warn(
        { kind: 'digest-time-invalid', token },
        'DIGEST_TIMES 含非法/空时刻 token，调度前跳过（其余合法时刻照常调度）',
      );
      continue;
    }
    const { hour, minute } = parsed;
    // 去重键由整数派生——`"12:30"` 与 `" 12:30 "`（trim 后）派生同键，折叠为一个任务。
    const key = `${hour} ${minute}`;
    if (seen.has(key)) {
      logger.info(
        { kind: 'digest-time-deduped', hour, minute },
        'DIGEST_TIMES 含重复时刻，去重后只起一个任务',
      );
      continue;
    }
    seen.add(key);
    // cron `M H * * *`（5 段每日触发）。
    result.push({ hour, minute, expr: `${minute} ${hour} * * *` });
  }

  return result;
}

/**
 * 把单个 token 解析为整数时刻 `H:M`（接受 `9:5` 与 `09:05`，不强制零补；范围 0–23:0–59）。
 * 非两段、非纯数字、越界、含空白/符号 → undefined（调用方记错跳过）。
 */
function parseHourMinute(token: string): { hour: number; minute: number } | undefined {
  if (token.length === 0) {
    return undefined;
  }
  const parts = token.split(':');
  if (parts.length !== 2) {
    return undefined;
  }
  const [hStr, mStr] = parts;
  // 只接受纯数字串（`/^\d+$/`）——拒 `+9`/`9 `/空段/`0x9` 等；trim 已在外层做、此处 token 内不应再含空白。
  if (!/^\d+$/.test(hStr!) || !/^\d+$/.test(mStr!)) {
    return undefined;
  }
  const hour = Number(hStr);
  const minute = Number(mStr);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  return { hour, minute };
}

/** 一轮编排的最小依赖切片（注入式，使一轮编排可离线测试，不依赖真实 cron timing）。 */
export type DigestRunDeps = {
  /** 查候选 + 落库 + Top-N 频率快照 seam（buildDigest 读 listDigestCandidates+countRecentSenders；编排再 markDigested）。 */
  readonly repo: Pick<MailRepo, 'listDigestCandidates' | 'countRecentSenders' | 'markDigested'>;
  /** 摘要出口（逐段 notifyDigest）。 */
  readonly notifier: Pick<Notifier, 'notifyDigest'>;
  /** 调用时刻（注入 `() => Date` 时钟，使编排可测）。默认 `new Date()`。 */
  readonly now: () => Date;
};

/**
 * 一轮摘要编排（决策 2/3/7 的逐段提交 + 错误隔离，**不**含共享锁——锁由 makeDigestCallback 包裹）。
 * build → 逐段：`if ((await notifyDigest(seg.text)).outcome !== 'sent') return;` 再 `markDigested(seg.messageRowIds)`
 * （**每段发成功即 mark 该段**、遇首个非 sent 即停、其后段不发不 mark、下轮重试）。build 为 null → 记 digest-empty 返回。
 * catch 记**脱敏** kind/code（**绝不**记原始 error/cause/正文/收件人 PII/凭据）。**自身不抛**（供 `() => void run()` 注册无漏 promise）。
 */
export async function runDigestOnce(deps: DigestRunDeps): Promise<void> {
  const { repo, notifier, now } = deps;
  const at = now();
  try {
    const d = await buildDigest(repo, at);
    if (d === null) {
      // 无可入摘要邮件（无 P1/P2 且 P3 计数为 0）→ 禁推空摘要，只记结构化日志（决策 2 / spec）。
      logger.info({ kind: 'digest-empty' }, '本轮无可入摘要邮件，不推送');
      return;
    }
    for (const seg of d.segments) {
      const result = await notifier.notifyDigest(seg.text);
      if (result.outcome !== 'sent') {
        // 遇首个非 sent（failed/skipped）即停：本段及其后段不 mark，下轮重试（不丢件）。
        logger.warn(
          { kind: 'digest-segment-not-sent', outcome: result.outcome },
          '摘要某段未发送成功，停止本轮（其后段不发、不 mark，下轮重试）',
        );
        return;
      }
      // 该段发成功即提交：markDigested 该段 row-ids（含 P3 段的 P3 row-ids），已 mark 段下轮不重发。
      await repo.markDigested(seg.messageRowIds, DIGEST_TYPE_DAILY, at);
    }
  } catch (err) {
    // 运行期错误隔离：只记**脱敏** kind/code，**绝不**记原始 error/cause/正文/收件人 PII/凭据（见 logger 纪律）。
    // 只在 code 为字符串/数字标量时记录——非标量/含 PII 的 code 不入日志。
    const rawCode = (err as { code?: unknown })?.code;
    const errorCode =
      typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined;
    logger.warn(
      {
        kind: 'digest-round-failed',
        errorName: err instanceof Error ? err.name : 'unknown',
        errorCode,
      },
      '摘要本轮编排失败（已记脱敏日志、不崩进程、不泄露原始错误/PII/凭据）',
    );
  }
}

/**
 * 进程内共享锁 + 一轮 runner 工厂（决策 7）。返回 `{ runOnce }`：**单一**共享 `digestRunning` 锁由本次构造、
 * 所有经此返回的 `runOnce` 闭包共用（startDigestSchedulers 给每个 cron 任务的回调都调用同一 `runOnce`，
 * 故跨任务共享同一锁）。`runOnce` 顶端**同步**取锁（先于首个 await、**紧邻 try、其间无可同步抛语句**），
 * `finally` 释放——即便保护体首行同步抛也不泄漏锁（有测试钉住）。
 *
 * `run` 注入使「保护体首行同步抛仍释放锁」与「跨任务互斥」可离线测试（生产传 `() => runDigestOnce(deps)`）。
 */
export function createSharedLockRunner(run: () => Promise<void>): { runOnce: () => Promise<void> } {
  // **单一**共享锁实例——本次构造、所有经此 runOnce 的调用共用（决策 7：切勿每任务各起一个）。
  const lock = { running: false };

  const runOnce = async (): Promise<void> => {
    // —— 同步取锁先于首个 await（JS run-to-completion 下无 TOCTOU）；**紧邻 try、其间无可同步抛语句** ——
    if (lock.running) {
      logger.info(
        { kind: 'digest-skipped-running' },
        '上一轮摘要尚未结束，跳过本次触发（跨任务共享锁互斥）',
      );
      return;
    }
    lock.running = true;
    try {
      await run();
    } finally {
      // finally 释放——即便保护体（run）首行同步抛也不泄漏锁（不泄漏，有测试钉住）。
      lock.running = false;
    }
  };

  return { runOnce };
}

/** startDigestSchedulers 的注入点（main 接线 + 测试注入）。 */
export type DigestSchedulerOptions = {
  /** DIGEST_TIMES 字符串（config.DIGEST_TIMES；`undefined`→默认，`''`→不调度）。 */
  readonly timesString: string | undefined;
  /** cron 时区（容器 TZ 兜底；显式传使代码层可见可测）。 */
  readonly timezone: string;
  /** 查候选 + 落库 + Top-N 频率快照 seam。 */
  readonly repo: Pick<MailRepo, 'listDigestCandidates' | 'countRecentSenders' | 'markDigested'>;
  /** 摘要出口。 */
  readonly notifier: Pick<Notifier, 'notifyDigest'>;
  /** 注入时钟（可测）。默认 `() => new Date()`。 */
  readonly now?: () => Date;
};

/**
 * 启动每日摘要调度（决策 6/7）。
 *
 * - 解析 + 去重 DIGEST_TIMES → 各合法时刻一个每日 cron 任务（`M H * * *`，显式传 `timezone`）。
 * - **一个**进程内共享 `digestRunning` 锁，**本函数内一次构造、所有 digest 任务闭包共用**——回调顶端同步
 *   取锁（先于首个 await、紧邻 try），`finally` 释放；防相邻/重复时刻或慢 digest 跨任务并发。
 * - 每个 `cron.schedule(...)` 构造各自 try/catch：非法 timezone/表达式在构造期同步抛 → 本地接住、记脱敏 kind、
 *   跳过该任务（**不冒泡到 main setup**），其余任务正常调度；返回成功构造的 ScheduledTask[]。
 *
 * @returns ScheduledTask[]——调用方（main 优雅关闭）须 concat 进被 shutdown() 迭代的列表、对每个 task.stop()。
 *   无合法时刻 / 全非法 / 显式空 → []（不调度，服务照常启动、/health 可用）。
 */
export function startDigestSchedulers(options: DigestSchedulerOptions): ScheduledTask[] {
  const { timesString, timezone, repo, notifier } = options;
  const now = options.now ?? (() => new Date());

  const times = parseDigestTimes(timesString);
  if (times.length === 0) {
    logger.info(
      { kind: 'digest-scheduler-no-times' },
      '无合法摘要时刻（显式空 / 全非法 / 缺省后仍为空）：不启动摘要调度（/health 仍可用）',
    );
    return [];
  }

  // **单一**共享锁 + 一轮 runner，本次构造、所有 digest 任务回调共用同一 `runOnce`（决策 7：切勿每任务各起一个）。
  const { runOnce } = createSharedLockRunner(() => runDigestOnce({ repo, notifier, now }));

  const tasks: ScheduledTask[] = [];
  for (const { hour, minute, expr } of times) {
    // **构造期错误隔离**：非法 timezone/表达式在 cron.schedule 构造期同步抛——本地 try/catch 接住、
    // 记脱敏 kind、跳过该任务（不冒泡到 main setup → process.exit(1)；保轮询 + /health 存活）。
    try {
      // cron 不 await 回调返回值——runOnce 内部已自行 catch+finally（锁必释放、异常不外泄）；
      // 故注册成 `() => void runOnce()` 不漏 rejected promise、不破坏互斥（锁在回调内、与 cron 生命周期解耦）。
      const task = cron.schedule(expr, () => void runOnce(), { timezone });
      tasks.push(task);
    } catch (err) {
      logger.warn(
        {
          kind: 'digest-schedule-construct-failed',
          hour,
          minute,
          errorName: err instanceof Error ? err.name : 'unknown',
        },
        '摘要 cron 任务构造失败（非法 timezone/表达式），跳过该任务（轮询 + /health 仍存活）',
      );
    }
  }

  logger.info(
    { kind: 'digest-scheduler-started', taskCount: tasks.length, timezone },
    '每日摘要调度器已启动（共享锁跨任务互斥 + 逐段提交 + 构造期/运行期错误隔离）',
  );

  return tasks;
}
