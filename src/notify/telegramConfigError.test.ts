// telegramChannelFromConfig ERROR 分支单测：resolver 返回 present-but-invalid
// （token-shape-invalid, severity==='error'）时，记一条 notify-config-invalid 结构化日志
// （只带 reason+varName、绝不带 token 值）并降级返回 undefined。
//
// 用与 notifier.test.ts no-channel 测试相同的子进程模式：写一个临时 channels.yaml，把
// HANGAR_NOTIFY_CONFIG 指向它、并把占位变量 TG_BOT_TEST_XYZ 设为一个 set-but-invalid 的值，
// 在子进程里跑真实 telegramChannelFromConfig()（pino 默认写 fd 1），捕获全部 stdout。
// 载荷断言（b）——输出绝不含 token 值——是本测试的承重安全断言。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('telegramChannelFromConfig：present-but-invalid（token-shape-invalid）→ 记 notify-config-invalid 且不含 token 值、返回 undefined', () => {
  const telegramHref = new URL('./telegram.js', import.meta.url).href;
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  // 唯一临时路径（避免 resolver 按路径 memoize 时命中他测的缓存）。
  const cfgPath = join(tmpdir(), `hangar-notify-cfg-${process.pid}-${Date.now()}.yaml`);
  // 单引号拼接：`${TG_BOT_TEST_XYZ}` 必须原样落盘、不被 JS 模板插值。
  const yaml = [
    'apps:',
    '  inbox:',
    '    private:',
    '      bot: "${TG_BOT_TEST_XYZ}"',
    '      chat: "999"',
    '',
  ].join('\n');

  try {
    writeFileSync(cfgPath, yaml, 'utf8');
    const script = `
      import(${JSON.stringify(telegramHref)}).then(({ telegramChannelFromConfig }) => {
        const channel = telegramChannelFromConfig();
        process.stdout.write('RESULT:' + JSON.stringify({ channel: channel === undefined ? 'undefined' : 'defined' }) + '\\n');
      });
    `;
    const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: repoRoot,
      env: { ...process.env, HANGAR_NOTIFY_CONFIG: cfgPath, TG_BOT_TEST_XYZ: 'not-a-valid-token' },
      encoding: 'utf8',
    });

    // (a) pino ERROR 行：kind/reason/varName 恰为预期（只带稳定 reason + env 变量名）。
    const logLine = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.includes('"kind":"notify-config-invalid"'));
    assert.ok(logLine !== undefined, `子进程未输出 notify-config-invalid 日志行：${out}`);
    const record = JSON.parse(logLine) as Record<string, unknown>;
    assert.equal(record.kind, 'notify-config-invalid');
    assert.equal(record.reason, 'token-shape-invalid');
    assert.equal(record.varName, 'TG_BOT_TEST_XYZ');

    // (b) 承重安全断言：token 值绝不出现在任何 stdout（含 pino 行）。
    assert.ok(!out.includes('not-a-valid-token'), '日志整体绝不含 token 值');

    // (c) 降级：telegramChannelFromConfig() 返回 undefined。
    const resultLine = out.split('\n').find((l) => l.startsWith('RESULT:'));
    assert.ok(resultLine !== undefined, `子进程未输出 RESULT 行：${out}`);
    const result = JSON.parse(resultLine.slice('RESULT:'.length)) as { channel: string };
    assert.equal(result.channel, 'undefined', 'telegramChannelFromConfig 降级返回 undefined');
  } finally {
    try {
      unlinkSync(cfgPath);
    } catch {
      // 临时文件可能未创建/已删——忽略清理错误。
    }
  }
});
