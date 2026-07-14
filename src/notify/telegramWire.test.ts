// wire-level 对拍（add-shared-notify 5.3）：换凭据来源后，共享传输发出的 sendMessage
// payload 与今天逐字节一致——parse_mode 仍不设、攻击者可影响文本按字面发（不转义）。
//
// 这条断言在「换传输（apprise）」方案里不可能通过（apprise 默认 parse_mode 会转义/膨胀），
// 在「只换凭据来源、传输不动」方案里成立——即本变更的核心验收。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTelegramChannel } from './telegram.js';
import type { NotificationPayload } from './notifier.js';

// 换行用 String.fromCharCode 构造（本目录约定：源码保持纯 ASCII，禁写裸控制字符）。
const LF = String.fromCharCode(0x0a);

test('wire 对拍：sendMessage 不设 parse_mode、< 与 & 按字面发、chat_id 透传', async () => {
  // 共享传输（createTelegramChannel）——凭据来源改了，这层一行没动。
  const channel = createTelegramChannel({
    botToken: '123456:aaaaaaaaaaaaaaaaaaaaaaaa',
    chatId: '999',
  });

  // 含 `<`、`&`、换行的邮件：这些若被 parse_mode 解释/转义，wire 就会变。
  const payload: NotificationPayload = {
    priority: 'P0',
    category: 'work',
    confidence: 0.9,
    subject: `报价 <b> & 确认${LF}第二行`,
    fromName: 'Ann & <Bob>',
    fromEmail: 'sender@example.com',
    reason: '裁定原因',
    riskFlags: [],
    accountId: 'gmail:me@example.com',
    accountLabel: '公司邮箱',
  };

  // stub 全局 fetch，捕获请求体、立即返回最小 Response-like（不触达真实 telegram）。
  const realFetch = globalThis.fetch;
  let captured: { url: string; body: string } | undefined;
  globalThis.fetch = (async (url: unknown, init: { body?: unknown }) => {
    captured = { url: String(url), body: String(init.body) };
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  try {
    const result = await channel.send(payload);
    assert.equal(result.outcome, 'sent', '传输返回 sent');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(captured !== undefined, 'fetch 被调用、捕获到请求');
  const parsed = JSON.parse(captured.body) as Record<string, unknown>;

  // parse_mode 绝不出现（安全不变量）——键缺席、值 undefined。
  assert.ok(!('parse_mode' in parsed), 'body 无 parse_mode 键');
  assert.equal(parsed.parse_mode, undefined, 'parse_mode 为 undefined');

  // chat_id 透传。
  assert.equal(parsed.chat_id, '999', 'chat_id 透传');

  // `<`、`&` 按字面出现在 text（未被转义为 &lt;/&amp;）——这就是无 parse_mode 的字节等价行为。
  const text = parsed.text as string;
  assert.ok(text.includes('<'), 'text 含字面 <（未转义）');
  assert.ok(text.includes('&'), 'text 含字面 &（未转义）');
  assert.ok(!text.includes('&lt;') && !text.includes('&amp;'), 'text 未做 HTML 转义');
});
