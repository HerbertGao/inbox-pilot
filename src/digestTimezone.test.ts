// 离线验收（deploy-operability §4.4）：resolveDigestTimezone——TZ 解析 + 回退告警。
// 钉死 `'' ?? x` 与 `'' || x` 的正确性边界：空串必须回退（用 `||`，非 `??`）。
//   - 空串 TZ → Asia/Shanghai 且发 tz-fallback-default 告警；
//   - 未设置 TZ → 同上；
//   - 已设置 TZ（UTC）→ 原样采用、不告警。
// 注入假 logger 断言 warn（生产 logger 在 main.ts 接线，main.ts 不可被测试 import——故 helper 独立成模块）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveDigestTimezone } from './digestTimezone.js';

/** 假 logger：记录每次 warn 的 (obj, msg)，供断言 tz-fallback-default 告警是否发出。 */
function fakeLogger(): {
  log: { warn: (obj: object, msg: string) => void };
  warnCalls: Array<{ obj: Record<string, unknown>; msg: string }>;
} {
  const warnCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warnCalls,
    log: {
      warn(obj: object, msg: string): void {
        warnCalls.push({ obj: obj as Record<string, unknown>, msg });
      },
    },
  };
}

test('空字符串 TZ → 回退 Asia/Shanghai 且发 tz-fallback-default 告警（`||` 而非 `??`）', () => {
  const { log, warnCalls } = fakeLogger();
  const tz = resolveDigestTimezone({ TZ: '' }, log);
  assert.equal(tz, 'Asia/Shanghai');
  assert.equal(warnCalls.length, 1, '空串回退必发一次告警');
  assert.equal(warnCalls[0]!.obj.kind, 'tz-fallback-default');
});

test('未设置 TZ（undefined）→ 回退 Asia/Shanghai 且发 tz-fallback-default 告警', () => {
  const { log, warnCalls } = fakeLogger();
  const tz = resolveDigestTimezone({}, log);
  assert.equal(tz, 'Asia/Shanghai');
  assert.equal(warnCalls.length, 1, '未设置回退必发一次告警');
  assert.equal(warnCalls[0]!.obj.kind, 'tz-fallback-default');
});

test('已设置 TZ（UTC）→ 原样采用、不告警', () => {
  const { log, warnCalls } = fakeLogger();
  const tz = resolveDigestTimezone({ TZ: 'UTC' }, log);
  assert.equal(tz, 'UTC');
  assert.equal(warnCalls.length, 0, '已设置合法 TZ 不告警');
});

test('纯空白 TZ（"  "）→ 回退 Asia/Shanghai 且发 tz-fallback-default 告警（trim）', () => {
  const { log, warnCalls } = fakeLogger();
  const tz = resolveDigestTimezone({ TZ: '  ' }, log);
  assert.equal(tz, 'Asia/Shanghai');
  assert.equal(warnCalls.length, 1, '纯空白回退必发一次告警');
  assert.equal(warnCalls[0]!.obj.kind, 'tz-fallback-default');
});

test('带首尾空白的合法 TZ（" UTC "）→ trim 后原样采用、不告警', () => {
  const { log, warnCalls } = fakeLogger();
  const tz = resolveDigestTimezone({ TZ: ' UTC ' }, log);
  assert.equal(tz, 'UTC');
  assert.equal(warnCalls.length, 0, 'trim 保留合法时区、不告警');
});
