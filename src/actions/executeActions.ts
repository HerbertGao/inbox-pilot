// 动作分发 executeActions（migration §1.2 gut+restructure，design D2；§4.1/4.2 补齐 reflect/mark_read）。
//
// pivot（design D2）：自动动作**不走 hangar gateway**，由 run(ctx) 直接调用本编排。相较旧版：
//   - **剥掉 durable** recordAction/enqueueRetry/updateAction/mail_actions 状态机（破脊柱 #3/#8，不搬）；
//     保留**内存有界重试 + BackoffBudget + 三值处理（sent/skipped/failed）+ reauth 致命通道**。
//   - **去掉 `repo` / `messageRowId` 参**（不再落 mail_actions 行）。
//   - **把每动作结果 surface 成返回值** `{ reflect, markRead, notify, notifyExhausted }`——run() 依此
//     emit 真域事件、并按 `notifyExhausted` 决定是否跳 markProcessed（design D2 结果回传契约）。
//
// 三动作（§4.1/§4.2）：**顺序 reflect_priority → notify → mark_read**（仅可读性，design D3——不变量
// `shouldNotifyNow ⊥ shouldMarkRead` 才是 seam B 唯一守护，重排救不了同真）。
//   - reflect_priority：**始终**（标签是分类可见性、不被门控）、幂等、有界重试；耗尽 → 'failed'（run()
//     emit reflect.failed、**不阻断** notify，best-effort 记降级 §5.2）。
//   - notify：仅 shouldNotifyNow；三值 + 有界重试；耗尽 → 'failed'（run() 跳 markProcessed → re-poll）。
//   - mark_read：仅 shouldMarkRead、幂等、有界重试；耗尽 → 'failed'（emit mark_read.failed、best-effort）。
// 三者任一遇 `ProviderReauthRequired` → **re-throw**（不重试、不吞）——run() 逃逸到账号级持久 suspend。
// 审计（emit reflect.*/notify.*/mark_read.*）由 run() 依返回值发；本函数不 emit、不落库。
// best-effort 取消 `signal`（design D7）：由 run() per-email 超时 abort 时透传给 reflect/mark_read 的
// gmail.modify（notify 的界由 telegram 自身 client timeout AbortSignal.timeout 提供，见 telegram.ts）。

import { logger } from '../logger.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { Notifier, NotifyResult } from '../notify/notifier.js';
import type { ProviderActions } from './providerActions.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import { redactError } from './redactError.js';

/** 单次 executeActions 调用内每个动作的尝试上限（含首次）。小常数、禁无限、内存计数器。 */
const MAX_ATTEMPTS = 3;

/**
 * 退避参数（有紧上限的指数退避）：起始 ~100ms、指数翻倍、每次重试封顶 ≤500ms、单封总退避封顶 ≤~750ms。
 */
const BACKOFF_BASE_MS = 100;
const BACKOFF_PER_RETRY_CAP_MS = 500;
const BACKOFF_TOTAL_CAP_MS = 750;

/** 可注入睡眠 seam：默认真实 setTimeout，测试注入假时钟以零真实等待断言退避被调用、求和有上限。 */
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** 单封邮件的累计退避预算（贯穿一次 executeActions 调用）：受 per-retry + 剩余总预算封顶；耗尽 → 退避降 0。 */
class BackoffBudget {
  private spentMs = 0;
  constructor(private readonly sleep: SleepFn) {}

  async backoff(attempt: number): Promise<void> {
    const remaining = BACKOFF_TOTAL_CAP_MS - this.spentMs;
    if (remaining <= 0) {
      return;
    }
    const exponential = BACKOFF_BASE_MS * 2 ** (attempt - 1);
    const delay = Math.min(exponential, BACKOFF_PER_RETRY_CAP_MS, remaining);
    if (delay <= 0) {
      return;
    }
    this.spentMs += delay;
    await this.sleep(delay);
  }
}

/** notify 结果三值 + `'none'`（不满足 `shouldNotifyNow`、未发）。design D2 结果回传契约。 */
export type NotifyOutcome = 'none' | 'sent' | 'skipped' | 'failed';

/** reflect/mark_read 结果（§4 wired）：`'none'`=未执行（无 provider / mark_read 未满足 shouldMarkRead）/`'ok'`/`'failed'`（发送态耗尽）。 */
export type ActionOutcome = 'none' | 'ok' | 'failed';

/**
 * executeActions 返回：每动作结果 surface 给 run()（design D2）。
 * run() 据此 emit 真域事件、按 `notifyExhausted` 决定跳 markProcessed。
 */
export type ExecuteActionsResult = {
  reflect: ActionOutcome;
  markRead: ActionOutcome;
  notify: NotifyOutcome;
  /** notify 发送态耗尽（= notify==='failed'）；保留为显式字段（可读，run() 分支 markProcessed）。 */
  notifyExhausted: boolean;
};

/** executeActions 的可注入依赖。notifier 必给；provider 供 reflect/mark_read（§4.1，缺省则二者 'none'）。 */
export type ExecuteActionsDeps = {
  readonly notifier: Notifier;
  /** reflect_priority / mark_read 的 provider seam（§4.1）；缺省（无 provider）→ 二者 'none'。 */
  readonly provider?: ProviderActions;
  /** 退避睡眠 seam（默认真实 setTimeout，测试注入假时钟断言退避而不真实等待）。 */
  readonly sleep?: SleepFn;
  /** best-effort 取消 signal（design D7）：per-email 超时 abort 时透传给 reflect/mark_read 的 gmail.modify。 */
  readonly signal?: AbortSignal;
};

/**
 * 通用 provider 动作（reflect_priority / mark_read）的有界重试（§4.1，与 notify 共 BackoffBudget）：
 *   - 成功 → 'ok'。
 *   - 抛 `ProviderReauthRequired` → **re-throw**（致命、不重试；run() 逃逸账号级持久 suspend）。
 *   - 其余（瞬时/发送态）→ 有界重试；耗尽 → 'failed'（run() emit *.failed、best-effort、不阻断后续动作）。
 * 幂等前提由 provider 保证（reflect addLabelIds / mark_read removeLabelIds 重复安全）——重试不会双发。
 */
async function executeProviderAction(
  op: 'reflect' | 'mark_read',
  call: (signal?: AbortSignal) => Promise<void>,
  budget: BackoffBudget,
  signal?: AbortSignal,
): Promise<ActionOutcome> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // per-email 超时后 fence+abort：中止重试循环（否则被弃的 executeActions 继续重试，晚到副作用越界）。
    if (signal?.aborted) {
      return 'failed';
    }
    try {
      await call(signal);
      return 'ok';
    } catch (err) {
      // 致命 reauth：re-throw（不重试、不吞）——run() 逃逸到账号级。
      if (err instanceof ProviderReauthRequired) {
        throw err;
      }
      lastError = redactError(err);
      if (attempt < MAX_ATTEMPTS) {
        await budget.backoff(attempt);
      }
    }
  }
  logger.warn(
    { kind: `${op}-action-exhausted`, attempts: MAX_ATTEMPTS, error: lastError },
    `${op} 动作发送态重试耗尽（run() emit ${op}.failed、best-effort 记降级；不阻断 notify）`,
  );
  return 'failed';
}

/**
 * 通知动作（仅当 decision.shouldNotifyNow）：单次调用内有界重试地调 notifier.notify（三值不抛）：
 *   - sent    → 'sent'（run() emit notify.sent，在重试之外）。
 *   - skipped → 'skipped'（无渠道降级：直接返回、不重试、不消耗退避预算）。
 *   - failed  → 有界重试；耗尽 → 'failed'（run() emit notify.failed + 跳 markProcessed → 下轮 re-poll）。
 * **致命通道**：若（未来 provider-backed）notifier 抛 `ProviderReauthRequired` → **re-throw**（run() per-email
 * catch 逃逸到账号级），绝不当发送态瞬时失败吞掉。
 */
async function executeNotify(
  decision: FinalDecision,
  email: NormalizedEmail,
  notifier: Notifier,
  budget: BackoffBudget,
  signal?: AbortSignal,
): Promise<NotifyOutcome> {
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // per-email 超时后 fence+abort：未发即当耗尽返回 'failed'（调用方跳 markProcessed → 下轮 re-poll 重发）；
    // 已发则上一轮已 return 'sent'，绝不到此，故不会漏发。
    if (signal?.aborted) {
      return 'failed';
    }
    let result: NotifyResult;
    try {
      result = await notifier.notify(decision, email);
    } catch (err) {
      // 致命 reauth：re-throw（不重试、不吞）——run() 逃逸到账号级。
      if (err instanceof ProviderReauthRequired) {
        throw err;
      }
      // 契约为「不抛」；防御未来会抛的渠道——当作一次失败尝试纳入有界重试。
      lastError = redactError(err);
      if (attempt < MAX_ATTEMPTS) {
        await budget.backoff(attempt);
      }
      continue;
    }
    if (result.outcome === 'sent') {
      return 'sent';
    }
    if (result.outcome === 'skipped') {
      // 无渠道降级：直接终结、不重试、不进退避路径。
      return 'skipped';
    }
    // failed：记脱敏 error，退避（除最后一次）后继续。
    lastError = redactError(result.error);
    if (attempt < MAX_ATTEMPTS) {
      await budget.backoff(attempt);
    }
  }
  logger.warn(
    { kind: 'notify-action-exhausted', attempts: MAX_ATTEMPTS, error: lastError },
    '通知动作发送态重试耗尽（跳 markProcessed → 下轮 cron re-poll 重发，受死信门封顶）',
  );
  return 'failed';
}

/**
 * 按 FinalDecision 分发并执行动作（只认 FinalDecision，不读原始 Classification）。
 *
 * 顺序 reflect_priority → notify → mark_read（§4.2，仅可读性）：
 *   - reflect_priority：**始终**（provider 缺省 → 'none'）、幂等、有界重试。
 *   - notify：仅 shouldNotifyNow（否则 'none'）；三值 + 有界重试。
 *   - mark_read：仅 shouldMarkRead 且 provider 存在（否则 'none'）、幂等、有界重试。
 * 三者共用同一 per-email `BackoffBudget`（累计退避封顶贯穿本次调用）。任一动作抛 `ProviderReauthRequired`
 * → 整个 executeActions **re-throw**（run() 逃逸账号级）；后续动作不再执行。
 *
 * @returns 每动作结果 + notifyExhausted，供 run() emit 域事件与分支 markProcessed（design D2）。
 */
export async function executeActions(
  email: NormalizedEmail,
  decision: FinalDecision,
  deps: ExecuteActionsDeps,
): Promise<ExecuteActionsResult> {
  const budget = new BackoffBudget(deps.sleep ?? realSleep);
  const provider = deps.provider;
  const signal = deps.signal;

  // reflect_priority：始终（标签是分类可见性，不被 shouldNotifyNow/shouldMarkRead 门控）。
  const reflect: ActionOutcome =
    provider !== undefined
      ? await executeProviderAction('reflect', (s) => provider.reflectPriority(email, decision, s), budget, signal)
      : 'none';

  // notify：仅 shouldNotifyNow。
  const notify: NotifyOutcome = decision.shouldNotifyNow
    ? await executeNotify(decision, email, deps.notifier, budget, signal)
    : 'none';

  // ponytail: 消费点强制 shouldNotifyNow ⊥ shouldMarkRead——这是 seam B 防丢推送的唯一守护。今天
  // `!shouldNotifyNow` 是 no-op（不变量成立、二者永不同真）；它是 belt-and-suspenders 安全网：将来若
  // 不变量被破，也**绝不**对 notify-due 封 mark_read（清 is:unread 会在 re-poll 时丢掉那次 notify）。
  // 升级路径：若引入非优先级派生的 decision 面，须重新验证 ⊥。
  if (decision.shouldMarkRead && decision.shouldNotifyNow) {
    logger.warn(
      { kind: 'mark-read-notify-invariant-violation' },
      'shouldMarkRead ∧ shouldNotifyNow（不应发生:⊥ 不变量被破）——跳过 mark_read 防丢推送',
    );
  }
  // mark_read：仅 shouldMarkRead 且 **非 notify-due**（幂等；见上 ponytail ⊥ 守护）。
  const markRead: ActionOutcome =
    provider !== undefined && decision.shouldMarkRead && !decision.shouldNotifyNow
      ? await executeProviderAction('mark_read', (s) => provider.markRead(email, s), budget, signal)
      : 'none';

  return { reflect, markRead, notify, notifyExhausted: notify === 'failed' };
}
