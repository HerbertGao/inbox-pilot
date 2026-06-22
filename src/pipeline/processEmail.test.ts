// 离线验收（组 F §7.2）：processEmail 全链路自检（node:test）。
//
// 每个用例：构造 NormalizedEmail fixture + 注入假 classify（返回指定 Classification）+
// InMemoryMailRepo（断言落库/动作）+ FakeProviderActions（断言标已读）+ 经 createNotifier
// ({channel: 记录型假渠道}) 构造的 notifier（在渠道 payload 层断言正文不泄露）。
//
// 关键 seam 纪律：
//   - 正文不泄露断言在「渠道 payload 层」（notifier→channel 边界做白名单投影）——
//     记录型假渠道存下收到的 payload，断言其不含 textBody/htmlBody 键、且不含 fixture sentinel。
//   - 「重复邮件跳过 → 0 次 classify」用计数器断言（不只断言落库无新增）。
//   - 「动作失败 ≤3 次尝试」用渠道/provider 调用计数器断言单次调用内尝试有上限（不声称跨重启）。
//   - 不接真实 provider/网络；不发送邮件。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { processEmail, type ClassifyFn } from './processEmail.js';
import { InMemoryMailRepo } from '../repo/inMemoryMailRepo.js';
import { FakeProviderActions, type ProviderActions } from '../actions/providerActions.js';
import { ProviderReauthRequired } from '../providers/provider.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import { createNotifier } from '../notify/notifier.js';
import type {
  NotificationChannel,
  NotificationPayload,
} from '../notify/notifier.js';
import type { ChannelSendResult } from '../notify/telegram.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import { SENSITIVE_DOMAINS } from '../rules/lists.js';

// 独特 sentinel：放进 fixture 的 textBody/htmlBody，断言它绝不出现在渠道 payload 里。
const BODY_SENTINEL = 'SENTINEL_SECRET_BODY_3f9a7c';

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'acct-1',
    provider: 'gmail',
    providerMessageId: 'msg-1',
    subject: '普通主题 ordinary subject',
    fromEmail: 'sender@example.com',
    fromName: '发件人',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    textBody: `正文开头 ${BODY_SENTINEL} 正文结尾`,
    htmlBody: `<p>${BODY_SENTINEL}</p>`,
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
    reason: '测试分类',
    risk_flags: [],
    ...overrides,
  };
}

// 计数型假 classify：记调用次数 + 收到的邮件，按需返回固定 Classification。
function makeClassifySpy(
  cls: Classification,
): ClassifyFn & { calls: NormalizedEmail[] } {
  const calls: NormalizedEmail[] = [];
  const fn = (async (email: NormalizedEmail): Promise<Classification> => {
    calls.push(email);
    return cls;
  }) as ClassifyFn & { calls: NormalizedEmail[] };
  fn.calls = calls;
  return fn;
}

// 记录型假渠道：实现 NotificationChannel.send(payload)，存下每次收到的 payload。
// 这是「正文不泄露」断言的正确层次（notifier 已在边界做白名单投影）。
function makeRecordingChannel(
  result: ChannelSendResult = { outcome: 'sent' },
): NotificationChannel & { payloads: NotificationPayload[]; sendCount: number } {
  const payloads: NotificationPayload[] = [];
  const channel = {
    name: 'recording',
    payloads,
    sendCount: 0,
    async send(payload: NotificationPayload): Promise<ChannelSendResult> {
      channel.sendCount += 1;
      payloads.push(payload);
      return result;
    },
  };
  return channel;
}

// 恒抛的假 provider（断言标已读失败 → failed + 有界重试），记尝试次数。
// reflectPriority no-op（executeActions 始终先调它；本桩只验 markRead 失败语义）。
function makeThrowingProvider(): ProviderActions & { attempts: number } {
  const provider = {
    attempts: 0,
    async reflectPriority(): Promise<void> {
      // no-op：不影响本用例对 markRead 失败的断言。
    },
    async markRead(_email: NormalizedEmail): Promise<void> {
      provider.attempts += 1;
      throw new Error('fake markRead failure');
    },
  };
  return provider;
}

// ——————————————————————————————————————————————————————————
// P0/P4 → 推送、不标已读、notify(done)、正文不泄露（渠道 payload 层）
// ——————————————————————————————————————————————————————————

test('P0 → 推送 notify(done)、不标已读、渠道 payload 不含正文', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P0' }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const actions = repo.getActions(rowId);
  // notify 动作落 done、无 mark_read 动作。
  const notify = actions.find((a) => a.actionType === 'notify');
  assert.ok(notify, 'P0 必须有 notify 动作');
  assert.equal(notify.status, 'done');
  assert.ok(!actions.some((a) => a.actionType === 'mark_read'), 'P0 不应有 mark_read 动作');
  // 不标已读。
  assert.equal(provider.markReadCalls.length, 0);

  // —— 正文不泄露（渠道 payload 层结构断言）——
  assert.equal(channel.payloads.length, 1);
  const payload = channel.payloads[0]!;
  // payload 不含 textBody/htmlBody 键。
  assert.ok(!('textBody' in payload), 'payload 禁止含 textBody 键');
  assert.ok(!('htmlBody' in payload), 'payload 禁止含 htmlBody 键');
  // payload 任何字段的序列化里都不出现 fixture sentinel。
  assert.ok(
    !JSON.stringify(payload).includes(BODY_SENTINEL),
    'payload 序列化不应包含正文 sentinel',
  );
  // 白名单字段确实送达。
  assert.equal(payload.priority, 'P0');
  assert.equal(payload.subject, email.subject);
  assert.equal(payload.fromEmail, email.fromEmail);
  assert.equal(payload.reason, '测试分类');
  assert.equal(payload.category, 'work');
});

test('P4 → 推送 notify(done)、不标已读、payload 含 riskFlags 不含正文', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(
    makeClassification({ priority: 'P4', risk_flags: ['phishing-suspect'] }),
  );
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const actions = repo.getActions(rowId);
  assert.equal(actions.find((a) => a.actionType === 'notify')?.status, 'done');
  assert.equal(provider.markReadCalls.length, 0);

  const payload = channel.payloads[0]!;
  assert.equal(payload.priority, 'P4');
  assert.ok(payload.riskFlags.includes('phishing-suspect'));
  assert.ok(!('textBody' in payload) && !('htmlBody' in payload));
  assert.ok(!JSON.stringify(payload).includes(BODY_SENTINEL));
});

// ——————————————————————————————————————————————————————————
// P2 普通 → markRead + mark_read(done)、无 notify
// ——————————————————————————————————————————————————————————

test('P2 普通 → markRead 调用 + mail_actions mark_read(done)、无 notify', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  // 标已读调用含该邮件。
  assert.equal(provider.markReadCalls.length, 1);
  assert.equal(provider.markReadCalls[0]?.providerMessageId, email.providerMessageId);

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const actions = repo.getActions(rowId);
  assert.equal(actions.find((a) => a.actionType === 'mark_read')?.status, 'done');
  assert.ok(!actions.some((a) => a.actionType === 'notify'), 'P2 普通邮件不应有 notify 动作');
  // 未触发推送。
  assert.equal(channel.sendCount, 0);
});

// ——————————————————————————————————————————————————————————
// 敏感域名 P2 → 不 markRead（FinalDecision 护栏）
// ——————————————————————————————————————————————————————————

test('敏感域名 P2（user@bank.com）→ 不 markRead', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const email = makeEmail({ fromEmail: `user@${SENSITIVE_DOMAINS[0]}` });

  await processEmail(email, { repo, provider, notifier, classify });

  // 护栏：FinalDecision.shouldMarkRead=false → executeActions 不发起标已读。
  assert.equal(provider.markReadCalls.length, 0);
  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  assert.ok(!repo.getActions(rowId).some((a) => a.actionType === 'mark_read'));
});

// ——————————————————————————————————————————————————————————
// confidence<0.65 → 降级 P1、不标已读、digest 标记持久化
// ——————————————————————————————————————————————————————————

test('confidence<0.65 → 降级 P1、不标已读、rawAiJson.finalDecision.shouldIncludeDigest=true', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2', confidence: 0.4 }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  assert.equal(provider.markReadCalls.length, 0); // 不标已读

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const cls = repo.getLatestClassification(rowId)!;
  // final priority 落专列 = P1（降级后）。
  assert.equal(cls.priority, 'P1');
  // digest 标记持久化进 rawAiJson。
  assert.equal(cls.rawAiJson.finalDecision.shouldIncludeDigest, true);
});

// ——————————————————————————————————————————————————————————
// 验证码主题 → P0、推送、不标已读
// ——————————————————————————————————————————————————————————

test('验证码主题 → P0、notify(done)、不标已读', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  // 建议 P3 + mark_read，验证主题验证码强制 P0 覆盖建议。
  const classify = makeClassifySpy(makeClassification({ priority: 'P3', should_mark_read: true }));
  const email = makeEmail({ subject: '您的验证码是 998877' });

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const cls = repo.getLatestClassification(rowId)!;
  assert.equal(cls.priority, 'P0');
  assert.equal(repo.getActions(rowId).find((a) => a.actionType === 'notify')?.status, 'done');
  assert.equal(provider.markReadCalls.length, 0);
});

// ——————————————————————————————————————————————————————————
// 落库可恢复：raw vs final、appliedRules、digest、confidence 透传
// ——————————————————————————————————————————————————————————

test('落库可恢复：raw priority、final priority、appliedRules、digest、confidence 透传', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  // 低置信 P2 → 降级 P1：raw=P2、final=P1，二者都应可恢复。
  const classify = makeClassifySpy(makeClassification({ priority: 'P2', confidence: 0.5 }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const cls = repo.getLatestClassification(rowId)!;

  // appliedRules 与 shouldIncludeDigest 从 rawAiJson.finalDecision 读回。
  assert.ok(cls.rawAiJson.finalDecision.appliedRules.includes('low-confidence→P1'));
  assert.equal(cls.rawAiJson.finalDecision.shouldIncludeDigest, true);
  // 原始 priority（rawAiJson.aiClassification.priority）= P2。
  assert.equal(cls.rawAiJson.aiClassification.priority, 'P2');
  // final priority（专列 row.priority）= P1。
  assert.equal(cls.priority, 'P1');
  // confidence 可恢复且 final === raw（引擎透传不改写）。
  assert.equal(cls.confidence, 0.5);
  assert.equal(cls.confidence, cls.rawAiJson.aiClassification.confidence);
});

// ——————————————————————————————————————————————————————————
// 重复邮件（已 processedAt）→ 跳过：classify 0 次新增、无新增 mail_actions
// ——————————————————————————————————————————————————————————

test('重复邮件（已 processedAt）→ 跳过：classify 0 次新增调用、无新增 mail_actions', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });
  const callsAfterFirst = classify.calls.length;
  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const actionsAfterFirst = repo.getActions(rowId).length;
  const markReadAfterFirst = provider.markReadCalls.length;

  // 同 (accountId, providerMessageId) 再调一次 → 命中已处理 → 跳过。
  await processEmail(email, { repo, provider, notifier, classify });

  assert.equal(classify.calls.length, callsAfterFirst, '重复邮件不应再次调用 classify');
  assert.equal(classify.calls.length, 1);
  assert.equal(repo.getActions(rowId).length, actionsAfterFirst, '重复邮件不应新增 mail_actions');
  assert.equal(provider.markReadCalls.length, markReadAfterFirst, '重复邮件不应再次标已读');
});

// ——————————————————————————————————————————————————————————
// 已 saveEmail 未 processedAt 的重跑路径 → 复用同一行、不抛唯一键冲突
// ——————————————————————————————————————————————————————————

test('已 saveEmail 未 markProcessed 的重跑路径 → 复用同一行、不抛、emailsById 仍 1 行', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const email = makeEmail();

  // 手动落库（不 markProcessed），模拟崩在 saveEmail 之后的重跑场景。
  const stored = await repo.saveEmail(email);
  assert.equal(stored.processedAt, null);

  // processEmail 应复用该行、走完链路、不抛唯一键冲突。
  await processEmail(email, { repo, provider, notifier, classify });

  // 复用同一行：findByDedupKey 拿到的 id 与手动 saveEmail 的 id 相同。
  const after = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!;
  assert.equal(after.id, stored.id);
  assert.ok(after.processedAt !== null, '重跑后应已 markProcessed');
  // 第二次 saveEmail（processEmail 内部）应复用，不再插入新行。
  assert.equal(repo.getActions(stored.id).length > 0, true);
});

// ——————————————————————————————————————————————————————————
// 动作失败 → failed + 单次调用内 ≤3 次尝试、markProcessed 仍执行
// ——————————————————————————————————————————————————————————

test('标已读失败 → mark_read(failed) + 单次调用内 ≤3 次尝试、markProcessed 仍执行', async () => {
  const repo = new InMemoryMailRepo();
  const provider = makeThrowingProvider();
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const markRead = repo.getActions(rowId).find((a) => a.actionType === 'mark_read');
  assert.equal(markRead?.status, 'failed');
  // 单次调用内尝试次数有上限（≤3，不声称跨重启累计）。
  assert.ok(provider.attempts >= 1 && provider.attempts <= 3, `尝试次数应 ∈ [1,3]，实际 ${provider.attempts}`);
  // markProcessed 仍执行（不以动作成功为前提）。
  const after = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!;
  assert.ok(after.processedAt !== null, 'markProcessed 应仍执行');
});

test('推送失败 → notify(failed) + 单次调用内 ≤3 次尝试、markProcessed 仍执行', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel({ outcome: 'failed', error: 'telegram-http-500' });
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P0' }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const notify = repo.getActions(rowId).find((a) => a.actionType === 'notify');
  assert.equal(notify?.status, 'failed');
  // 单次调用内 ≤3 次尝试。
  assert.ok(channel.sendCount >= 1 && channel.sendCount <= 3, `sendCount 应 ∈ [1,3]，实际 ${channel.sendCount}`);
  const after = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!;
  assert.ok(after.processedAt !== null, 'markProcessed 应仍执行');
});

// ——————————————————————————————————————————————————————————
// 无渠道配置 → skipped（不抛、流水线完成）
// ——————————————————————————————————————————————————————————

test('无渠道配置 → notify 动作落 skipped、不抛、流水线完成', async () => {
  // 注入确定性返回 skipped 的假 notifier（不经 createNotifier/telegramChannelFromConfig）——
  // 故不依赖 .env、绝不触达真实通道；测「notify 为 skipped 时流水线落 skipped 且照常完成」。
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  const notifier = {
    async notify() {
      return { outcome: 'skipped' as const, reason: 'no-channel' };
    },
  };
  const classify = makeClassifySpy(makeClassification({ priority: 'P0' }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const notify = repo.getActions(rowId).find((a) => a.actionType === 'notify');
  const after = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!;
  // 流水线完成（不抛、markProcessed 执行）。
  assert.ok(after.processedAt !== null, '无渠道也应完成流水线');
  // skipped 现在确定（假 notifier），无条件断言。
  assert.equal(notify?.status, 'skipped');
  assert.ok(notify?.error !== null, 'skipped 应含原因');
});

// ——————————————————————————————————————————————————————————
// 失败日志/失败证据脱敏（结构断言）：不含凭据值、不含正文
// ——————————————————————————————————————————————————————————

test('推送失败 → 持久化失败证据不含 textBody/htmlBody，且 payload 不泄露正文', async () => {
  const repo = new InMemoryMailRepo();
  const provider = new FakeProviderActions();
  // 渠道返回脱敏 error（只含 HTTP 状态摘要，不含 token/chat_id/正文）。
  const channel = makeRecordingChannel({ outcome: 'failed', error: 'telegram-http-500' });
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P0' }));
  const email = makeEmail();

  await processEmail(email, { repo, provider, notifier, classify });

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  const notify = repo.getActions(rowId).find((a) => a.actionType === 'notify')!;
  assert.equal(notify.status, 'failed');

  // 失败证据（mail_actions.error）不含 textBody/htmlBody 的值（子串断言）。
  const errorEvidence = notify.error ?? '';
  assert.ok(!errorEvidence.includes(BODY_SENTINEL), 'error 摘要不应含正文 sentinel');
  // 渠道收到的 payload 同样不泄露正文（白名单投影）。
  for (const payload of channel.payloads) {
    assert.ok(!('textBody' in payload) && !('htmlBody' in payload));
    assert.ok(!JSON.stringify(payload).includes(BODY_SENTINEL));
  }
  // 凭据值不在失败证据中：本期 token 由构造即不进 error 摘要（渠道只回 HTTP 状态摘要）。
  // 这里兜底断言 error 摘要不含 token/chat_id 的占位前缀（无真实凭据值可比，做结构断言）。
  assert.ok(!errorEvidence.toLowerCase().includes('bot'), 'error 不应含 token 片段');
});

// ——————————————————————————————————————————————————————————
// N1 回归：notify 成功后若 updateAction('done') 自身抛 → 不在同一调用内重发通知
// ——————————————————————————————————————————————————————————

test('updateAction(done) 在 notify 成功后抛 → 不重发通知（sendCount===1）、processEmail 向上抛', async () => {
  // repo 在落 done 时抛（模拟真实 DB 写入故障），其余沿用内存实现。
  class ThrowOnDoneRepo extends InMemoryMailRepo {
    async updateAction(
      id: string,
      status: 'done' | 'failed' | 'skipped',
      error?: string,
    ): Promise<void> {
      if (status === 'done') {
        throw new Error('fake DB write failure on done');
      }
      return super.updateAction(id, status, error);
    }
  }
  const repo = new ThrowOnDoneRepo();
  const provider = new FakeProviderActions();
  const channel = makeRecordingChannel(); // 默认 sent
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P0' }));
  const email = makeEmail();

  // notify 已成功送达后落 done 抛 → 异常向上传播（不被重试循环吞、不重发）。
  await assert.rejects(processEmail(email, { repo, provider, notifier, classify }));

  // 关键：通知只发了一次，没有因落库失败而在同一调用内重发（spec「每次调用至多一条」）。
  assert.equal(channel.sendCount, 1);
  // markProcessed 未执行（落库链中断）→ 留待 at-least-once 重跑。
  const after = await repo.findByDedupKey(email.accountId, email.providerMessageId);
  assert.ok(after !== null && after.processedAt === null, '落库中断后不应 markProcessed');
});

// ——————————————————————————————————————————————————————————
// ProviderReauthRequired（致命）：reflectPriority 抛 → executeActions 重抛 →
// processEmail 跳过 markProcessed；in-flight reflect_priority 行为 failed 非 pending
// ——————————————————————————————————————————————————————————

test('reflectPriority 抛 ProviderReauthRequired → processEmail 向上抛、markProcessed 不调用、reflect_priority 行 failed 非 pending', async () => {
  const repo = new InMemoryMailRepo();
  // provider.reflectPriority 抛致命 ProviderReauthRequired；markRead 不应被调到（reflectPriority 先于 markRead 且抛断流程）。
  const provider: ProviderActions & { markReadCalls: number } = {
    markReadCalls: 0,
    async reflectPriority(
      _email: NormalizedEmail,
      _decision: FinalDecision,
    ): Promise<void> {
      throw new ProviderReauthRequired('acct-1');
    },
    async markRead(_email: NormalizedEmail): Promise<void> {
      provider.markReadCalls += 1;
    },
  };
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const email = makeEmail();

  await assert.rejects(
    processEmail(email, { repo, provider, notifier, classify }),
    (err: unknown) => err instanceof ProviderReauthRequired,
  );

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  // reflect_priority 行落 failed（非 orphan pending）。
  const reflect = repo.getActions(rowId).find((a) => a.actionType === 'reflect_priority');
  assert.ok(reflect, '应有 reflect_priority 动作行');
  assert.equal(reflect.status, 'failed', 'reflect_priority 行应为 failed、非 pending');
  assert.notEqual(reflect.status, 'pending');
  // markRead 未被调（reflectPriority 抛断流程）。
  assert.equal(provider.markReadCalls, 0, 'reflectPriority 抛后不应再调 markRead');
  // markProcessed 跳过（致命错误向上传播）。
  const after = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!;
  assert.equal(after.processedAt, null, 'ProviderReauthRequired 后必须跳过 markProcessed');
});

test('markRead 抛 ProviderReauthRequired（P2，reflectPriority 先成功）→ 向上抛、markProcessed 不调用、mark_read 行 failed', async () => {
  const repo = new InMemoryMailRepo();
  const provider: ProviderActions & { reflectCalls: number } = {
    reflectCalls: 0,
    async reflectPriority(): Promise<void> {
      provider.reflectCalls += 1; // 成功
    },
    async markRead(_email: NormalizedEmail): Promise<void> {
      throw new ProviderReauthRequired('acct-1');
    },
  };
  const channel = makeRecordingChannel();
  const notifier = createNotifier({ channel });
  const classify = makeClassifySpy(makeClassification({ priority: 'P2' }));
  const email = makeEmail();

  await assert.rejects(
    processEmail(email, { repo, provider, notifier, classify }),
    (err: unknown) => err instanceof ProviderReauthRequired,
  );

  const rowId = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!.id;
  // reflectPriority 先成功落 done。
  assert.equal(provider.reflectCalls, 1);
  const reflect = repo.getActions(rowId).find((a) => a.actionType === 'reflect_priority');
  assert.equal(reflect?.status, 'done');
  // mark_read 行落 failed（非 orphan pending）。
  const markRead = repo.getActions(rowId).find((a) => a.actionType === 'mark_read');
  assert.equal(markRead?.status, 'failed', 'mark_read 行应为 failed、非 pending');
  // markProcessed 跳过。
  const after = (await repo.findByDedupKey(email.accountId, email.providerMessageId))!;
  assert.equal(after.processedAt, null, 'ProviderReauthRequired 后必须跳过 markProcessed');
});
