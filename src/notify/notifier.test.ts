// notifier.notifyDigest 单测（组 C §3.3）：摘要出口透传文本 + 无渠道降级（node:test）。
//
// 覆盖：
//   - 假渠道注入 createNotifier({channel})：notifyDigest 把**预组装文本**原样透传给
//     channel.sendText、返回 { outcome:'sent' }（不再投影 per-email payload）。
//   - 渠道 sendText 失败 → notifyDigest 返回 failed（脱敏 error），不抛。
//   - 无渠道（resolver 解析不出目的地）→ skipped 降级。telegramChannelFromConfig 现读
//     @herbertgao/hangar-notify resolver，故经子进程把 HANGAR_NOTIFY_CONFIG 指向不存在的文件跑真实
//     createNotifier()→telegramChannelFromConfig()→undefined 路径，确定性命中 no-channel
//     分支（与其它测试「绝不触达真实通道」同一纪律）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { createNotifier } from './notifier.js';
import type { NotificationChannel, NotificationPayload } from './notifier.js';
import type { ChannelSendResult } from './telegram.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import { normalizeEmail } from '../normalizer/normalizeEmail.js';
import { toRawEmail } from '../providers/gmail/gmailMap.js';
import { InMemoryMailRepo } from '../repo/inMemoryMailRepo.js';
import type { Classification } from '../classifier/schema.js';

/** 记录型假渠道：记下 sendText 收到的文本，便于断言透传；不触达真实 telegram。 */
function makeRecordingChannel(
  result: ChannelSendResult = { outcome: 'sent' },
): NotificationChannel & { texts: string[] } {
  const texts: string[] = [];
  const channel = {
    name: 'recording',
    texts,
    async send(): Promise<ChannelSendResult> {
      return result;
    },
    async sendText(text: string): Promise<ChannelSendResult> {
      texts.push(text);
      return result;
    },
  };
  return channel;
}

test('notifyDigest：假渠道注入 → 透传预组装文本、返回 sent', async () => {
  const channel = makeRecordingChannel({ outcome: 'sent' });
  const notifier = createNotifier({ channel });

  const text = '[每日摘要]\nP1 - 主题 - 原因';
  const result = await notifier.notifyDigest(text);

  // 文本被原样透传给 channel.sendText（不投影 payload、不渲染）。
  assert.deepEqual(channel.texts, [text]);
  // 返回 sent + 渠道名。
  assert.deepEqual(result, { outcome: 'sent', channel: 'recording' });
});

test('notifyDigest：渠道 sendText 失败 → 返回 failed（脱敏 error）、不抛', async () => {
  const channel = makeRecordingChannel({ outcome: 'failed', error: 'telegram-http-500' });
  const notifier = createNotifier({ channel });

  const result = await notifier.notifyDigest('文案');

  assert.equal(result.outcome, 'failed');
  assert.equal(result.outcome === 'failed' ? result.channel : undefined, 'recording');
  assert.equal(result.outcome === 'failed' ? result.error : undefined, 'telegram-http-500');
});

test('notifyDigest：无渠道（resolver 无 inbox 目的地）→ skipped 降级', () => {
  // telegramChannelFromConfig 现读 @herbertgao/hangar-notify resolver；进程内可能存在约定默认
  // channels.yaml，故在子进程里把 HANGAR_NOTIFY_CONFIG 指向不存在的文件（config-missing →
  // resolve 返回 undefined），确定性命中真实 createNotifier()→telegramChannelFromConfig()→
  // undefined 的 no-channel 分支 → skipped（不依赖、也绝不触达真实 telegram）。结果以 RESULT:
  // 前缀打印，与 pino 日志行（默认 stdout）区隔，避免脆弱的「取末行」解析。
  const notifierHref = new URL('./notifier.js', import.meta.url).href;
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const script = `
    import(${JSON.stringify(notifierHref)}).then(async ({ createNotifier }) => {
      const r = await createNotifier().notifyDigest('文案');
      process.stdout.write('RESULT:' + JSON.stringify(r) + '\\n');
    });
  `;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, HANGAR_NOTIFY_CONFIG: '/nonexistent/channels.yaml' },
    encoding: 'utf8',
  });

  const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line !== undefined, `子进程未输出 RESULT 行：${out}`);
  const result = JSON.parse(line.slice('RESULT:'.length));
  assert.deepEqual(result, { outcome: 'skipped', reason: 'no-channel' });
});

// ——————————————————————————————————————————————————————————
// notification-mailbox-clarity 5.4：projectPayload 投影 + poller 填 accountLabel +
// retry/drain rebuild accountLabel==label + notify 日志字段（不含 label/accountLabel）
// ——————————————————————————————————————————————————————————

/** 捕获 send 收到的 payload 的假渠道（不触达真实 telegram）；驱动 projectPayload 真实入口。 */
function makePayloadCapturingChannel(
  result: ChannelSendResult = { outcome: 'sent' },
): NotificationChannel & { payloads: NotificationPayload[] } {
  const payloads: NotificationPayload[] = [];
  return {
    name: 'capturing',
    payloads,
    async send(payload: NotificationPayload): Promise<ChannelSendResult> {
      payloads.push(payload);
      return result;
    },
    async sendText(): Promise<ChannelSendResult> {
      return result;
    },
  };
}

function makeDecision(overrides: Partial<FinalDecision> = {}): FinalDecision {
  return {
    priority: 'P0',
    category: 'work',
    confidence: 0.9,
    shouldNotifyNow: true,
    shouldMarkRead: false,
    shouldIncludeDigest: false,
    reason: '裁定原因',
    riskFlags: [],
    appliedRules: [],
    ...overrides,
  };
}

test('projectPayload：notify 经真实入口投影 payload 含 accountId/accountLabel、不含正文（textBody/htmlBody）', async () => {
  const channel = makePayloadCapturingChannel({ outcome: 'sent' });
  const notifier = createNotifier({ channel });

  const email: NormalizedEmail = {
    accountId: 'gmail:me@example.com',
    accountLabel: '公司邮箱',
    provider: 'gmail',
    providerMessageId: 'm1',
    subject: '主题',
    fromEmail: 'a@b.com',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    textBody: '机密正文，不应进 payload',
    htmlBody: '<p>机密正文</p>',
    hasAttachments: false,
    headers: {},
  };

  const result = await notifier.notify(makeDecision(), email);
  assert.deepEqual(result, { outcome: 'sent', channel: 'capturing' });

  assert.equal(channel.payloads.length, 1, 'notify 投影一次 payload');
  const payload = channel.payloads[0]!;
  // accountId / accountLabel 被投影进 payload。
  assert.equal(payload.accountId, 'gmail:me@example.com', 'payload 含 accountId');
  assert.equal(payload.accountLabel, '公司邮箱', 'payload 含 accountLabel');
  // payload 结构层杜绝正文：键不存在、值不出现。
  assert.ok(!('textBody' in payload), 'payload 无 textBody 键');
  assert.ok(!('htmlBody' in payload), 'payload 无 htmlBody 键');
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('机密正文'), 'payload 不含正文内容');
});

test('poller 填 accountLabel：gmail toRawEmail(message, accountId, accountLabel) → normalize → notify 投影该 accountLabel', async () => {
  // 驱动真实 poller 入口（toRawEmail）填 accountLabel，经 normalizeEmail 收敛，再经 notify 投影。
  const raw = toRawEmail(
    {
      id: 'g1',
      payload: {
        headers: [
          { name: 'Subject', value: '主题' },
          { name: 'From', value: '发件人 <a@b.com>' },
        ],
      },
    },
    'gmail:me@example.com',
    '公司邮箱', // accountLabel = label??email（穿透链由 main.ts 接线填）
  );
  const email = normalizeEmail(raw);
  assert.equal(email.accountLabel, '公司邮箱', 'normalize 透传 poller 填入的 accountLabel');

  const channel = makePayloadCapturingChannel();
  const notifier = createNotifier({ channel });
  await notifier.notify(makeDecision(), email);
  assert.equal(channel.payloads[0]!.accountLabel, '公司邮箱', 'poller→normalize→notify 链路保住 accountLabel');
});

// (migration §1.2) durable retry/drain（selectDueRetries/rebuildNormalizedEmail）已剥离，其
//  accountLabel-rebuild 用例随之删除；re-poll 复用分类的 accountLabel 保真由 §2 self-check 覆盖。

test('notify 日志字段：失败日志仅 {kind,priority,channel,error}、不含 label/accountLabel（子进程捕获 pino 行）', () => {
  // pino 同步写 fd 1（非 process.stdout.write），故在子进程跑 notify 失败路径、捕获其 stdout 的
  // notify-failed JSON 行，断言 payload 字段集合 + 不含 label/accountLabel/正文（守「label 不进结构化日志」）。
  const notifierHref = new URL('./notifier.js', import.meta.url).href;
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const script = `
    import(${JSON.stringify(notifierHref)}).then(async ({ createNotifier }) => {
      const channel = {
        name: 'failing',
        async send() { return { outcome: 'failed', error: 'telegram-http-500' }; },
        async sendText() { return { outcome: 'failed', error: 'telegram-http-500' }; },
      };
      const notifier = createNotifier({ channel });
      const decision = { priority: 'P0', category: 'work', confidence: 0.9, shouldNotifyNow: true, shouldMarkRead: false, shouldIncludeDigest: false, reason: 'r', riskFlags: [], appliedRules: [] };
      const email = { accountId: 'gmail:me@example.com', accountLabel: '公司邮箱', provider: 'gmail', providerMessageId: 'm1', subject: 's', fromEmail: 'a@b.com', to: [], date: new Date().toISOString(), hasAttachments: false, headers: {}, textBody: 'BODY', htmlBody: '<p>BODY</p>' };
      await notifier.notify(decision, email);
    });
  `;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: repoRoot,
    env: { ...process.env, TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'y' },
    encoding: 'utf8',
  });

  const logLine = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.includes('"kind":"notify-failed"'));
  assert.ok(logLine !== undefined, `子进程未输出 notify-failed 日志行：${out}`);
  const record = JSON.parse(logLine) as Record<string, unknown>;
  // 业务字段（剔除 pino 信封 level/time/pid/hostname/msg）= {kind,priority,channel,error}。
  const { level: _l, time: _t, pid: _p, hostname: _h, msg: _m, ...biz } = record;
  assert.deepEqual(
    Object.keys(biz).sort(),
    ['channel', 'error', 'kind', 'priority'],
    'notify 失败日志业务字段恰为 {kind,priority,channel,error}',
  );
  assert.equal(biz.kind, 'notify-failed');
  assert.equal(biz.priority, 'P0');
  assert.equal(biz.channel, 'failing');
  assert.equal(biz.error, 'telegram-http-500');
  // 守「label 不进结构化日志」+ 正文不入日志。
  assert.ok(!('label' in record), '日志不含 label 字段');
  assert.ok(!('accountLabel' in record), '日志不含 accountLabel 字段');
  assert.ok(!out.includes('公司邮箱'), '日志整体不含 label 值');
  assert.ok(!out.includes('BODY'), '日志整体不含正文');
});
