// 离线验收：accountService.deriveAccountId（node:test）。
//
// env-single loadImapAccount / ImapConfigError / 锚定 call-shape 已随「`MailAccount` 是唯一账号
// 真相源」移除——账号经 accountRegistry 从 DB 加载（见 accountRegistry.test.ts）。本文件只覆盖
// 仍保留的确定性 id 派生（CLI add 与迁移共用、防命名空间分裂）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveAccountId } from './accountService.js';

test('deriveAccountId：无显式 id → 确定性 `imap:<user>@<host>`', () => {
  assert.equal(
    deriveAccountId(undefined, 'me@example.com', 'imap.example.com'),
    'imap:me@example.com@imap.example.com',
  );
});

test('deriveAccountId：显式 id（--account-id 对齐既有/自定义 id）→ 用作 id（覆盖派生）', () => {
  assert.equal(
    deriveAccountId('imap:custom-id', 'me@example.com', 'imap.example.com'),
    'imap:custom-id',
  );
});

test('deriveAccountId：同 (user, host) 跨调用恒一致；不同 (user, host) → 不同命名空间', () => {
  const a = deriveAccountId(undefined, 'me@example.com', 'imap.example.com');
  const b = deriveAccountId(undefined, 'me@example.com', 'imap.example.com');
  assert.equal(a, b);
  assert.notEqual(
    deriveAccountId(undefined, 'me@example.com', 'imap.example.com'),
    deriveAccountId(undefined, 'other@example.com', 'imap.example.com'),
  );
});
