// 脱敏 error 摘要：擦除已知敏感片段（token / authorization / chat_id / 邮箱）后截断为短摘要。
// executeActions（首次发送态失败）与 retryQueue（drain 重试失败）**共用**——消除重复、一处加固。
//
// 注：provider/notifier 抛出的 `error.message` 本就只是传输层摘要（bearer token 多在 `error.config`/
// `.response`、非 message）；渠道层（notifier.sanitizeChannelError）+ provider 层结构化脱敏仍是主防线。
// 此处的擦除是 defense-in-depth：兜底任何意外把凭据/PII 塞进 message 的情形（硬约束「凭据/正文绝不入日志」）。

/** 脱敏 error 摘要上限：截断为短摘要，禁含 token / chat_id / 正文。 */
const ERROR_SUMMARY_MAX = 200;

/**
 * 把抛出的未知错误脱敏为短摘要：取 `message`（或 `String(err)`）→ 擦除敏感片段 → 截断到 `ERROR_SUMMARY_MAX`。
 * 禁含 token / chat_id / 凭据 / 邮箱 / 正文。
 */
export function redactError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'unknown error';
  const scrubbed = raw
    // telegram bot token 形态 <digits>:<token>
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    // Authorization: Bearer <...>
    .replace(/\b(authorization)\s*[:=]\s*(?:Bearer\s+)?[^,\s&]+/gi, '$1=[redacted]')
    // token / refresh_token / access_token / chat_id = <...>
    .replace(
      /\b(token|refresh[_-]?token|access[_-]?token|chat[_-]?id)\s*[:=]\s*[^,\s&]+/gi,
      '$1=[redacted]',
    )
    // 邮箱地址
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
  return scrubbed.length > ERROR_SUMMARY_MAX ? scrubbed.slice(0, ERROR_SUMMARY_MAX) : scrubbed;
}
