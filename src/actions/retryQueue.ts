// durable-retry 的 drain（排空到期重试）：drainAccountRetries（durable-retry 决策 1/2/3/5/6、
// tasks 3.1/3.2/3.3）。
//
// 职责：在该账号一轮 poll 的 live provider 连接 + per-account 锁内，排空 `status='retrying' ∧
// nextRetryAt ≤ now` 的可重试动作——逐条重建输入（复用已存 FinalDecision、绝不重新 LLM 分类）、
// 按 actionType 复发原动作、按结果推进状态（done / 长程退避 retrying / dead_letter）。
//
// 不可违反的约束（逐条对应 spec / design）：
//   - **绝不重新 LLM 分类**：只复用 selectDueRetries 重建出的 decision（rebuild.ok===true）。
//   - **复发即原动作**：ReflectPriority→provider.reflectPriority / MarkRead→provider.markRead /
//     Notify→notifier.notify；notify 账号无关（用注入的 notifier、非 connection-bound）。
//   - **死信触发统一表述**：增量后 `retryCount ≥ MAX_DURABLE_ATTEMPTS`（=6，非 `+1≥`）→ dead_letter。
//   - **notify staleness 上界**：receivedAt 超 NOTIFY_STALENESS_MS 的 notify 直接 dead_letter、不补发；
//     markRead/reflectPriority **无** staleness 上界（迟标仍正确，试到成功或 attempts 耗尽）。
//   - **永久重建失败（rebuild.ok===false）→ dead_letter**、不崩 drain。
//   - **瞬时 DB I/O 错误由 selectDueRetries 抛出向上传播**（保持 retrying、不推进 retryCount、不死信）——
//     不在本函数转 dead_letter。
//   - **ProviderReauthRequired**：逐条 catch 必须重新抛出它（不被隔离吞掉）→ 停止本账号本轮 drain、
//     当前行保持 retrying（不推进不进死信）、向上传播账号级失败。判别用 instanceof + 防御性 unwrap .cause。
//   - **drain 有界**：条数 ≤ DRAIN_BATCH_CAP（由 selectDueRetries 的 limit 落地）+ 软 deadline 提前退出
//     （每条前检查、超预算即停本轮、剩余下轮）；**不轮内 sleep**（退避是 nextRetryAt 时间维度）。
//   - **逐条隔离普通瞬时异常**：一条失败不阻断同账号其余 drain（按瞬时失败推进 retryCount/nextRetryAt）。
//   - **脱敏日志**：dead_letter 记结构化日志（kind+actionType+retryCount，绝不正文/凭据/PII）。

import { logger } from '../logger.js';
import type { MailRepo, DueRetryAction } from '../repo/mailRepo.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { ProviderActions } from './providerActions.js';
import type { Notifier } from '../notify/notifier.js';
import { ActionType } from './actionTypes.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import {
  durableBackoffMs,
  MAX_DURABLE_ATTEMPTS,
  NOTIFY_STALENESS_MS,
  DRAIN_BATCH_CAP,
} from './retryConstants.js';
import { redactError } from './redactError.js';

/**
 * drain 软 deadline seam（决策 6 ponytail：用**单调 elapsed**，不在 drain 内取 `Date.now`，以保可测）。
 * `elapsedMs()` 返回自本轮起点的单调流逝毫秒；`budgetMs` 是本轮 drain 的保守时间分额。
 * **每条 drain 前检查**：`elapsedMs() >= budgetMs` 即提前停止本轮（剩余到期项下轮续）。
 *
 * 生产接线（poll 路径）：起点时刻 = poll 开始时由调用方捕获、`elapsedMs = () => Date.now() - startMs`、
 * `budgetMs = DRAIN_TIME_BUDGET_MS`。测试注入一个可控计数 elapsedMs（如返回递增桩值），零真实等待
 * 即可断言「超软 deadline 提前退出、剩余下轮」。
 */
export type DrainDeadline = {
  elapsedMs(): number;
  budgetMs: number;
};

/**
 * drainAccountRetries 的可注入依赖（决策 1：**必须含 notifier**——drain 重试 notify 动作账号无关、
 * 非 connection-bound；无它则 drain 无法重试 notify，即本变更首要动机 P0/P4 通知丢失）。
 *   - `provider`：connection-bound（pollOnce/gmailPoll 体内 makeProvider(connection) 构造）→ reflectPriority/markRead。
 *   - `notifier`：账号无关（main.ts 透传 defaultNotifier）→ notify。
 *   - `repo`：selectDueRetries / enqueueRetry / markActionDeadLetter / updateAction。
 *   - `clock`：当前时刻（staleness 基准 + nextRetryAt 计算；可注入假时钟）。
 *   - `deadline`：软 elapsed-budget（单调，超预算提前退出）。
 */
export type DrainDeps = {
  readonly provider: ProviderActions;
  readonly notifier: Notifier;
  readonly repo: MailRepo;
  readonly clock: () => Date;
  readonly deadline: DrainDeadline;
};

/**
 * 从一个抛出的错误里取出**展开后的** `ProviderReauthRequired`（决策 6 不变量），无则 null：
 * `instanceof` 充分**当且仅当**各 sink 裸抛 reauth（现 provider.ts 构造时无 cause、notifier 不抛 reauth）；
 * 防御性地 unwrap 一层 `.cause`（防未来 sink 包裹 reauth）。**返回展开后的实例**而非布尔——使调用方
 * **重抛 unwrap 后的 reauth**，否则上游 `instanceof ProviderReauthRequired` 会漏判被包装的 reauth → 不 suspend。
 */
function unwrapReauthError(err: unknown): ProviderReauthRequired | null {
  if (err instanceof ProviderReauthRequired) {
    return err;
  }
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof ProviderReauthRequired ? cause : null;
}

/** 重建成功（rebuild.ok===true）的到期重试动作——drain 据此复发原动作（email/decision 已就绪）。 */
type RebuiltAction = DueRetryAction & {
  rebuild: { ok: true; email: NormalizedEmail; decision: FinalDecision };
};

/**
 * 复发一条动作（按 actionType 调对应 sink）。成功无返回；失败抛出（由 drain 逐条 catch 处理为
 * 瞬时失败推进 / reauth 重抛）。
 *   - ReflectPriority → provider.reflectPriority(email, decision)（复用已存 decision、绝不重新分类）。
 *   - MarkRead        → provider.markRead(email)（不消费 decision）。
 *   - Notify          → notifier.notify(decision, email)：`sent`→成功；`failed`→**当瞬时失败抛出**
 *                       （走推进路径）；`skipped`（无渠道）→当成功（不再重试入队，无渠道时 drain 也发不出）。
 */
async function redispatch(action: RebuiltAction, deps: DrainDeps): Promise<void> {
  const { email, decision } = action.rebuild;
  switch (action.actionType) {
    case ActionType.ReflectPriority:
      await deps.provider.reflectPriority(email, decision);
      return;
    case ActionType.MarkRead:
      await deps.provider.markRead(email);
      return;
    case ActionType.Notify: {
      const result = await deps.notifier.notify(decision, email);
      if (result.outcome === 'sent' || result.outcome === 'skipped') {
        // sent → 成功；skipped（无渠道）→ 视为成功落 done（drain 无渠道也发不出，不应反复入队/死信）。
        return;
      }
      // failed → 当瞬时失败：抛出走推进路径（retryCount+1 / 退避 / 死信）。脱敏 error 进 message。
      throw new Error(`notify-failed:${result.channel}:${result.error}`);
    }
    default:
      // 未知 actionType（不应发生：selectDueRetries 只产合法 ActionType）；当瞬时失败兜底、不崩。
      throw new Error(`unknown-action-type:${String(action.actionType)}`);
  }
}

/**
 * 单条成功推进：落终态 done。记一条脱敏 debug 日志（kind+actionType+retryCount，绝不正文/凭据/PII）。
 */
async function advanceSuccess(action: DueRetryAction, deps: DrainDeps): Promise<void> {
  logger.debug(
    {
      kind: 'durable-retry-drain-success',
      actionType: action.actionType,
      retryCount: action.retryCount,
    },
    'drain 重试成功，落终态 done',
  );
  await deps.repo.updateAction(action.actionRowId, 'done');
}

/**
 * 单条瞬时失败推进（决策 2，统一表述）：`retryCount += 1` → **先判 `retryCount ≥ MAX_DURABLE_ATTEMPTS`
 * → dead_letter（不再索引 backoff）**；否则 `nextRetryAt = now + durableBackoffMs(retryCount)`
 * （此时 retryCount∈1..5、合法索引）、保持 retrying。**不轮内 sleep**（退避是 nextRetryAt 时间维度）。
 */
async function advanceTransientFailure(
  action: DueRetryAction,
  error: string,
  deps: DrainDeps,
): Promise<void> {
  const nextCount = action.retryCount + 1;
  if (nextCount >= MAX_DURABLE_ATTEMPTS) {
    // 死信落**推进后**的 retryCount（=MAX）：max-attempts 死亡在第 MAX 次失败后触发，行应记 retryCount=MAX。
    // （staleness/rebuild 死亡不经此处、不增计数——它们记当前 retryCount，见 deadLetter 调用点。）
    await deadLetter({ ...action, retryCount: nextCount }, `max-attempts:${error}`, deps);
    return;
  }
  const now = deps.clock();
  // 每次 drain 重试（仍瞬时失败、保持 retrying）记一条脱敏结构化日志（kind+actionType+retryCount+脱敏 error，
  // 绝不正文/凭据/PII/解析值）。`retryCount` 记**推进后**的值（= 已用尽的退避槽数）；`error` 已由 redactError 脱敏。
  logger.warn(
    {
      kind: 'durable-retry-drain-retrying',
      actionType: action.actionType,
      retryCount: nextCount,
      error,
    },
    'drain 重试仍瞬时失败，长程退避后保持 retrying（下次到期下轮再试）',
  );
  await deps.repo.enqueueRetry(
    action.actionRowId,
    nextCount,
    new Date(now.getTime() + durableBackoffMs(nextCount)),
    error,
  );
}

/**
 * 落终态 dead_letter（决策 2/3，可观测）：记脱敏结构化日志（kind+actionType+retryCount，
 * **绝不**正文/凭据/PII）+ repo.markActionDeadLetter（DB 可查 status=dead_letter）。
 * `reason` 已是脱敏短摘要（max-attempts / staleness / rebuild-failed）。
 */
async function deadLetter(
  action: DueRetryAction,
  reason: string,
  deps: DrainDeps,
): Promise<void> {
  logger.warn(
    {
      kind: 'durable-retry-dead-letter',
      actionType: action.actionType,
      retryCount: action.retryCount,
      reason,
    },
    'durable 重试进死信（终态、不再自动重试）',
  );
  await deps.repo.markActionDeadLetter(action.actionRowId, action.retryCount, reason);
}

/**
 * 排空该账号到期可重试动作（durable-retry 决策 1/2/3/5/6）。
 *
 * 折叠进 poll：由 pollOnce/gmailPoll 体内（新邮件循环之后、连接 teardown 之前）调用，复用 live
 * provider 连接 + per-account 锁。`selectDueRetries(limit=DRAIN_BATCH_CAP)` 取到期项（条数有界）→
 * 逐条（try/catch 隔离普通瞬时异常）：每条前检查软 deadline（超预算即停本轮、剩余下轮）→ 重建输入
 * （已在 selectDueRetries 内完成；rebuild.ok===false=永久死信，瞬时 DB 错误已由 selectDueRetries 抛出）
 * → 复发原动作 → 按结果推进（done / 退避 retrying / dead_letter）。
 *
 * **ProviderReauthRequired**：逐条 catch 必须重新抛出它（穿透隔离）→ 停止本账号本轮 drain、当前行
 * 保持 retrying（不推进 retryCount、不进死信）、向上传播账号级失败（poll → scheduler suspend）。
 *
 * **瞬时 DB I/O 错误**：由 selectDueRetries 抛出（非每行 case），自然向上传播（不在本函数转 dead_letter）。
 *
 * @param accountId 本账号 id（selectDueRetries 据此过滤 message.accountId）。
 */
export async function drainAccountRetries(
  accountId: string,
  deps: DrainDeps,
): Promise<void> {
  // 条数有界：limit=DRAIN_BATCH_CAP（决策 6）。瞬时 DB I/O 错误在此抛出 → 向上传播（不死信、不入循环）。
  const due = await deps.repo.selectDueRetries(accountId, deps.clock(), DRAIN_BATCH_CAP);

  for (const action of due) {
    // 软 deadline 提前退出（决策 6）：每条前检查单调 elapsed，超预算即停本轮（剩余项保持 retrying、下轮续）。
    if (deps.deadline.elapsedMs() >= deps.deadline.budgetMs) {
      logger.info(
        { kind: 'durable-retry-drain-budget-exhausted', accountId },
        'drain 超软 deadline，提前停止本轮（剩余到期项下轮续）',
      );
      return;
    }

    // 永久重建失败（rebuild.ok===false：行缺失 / JSON 损坏 / shape 不符）→ dead_letter、不崩。
    if (!action.rebuild.ok) {
      await deadLetter(action, 'rebuild-failed', deps);
      continue;
    }

    // notify staleness 上界（决策 3）：receivedAt 超 NOTIFY_STALENESS_MS 的 notify 直接 dead_letter、
    // 不补发（数天前的 P0 补发无意义）；markRead/reflectPriority **无** staleness 上界。
    if (action.actionType === ActionType.Notify) {
      const ageMs = deps.clock().getTime() - action.receivedAt.getTime();
      if (ageMs > NOTIFY_STALENESS_MS) {
        await deadLetter(action, 'notify-stale', deps);
        continue;
      }
    }

    // 逐条 try/catch **只隔离 sink（redispatch）异常**；ProviderReauthRequired 穿透重抛停整轮。
    let redispatched = false;
    try {
      // 此处 action.rebuild.ok===true（上面已分流 ok===false）；窄化为 RebuiltAction 复发原动作。
      await redispatch(action as RebuiltAction, deps);
      redispatched = true;
    } catch (err) {
      // reauth：穿透逐条隔离**重抛 unwrap 后的 reauth**（停本账号本轮 drain）——当前行**保持 retrying**
      // （不推进 retryCount、不进死信），其后未试行不动；账号级失败沿 poll → scheduler 传播触发 suspend。
      // 重抛 unwrap 后的实例（非外层包装）：保证上游 `instanceof ProviderReauthRequired` 命中（决策 6 不变量）。
      const reauth = unwrapReauthError(err);
      if (reauth !== null) {
        throw reauth;
      }
      // 普通瞬时失败：逐条隔离（不阻断同账号其余 drain），按瞬时失败推进 retryCount/nextRetryAt（或死信）。
      await advanceTransientFailure(action, redactError(err), deps);
    }
    // **redispatch 成功后才落 done，且 advanceSuccess 在 sink-catch 之外**：其 `updateAction(done)` 的
    // repo-I/O 失败按 repo-I/O 通道**向上传播**（同 selectDueRetries 抛出语义——退出本轮 drain，行保持
    // retrying，下轮重试），**绝不**被当作发送失败重入 advanceTransientFailure（否则会把已发出的动作重新
    // 入队/重发、甚至误死信）。镜像 executeActions 的「notify done-写入移出重试 try」原则。
    if (redispatched) {
      await advanceSuccess(action, deps);
    }
  }
}
