// gmailActions self-check（migration m1）：写侧 400 invalid_grant → ProviderReauthRequired（对称
// classifyReadError 的读侧识别），非当瞬时 GmailActionError（否则 3× 重试猛打 token 端点、且不持久 disable）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGmailProvider, GmailActionError } from './gmailActions.js';
import type { GmailApi } from './gmailClient.js';
import { ProviderReauthRequired } from '../provider.js';
import type { NormalizedEmail } from '../../normalizer/normalizeEmail.js';

const ACCOUNT_ID = 'gmail:me@example.com';

function makeEmail(): NormalizedEmail {
  return {
    accountId: ACCOUNT_ID,
    provider: 'gmail',
    providerMessageId: 'm1',
    subject: 's',
    fromEmail: 'a@b.com',
    to: [],
    date: '2026-07-07T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
  };
}

/** fake GmailApi：messages.modify 抛注入 err（markRead 只用 modify）；其余方法不被触达。 */
function gmailModifyThrows(err: unknown): GmailApi {
  return {
    users: {
      messages: {
        async list() {
          return { data: { messages: [], nextPageToken: null } };
        },
        async get() {
          throw new Error('unused');
        },
        async modify() {
          throw err;
        },
      },
      labels: {
        async list() {
          return { data: { labels: [] } };
        },
        async create() {
          return { data: { id: 'x', name: 'x' } };
        },
      },
    },
  } as GmailApi;
}

test('m1 写侧 invalid_grant（token 端点 400，response.data.error）→ ProviderReauthRequired（非 GmailActionError）', async () => {
  const provider = createGmailProvider(ACCOUNT_ID, gmailModifyThrows({ response: { data: { error: 'invalid_grant' } } }));
  await assert.rejects(
    () => provider.markRead(makeEmail()),
    (e) => e instanceof ProviderReauthRequired,
  );
});

test('m1 写侧 invalid_grant（GaxiosError.message 兜底）→ ProviderReauthRequired', async () => {
  const provider = createGmailProvider(ACCOUNT_ID, gmailModifyThrows(Object.assign(new Error('invalid_grant'))));
  await assert.rejects(
    () => provider.markRead(makeEmail()),
    (e) => e instanceof ProviderReauthRequired,
  );
});

test('m1 对照：普通瞬时发送态失败仍是 GmailActionError（不误判 reauth）', async () => {
  const provider = createGmailProvider(ACCOUNT_ID, gmailModifyThrows(new Error('transient')));
  await assert.rejects(
    () => provider.markRead(makeEmail()),
    (e) => e instanceof GmailActionError,
  );
});
