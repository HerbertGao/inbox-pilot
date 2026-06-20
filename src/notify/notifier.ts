// 通知器 Notifier（design「通知渠道：telegram」、spec notifications 5 条需求）。
//
// 职责：P0/P4 即时推送（shouldNotifyNow 为真）经聊天渠道推送一条 §13 文案。
//
// 不可违反的硬约束：
//   - 绝不发送/回复邮件——只调用聊天/推送渠道（telegram）。
//   - 通知不泄露完整正文：notify 内部先把 NormalizedEmail 投影成白名单 NotificationPayload
//     （subject/fromName/fromEmail/reason/category/confidence/priority/riskFlags），
//     textBody/htmlBody 从结构上无法进入渠道入参与日志。
//   - 凭据只从 config 读、禁写死、不入日志。
//
// 三态返回（供 executeActions 组 E 落 mail_actions）：
//   - sent     → 对应 notify 动作记 done。
//   - skipped  → 无渠道凭据降级（不抛、不进重试），记 skipped + reason。
//   - failed   → 渠道推送失败（带脱敏 error 摘要），记 failed；重试由 executeActions 在单次调用内做。

import { logger } from '../logger.js';
import type { FinalDecision, Priority, Category } from '../rules/finalDecision.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import { telegramChannelFromConfig, type ChannelSendResult } from './telegram.js';

/**
 * 交给渠道/日志的白名单投影。**只含**通知所需字段——textBody/htmlBody 不在此结构中，
 * 从类型层面杜绝完整正文泄露（组 F 会结构断言渠道入参不含 textBody/htmlBody）。
 */
export type NotificationPayload = {
  readonly priority: Priority;
  readonly category: Category;
  readonly confidence: number;
  readonly subject: string;
  readonly fromName?: string;
  readonly fromEmail: string;
  readonly reason: string;
  readonly riskFlags: readonly string[];
};

/** 渠道 seam：notifier 把白名单 payload 交给渠道，渠道返回 sent/failed（不抛）。 */
export type NotificationChannel = {
  readonly name: string;
  send(payload: NotificationPayload): Promise<ChannelSendResult>;
};

/**
 * notify 结果三态（区分供 executeActions 落 mail_actions）：
 *   sent     —— 渠道推送成功。
 *   skipped  —— 无渠道凭据降级（含 reason，不进重试预算）。
 *   failed   —— 渠道推送失败（含脱敏 error 摘要，可重试）。
 */
export type NotifyResult =
  | { readonly outcome: 'sent'; readonly channel: string }
  | { readonly outcome: 'skipped'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly channel: string; readonly error: string };

/** Notifier seam：processEmail/executeActions 注入；默认接真身（telegram from config），测试注入假渠道。 */
export type Notifier = {
  notify(decision: FinalDecision, email: NormalizedEmail): Promise<NotifyResult>;
};

/**
 * 把规则裁定 + 规范化邮件投影成白名单 payload。
 * **只取**白名单字段——这是杜绝正文泄露的单点收敛：textBody/htmlBody 不被读取。
 */
function projectPayload(decision: FinalDecision, email: NormalizedEmail): NotificationPayload {
  return {
    priority: decision.priority,
    category: decision.category,
    confidence: decision.confidence,
    subject: email.subject,
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    reason: decision.reason,
    riskFlags: decision.riskFlags,
  };
}

/**
 * 渠道 error 在 notifier 边界的脱敏：NotificationChannel 是可注入 seam（telegram 已只产
 * 安全 token，但未来渠道如 bark 不可信）。只放行紧凑机器安全 token（如 telegram-http-500 /
 * telegram-fetch-error-TimeoutError），其余一律替换为定值——杜绝渠道把正文/凭据经 error
 * 字段泄进日志或 mail_actions（硬约束：密钥/正文不入日志）。
 */
function sanitizeChannelError(error: string): string {
  return /^[a-z0-9._-]{1,120}$/i.test(error) ? error : 'notify-channel-error-redacted';
}

/**
 * 默认 Notifier。选渠道：传入 channel（或默认从 config 构造 telegram）存在 → 推送；
 * 否则降级——记一条结构化日志（不含凭据/正文）并返回 skipped，不抛、不崩。
 *
 * 渠道解析采用「构造时一次性解析」：channel 为 NotificationChannel 时直接用；
 * 为 undefined（默认）时调 telegramChannelFromConfig()（TELEGRAM_* 缺失则得 undefined → 降级）。
 */
export function createNotifier(args?: {
  readonly channel?: NotificationChannel;
}): Notifier {
  const channel: NotificationChannel | undefined =
    args?.channel ?? telegramChannelFromConfig();

  return {
    async notify(decision: FinalDecision, email: NormalizedEmail): Promise<NotifyResult> {
      if (channel === undefined) {
        // 无渠道降级：结构化日志只含脱敏字段（kind/priority），禁含凭据/正文。
        logger.info(
          { kind: 'notify-skipped-no-channel', priority: decision.priority },
          '无通知渠道凭据，降级跳过推送',
        );
        return { outcome: 'skipped', reason: 'no-channel' };
      }

      // 白名单投影后才交给渠道——textBody/htmlBody 不进入渠道入参。
      const payload = projectPayload(decision, email);
      const result = await channel.send(payload);

      if (result.outcome === 'sent') {
        return { outcome: 'sent', channel: channel.name };
      }
      // 推送失败：不抛、记结构化日志（只含脱敏 error 摘要 + kind/priority/channel），
      // 禁含凭据/正文。终态落 mail_actions 由 executeActions（组 E）负责。
      const safeError = sanitizeChannelError(result.error);
      logger.warn(
        {
          kind: 'notify-failed',
          channel: channel.name,
          priority: decision.priority,
          error: safeError,
        },
        '通知推送失败',
      );
      return { outcome: 'failed', channel: channel.name, error: safeError };
    },
  };
}

/** 默认 Notifier 实例（接真身：telegram from config）。测试用 createNotifier({ channel }) 注入假渠道。 */
export const defaultNotifier: Notifier = createNotifier();
