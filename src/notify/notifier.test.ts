// notifier.notifyDigest 单测（组 C §3.3）：摘要出口透传文本 + 无渠道降级（node:test）。
//
// 覆盖：
//   - 假渠道注入 createNotifier({channel})：notifyDigest 把**预组装文本**原样透传给
//     channel.sendText、返回 { outcome:'sent' }（不再投影 per-email payload）。
//   - 渠道 sendText 失败 → notifyDigest 返回 failed（脱敏 error），不抛。
//   - 无渠道（且无 TELEGRAM_* 配置）→ skipped 降级。本仓 .env 带 TELEGRAM_*，故经
//     子进程清空 TELEGRAM_* 跑真实 createNotifier()→telegramChannelFromConfig()→undefined
//     路径，确定性命中 no-channel 分支（与其它测试「绝不触达真实通道」同一纪律）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { createNotifier } from './notifier.js';
import type { NotificationChannel } from './notifier.js';
import type { ChannelSendResult } from './telegram.js';

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

test('notifyDigest：无渠道（无 TELEGRAM_* 配置）→ skipped 降级', () => {
  // 本仓 .env 带 TELEGRAM_*，进程内 createNotifier() 会构出真实渠道；故在清空 TELEGRAM_*
  // 的子进程里跑真实 createNotifier()→telegramChannelFromConfig()→undefined 的 no-channel 分支，
  // 确定性命中 skipped（不依赖、也绝不触达真实 telegram）。结果以 RESULT: 前缀打印，
  // 与 pino 日志行（默认 stdout）区隔，避免脆弱的「取末行」解析。
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
    env: { ...process.env, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
    encoding: 'utf8',
  });

  const line = out.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line !== undefined, `子进程未输出 RESULT 行：${out}`);
  const result = JSON.parse(line.slice('RESULT:'.length));
  assert.deepEqual(result, { outcome: 'skipped', reason: 'no-channel' });
});
