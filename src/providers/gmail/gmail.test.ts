// Gmail provider（4.5）离线单测（node:test）。注入假 GmailApi + InMemoryMailRepo + Fake/真 provider
// + 假 classify；全离线、不连网络、不发邮件。
//
// 覆盖 tasks 4.5 全部断言（逐 test 标注对应场景）：
//   - 未处理未读进流水线；已处理长期未读 DB 预去重不再 get；分页穷尽 + 最旧优先不饿死旧件；
//   - reflectPriority 权威标签（create / 409→existing / 缓存按账号隔离）；
//   - shouldMarkRead→去 UNREAD、P0/P4 保持 UNREAD+仍带标签；reflectPriority 先于 markRead；
//   - HTML-only→textBody 喂分类器；全无正文→subject/headers 分类；单封缺 From skip；
//   - 读侧 429 结束本轮（非逐封 skip 继续翻页）；写侧 429 非致命仍 markProcessed；
//   - 403→ProviderReauthRequired→markProcessed 跳过、账号隔离；access_token 不落 authJson；
//   - scope 恰为 {gmail.modify} 精确相等 + provider 方法面无 send（结构性）；PKCE verifier 全程一致；
//   - refresh 失败日志无 token/secret 子串；回调日志无 code/state 子串、无完整回调 URL。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';

import { gmailPoll, htmlToText, toRawEmail, type GmailPollDeps } from './gmailPoller.js';
import {
  createGmailProvider,
  PRIORITY_LABELS,
  GmailActionError,
  GMAIL_ACTION_FAILED,
  _clearLabelCacheForTest,
} from './gmailActions.js';
import { createGmailClient, throwReauth, type GmailApi, type GmailMessage } from './gmailClient.js';
import {
  authorizeGmailAccount,
  GMAIL_MODIFY_SCOPE,
  GmailOAuthError,
  GMAIL_OAUTH_NO_REFRESH_TOKEN,
  GMAIL_OAUTH_ACCESS_DENIED,
  type OAuth2ClientLike as OAuthClientLike,
} from './oauth.js';
import { InMemoryMailRepo } from '../../repo/inMemoryMailRepo.js';
import { FakeProviderActions } from '../../actions/providerActions.js';
import { processEmail, type ClassifyFn } from '../../pipeline/processEmail.js';
import { createNotifier } from '../../notify/notifier.js';
import type { NotificationChannel } from '../../notify/notifier.js';
import type { ChannelSendResult } from '../../notify/telegram.js';
import { ProviderReauthRequired } from '../provider.js';
import { REDACT_PATHS, logger as prodLogger } from '../../logger.js';
import { pino } from 'pino';
import type { Classification } from '../../classifier/schema.js';

const ACCOUNT_ID = 'gmail:user@example.com';

// ——————————————————————————————————————————————————————————
// 测试辅助
// ——————————————————————————————————————————————————————————

async function makeRepo(): Promise<InMemoryMailRepo> {
  const r = new InMemoryMailRepo();
  await r.upsertAccount({
    id: ACCOUNT_ID,
    provider: 'gmail',
    email: 'user@example.com',
    authJson: { refreshToken: 'rt-secret', scopes: [GMAIL_MODIFY_SCOPE] },
  });
  return r;
}

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

// base64url 编码 body.data（Gmail 形态）。
function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

// 构造一条 text/plain 邮件的 GmailMessage。
function plainMessage(id: string, overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    snippet: `snippet ${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Sender Name <sender@example.com>' },
        { name: 'Subject', value: `主题 ${id}` },
        { name: 'Date', value: 'Sat, 20 Jun 2026 00:00:00 +0000' },
      ],
      body: { data: b64url(`正文 ${id}`) },
    },
    ...overrides,
  };
}

/**
 * 可配假 GmailApi：
 *  - pages：list 每页返回的 message id（穷尽翻页 + nextPageToken）。
 *  - messages：id → GmailMessage（get 据此返回）。
 *  - listError / getError(id)：注入读侧错误（429 / 401 / 403 等 GaxiosError-like）。
 *  - 记录 getCalls / modifyCalls / labelCreateNames 供断言。
 */
class FakeGmail implements GmailApi {
  pages: string[][] = [];
  messages = new Map<string, GmailMessage>();
  getCalls: string[] = [];
  modifyCalls: Array<{ id: string; addLabelIds?: string[]; removeLabelIds?: string[] }> = [];
  labelCreateNames: string[] = [];
  labelListCalls = 0;
  existingLabels: Array<{ id: string; name: string }> = [];
  listError: unknown;
  getErrors = new Map<string, unknown>();
  modifyErrors = new Map<string, unknown>();
  labelCreateError: unknown;
  // create 返回的 id 计数。
  private labelSeq = 0;

  readonly users = {
    messages: {
      list: async (params: { pageToken?: string }) => {
        if (this.listError !== undefined) {
          throw this.listError;
        }
        const idx = params.pageToken === undefined ? 0 : Number(params.pageToken);
        const page = this.pages[idx] ?? [];
        const next = idx + 1 < this.pages.length ? String(idx + 1) : null;
        return { data: { messages: page.map((id) => ({ id })), nextPageToken: next } };
      },
      get: async (params: { id: string }) => {
        this.getCalls.push(params.id);
        const err = this.getErrors.get(params.id);
        if (err !== undefined) {
          throw err;
        }
        const msg = this.messages.get(params.id);
        if (msg === undefined) {
          throw new Error(`fake get: unknown id ${params.id}`);
        }
        return { data: msg };
      },
      modify: async (params: {
        id: string;
        requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
      }) => {
        const err = this.modifyErrors.get(params.id);
        if (err !== undefined) {
          throw err;
        }
        this.modifyCalls.push({ id: params.id, ...params.requestBody });
        return { data: {} };
      },
    },
    labels: {
      list: async () => {
        this.labelListCalls += 1;
        return { data: { labels: this.existingLabels.map((l) => ({ id: l.id, name: l.name })) } };
      },
      create: async (params: { requestBody: { name: string } }) => {
        if (this.labelCreateError !== undefined) {
          throw this.labelCreateError;
        }
        this.labelCreateNames.push(params.requestBody.name);
        this.labelSeq += 1;
        return { data: { id: `label-${this.labelSeq}`, name: params.requestBody.name } };
      },
    },
  };
}

// GaxiosError-like：顶层 status / response.status；可选 errors[].reason；以及含凭据子串的 message/.response/.config。
function gaxiosError(
  status: number,
  withSecrets = false,
  reason?: string,
): Error & Record<string, unknown> {
  const e = new Error(withSecrets ? 'refresh_token=leaky-rt client_secret=leaky-cs' : 'api error') as Error &
    Record<string, unknown>;
  e.status = status;
  e.code = status;
  // reason（标量）走 Gaxios 顶层 errors[0].reason（403 速率/配额 vs 权限失配的判别依据）。
  if (reason !== undefined) {
    e.errors = [{ reason, message: 'r' }];
  }
  if (withSecrets) {
    e.response = { status, data: { refresh_token: 'leaky-rt', error: 'invalid_grant' } };
    e.config = { headers: { Authorization: 'Bearer leaky-at' }, data: 'client_secret=leaky-cs' };
  } else {
    e.response = { status };
  }
  return e;
}

// pino logger 写入内存 buffer（与生产同 redact），断言凭据不入日志。
function captureLogger(): { logger: pino.Logger; output: () => string } {
  const lines: string[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(chunk);
    },
  };
  const l = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);
  return { logger: l, output: () => lines.join('') };
}

/**
 * 真·sink 捕获：在 `fn()` 期间拦截**生产 logger 自身的目的地流**（pino 的 SonicBoom，经
 * `pino.symbols.streamSym` 取得），收集其**已序列化、已 redact** 的输出后还原。使断言**驱动真实
 * 生产代码路径**（throwReauth / 真实 OAuth 回调处理），而非手抄脱敏字段——若某 sink 误把原始
 * GaxiosError 整体记入，本捕获会抓到泄露（非空泛断言；见下方自检 test 验证）。
 */
async function captureProdStdout(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const streamSym = pino.symbols.streamSym;
  const stream = (prodLogger as unknown as Record<symbol, { write: (c: string) => boolean }>)[streamSym];
  const orig = stream.write.bind(stream);
  stream.write = (chunk: string): boolean => {
    chunks.push(chunk);
    return true;
  };
  try {
    await fn();
  } finally {
    stream.write = orig;
  }
  return chunks.join('');
}

function pollDeps(
  gmail: GmailApi,
  repo: InMemoryMailRepo,
  provider: FakeProviderActions,
  classify: ClassifyFn,
  extra: Partial<GmailPollDeps> = {},
): GmailPollDeps {
  return { gmail, repo, provider, classify, ...extra };
}

// ——————————————————————————————————————————————————————————
// 1. 未处理未读进流水线 + providerMessageId/threadId/snippet 映射
// ——————————————————————————————————————————————————————————

test('未处理未读 → messages.get → 收敛 → processEmail（providerMessageId=message id）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1', 'm2']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.messages.set('m2', plainMessage('m2'));
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  const seen: string[] = [];
  const runProcess = async (email: import('../../normalizer/normalizeEmail.js').NormalizedEmail) => {
    seen.push(email.providerMessageId);
    assert.equal(email.provider, 'gmail');
    assert.equal(email.accountId, ACCOUNT_ID);
  };

  await gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
    processEmail: runProcess,
  }));

  // 最旧优先：list 最新优先（m1,m2）故逆序处理（m2,m1）。
  assert.deepEqual(seen, ['m2', 'm1']);
  assert.deepEqual(gmail.getCalls.sort(), ['m1', 'm2']);
});

// ——————————————————————————————————————————————————————————
// 2. 已处理长期未读经 DB 预去重不再 get
// ——————————————————————————————————————————————————————————

test('已处理长期未读 → DB 预去重跳过、不 messages.get', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1', 'm2']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.messages.set('m2', plainMessage('m2'));
  const repo = await makeRepo();
  // 预置 m1 已处理（saveEmail + markProcessed）。
  const stored = await repo.saveEmail({
    accountId: ACCOUNT_ID,
    provider: 'gmail',
    providerMessageId: 'm1',
    subject: 's',
    fromEmail: 'a@b.c',
    to: [],
    date: new Date().toISOString(),
    hasAttachments: false,
    headers: {},
  });
  await repo.markProcessed(stored.id);
  const provider = new FakeProviderActions();

  await gmailPoll(
    ACCOUNT_ID,
    pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async () => {},
    }),
  );

  // m1 已处理：预去重跳过、不 get；仅 m2 被 get。
  assert.deepEqual(gmail.getCalls, ['m2'], '已处理 m1 不应被 get');
});

// ——————————————————————————————————————————————————————————
// 3. 分页穷尽 + 最旧优先不饿死旧件（get 预算）
// ——————————————————————————————————————————————————————————

test('分页穷尽翻页 + 最旧优先：get 预算不饿死最旧未处理件', async () => {
  const gmail = new FakeGmail();
  // 3 页（穷尽翻页验证）：list 最新优先，最旧件 = 最后一页最后一个。
  gmail.pages = [
    ['n1', 'n2'],
    ['n3', 'n4'],
    ['old1', 'old2'],
  ];
  for (const id of ['n1', 'n2', 'n3', 'n4', 'old1', 'old2']) {
    gmail.messages.set(id, plainMessage(id));
  }
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  const seen: string[] = [];

  // get 预算仅 2：最旧优先应先处理最旧两件（old2, old1），不被新件饿死。
  await gmailPoll(
    ACCOUNT_ID,
    pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      getBudget: 2,
      processEmail: async (e) => {
        seen.push(e.providerMessageId);
      },
    }),
  );

  // 全部未读 id 顺序（list 最新优先）：n1,n2,n3,n4,old1,old2 → 逆序最旧优先：old2,old1,...
  assert.deepEqual(seen, ['old2', 'old1'], '最旧优先 + get 预算：先处理最旧两件');
  // 翻页穷尽：list 列完所有 3 页（纯 id 轻）；get 只 2 次（预算在 get 数）。
  assert.equal(gmail.getCalls.length, 2, 'get 数受预算约束（非翻页数）');
});

// ——————————————————————————————————————————————————————————
// 4. reflectPriority 权威标签：create / 409→existing / 缓存按账号隔离
// ——————————————————————————————————————————————————————————

test('reflectPriority 打权威标签：缺失→create、缓存、二次不再 create', async () => {
  _clearLabelCacheForTest();
  const gmail = new FakeGmail();
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  const email = makeEmail('m1');
  await provider.reflectPriority(email, decision('P0'));
  await provider.reflectPriority(makeEmail('m2'), decision('P0'));

  // 仅首次 create（缓存命中后不再 create）。
  assert.deepEqual(gmail.labelCreateNames, [PRIORITY_LABELS.P0], 'P0 权威标签仅 create 一次');
  // 两封都 addLabelIds 同一 labelId（幂等打标签）。
  assert.equal(gmail.modifyCalls.length, 2);
  assert.deepEqual(gmail.modifyCalls[0].addLabelIds, ['label-1']);
  assert.deepEqual(gmail.modifyCalls[1].addLabelIds, ['label-1']);
});

test('reflectPriority 409「已存在」→ 取该账号已存在 labelId（不致命）', async () => {
  _clearLabelCacheForTest();
  const gmail = new FakeGmail();
  gmail.labelCreateError = gaxiosError(409);
  gmail.existingLabels = [{ id: 'existing-p2', name: PRIORITY_LABELS.P2 }];
  const provider = createGmailProvider(ACCOUNT_ID, gmail);

  await provider.reflectPriority(makeEmail('m1'), decision('P2'));

  assert.equal(gmail.labelListCalls, 1, '409 后 labels.list 取已存在');
  assert.deepEqual(gmail.modifyCalls[0].addLabelIds, ['existing-p2']);
});

test('labelId 缓存按 (accountId,labelName) 隔离：A 的 labelId 不被 B 复用', async () => {
  _clearLabelCacheForTest();
  const gmailA = new FakeGmail();
  const gmailB = new FakeGmail();
  const provA = createGmailProvider('gmail:a@x.com', gmailA);
  const provB = createGmailProvider('gmail:b@x.com', gmailB);

  await provA.reflectPriority(makeEmail('a1'), decision('P0'));
  await provB.reflectPriority(makeEmail('b1'), decision('P0'));

  // 两账号各自 create 一次（缓存按账号隔离，B 不复用 A 的 labelId）。
  assert.deepEqual(gmailA.labelCreateNames, [PRIORITY_LABELS.P0]);
  assert.deepEqual(gmailB.labelCreateNames, [PRIORITY_LABELS.P0]);
  assert.deepEqual(gmailA.modifyCalls[0].addLabelIds, ['label-1']);
  assert.deepEqual(gmailB.modifyCalls[0].addLabelIds, ['label-1']); // B 自己的 label-1，非 A 的。
});

// ——————————————————————————————————————————————————————————
// 5. markRead 去 UNREAD；P0/P4 保持 UNREAD + 仍带标签；reflectPriority 先于 markRead
// ——————————————————————————————————————————————————————————

test('markRead → removeLabelIds [UNREAD]（幂等）', async () => {
  const gmail = new FakeGmail();
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  await provider.markRead(makeEmail('m1'));
  await provider.markRead(makeEmail('m1')); // 幂等。
  assert.equal(gmail.modifyCalls.length, 2);
  assert.deepEqual(gmail.modifyCalls[0].removeLabelIds, ['UNREAD']);
});

// 注：reflectPriority-before-markRead 的**调用顺序**由 executeActions（Group C，task 3.1）保证；
// 本组（4.x）只断言两个方法各自行为正确。此处直接按 spec 顺序调用 provider 断言两方法协同效果：
//   reflectPriority(打标签) → markRead(去 UNREAD)，标签 modify 在去 UNREAD modify 之前。
test('Gmail provider：reflectPriority(打标签) 后 markRead(去 UNREAD) 的 modify 序列正确', async () => {
  _clearLabelCacheForTest();
  const gmail = new FakeGmail();
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  const email = makeEmail('m1');

  // 按 executeActions 将施加的顺序调用（Group C 保证此顺序）。
  await provider.reflectPriority(email, decision('P2'));
  await provider.markRead(email);

  const addIdx = gmail.modifyCalls.findIndex((c) => c.addLabelIds !== undefined);
  const removeIdx = gmail.modifyCalls.findIndex((c) => c.removeLabelIds?.includes('UNREAD'));
  assert.ok(addIdx >= 0 && removeIdx >= 0, '应同时有打标签与去 UNREAD');
  assert.ok(addIdx < removeIdx, 'reflectPriority 的 modify 先于 markRead 的 modify');
});

// 经 executeActions 验证去 UNREAD 受 shouldMarkRead 门控（executeActions 已落地 markRead 门控）；
// reflectPriority 的「始终调用」由 Group C 接线，本组单独断言 reflectPriority 打标签正确（见上面用例）。
test('经 executeActions：P2(shouldMarkRead) → 去 UNREAD；P0/P4 → 不去 UNREAD（保持未读）', async () => {
  // P2：去 UNREAD。
  {
    const gmail = new FakeGmail();
    const provider = createGmailProvider(ACCOUNT_ID, gmail);
    const repo = await makeRepo();
    const notifier = createNotifier({ channel: noopChannel() });
    await processEmail(makeEmail('p2'), {
      repo,
      provider,
      notifier,
      classify: makeClassify(makeClassification({ priority: 'P2' })),
    });
    assert.ok(
      gmail.modifyCalls.some((c) => c.removeLabelIds?.includes('UNREAD')),
      'P2 应去 UNREAD',
    );
  }
  // P0/P4：不去 UNREAD（保持未读、用户可见）。
  for (const priority of ['P0', 'P4'] as const) {
    const gmail = new FakeGmail();
    const provider = createGmailProvider(ACCOUNT_ID, gmail);
    const repo = await makeRepo();
    const notifier = createNotifier({ channel: noopChannel() });
    await processEmail(makeEmail(`m-${priority}`), {
      repo,
      provider,
      notifier,
      classify: makeClassify(makeClassification({ priority })),
    });
    assert.ok(
      !gmail.modifyCalls.some((c) => c.removeLabelIds?.includes('UNREAD')),
      `${priority} 不应去 UNREAD（保持未读）`,
    );
  }
});

// reflectPriority「始终打标签、不受 shouldMarkRead 门控」：直接对 P0/P4 调 reflectPriority 验证。
test('reflectPriority：P0/P4（shouldMarkRead=false）仍打对应权威标签', async () => {
  for (const priority of ['P0', 'P4'] as const) {
    _clearLabelCacheForTest();
    const gmail = new FakeGmail();
    const provider = createGmailProvider(ACCOUNT_ID, gmail);
    await provider.reflectPriority(makeEmail(`m-${priority}`), decision(priority));
    assert.deepEqual(gmail.labelCreateNames, [PRIORITY_LABELS[priority]], `${priority} 打对应权威标签`);
    assert.deepEqual(gmail.modifyCalls[0].addLabelIds, ['label-1']);
  }
});

// ——————————————————————————————————————————————————————————
// 6. HTML-only → textBody 喂分类器；全无正文 → subject/headers；缺 From skip
// ——————————————————————————————————————————————————————————

test('HTML-only → text/html 去标签 → textBody（喂分类器）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['h1']];
  gmail.messages.set('h1', {
    id: 'h1',
    threadId: 't',
    payload: {
      mimeType: 'text/html',
      headers: [
        { name: 'From', value: 'a@b.c' },
        { name: 'Subject', value: 'html' },
      ],
      body: { data: b64url('<style>.x{color:red}</style><p>Hello <b>World</b></p><script>evil()</script>') },
    },
  });
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  let fedTextBody: string | undefined;

  await gmailPoll(
    ACCOUNT_ID,
    pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async (e) => {
        fedTextBody = e.textBody;
      },
    }),
  );

  assert.ok(fedTextBody !== undefined, 'HTML-only 应有 textBody');
  assert.ok(fedTextBody!.includes('Hello'), '去标签后含正文文本');
  assert.ok(!fedTextBody!.includes('evil'), '<script> 块应被剔除');
  assert.ok(!fedTextBody!.includes('color:red'), '<style> 块应被剔除');
  assert.ok(!fedTextBody!.includes('<p>'), '标签应被去除');
});

test('全无正文（无 text/plain/html/snippet）→ 仍进流水线（subject/headers 分类）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['e1']];
  gmail.messages.set('e1', {
    id: 'e1',
    threadId: 't',
    payload: {
      mimeType: 'application/pkcs7-mime',
      headers: [
        { name: 'From', value: 'a@b.c' },
        { name: 'Subject', value: '加密邮件' },
      ],
    },
  });
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  let fed: import('../../normalizer/normalizeEmail.js').NormalizedEmail | undefined;

  await gmailPoll(
    ACCOUNT_ID,
    pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async (e) => {
        fed = e;
      },
    }),
  );

  assert.ok(fed !== undefined, '全无正文邮件不丢弃');
  assert.equal(fed!.textBody, undefined, '无正文：textBody 未设');
  assert.equal(fed!.subject, '加密邮件', '以 subject 分类');
});

test('单封缺 From → normalize 后 fromEmail 空串、仍进流水线（不崩整批）', async () => {
  // Gmail 邮件总有 id（providerMessageId 不缺）；缺 From 时 normalizeEmail 不抛（fromEmail→''）。
  // 验证整批不被单封映射干扰：一封缺 From、一封正常，都进流水线。
  const gmail = new FakeGmail();
  gmail.pages = [['ok1', 'nofrom']];
  gmail.messages.set('ok1', plainMessage('ok1'));
  gmail.messages.set('nofrom', {
    id: 'nofrom',
    threadId: 't',
    payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '无发件人' }], body: { data: b64url('x') } },
  });
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  const seen: string[] = [];

  await gmailPoll(
    ACCOUNT_ID,
    pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async (e) => {
        seen.push(`${e.providerMessageId}:${e.fromEmail}`);
      },
    }),
  );

  assert.deepEqual(seen.sort(), ['nofrom:', 'ok1:sender@example.com'].sort());
});

// ——————————————————————————————————————————————————————————
// 7. 读侧 429 结束本轮（不逐封 skip 继续翻页）；403 抛 reauth
// ——————————————————————————————————————————————————————————

test('读侧 list 429 → 结束本轮（上抛，不逐封 skip 继续翻页）', async () => {
  const gmail = new FakeGmail();
  gmail.listError = gaxiosError(429);
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()))),
    (err: unknown) => readStatus(err) === 429,
  );
  assert.equal(gmail.getCalls.length, 0, '429 结束本轮：不进入逐封 get');
});

test('读侧 get 429 → 绕过逐封 skip、结束本轮', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1', 'm2']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.messages.set('m2', plainMessage('m2'));
  gmail.getErrors.set('m2', gaxiosError(429)); // m2 是最旧（先处理），429 立即结束本轮。
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async () => {},
    })),
    (err: unknown) => readStatus(err) === 429,
  );
});

test('读侧 list 403 insufficientPermissions → ProviderReauthRequired（隔离账号）', async () => {
  const gmail = new FakeGmail();
  gmail.listError = gaxiosError(403, false, 'insufficientPermissions');
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()))),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
});

test('读侧 list 401 → ProviderReauthRequired（无歧义 auth 失败、隔离账号）', async () => {
  const gmail = new FakeGmail();
  gmail.listError = gaxiosError(401);
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()))),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
});

test('读侧 list 403 rateLimitExceeded → 瞬时（结束本轮、账号不被 suspend、非 ProviderReauthRequired）', async () => {
  const gmail = new FakeGmail();
  gmail.listError = gaxiosError(403, false, 'rateLimitExceeded');
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()))),
    // 瞬时：上抛原始 403 err（status===403），**非** ProviderReauthRequired。
    (err: unknown) => readStatus(err) === 403 && !(err instanceof ProviderReauthRequired),
  );
  assert.equal(gmail.getCalls.length, 0, '速率/配额 403 结束本轮：不进入逐封 get');
});

test('读侧 list 403 缺 reason → 默认瞬时（安全侧、不误 suspend 健康账号）', async () => {
  const gmail = new FakeGmail();
  gmail.listError = gaxiosError(403); // 无 reason
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()))),
    (err: unknown) => readStatus(err) === 403 && !(err instanceof ProviderReauthRequired),
  );
});

test('读侧 get 403 insufficientPermissions → ProviderReauthRequired（绕过逐封 skip、隔离账号）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1', 'm2']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.messages.set('m2', plainMessage('m2'));
  gmail.getErrors.set('m2', gaxiosError(403, false, 'insufficientPermissions')); // m2 最旧、先处理。
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async () => {},
    })),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
});

test('读侧 get 401 → ProviderReauthRequired（绕过逐封 skip、隔离账号）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.getErrors.set('m1', gaxiosError(401));
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async () => {},
    })),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
});

test('读侧 get 403 rateLimitExceeded → 瞬时（结束本轮、账号不被 suspend、非 ProviderReauthRequired）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1', 'm2']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.messages.set('m2', plainMessage('m2'));
  gmail.getErrors.set('m2', gaxiosError(403, false, 'rateLimitExceeded')); // m2 最旧、先处理。
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async () => {},
    })),
    (err: unknown) => readStatus(err) === 403 && !(err instanceof ProviderReauthRequired),
  );
});

test('读侧 get 403 缺 reason → 默认瞬时（安全侧、不误 suspend 健康账号）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.getErrors.set('m1', gaxiosError(403)); // 无 reason
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async () => {},
    })),
    (err: unknown) => readStatus(err) === 403 && !(err instanceof ProviderReauthRequired),
  );
});

// invalid_grant（refresh token 撤销/过期）：token 端点 body `{error:'invalid_grant'}`、HTTP 400、
// GaxiosError.message='invalid_grant'。messageOnly=true 模拟仅 message 携带（覆盖无 response.data 兜底分支）。
function invalidGrantError(messageOnly = false): Error & Record<string, unknown> {
  const e = new Error('invalid_grant') as Error & Record<string, unknown>;
  e.status = 400;
  e.code = 400;
  e.response = messageOnly
    ? { status: 400 }
    : { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
  return e;
}

test('读侧 list invalid_grant（refresh token 撤销/过期, HTTP 400）→ ProviderReauthRequired（隔离 + suspend）', async () => {
  const gmail = new FakeGmail();
  gmail.listError = invalidGrantError();
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()))),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
  assert.equal(gmail.getCalls.length, 0, 'invalid_grant 结束本轮：不进入逐封 get');
});

test('读侧 list invalid_grant 仅经 message 携带（无 response.data 兜底）→ ProviderReauthRequired', async () => {
  const gmail = new FakeGmail();
  gmail.listError = invalidGrantError(true);
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()))),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
});

test('读侧 get invalid_grant（HTTP 400）→ ProviderReauthRequired（绕过逐封 skip、隔离 + suspend）', async () => {
  const gmail = new FakeGmail();
  gmail.pages = [['m1']];
  gmail.messages.set('m1', plainMessage('m1'));
  gmail.getErrors.set('m1', invalidGrantError());
  const repo = await makeRepo();
  const provider = new FakeProviderActions();
  await assert.rejects(
    gmailPoll(ACCOUNT_ID, pollDeps(gmail, repo, provider, makeClassify(makeClassification()), {
      processEmail: async () => {},
    })),
    (err: unknown) => err instanceof ProviderReauthRequired && err.accountId === ACCOUNT_ID,
  );
});

// ——————————————————————————————————————————————————————————
// 8. 写侧 429 非致命仍 markProcessed；403 → reauth → markProcessed 跳过
// ——————————————————————————————————————————————————————————

test('写侧 429 非致命：reflectPriority/markRead 失败仍落 failed、processEmail 仍 markProcessed', async () => {
  _clearLabelCacheForTest();
  const gmail = new FakeGmail();
  // 标签 create 成功，但 messages.modify 始终 429。
  gmail.modifyErrors.set('m1', gaxiosError(429));
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  const repo = await makeRepo();
  const notifier = createNotifier({ channel: noopChannel() });
  const email = makeEmail('m1');

  // executeActions 把发送态失败落 mail_actions、不抛；processEmail 仍 markProcessed。
  await processEmail(email, { repo, provider, notifier, classify: makeClassify(makeClassification({ priority: 'P2' })) });

  const stored = (await repo.findByDedupKey(ACCOUNT_ID, 'm1'))!;
  assert.ok(stored.processedAt !== null, '写侧 429 非致命：markProcessed 仍执行');
  const markRead = repo.getActions(stored.id).find((a) => a.actionType === 'mark_read');
  assert.equal(markRead?.status, 'failed');
  assert.equal(markRead?.error, GMAIL_ACTION_FAILED, 'failed error 是脱敏固定 kind 串');
});

test('写侧 403 scope 失配（insufficientPermissions）→ markRead 抛 ProviderReauthRequired', async () => {
  const gmail = new FakeGmail();
  gmail.modifyErrors.set('m1', gaxiosError(403, false, 'insufficientPermissions'));
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  await assert.rejects(
    provider.markRead(makeEmail('m1')),
    (err: unknown) => err instanceof ProviderReauthRequired,
  );
});

test('写侧 403 速率/配额（rateLimitExceeded）→ 瞬时 GmailActionError（不 reauth、账号不被 suspend）', async () => {
  const gmail = new FakeGmail();
  gmail.modifyErrors.set('m1', gaxiosError(403, false, 'rateLimitExceeded'));
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  await assert.rejects(
    provider.markRead(makeEmail('m1')),
    (err: unknown) => err instanceof GmailActionError && !(err instanceof ProviderReauthRequired),
  );
});

test('写侧 403 reason 缺失/不明 → 默认瞬时（GmailActionError，不误 suspend 健康账号）', async () => {
  const gmail = new FakeGmail();
  gmail.modifyErrors.set('m1', gaxiosError(403)); // 无 reason
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  await assert.rejects(
    provider.markRead(makeEmail('m1')),
    (err: unknown) => err instanceof GmailActionError && !(err instanceof ProviderReauthRequired),
  );
});

// ——————————————————————————————————————————————————————————
// 9. access_token 不落 authJson（运行期 refresh 只回写 refreshToken）
// ——————————————————————————————————————————————————————————

test('运行期 refresh：仅 refresh_token 轮换才回写、access_token 绝不入 persist', async () => {
  const persisted: Array<{ accountId: string; refreshToken: string }> = [];
  let tokensListener: ((t: { refresh_token?: string | null; access_token?: string }) => void) | undefined;
  const fakeOAuth: import('./gmailClient.js').OAuth2ClientLike = {
    setCredentials() {},
    on(_event, listener) {
      tokensListener = listener as typeof tokensListener;
      return this;
    },
  };
  createGmailClient(ACCOUNT_ID, {
    clientId: 'cid',
    clientSecret: 'csec',
    refreshToken: 'rt-0',
    oauthClient: fakeOAuth,
    makeGmailApi: () => new FakeGmail(),
    persistRefreshToken: async (accountId, refreshToken) => {
      persisted.push({ accountId, refreshToken });
    },
  });

  // 普通 access token 刷新（无 refresh_token 轮换）→ 不回写。
  tokensListener!({ access_token: 'at-new' });
  assert.equal(persisted.length, 0, 'access_token 刷新不回写（不落 at-rest）');

  // refresh_token 轮换 → 仅回写 refreshToken。
  tokensListener!({ refresh_token: 'rt-1', access_token: 'at-2' });
  await new Promise((r) => setImmediate(r)); // 等 persist 的 microtask。
  assert.deepEqual(persisted, [{ accountId: ACCOUNT_ID, refreshToken: 'rt-1' }]);
});

// ——————————————————————————————————————————————————————————
// 10. scope 恰为 {gmail.modify} 精确相等 + provider 方法面无 send（结构性）
// ——————————————————————————————————————————————————————————

test('scope 恰为 {gmail.modify}（规范化单元素集精确相等）', () => {
  const scopeSet = new Set([GMAIL_MODIFY_SCOPE]);
  assert.equal(scopeSet.size, 1);
  assert.ok(scopeSet.has('https://www.googleapis.com/auth/gmail.modify'));
  // 精确相等：唯一元素正是该全 URL。
  assert.deepEqual([...scopeSet], ['https://www.googleapis.com/auth/gmail.modify']);
});

test('结构性断言：构建的 Gmail provider 方法面无 send / 无 messages.send 路径', () => {
  const gmail = new FakeGmail();
  const provider = createGmailProvider(ACCOUNT_ID, gmail);
  const keys = Object.keys(provider);
  // provider 仅 markRead / reflectPriority，无任何 send。
  assert.deepEqual(keys.sort(), ['markRead', 'reflectPriority']);
  for (const k of keys) {
    assert.ok(!/send/i.test(k), `provider 方法面不含 send：${k}`);
  }
  // GmailApi 结构子集无 send 路径（messages 仅 list/get/modify）。
  assert.deepEqual(Object.keys(gmail.users.messages).sort(), ['get', 'list', 'modify']);
  assert.ok(!('send' in gmail.users.messages), 'GmailApi.users.messages 无 send');
});

// ——————————————————————————————————————————————————————————
// 11. PKCE verifier 全程一致（发起 challenge 的 verifier == getToken 用 verifier）
// ——————————————————————————————————————————————————————————

test('OAuth：PKCE verifier 全程一致 + scope 恰为 gmail.modify + email 仅小写', async () => {
  let generatedVerifier = '';
  let getTokenVerifier = '';
  let authUrlScopes: string[] = [];
  let authUrlRedirect = '';
  let getTokenRedirect = '';

  const fakeClient: OAuthClientLike = {
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'verifier-xyz', codeChallenge: 'challenge-xyz' };
    },
    generateAuthUrl(opts) {
      generatedVerifier = 'verifier-xyz';
      authUrlScopes = opts.scope;
      authUrlRedirect = opts.redirect_uri;
      assert.equal(opts.access_type, 'offline');
      assert.equal(opts.prompt, 'consent');
      assert.equal(opts.code_challenge_method, 'S256');
      assert.equal(opts.code_challenge, 'challenge-xyz');
      return `http://auth.example/?state=${opts.state}`;
    },
    async getToken(opts) {
      getTokenVerifier = opts.codeVerifier;
      getTokenRedirect = opts.redirect_uri;
      return { tokens: { refresh_token: 'rt-final', scope: GMAIL_MODIFY_SCOPE } };
    },
    setCredentials() {},
  };

  const result = await authorizeGmailAccount(
    { clientId: 'cid', clientSecret: 'csec' },
    {
      makeOAuthClient: () => fakeClient,
      getProfileEmail: async () => 'User.Name+Tag@Example.COM',
      // 模拟用户点开 URL → 向 loopback 回调发 code+state。
      openAuthUrl: async (url) => {
        const u = new URL(url);
        const state = u.searchParams.get('state')!;
        // authUrlRedirect 是唯一精确 redirect_uri（含 bound-port）。
        await fireCallback(authUrlRedirect, { state, code: 'auth-code' });
      },
    },
  );

  // PKCE 全程一致。
  assert.equal(generatedVerifier, 'verifier-xyz');
  assert.equal(getTokenVerifier, 'verifier-xyz', 'getToken 用同一 PKCE verifier');
  // scope 恰为 gmail.modify。
  assert.deepEqual(authUrlScopes, [GMAIL_MODIFY_SCOPE]);
  // redirect_uri 两处精确一致（含端口）。
  assert.equal(authUrlRedirect, getTokenRedirect, '授权 URL 与 getToken redirect_uri 精确一致');
  assert.match(authUrlRedirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/);
  // email 仅小写（不剥点/+tag）。
  assert.equal(result.email, 'user.name+tag@example.com');
  assert.equal(result.refreshToken, 'rt-final');
  assert.deepEqual(result.scopes, [GMAIL_MODIFY_SCOPE]);
});

test('OAuth：缺 refresh token → 显式失败（不建残缺账号）', async () => {
  const fakeClient: OAuthClientLike = {
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'v', codeChallenge: 'c' };
    },
    generateAuthUrl(opts) {
      return `http://auth/?state=${opts.state}&redir=${encodeURIComponent(opts.redirect_uri)}`;
    },
    async getToken() {
      return { tokens: { refresh_token: null, scope: GMAIL_MODIFY_SCOPE } }; // 无 refresh token。
    },
    setCredentials() {},
  };
  await assert.rejects(
    authorizeGmailAccount(
      { clientId: 'cid', clientSecret: 'csec' },
      {
        makeOAuthClient: () => fakeClient,
        openAuthUrl: async (url) => {
          const u = new URL(url);
          const redir = decodeURIComponent(u.searchParams.get('redir')!);
          await fireCallback(redir, { state: u.searchParams.get('state')!, code: 'c' });
        },
      },
    ),
    (err: unknown) => err instanceof GmailOAuthError && err.kind === GMAIL_OAUTH_NO_REFRESH_TOKEN,
  );
});

test('OAuth：error= 带错误/缺失 state 不消费 one-shot（随后正确回调仍成功）', async () => {
  let authUrlRedirect = '';
  const fakeClient: OAuthClientLike = {
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'v', codeChallenge: 'c' };
    },
    generateAuthUrl(opts) {
      authUrlRedirect = opts.redirect_uri;
      return `http://auth/?state=${opts.state}`;
    },
    async getToken() {
      return { tokens: { refresh_token: 'rt-final', scope: GMAIL_MODIFY_SCOPE } };
    },
    setCredentials() {},
  };

  const result = await authorizeGmailAccount(
    { clientId: 'cid', clientSecret: 'csec' },
    {
      makeOAuthClient: () => fakeClient,
      getProfileEmail: async () => 'user@example.com',
      openAuthUrl: async (url) => {
        const u = new URL(url);
        const realState = u.searchParams.get('state')!;
        // (1) error=access_denied + 错误 state → 必须不消费 one-shot、不中止。
        await fireRaw(authUrlRedirect, { error: 'access_denied', state: 'WRONG-STATE' });
        // (2) error=access_denied + 缺失 state → 同样不消费 one-shot、不中止。
        await fireRaw(authUrlRedirect, { error: 'access_denied' });
        // (3) 随后正确 state 回调仍能成功换 token（证明 one-shot 未被前面的错误 state 杀死）。
        await fireCallback(authUrlRedirect, { state: realState, code: 'auth-code' });
      },
    },
  );
  assert.equal(result.refreshToken, 'rt-final', '错误 state 的 error= 未消费 one-shot，正确回调仍成功');
});

test('OAuth：两次匹配回调 → 第二次回 410、不触发第二次 token 交换（one-shot 只消费一次）', async () => {
  let authUrlRedirect = '';
  let realState = '';
  let getTokenCalls = 0;
  const fakeClient: OAuthClientLike = {
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'v', codeChallenge: 'c' };
    },
    generateAuthUrl(opts) {
      authUrlRedirect = opts.redirect_uri;
      realState = opts.state;
      return `http://auth/?state=${opts.state}`;
    },
    async getToken() {
      getTokenCalls += 1;
      return { tokens: { refresh_token: 'rt-final', scope: GMAIL_MODIFY_SCOPE } };
    },
    setCredentials() {},
  };

  const result = await authorizeGmailAccount(
    { clientId: 'cid', clientSecret: 'csec' },
    {
      makeOAuthClient: () => fakeClient,
      getProfileEmail: async () => 'user@example.com',
      openAuthUrl: async () => {
        // 两次匹配回调**并发**发起（两连接在 close 排空前都已建立）：先到者消费 one-shot、换 token；
        // 后到者被 settled 短路、回 410，不再换 token。
        const [s1, s2] = await Promise.all([
          fireWithStatus(authUrlRedirect, { state: realState, code: 'auth-code' }),
          fireWithStatus(authUrlRedirect, { state: realState, code: 'auth-code-2' }),
        ]);
        // 一次 200（消费 one-shot）、一次 410（被短路）——顺序不定，断言为该多重集。
        assert.deepEqual([s1, s2].sort(), [200, 410], '两次匹配回调：一次 200 消费、一次 410 短路');
      },
    },
  );
  assert.equal(result.refreshToken, 'rt-final');
  assert.equal(getTokenCalls, 1, '只换一次 token（第二次匹配回调不触发 getToken）');
});

test('OAuth：error=access_denied 且 state 匹配 → 干净中止（GMAIL_OAUTH_ACCESS_DENIED）', async () => {
  let authUrlRedirect = '';
  const fakeClient: OAuthClientLike = {
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'v', codeChallenge: 'c' };
    },
    generateAuthUrl(opts) {
      authUrlRedirect = opts.redirect_uri;
      return `http://auth/?state=${opts.state}`;
    },
    async getToken() {
      return { tokens: { refresh_token: 'rt', scope: GMAIL_MODIFY_SCOPE } };
    },
    setCredentials() {},
  };
  await assert.rejects(
    authorizeGmailAccount(
      { clientId: 'cid', clientSecret: 'csec' },
      {
        makeOAuthClient: () => fakeClient,
        openAuthUrl: async (url) => {
          const u = new URL(url);
          await fireCallback(authUrlRedirect, { state: u.searchParams.get('state')!, error: 'access_denied' });
        },
      },
    ),
    (err: unknown) => err instanceof GmailOAuthError && err.kind === GMAIL_OAUTH_ACCESS_DENIED,
  );
});

// ——————————————————————————————————————————————————————————
// 12. refresh 失败日志无 token/secret 子串（合成 GaxiosError 凭据子串全丢弃）
// ——————————————————————————————————————————————————————————

test('refresh/403 失败日志：仅 code+kind，无 token/secret/bearer 子串', async () => {
  const cap = captureLogger();
  // throwReauth 用模块级 logger；为离线断言「不泄露」，直接复刻其脱敏字段写入捕获 logger，
  // 再断言整体输出不含凭据子串（合成 GaxiosError 的 .message/.response/.config 都含凭据）。
  const err = gaxiosError(403, true);
  // 仅取 code（标量），绝不整体记 err。
  const code = (err as { code?: unknown }).code;
  cap.logger.warn({ kind: 'gmail-reauth-required', accountId: ACCOUNT_ID, code }, 'reauth');

  const out = cap.output();
  for (const secret of ['leaky-rt', 'leaky-cs', 'leaky-at', 'Bearer', 'invalid_grant']) {
    assert.ok(!out.includes(secret), `日志不应含凭据子串 ${secret}`);
  }
  assert.ok(out.includes('gmail-reauth-required'), '应含固定 kind');
  assert.ok(out.includes('403'), '应含 code');
});

test('真·sink：throwReauth(合成 GaxiosError) 经生产 logger 不泄露 token/secret/bearer', async () => {
  // 驱动**真实生产代码路径**（throwReauth 用模块级 prodLogger，写 process.stdout）——若 throwReauth
  // 误记原始 GaxiosError，本捕获会抓到泄露（区别于手抄脱敏字段的空泛断言）。
  const err = gaxiosError(403, true); // .message/.response/.config 都含凭据子串
  const out = await captureProdStdout(() => {
    try {
      throwReauth(ACCOUNT_ID, err);
    } catch {
      // throwReauth 必抛 ProviderReauthRequired（已先记日志）。
    }
  });
  for (const secret of ['leaky-rt', 'leaky-cs', 'leaky-at', 'Bearer', 'invalid_grant']) {
    assert.ok(!out.includes(secret), `生产 sink 输出不应含凭据子串 ${secret}`);
  }
  assert.ok(out.includes('gmail-reauth-required'), '生产 sink 含固定 kind');
});

test('真·sink（自检非空泛）：直接整体记原始 GaxiosError 会泄露——证明上面断言有效', async () => {
  // 故意整体记原始 err（**反**生产纪律），证明捕获断言确实能抓到泄露（防上一个 test 是空泛绿）。
  const err = gaxiosError(403, true);
  const out = await captureProdStdout(() => {
    prodLogger.warn({ kind: 'self-check', err }, 'leak-on-purpose');
  });
  // pino key-redact 清不掉字符串内嵌的凭据（.message/.config.data），故必现泄露。
  assert.ok(out.includes('leaky-rt') || out.includes('leaky-cs') || out.includes('leaky-at'),
    '整体记原始 error 会泄露字符串内嵌凭据（证明捕获断言非空泛）');
});

test('真·sink：OAuth 回调处理经生产 logger 不泄露 code/state（驱动真实 awaitLoopbackCode 路径）', async () => {
  // 驱动真实 oauth.ts 回调处理：成功回调消费 one-shot、生产 logger 记 {kind,stateResult,path}。
  // 捕获生产 stdout，断言不含授权 code / state（即便它们在回调 URL 的 query 里）。
  let authUrlRedirect = '';
  let realState = '';
  const fakeClient: OAuthClientLike = {
    async generateCodeVerifierAsync() {
      return { codeVerifier: 'v', codeChallenge: 'c' };
    },
    generateAuthUrl(opts) {
      authUrlRedirect = opts.redirect_uri;
      realState = opts.state;
      return `http://auth/?state=${opts.state}`;
    },
    async getToken() {
      return { tokens: { refresh_token: 'rt', scope: GMAIL_MODIFY_SCOPE } };
    },
    setCredentials() {},
  };
  const secretCode = 'AUTHCODE-leaky-12345';
  const out = await captureProdStdout(async () => {
    await authorizeGmailAccount(
      { clientId: 'cid', clientSecret: 'csec' },
      {
        makeOAuthClient: () => fakeClient,
        getProfileEmail: async () => 'user@example.com',
        openAuthUrl: async () => {
          await fireCallback(authUrlRedirect, { state: realState, code: secretCode });
        },
      },
    );
  });
  assert.ok(!out.includes(secretCode), '生产 sink 不含授权 code');
  assert.ok(!out.includes(realState), '生产 sink 不含 state');
  assert.ok(!out.includes('?code='), '生产 sink 不含完整回调 query');
});

// ——————————————————————————————————————————————————————————
// 13. 回调日志无 code/state 子串、不含完整回调 URL
// ——————————————————————————————————————————————————————————

test('OAuth 回调日志：无 code/state 子串、无完整回调 URL（只 {kind,stateResult,path}）', async () => {
  const cap = captureLogger();
  // 复刻 oauth.ts 回调日志字段（只记 kind/stateResult/path），断言不含 code/state/完整 URL。
  const secretCode = 'SUPER-SECRET-CODE-123';
  const secretState = 'SUPER-SECRET-STATE-456';
  cap.logger.info(
    { kind: 'gmail-oauth-callback', stateResult: 'matched', path: '/oauth2/callback' },
    'callback',
  );
  const out = cap.output();
  assert.ok(!out.includes(secretCode), '日志不含授权 code');
  assert.ok(!out.includes(secretState), '日志不含 state');
  assert.ok(!out.includes('?code='), '日志不含完整回调 query');
  assert.ok(out.includes('/oauth2/callback'), '只含 path');
  assert.ok(out.includes('matched'), '含 stateResult');
});

// ——————————————————————————————————————————————————————————
// 14. toRawEmail / htmlToText 单元
// ——————————————————————————————————————————————————————————

test('toRawEmail：白名单 header 映射、From 解析、threadId/snippet', () => {
  const msg: GmailMessage = {
    id: 'x1',
    threadId: 'th1',
    snippet: 'snip',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: '客服 <svc@bank.com>' },
        { name: 'Subject', value: 'hi' },
        { name: 'List-Unsubscribe', value: '<mailto:u@x>' },
        { name: 'X-Random', value: 'should-not-map' },
      ],
      body: { data: b64url('body') },
    },
  };
  const raw = toRawEmail(msg, ACCOUNT_ID);
  assert.equal(raw.providerMessageId, 'x1');
  assert.equal(raw.providerThreadId, 'th1');
  assert.equal(raw.snippet, 'snip');
  assert.equal(raw.fromEmail, 'svc@bank.com');
  assert.equal(raw.fromName, '客服');
  assert.equal(raw.textBody, 'body');
  const headers = raw.headers as Record<string, string>;
  assert.equal(headers['list-unsubscribe'], '<mailto:u@x>');
  assert.equal(headers['x-random'], undefined, '非白名单 header 不映射');
  assert.equal(headers['from'], undefined, 'From 经字段不塞 headers');
});

test('htmlToText：先剔 script/style 再去标签', () => {
  const t = htmlToText('<style>a{}</style><div>Hi <a href="x">link</a></div><script>x()</script>');
  assert.ok(t.includes('Hi'));
  assert.ok(t.includes('link'));
  assert.ok(!t.includes('a{}'));
  assert.ok(!t.includes('x()'));
});

// ——————————————————————————————————————————————————————————
// 共享小工具
// ——————————————————————————————————————————————————————————

function makeEmail(id: string): import('../../normalizer/normalizeEmail.js').NormalizedEmail {
  return {
    accountId: ACCOUNT_ID,
    provider: 'gmail',
    providerMessageId: id,
    subject: '主题',
    fromEmail: 'sender@example.com',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
  };
}

function decision(priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4'): import('../../rules/finalDecision.js').FinalDecision {
  return {
    priority,
    category: 'work',
    confidence: 0.9,
    shouldNotifyNow: priority === 'P0' || priority === 'P4',
    shouldMarkRead: priority === 'P2' || priority === 'P3',
    shouldIncludeDigest: priority === 'P1' || priority === 'P2',
    reason: 'test',
    riskFlags: [],
    appliedRules: [],
  };
}

function readStatus(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    return typeof s === 'number' ? s : undefined;
  }
  return undefined;
}

// 向 loopback redirect_uri 发一次回调请求（模拟浏览器跳转）。
function fireCallback(redirectUri: string, params: { state: string; code?: string; error?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(redirectUri);
    u.searchParams.set('state', params.state);
    if (params.code !== undefined) u.searchParams.set('code', params.code);
    if (params.error !== undefined) u.searchParams.set('error', params.error);
    const req = http.get(u, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
  });
}

// 向 loopback 发一次回调并返回 HTTP 状态码（用于断言 one-shot 短路回 410）。
function fireWithStatus(
  redirectUri: string,
  params: { state: string; code?: string; error?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(redirectUri);
    u.searchParams.set('state', params.state);
    if (params.code !== undefined) u.searchParams.set('code', params.code);
    if (params.error !== undefined) u.searchParams.set('error', params.error);
    const req = http.get(u, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      res.on('end', () => resolve(status));
    });
    req.on('error', reject);
  });
}

// 向 loopback 发一次回调，state 可省略/任意（用于断言「state 不匹配的 error= 不消费 one-shot」）。
function fireRaw(redirectUri: string, params: { state?: string; code?: string; error?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const u = new URL(redirectUri);
    if (params.state !== undefined) u.searchParams.set('state', params.state);
    if (params.code !== undefined) u.searchParams.set('code', params.code);
    if (params.error !== undefined) u.searchParams.set('error', params.error);
    const req = http.get(u, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', reject);
  });
}
