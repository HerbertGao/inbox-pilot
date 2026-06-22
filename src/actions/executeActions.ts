// 动作分发 executeActions（spec「executeActions 按 FinalDecision 分发并落 mail_actions」、
// design「executeActions + mail_actions 状态机」）。
//
// 职责：按规则引擎裁定的 FinalDecision 分发并执行动作，每个动作把状态落 mail_actions。
//
// 不可违反的约束（逐条对应 spec / design）：
//   - 只认 FinalDecision：标已读仅当 decision.shouldMarkRead 为 true（P4/敏感/低置信已被规则引擎置 false）；
//     通知仅当 decision.shouldNotifyNow 为 true。**禁止**读原始 Classification 决定动作。
//   - shouldIncludeDigest 本期**不产生动作**（摘要属 P5）；它已由 saveClassification 持久化进 rawAiJson，
//     executeActions 不为它建 mail_actions 行。
//   - 每个动作先 recordAction(pending) → 执行后 updateAction(done|failed|skipped, error?)。
//     {done,failed,skipped} 为终态、pending 为唯一中间态。
//   - 失败有界重试：**单次 executeActions 调用内**的内存计数器（小常数，禁无限、禁跨重启累计、
//     无 retryCount 列）；只把终态落 mail_actions。
//   - 无渠道降级（notify skipped）：**直接**落 skipped、不进入重试循环、不计入重试预算。
//   - 单个动作失败**禁止**阻断其余动作；markProcessed 由 processEmail 在本函数返回后照常执行，
//     **不以通知成功为前提**（P0/P4 通知重试耗尽仍 failed 时 markProcessed 仍照常 —— P2 接受的
//     at-most-once-after-retry）。
//   - 脱敏 error：截断为摘要，禁含 token / chat_id / 正文。

import { logger } from '../logger.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { MailRepo } from '../repo/mailRepo.js';
import type { Notifier, NotifyResult } from '../notify/notifier.js';
import { ActionType } from './actionTypes.js';
import type { ProviderActions } from './providerActions.js';
import { ProviderReauthRequired } from '../providers/provider.js';

/**
 * 单次 executeActions 调用内每个动作的尝试上限（含首次）。小常数、禁无限。
 * 内存计数器、不落 retryCount 列、不跨重启累计（durable 跨重启重试预算属 P6）。
 */
const MAX_ATTEMPTS = 3;

/** 脱敏 error 摘要上限：截断为短摘要，禁含 token / chat_id / 正文。 */
const ERROR_SUMMARY_MAX = 200;

/** executeActions 的可注入依赖。三者皆由 processEmail 注入（默认接真身、测试注入假体）。 */
export type ExecuteActionsDeps = {
  readonly repo: MailRepo;
  readonly provider: ProviderActions;
  readonly notifier: Notifier;
};

/**
 * 把抛出的未知错误脱敏为短摘要：只取 message（或 String(err)）并截断。
 * 禁含 token / chat_id / 正文 —— provider/notifier 的 error 本就只是传输层摘要，这里再截断兜底。
 */
function redactError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  return raw.length > ERROR_SUMMARY_MAX ? raw.slice(0, ERROR_SUMMARY_MAX) : raw;
}

/**
 * 优先级落地动作：**始终**被 executeActions 调用（标签是分类可见性、不被 shouldMarkRead 门控）。
 * recordAction(pending) → 单次调用内有界重试地调 provider.reflectPriority → done；
 * 发送态失败耗尽 → updateAction(failed, 脱敏error)、**不抛**（不阻断 markRead/notify/markProcessed）。
 * reflectPriority 真实实现幂等（重复打同一标签安全），重试安全。
 *
 * **致命错误通道（区别于发送态瞬时失败）**：provider 抛 `ProviderReauthRequired`（token 撤销 /
 * scope 403）时，必须在本作用域内把该 in-flight 行置 `failed`(reauth kind)、**不留 orphan pending**，
 * 然后 **re-throw** —— 由 executeActions 传播出去，processEmail 因此跳过 markProcessed，
 * scheduler 的 per-account guard 隔离该账号。绝不当发送态瞬时失败吞掉。
 */
async function executeReflectPriority(
  email: NormalizedEmail,
  decision: FinalDecision,
  deps: ExecuteActionsDeps,
  messageRowId: string,
): Promise<void> {
  const actionRowId = await deps.repo.recordAction(messageRowId, ActionType.ReflectPriority);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await deps.provider.reflectPriority(email, decision);
      await deps.repo.updateAction(actionRowId, 'done');
      return;
    } catch (err) {
      // 致命错误：落 failed(reauth kind) 后 re-throw（不重试、不吞）；rowId 在作用域内、无 orphan pending。
      if (err instanceof ProviderReauthRequired) {
        await deps.repo.updateAction(actionRowId, 'failed', err.kind);
        throw err;
      }
      lastError = err;
      // 发送态瞬时失败：继续下一次尝试（reflectPriority 幂等，重试安全）；耗尽后落 failed、不抛。
    }
  }
  const summary = redactError(lastError);
  logger.warn(
    { kind: 'reflect-priority-failed', attempts: MAX_ATTEMPTS, error: summary },
    '优先级落地动作重试耗尽，落 failed',
  );
  await deps.repo.updateAction(actionRowId, 'failed', summary);
}

/**
 * 标已读动作：仅当 decision.shouldMarkRead 为 true 时调用。
 * recordAction(pending) → 单次调用内有界重试地调 provider.markRead → done；
 * 发送态失败耗尽 → updateAction(failed, 脱敏error)、**不抛**。markRead 真实实现幂等，重试安全。
 * 发送态不抛 —— markRead 的发送失败只落 mail_actions、不阻断其余动作与 markProcessed。
 * 注：updateAction('done') 仍在重试 try 内（与 executeNotify **有意**不对称——markRead 幂等，
 * done-写入失败时重试重标已读无害；notify 不幂等故其 done-写入移出 try）。repo 写入持久故障会
 * 经耗尽分支的 updateAction(failed) 向上传播 → processEmail at-least-once 重跑兜底。
 *
 * **致命错误通道**：同 executeReflectPriority——provider 抛 `ProviderReauthRequired` 时本作用域内
 * 置 failed(reauth kind)、不留 orphan pending，然后 re-throw（不当发送态瞬时失败吞掉）。
 */
async function executeMarkRead(
  email: NormalizedEmail,
  deps: ExecuteActionsDeps,
  messageRowId: string,
): Promise<void> {
  const actionRowId = await deps.repo.recordAction(messageRowId, ActionType.MarkRead);
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await deps.provider.markRead(email);
      await deps.repo.updateAction(actionRowId, 'done');
      return;
    } catch (err) {
      // 致命错误：落 failed(reauth kind) 后 re-throw（不重试、不吞）；rowId 在作用域内、无 orphan pending。
      if (err instanceof ProviderReauthRequired) {
        await deps.repo.updateAction(actionRowId, 'failed', err.kind);
        throw err;
      }
      lastError = err;
      // 发送态瞬时失败：继续下一次尝试（标已读幂等，重试安全）；耗尽后落 failed、不抛。
    }
  }
  // ponytail: 假 provider 仅抛固定串，redactError 截断即可；接真实 IMAP/Gmail（P3/P4）时
  // markRead 异常 message 可能含账号/服务器 URL 片段，需与 notify 渠道同级脱敏（届时在 provider
  // 实现内做结构化脱敏，不改本期 seam）。
  const summary = redactError(lastError);
  logger.warn(
    { kind: 'mark-read-failed', attempts: MAX_ATTEMPTS, error: summary },
    '标已读动作重试耗尽，落 failed',
  );
  await deps.repo.updateAction(actionRowId, 'failed', summary);
}

/**
 * 通知动作：仅当 decision.shouldNotifyNow 为 true 时调用。
 * recordAction(pending) → 调 notifier.notify（**不抛**、返回 NotifyResult）：
 *   - sent     → updateAction(done)。
 *   - skipped  → updateAction(skipped, reason)：**直接**落、不进重试循环、不计入重试预算。
 *   - failed   → 单次调用内有界重试地再调 notify；耗尽仍 failed → updateAction(failed, error)。
 * 发送态不抛 —— notify 的发送失败只落 mail_actions（failed/skipped）、不阻断 markProcessed。
 * 但终态落库 updateAction 已移出重试 try：notify 成功后若 updateAction 自身抛（repo I/O 故障），
 * 该异常**向上传播**（不在同一调用内重发通知，保 spec「每次调用至多一条」），由 processEmail 的
 * at-least-once 重跑兜底（跨重跑 ≤1 重复，spec 已接受）。
 */
async function executeNotify(
  decision: FinalDecision,
  email: NormalizedEmail,
  deps: ExecuteActionsDeps,
  messageRowId: string,
): Promise<void> {
  const actionRowId = await deps.repo.recordAction(messageRowId, ActionType.Notify);
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // 只把 notify() 调用纳入 try：notify 契约为「不抛、返回 NotifyResult」，此 try 仅防御未来
    // 注入会抛的渠道——把抛出当作一次失败尝试纳入有界重试。终态落库（updateAction）**不**包在
    // 此 try 内：notify 已成功后若落库自身抛，绝不能在同一调用内重发通知（保 spec「每次 processEmail
    // 调用至多一条」）——让该 repo 写入异常向上传播，由 processEmail 的 at-least-once 重跑兜底
    // （跨重跑 ≤1 重复，spec 已接受）。
    let result: NotifyResult;
    try {
      result = await deps.notifier.notify(decision, email);
    } catch (err) {
      lastError = redactError(err);
      continue;
    }
    if (result.outcome === 'sent') {
      await deps.repo.updateAction(actionRowId, 'done');
      return;
    }
    if (result.outcome === 'skipped') {
      // 无渠道降级：直接落 skipped、不重试、不计入重试预算（首轮即终结）。
      await deps.repo.updateAction(actionRowId, 'skipped', result.reason);
      return;
    }
    // failed：记录脱敏 error 摘要，继续下一次尝试。
    lastError = redactError(result.error);
  }
  logger.warn(
    { kind: 'notify-action-failed', attempts: MAX_ATTEMPTS, error: lastError },
    '通知动作重试耗尽，落 failed',
  );
  await deps.repo.updateAction(actionRowId, 'failed', lastError);
}

/**
 * 按 FinalDecision 分发并执行动作。只认 FinalDecision（不读原始 Classification）。
 *
 * **动作顺序**（防崩溃窗口，见 gmail-integration「动作顺序」）：
 *   reflectPriority（**始终**）→ markRead（仅 shouldMarkRead）→ notify（仅 shouldNotifyNow）。
 *   markProcessed 由 processEmail 在本函数返回后**最后**执行。
 *
 * - reflectPriority → 经 ProviderActions 把最终优先级落到 provider 维度（Gmail 打 `AI/P*` 标签）；
 *   始终调用（标签是分类可见性，不被 shouldMarkRead 门控）、幂等。
 * - shouldMarkRead → 经 ProviderActions 标已读。
 * - shouldNotifyNow → 经 Notifier 推送。
 * - shouldIncludeDigest → 本期不产生动作（仅由 saveClassification 持久化标记，摘要属 P5）。
 *
 * 各动作相互独立：一个动作的**发送态失败**不影响其余、只落 mail_actions（failed/skipped），
 * markProcessed 由 processEmail 在本函数返回后照常执行、不以动作发送成功为前提。
 * 注：「不抛」仅指动作发送态瞬时失败；两类异常会**向上传播**、跳过 markProcessed：
 *   ① 终态落库（updateAction）的 repo I/O 故障；
 *   ② `ProviderReauthRequired`（账号级致命：token 撤销 / scope 403）——动作 helper 已先把其
 *      in-flight 行置 failed(reauth kind)、不留 orphan pending，再 re-throw（不当发送态吞掉）；
 *      processEmail 因此跳过 markProcessed → scheduler per-account guard 隔离该账号。
 * 两种情形邮件均留待 at-least-once 重跑（动作幂等、重跑安全）。
 *
 * @param messageRowId 由 processEmail 在 saveEmail 后传入，动作行挂到这封邮件。
 */
export async function executeActions(
  email: NormalizedEmail,
  decision: FinalDecision,
  messageRowId: string,
  deps: ExecuteActionsDeps,
): Promise<void> {
  // 始终先落优先级（标签不被 shouldMarkRead 门控）；ProviderReauthRequired 会从此处向上抛。
  await executeReflectPriority(email, decision, deps, messageRowId);
  if (decision.shouldMarkRead) {
    await executeMarkRead(email, deps, messageRowId);
  }
  if (decision.shouldNotifyNow) {
    await executeNotify(decision, email, deps, messageRowId);
  }
  // shouldIncludeDigest：本期不产生动作（摘要 P5）。
}
