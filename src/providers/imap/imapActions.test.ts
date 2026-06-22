// imapActions（5.2）离线单测（node:test）。
//
// 断言（对照 tasks 5.2 + spec「经规则引擎裁定执行真实标已读」）：
//   - 注入会抛「含 host:port、user」消息的假连接 → markRead 重抛消息**严格等于**固定 kind 串
//     （零插值、非仅缺子串）。
//   - uid 缺失 → markRead 抛错（fail-loud、不 no-op）。
//   - 经 executeActions：仅 shouldMarkRead=true 才标 \Seen；P0/P1/P4/敏感保持未读（不调 addSeenFlag）。
//   - markRead 失败耗尽 → mail_actions=mark_read(failed)、processEmail 仍 markProcessed、
//     邮件保持未读（addSeenFlag 始终抛、从未成功）且不重试（at-most-once-after-retry、安全方向）。
//
// 全离线：注入假 ImapConnection + InMemoryMailRepo + 假 classify；不连网络、不发邮件。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createImapProvider,
  ImapMarkReadError,
  IMAP_MARK_READ_FAILED,
  IMAP_MARK_READ_MISSING_UID,
} from './imapActions.js';
import type {
  FetchedMessage,
  ImapConnection,
  ImapSearchCriteria,
  MailboxStatus,
} from './imapClient.js';
import { processEmail, type ClassifyFn } from '../../pipeline/processEmail.js';
import { InMemoryMailRepo } from '../../repo/inMemoryMailRepo.js';
import { createNotifier } from '../../notify/notifier.js';
import type { NotificationChannel } from '../../notify/notifier.js';
import type { ChannelSendResult } from '../../notify/telegram.js';
import type { Classification } from '../../classifier/schema.js';
import type { NormalizedEmail } from '../../normalizer/normalizeEmail.js';
import { SENSITIVE_DOMAINS } from '../../rules/lists.js';

// 假连接：addSeenFlag 行为可配（成功记录 uid / 抛含敏感串的错误）。其余方法非本测关注、置惰性默认。
function makeFakeConnection(
  addSeen: (uid: number) => Promise<void>,
): ImapConnection & { seenUids: number[] } {
  const seenUids: number[] = [];
  return {
    seenUids,
    async openInbox(): Promise<MailboxStatus> {
      return { uidValidity: 1, uidNext: 1 };
    },
    async search(_criteria: ImapSearchCriteria): Promise<number[]> {
      return [];
    },
    async fetchByUid(_uid: number): Promise<FetchedMessage | null> {
      return null;
    },
    async addSeenFlag(uid: number): Promise<void> {
      seenUids.push(uid);
      await addSeen(uid);
    },
    async logout(): Promise<void> {},
  };
}

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'imap:u@h',
    provider: 'imap',
    providerMessageId: 'mid-1',
    subject: '普通主题',
    fromEmail: 'sender@example.com',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    uid: 42,
    hasAttachments: false,
    headers: {},
    ...overrides,
  };
}

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    priority: 'P2',
    category: 'work',
    should_notify_now: false,
    should_mark_read: true,
    should_include_digest: true,
    confidence: 0.9,
    reason: '测试',
    risk_flags: [],
    ...overrides,
  };
}

function makeClassify(cls: Classification): ClassifyFn {
  return async () => cls;
}

// 无操作假渠道：本组断言标已读/未读行为、不断言 notify 内容，故注入它以保证 notifier
// 绝不落到真身 telegramChannelFromConfig()（杜绝测试发真实 Telegram 消息）。
function noopChannel(): NotificationChannel {
  return {
    name: 'noop',
    async send(): Promise<ChannelSendResult> {
      return { outcome: 'sent' };
    },
    async sendText(): Promise<ChannelSendResult> {
      return { outcome: 'sent' };
    },
  };
}

// ——————————————————————————————————————————————————————————
// markRead 失败 → 重抛消息**严格等于**固定 kind 串（零插值、非仅缺子串）
// ——————————————————————————————————————————————————————————

test('markRead 底层抛含 host:port/user 的错误 → 重抛消息严格等于固定 kind 串（零插值）', async () => {
  // 底层错误消息**故意**含敏感连接信息：host:port、user、口令、mailbox、IMAP 命令文本。
  const leaky =
    'IMAP error connecting to imap.bank-internal.example.com:993 as user alice@bank.com ' +
    'pass=hunter2 mailbox=INBOX cmd="UID STORE 42 +FLAGS (\\Seen)"';
  const connection = makeFakeConnection(async () => {
    throw new Error(leaky);
  });
  const provider = createImapProvider(connection);

  let thrown: unknown;
  try {
    await provider.markRead(makeEmail({ uid: 42 }));
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown instanceof ImapMarkReadError, '应抛 ImapMarkReadError');
  // **严格相等**（非「缺子串」）：消息就是固定 kind 串、零插值。
  assert.equal((thrown as Error).message, IMAP_MARK_READ_FAILED);
  assert.equal((thrown as ImapMarkReadError).kind, IMAP_MARK_READ_FAILED);
  // 二次兜底：重抛消息绝不含任何服务器/账号/口令/命令片段。
  const msg = (thrown as Error).message;
  for (const secret of [
    'imap.bank-internal.example.com',
    '993',
    'alice@bank.com',
    'hunter2',
    'INBOX',
    'STORE',
    '\\Seen',
  ]) {
    assert.ok(!msg.includes(secret), `重抛消息不应含敏感片段 ${secret}`);
  }
});

// ——————————————————————————————————————————————————————————
// uid 缺失 → fail-loud（抛错，不 no-op）
// ——————————————————————————————————————————————————————————

test('uid 缺失 → markRead 抛结构化错误（fail-loud，禁静默 no-op）', async () => {
  let called = false;
  const connection = makeFakeConnection(async () => {
    called = true;
  });
  const provider = createImapProvider(connection);

  let thrown: unknown;
  try {
    await provider.markRead(makeEmail({ uid: undefined }));
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown instanceof ImapMarkReadError, 'uid 缺失应抛 ImapMarkReadError');
  assert.equal((thrown as Error).message, IMAP_MARK_READ_MISSING_UID);
  // 禁静默 no-op：根本没调到 addSeenFlag。
  assert.equal(called, false, 'uid 缺失时禁调 addSeenFlag');
  assert.equal(connection.seenUids.length, 0);
});

test('uid 成功 → addSeenFlag 按活动 uid 调用、幂等不抛', async () => {
  const connection = makeFakeConnection(async () => {});
  const provider = createImapProvider(connection);
  await provider.markRead(makeEmail({ uid: 77 }));
  await provider.markRead(makeEmail({ uid: 77 })); // 幂等：重复标不报错。
  assert.deepEqual(connection.seenUids, [77, 77]);
});

// ——————————————————————————————————————————————————————————
// 经 executeActions：仅 shouldMarkRead=true 才标 \Seen
// ——————————————————————————————————————————————————————————

test('经 executeActions：P2 普通（shouldMarkRead=true）→ 标 \\Seen 一次', async () => {
  const connection = makeFakeConnection(async () => {});
  const provider = createImapProvider(connection);
  const repo = new InMemoryMailRepo();
  const notifier = createNotifier({ channel: noopChannel() });
  const classify = makeClassify(makeClassification({ priority: 'P2' }));
  const email = makeEmail({ uid: 100 });

  await processEmail(email, { repo, provider, notifier, classify });

  assert.deepEqual(connection.seenUids, [100], 'P2 普通应标 \\Seen 一次');
  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  assert.equal(repo.getActions(rowId).find((a) => a.actionType === 'mark_read')?.status, 'done');
});

test('经 executeActions：P0/P1/P4/敏感 → 不标 \\Seen（保持未读）', async () => {
  for (const setup of [
    { name: 'P0', cls: makeClassification({ priority: 'P0' }), email: makeEmail({ uid: 1 }) },
    { name: 'P1', cls: makeClassification({ priority: 'P1' }), email: makeEmail({ uid: 2 }) },
    { name: 'P4', cls: makeClassification({ priority: 'P4' }), email: makeEmail({ uid: 3 }) },
    {
      name: '敏感域名',
      cls: makeClassification({ priority: 'P2' }),
      email: makeEmail({ uid: 4, fromEmail: `u@${SENSITIVE_DOMAINS[0]}` }),
    },
  ]) {
    const connection = makeFakeConnection(async () => {});
    const provider = createImapProvider(connection);
    const repo = new InMemoryMailRepo();
    const notifier = createNotifier({ channel: noopChannel() });
    await processEmail(setup.email, { repo, provider, notifier, classify: makeClassify(setup.cls) });
    assert.equal(connection.seenUids.length, 0, `${setup.name} 不应标 \\Seen`);
  }
});

// ——————————————————————————————————————————————————————————
// markRead 失败耗尽 → mail_actions=failed、processEmail 仍 markProcessed、保持未读、不重试
// ——————————————————————————————————————————————————————————

test('markRead 失败耗尽 → mark_read(failed)、markProcessed 仍执行、保持未读、不重试', async () => {
  let attempts = 0;
  const connection = makeFakeConnection(async () => {
    attempts += 1;
    throw new Error('connect ECONNREFUSED imap.example.com:993');
  });
  const provider = createImapProvider(connection);
  const repo = new InMemoryMailRepo();
  const notifier = createNotifier({ channel: noopChannel() });
  const classify = makeClassify(makeClassification({ priority: 'P2' }));
  const email = makeEmail({ uid: 200 });

  // executeActions 不抛（标已读失败只落 mail_actions），processEmail 走完链路。
  await processEmail(email, { repo, provider, notifier, classify });

  const stored = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!;
  // markProcessed 仍执行（不以动作成功为前提）。
  assert.ok(stored.processedAt !== null, 'markProcessed 应仍执行');
  // mail_actions = mark_read(failed)；error 是脱敏固定 kind 串（经 redactError 截断后仍等于它）。
  const markRead = repo.getActions(stored.id).find((a) => a.actionType === 'mark_read');
  assert.equal(markRead?.status, 'failed');
  assert.equal(markRead?.error, IMAP_MARK_READ_FAILED, 'failed error 应是脱敏固定 kind 串');
  // 「保持未读」是安全方向：addSeenFlag 始终抛、从未成功 → 邮件未被标 \Seen。
  // 单次调用内有界重试（≤3），不重试到下轮（at-most-once-after-retry）。
  assert.ok(attempts >= 1 && attempts <= 3, `尝试次数应 ∈ [1,3]，实际 ${attempts}`);

  // 「不重试」：同邮件下轮（dedup 命中已 processedAt）→ 跳过、不再标已读。
  attempts = 0;
  await processEmail(email, { repo, provider, notifier, classify });
  assert.equal(attempts, 0, '已处理邮件下轮 dedup 跳过，不再尝试标已读');
});
