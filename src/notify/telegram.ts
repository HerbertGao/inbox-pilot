// Telegram 通知渠道（走 Node 24 内置全局 fetch，无新依赖；design「通知渠道：telegram」）。
//
// 硬约束（spec「仅推送通知，绝不发送邮件」「通知密钥只从配置读、不入日志」「不泄露完整正文」）：
//   1. 只 POST 到 Telegram sendMessage——绝不调用任何邮件发送/回复 API。
//   2. token / chat_id 只从 config 读、禁写死；失败 error 摘要禁含 token/chat_id/正文。
//   3. 渠道入参只接 NotificationPayload（白名单字段），textBody/htmlBody 结构上无法进入。

import { config } from '../config/config.js';
import type { NotificationChannel, NotificationPayload } from './notifier.js';

// 推送结果：sent 成功；failed 携带可记录的 error 摘要（不含凭据/正文）。
// 无渠道凭据的降级（skipped）由 notifier 在选渠道阶段处理，不进 channel.send。
export type ChannelSendResult =
  | { readonly outcome: 'sent' }
  | { readonly outcome: 'failed'; readonly error: string };

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/**
 * 把白名单 payload 渲染为 §13 文案。
 *   P0 → [P0 邮件] subject / 发件人 / 原因 / 分类 / 置信度
 *   P4 → [P4 风险邮件] subject / 发件人 / 风险 / 原因 + 「不要点链接，请进官网核验」
 *   其余优先级（理论上不会进即时推送，shouldNotifyNow 只对 P0/P4 为真）回落到通用模板。
 * 只引用 payload 的白名单字段——textBody/htmlBody 不在 payload 中，从结构上杜绝正文泄露。
 */
export function renderTelegramText(payload: NotificationPayload): string {
  const sender = formatSender(payload.fromName, payload.fromEmail);
  if (payload.priority === 'P4') {
    const risk = payload.riskFlags.length > 0 ? payload.riskFlags.join('、') : '（无）';
    return [
      `[P4 风险邮件] ${payload.subject}`,
      `发件人：${sender}`,
      `风险：${risk}`,
      `原因：${payload.reason}`,
      '不要点击链接，请直接进入官网或邮箱客户端核验。',
    ].join('\n');
  }
  // P0（及任何其它即时推送优先级）：subject / 发件人 / 原因 / 分类 / 置信度。
  return [
    `[${payload.priority} 邮件] ${payload.subject}`,
    `发件人：${sender}`,
    `原因：${payload.reason}`,
    `分类：${payload.category}`,
    `置信度：${formatConfidence(payload.confidence)}`,
  ].join('\n');
}

function formatSender(fromName: string | undefined, fromEmail: string): string {
  const email = fromEmail.length > 0 ? fromEmail : '（未知发件人）';
  return fromName !== undefined && fromName.length > 0 ? `${fromName} <${email}>` : email;
}

function formatConfidence(confidence: number): string {
  // 归一到 [0,1] 再两位小数，避免 NaN/越界值进文案。
  const clamped = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  return clamped.toFixed(2);
}

/**
 * Telegram 渠道实现。token / chat_id 在构造时从 config 注入（禁写死）；
 * send 单次推送，失败不抛——返回 failed（带脱敏 error 摘要），重试由 executeActions（组 E）在单次调用内做。
 */
export function createTelegramChannel(args: {
  readonly botToken: string;
  readonly chatId: string;
}): NotificationChannel {
  const { botToken, chatId } = args;
  return {
    name: 'telegram',
    async send(payload: NotificationPayload): Promise<ChannelSendResult> {
      const text = renderTelegramText(payload);
      try {
        // 纯文本推送：不设 parse_mode → subject/reason/fromName（均攻击者可影响）按字面发送、
        // 不被 telegram 解释为 Markdown/HTML。security: 未对这些字段做转义前，禁止添加
        // parse_mode，否则引入标记/链接注入。
        const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        if (!response.ok) {
          // 只记 HTTP 状态码（不含 token/chat_id/正文/响应体）作为脱敏 error 摘要。
          return { outcome: 'failed', error: `telegram-http-${response.status}` };
        }
        return { outcome: 'sent' };
      } catch (err) {
        // 网络/abort 等异常：只取错误类名作脱敏摘要，禁含 URL（内含 token）/正文。
        return { outcome: 'failed', error: errorKind(err) };
      }
    },
  };
}

/**
 * 默认从 config 构造 telegram 渠道；TELEGRAM_* 任一缺失返回 undefined（交由 notifier 降级）。
 * 凭据只从 config 读、禁写死。
 */
export function telegramChannelFromConfig(): NotificationChannel | undefined {
  const botToken = config.TELEGRAM_BOT_TOKEN;
  const chatId = config.TELEGRAM_CHAT_ID;
  if (botToken === undefined || botToken.length === 0 || chatId === undefined || chatId.length === 0) {
    return undefined;
  }
  return createTelegramChannel({ botToken, chatId });
}

/** 取错误的类名做脱敏摘要（fetch 失败的 message 可能内嵌含 token 的 URL，故只取 name）。 */
function errorKind(err: unknown): string {
  if (err instanceof Error && err.name.length > 0) {
    return `telegram-fetch-error-${err.name}`;
  }
  return 'telegram-fetch-error';
}
