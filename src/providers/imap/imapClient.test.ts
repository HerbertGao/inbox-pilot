// imapClient 离线单测（node:test）：openInbox 的 uidValidity 校验（FIX 4）。
//
// 注入结构化假 ImapFlow（仅实现 openInbox 用到的 mailboxOpen），断言：
//   - uidValidity 非正/非有限（undefined/NaN/0/负）→ 抛固定 kind 错（不写 NaN 游标的前置）。
//   - 合法正整数 uidValidity → 正常返回（UIDNEXT 缺失/非有限归一为 undefined）。
// 全离线、不连网络。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RealImapConnection } from './imapClient.js';
import type { ImapFlow } from 'imapflow';

// 结构化假 ImapFlow：仅 mailboxOpen 按给定值返回（openInbox 仅用到它）。
function fakeClient(mailbox: { uidValidity?: unknown; uidNext?: unknown }): ImapFlow {
  return {
    async mailboxOpen(): Promise<unknown> {
      return mailbox;
    },
  } as unknown as ImapFlow;
}

test('openInbox：uidValidity 非正/非有限（undefined/NaN/0/负）→ 抛固定 kind 错', async () => {
  for (const bad of [undefined, Number.NaN, 0, -1]) {
    const conn = new RealImapConnection(fakeClient({ uidValidity: bad, uidNext: 10 }));
    await assert.rejects(
      () => conn.openInbox(),
      (err: Error) => err.message === 'imap-invalid-uidvalidity',
      `uidValidity=${String(bad)} 应抛 imap-invalid-uidvalidity`,
    );
  }
});

test('openInbox：合法正整数 uidValidity → 正常返回（UIDNEXT 非有限 → undefined）', async () => {
  const conn = new RealImapConnection(fakeClient({ uidValidity: 5, uidNext: 11 }));
  assert.deepEqual(await conn.openInbox(), { uidValidity: 5, uidNext: 11 });

  // UIDNEXT 缺失 → undefined（既有 RFC 可选性兜底，与 uidValidity 校验并存）。
  const conn2 = new RealImapConnection(fakeClient({ uidValidity: 7 }));
  assert.deepEqual(await conn2.openInbox(), { uidValidity: 7, uidNext: undefined });
});
