// Telegram 通知渠道（走 Node 24 内置全局 fetch，无新依赖；design「通知渠道：telegram」）。
//
// 硬约束（spec「仅推送通知，绝不发送邮件」「通知密钥只从配置读、不入日志」「不泄露完整正文」）：
//   1. 只 POST 到 Telegram sendMessage——绝不调用任何邮件发送/回复 API。
//   2. bot token 经 hangar-notify resolver 从 env 读、chat_id 从 channels.yaml 读，均禁写死；失败 error 摘要禁含 token/chat_id/正文。
//   3. 渠道入参只接 NotificationPayload（白名单字段），textBody/htmlBody 结构上无法进入。

import { resolveWithReason } from 'hangar-notify';

import { logger } from '../logger.js';
import { CATEGORY_LABELS } from './categoryLabels.js';
import type { NotificationChannel, NotificationPayload } from './notifier.js';

// 推送结果：sent 成功；failed 携带可记录的 error 摘要（不含凭据/正文）。
// 无渠道凭据的降级（skipped）由 notifier 在选渠道阶段处理，不进 channel.send。
export type ChannelSendResult =
  | { readonly outcome: 'sent' }
  | { readonly outcome: 'failed'; readonly error: string };

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// 单次推送硬超时：Node 全局 fetch 默认无超时，连接卡死会无限挂住动作流水线。
const TELEGRAM_TIMEOUT_MS = 10_000;

/**
 * 把白名单 payload 渲染为 §13 文案（design 决策 1/2/3、spec notifications「单一模板」）。
 *
 * P0/P4 **单一模板**、统一字段序：
 *   [优先级] 主题 / 邮箱:<mailboxLabel> / 发件人 / 原因 / 分类:#中文 / 置信度
 *   + `riskFlags` **非空才**加风险行（P0 此前不显示、合并后非空时会显示——字段统一带来的行为变更）
 *   + **仅** P4 附「不要点链接、请进官网核验」安全提示
 *
 * 邮箱来源标签 **sanitize-then-fallback**（决策 1）：先净化 label 候选、净化后为空才回落
 * 裸 accountId（ASCII、净化 no-op、必非空）→ **绝不渲染空**「邮箱:」。绝不写成
 * `sanitizeField(accountLabel || accountId)`——全危险字符候选 pre-sanitize 非空被 `||`
 * 选中、再净化成空 → 空来源。
 *
 * 只引用 payload 的白名单字段——textBody/htmlBody 不在 payload 中，从结构上杜绝正文泄露。
 */
export function renderTelegramText(payload: NotificationPayload): string {
  // **所有攻击者可影响的自由文本字段**（主题 / 原因 / 发件人 / 风险标记 / 来源标签）在渲染前一律净化:
  // 仅净化 mailboxLabel 不够——subject 等含换行（`\r`/`\n`/U+2028/U+2029）会在多行消息里**伪造结构行**
  // （如假「邮箱：…」行），绕过来源可辨保证（CodeRabbit review）。sanitizeField 同时剥控制/格式/bidi。
  const subject = sanitizeField(payload.subject);
  const reason = sanitizeField(payload.reason);
  const sender = sanitizeField(formatSender(payload.fromName, payload.fromEmail));
  // sanitize-then-fallback：先净化 label 候选，净化后为空才回落裸 accountId（绝不空）。
  const fromLabel = sanitizeField(payload.accountLabel ?? '').trim();
  const mailboxLabel = fromLabel || payload.accountId;
  const lines = [
    `[${payload.priority} 邮件] ${subject}`,
    `邮箱：${mailboxLabel}`,
    `发件人：${sender}`,
    `原因：${reason}`,
    `分类：#${CATEGORY_LABELS[payload.category]}`,
    `置信度：${formatConfidence(payload.confidence)}`,
  ];
  // riskFlags 非空才加风险行（空则不渲染）；join 后净化（防风险标记里的换行伪造行）。
  if (payload.riskFlags.length > 0) {
    lines.push(`风险：${sanitizeField(payload.riskFlags.join('、'))}`);
  }
  // 仅 P4 附安全核验提示。
  if (payload.priority === 'P4') {
    lines.push('不要点击链接，请直接进入官网或邮箱客户端核验。');
  }
  return lines.join('\n');
}

/**
 * 来源标签渲染净化（单点防御 choke point，design 决策 1/4、spec notifications「来源标签渲染前净化」）。
 * 剥除 `s` 中**所有**出现的 `\p{Cc}`（C0/C1 控制）/ `\p{Cf}`（格式字符，含零宽/BOM/bidi 嵌入覆盖）
 * / U+2028 / U+2029（行分隔）/ U+2066–U+2069（bidi 隔离符）——带 `u`+`g` flag。
 * 账号 `email` 是 IMAP `--email` 未按 denylist 校验的自由文本，统一在此净化、防经 email
 * 重开 RTL-override 等来源伪装面；`label` 已 add 校验、`accountId` 已 ASCII，对其为 no-op。
 */
function sanitizeField(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\u2028\u2029\u2066-\u2069]/gu, '');
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

  /**
   * POST 一段**已渲染好**的文本到 sendMessage 并归一为 ChannelSendResult。
   * per-email `send`（先 renderTelegramText 再调本 helper）与摘要 `sendText`（直接传预组装文本）共用：
   * 同一超时、同一脱敏、同样**不设 parse_mode**（subject/reason/fromName/摘要文案均攻击者可影响、按字面发）。
   */
  async function postMessage(text: string): Promise<ChannelSendResult> {
    try {
      // 纯文本推送：不设 parse_mode → 文本（攻击者可影响）按字面发送、不被 telegram 解释为
      // Markdown/HTML。security: 未对其做转义前，禁止添加 parse_mode，否则引入标记/链接注入。
      const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        // 硬超时：超时 → AbortSignal 抛 TimeoutError → 下方 catch 经 errorKind 记
        // telegram-fetch-error-TimeoutError（不含 token/正文），纳入 executeActions 有界重试。
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
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
  }

  return {
    name: 'telegram',
    async send(payload: NotificationPayload): Promise<ChannelSendResult> {
      return postMessage(renderTelegramText(payload));
    },
    // 摘要出口：文案已由 buildDigest 预组装并按渠道上限分段，sendText 只负责 POST。
    async sendText(text: string): Promise<ChannelSendResult> {
      return postMessage(text);
    },
  };
}

/**
 * 默认从 hangar-notify resolver 取 telegram 目的地（inbox/private lane）；解析不出返回
 * undefined（交由 notifier 降级）。传输一行不改——只换凭据/目的地来源。
 * 凭据（bot token）经 resolver 从 env 读、禁写死；ERROR 日志只带 reason+varName，绝不带 token 值。
 */
export function telegramChannelFromConfig(): NotificationChannel | undefined {
  const { destination, failure } = resolveWithReason('inbox', 'private');
  if (destination === undefined) {
    // present-but-invalid config (bad token shape / malformed yaml) → ERROR: a real
    // misconfig, not just "unconfigured". absent → silent degrade (design D5/D6).
    // NEVER logs the token value — only the stable reason + the env var NAME.
    if (failure.severity === 'error') {
      logger.error(
        { kind: 'notify-config-invalid', reason: failure.reason, varName: failure.varName },
        '通知配置无效，降级跳过推送',
      );
    }
    return undefined; // notifier degrades to skipped (unchanged behavior)
  }
  return createTelegramChannel(destination);
}

/** 取错误的类名做脱敏摘要（fetch 失败的 message 可能内嵌含 token 的 URL，故只取 name）。 */
function errorKind(err: unknown): string {
  if (err instanceof Error && err.name.length > 0) {
    return `telegram-fetch-error-${err.name}`;
  }
  return 'telegram-fetch-error';
}
