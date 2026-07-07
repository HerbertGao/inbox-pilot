// Gmail message → RawEmail 映射（从旧 gmailPoller 抽出，migration §1.2）。
//
// 只含**纯映射**：把 messages.get(format='full') 的 GmailMessage 收敛为 normalizeEmail 的 RawEmail 入参
// （toRawEmail + header 收集 / From 解析 / body 提取 / HTML→text / 附件探测）。**不含** poll/drain/翻页
// 编排（那些随 gmailPoller 删除、在 run() 内重组）。类型从存活的 gmailClient.ts import。

import type { RawEmail } from '../../normalizer/normalizeEmail.js';
import type { GmailMessage, GmailMessagePart } from './gmailClient.js';

/** 分类器白名单的安全/退订轴头（仅这些 payload.headers 映射进 NormalizedEmail.headers）。 */
export const HEADER_WHITELIST = new Set([
  'reply-to',
  'return-path',
  'list-unsubscribe',
  'authentication-results',
]);

/**
 * 把 messages.get(format='full') 的邮件映射为 normalizeEmail 的 RawEmail 入参。
 * - providerMessageId = message id（跨重启稳定）；providerThreadId = threadId；snippet → snippet。
 * - text/plain → textBody；**无 text/plain 则 text/html 先剔 <script>/<style> 再去标签 → textBody**。
 * - htmlBody 可选保留（审计）；全无正文 → 不设 textBody（normalize 后以 subject+headers 分类）。
 * - payload.headers 仅取分类器白名单 → headers；From/Subject 经各自字段（不塞 headers）。
 */
export function toRawEmail(message: GmailMessage, accountId: string, accountLabel?: string): RawEmail {
  const payload = message.payload ?? undefined;
  const headerMap = collectHeaders(payload);

  const fromRaw = headerMap['from'] ?? '';
  const { fromEmail, fromName } = parseFrom(fromRaw);
  const subject = headerMap['subject'];
  const dateHeader = headerMap['date'];

  const textPlain = findBodyByMime(payload, 'text/plain');
  const textHtml = textPlain === undefined ? findBodyByMime(payload, 'text/html') : undefined;
  const textBody =
    textPlain !== undefined
      ? textPlain
      : textHtml !== undefined
        ? htmlToText(textHtml)
        : undefined;

  const whitelistHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerMap)) {
    if (HEADER_WHITELIST.has(key)) {
      whitelistHeaders[key] = value;
    }
  }

  const raw: RawEmail = {
    accountId,
    provider: 'gmail',
    providerMessageId: message.id ?? undefined,
    subject,
    fromEmail,
    headers: whitelistHeaders,
    hasAttachments: detectAttachments(payload),
  };
  // accountLabel（显示名 label??email）：穿透链承载，缺省不设（normalize 后下游回落裸 accountId）。
  if (accountLabel !== undefined) {
    raw.accountLabel = accountLabel;
  }
  if (typeof message.threadId === 'string' && message.threadId.length > 0) {
    raw.providerThreadId = message.threadId;
  }
  if (typeof message.snippet === 'string' && message.snippet.length > 0) {
    raw.snippet = message.snippet;
  }
  if (fromName !== undefined) {
    raw.fromName = fromName;
  }
  if (typeof dateHeader === 'string' && dateHeader.length > 0) {
    raw.date = dateHeader;
  }
  if (textBody !== undefined) {
    raw.textBody = textBody;
  }
  // htmlBody 可选保留（审计）；分类器不读 htmlBody，仅落库/审计。
  if (textHtml !== undefined) {
    raw.htmlBody = textHtml;
  }
  return raw;
}

/** 收集 payload 树上所有 header（key 小写、顶层优先：仅在未设时写，子 part 不覆盖顶层 From/Subject）。 */
function collectHeaders(part: GmailMessagePart | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (part === undefined) {
    return result;
  }
  const walk = (p: GmailMessagePart): void => {
    for (const h of p.headers ?? []) {
      if (typeof h.name === 'string' && typeof h.value === 'string') {
        const key = h.name.toLowerCase();
        if (result[key] === undefined) {
          result[key] = h.value;
        }
      }
    }
    for (const child of p.parts ?? []) {
      walk(child);
    }
  };
  walk(part);
  return result;
}

/** 从 `Name <addr@host>` / `addr@host` 解析裸地址 + 显示名。 */
function parseFrom(raw: string): { fromEmail: string; fromName?: string } {
  const trimmed = raw.trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(trimmed);
  if (m !== null) {
    const name = m[1].trim().replace(/^"(.*)"$/, '$1').trim();
    const addr = m[2].trim();
    return name.length > 0 ? { fromEmail: addr, fromName: name } : { fromEmail: addr };
  }
  return { fromEmail: trimmed };
}

/** 在 payload 树中按 mimeType 找首个有 body.data 的 part，base64url 解码为文本；无则 undefined。 */
function findBodyByMime(part: GmailMessagePart | undefined, mime: string): string | undefined {
  if (part === undefined) {
    return undefined;
  }
  if ((part.mimeType ?? '').toLowerCase() === mime) {
    const data = part.body?.data;
    if (typeof data === 'string' && data.length > 0) {
      return decodeBase64Url(data);
    }
  }
  for (const child of part.parts ?? []) {
    const found = findBodyByMime(child, mime);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** base64url（Gmail body.data 编码）→ utf8 文本。 */
function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * 轻量 HTML → 纯文本（// ponytail: 轻量去标签足够，完整 HTML 解析属后续）：
 * **先剔除 `<script>`/`<style>` 块**（否则 CSS/JS 文本污染分类输入），再去标签、解码常见实体、压空白。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 检测是否含附件（任一 part 有 filename 或 body.attachmentId）。 */
function detectAttachments(part: GmailMessagePart | undefined): boolean {
  if (part === undefined) {
    return false;
  }
  if (typeof part.filename === 'string' && part.filename.length > 0) {
    return true;
  }
  if (typeof part.body?.attachmentId === 'string' && part.body.attachmentId.length > 0) {
    return true;
  }
  for (const child of part.parts ?? []) {
    if (detectAttachments(child)) {
      return true;
    }
  }
  return false;
}
