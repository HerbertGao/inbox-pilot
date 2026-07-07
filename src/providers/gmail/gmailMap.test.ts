// gmailMap self-check（migration §1.2 抽出）：toRawEmail 映射 + htmlToText 去标签 + HEADER_WHITELIST。
// 从 gmailPoller 抽出的纯映射，抽出后独立可测（旧 gmail.test.ts 的 poller 半随文件删除）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toRawEmail, htmlToText, HEADER_WHITELIST } from './gmailMap.js';
import { normalizeEmail } from '../../normalizer/normalizeEmail.js';
import type { GmailMessage } from './gmailClient.js';

test('toRawEmail：From 解析 + subject + threadId + snippet + text/plain body', () => {
  const msg: GmailMessage = {
    id: 'g1',
    threadId: 't1',
    snippet: 'hi there',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: '主题' },
        { name: 'From', value: '发件人 <a@b.com>' },
        { name: 'Date', value: 'Mon, 07 Jul 2026 00:00:00 +0000' },
      ],
      body: { data: Buffer.from('正文内容', 'utf8').toString('base64url') },
    },
  };
  const raw = toRawEmail(msg, 'gmail:me@example.com', '公司邮箱');
  assert.equal(raw.providerMessageId, 'g1');
  assert.equal(raw.providerThreadId, 't1');
  assert.equal(raw.snippet, 'hi there');
  assert.equal(raw.subject, '主题');
  assert.equal(raw.fromEmail, 'a@b.com');
  assert.equal(raw.fromName, '发件人');
  assert.equal(raw.textBody, '正文内容');
  assert.equal(raw.accountLabel, '公司邮箱');
  assert.equal(raw.provider, 'gmail');
  // 经 normalize 收敛不抛（去重键三件套齐全）。
  const email = normalizeEmail(raw);
  assert.equal(email.accountLabel, '公司邮箱');
});

test('toRawEmail：headers 仅保留白名单轴，From/Subject 不塞 headers', () => {
  const msg: GmailMessage = {
    id: 'g2',
    payload: {
      headers: [
        { name: 'Subject', value: 's' },
        { name: 'From', value: 'a@b.com' },
        { name: 'Reply-To', value: 'reply@b.com' },
        { name: 'X-Whatever', value: 'nope' },
        { name: 'Authentication-Results', value: 'spf=pass' },
      ],
    },
  };
  const raw = toRawEmail(msg, 'gmail:me@example.com');
  assert.deepEqual(Object.keys(raw.headers as Record<string, string>).sort(), [
    'authentication-results',
    'reply-to',
  ]);
  assert.ok(!('subject' in (raw.headers as Record<string, string>)));
  assert.ok(!('x-whatever' in (raw.headers as Record<string, string>)));
  // 白名单常量含这两轴。
  assert.ok(HEADER_WHITELIST.has('reply-to') && HEADER_WHITELIST.has('authentication-results'));
});

test('toRawEmail：无 text/plain → text/html 剔 script/style + 去标签 → textBody', () => {
  const html = '<style>.x{color:red}</style><p>hello <b>world</b></p><script>alert(1)</script>';
  const msg: GmailMessage = {
    id: 'g3',
    payload: {
      mimeType: 'text/html',
      headers: [{ name: 'From', value: 'a@b.com' }],
      body: { data: Buffer.from(html, 'utf8').toString('base64url') },
    },
  };
  const raw = toRawEmail(msg, 'gmail:me@example.com');
  assert.equal(raw.textBody, 'hello world', 'script/style 剔除、标签去除、空白压缩');
  assert.equal(raw.htmlBody, html, 'htmlBody 原样保留（审计）');
});

test('htmlToText：剔 script/style、去标签、解实体、压空白', () => {
  assert.equal(htmlToText('<script>x</script><p>a &amp; b</p>'), 'a & b');
  assert.equal(htmlToText('<div>  multi\n  space </div>'), 'multi space');
});
