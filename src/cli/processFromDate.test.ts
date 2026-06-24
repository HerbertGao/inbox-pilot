// parseProcessFromDate 直接单测（onboarding-watermark 6.7）——共享 `--process-from` /
// `set-process-from` 日期 parse+validate helper。注入固定 `now` 使确定性。
//
// 覆盖：
//   - 合法 `YYYY-MM-DD` → UTC 零点 Date；
//   - 解析失败（越界月日、JS 进位归一的非真日期、非零填充、带时间分量、空串）→ kind:'invalid'；
//   - 严格未来（parsedUtcMidnight > now）→ kind:'future'；
//   - **今天**（UTC 零点 ≤ now）放行——含「东于 UTC 时区今天」（now 取当天 UTC 早晨）不被 date-to-date 误拒。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseProcessFromDate } from './processFromDate.js';

// 固定基准 now：2026-06-24T12:00:00Z（当天正午）。除非用例另指定，皆以此判未来/今天。
const NOW = new Date('2026-06-24T12:00:00.000Z');

// ——————————————————————————————————————————————————————————
// 合法：解析为 UTC 零点 Date
// ——————————————————————————————————————————————————————————

test('合法 2026-01-15 → ok、Date 为该日 UTC 零点（00:00:00.000Z）', () => {
  const r = parseProcessFromDate('2026-01-15', NOW);
  assert.equal(r.ok, true);
  assert.ok(r.ok); // narrow
  // UTC 零点：时分秒毫秒全 0、UTC 字段与原串逐字段一致。
  assert.equal(r.date.getTime(), Date.UTC(2026, 0, 15));
  assert.equal(r.date.toISOString(), '2026-01-15T00:00:00.000Z');
  assert.equal(r.date.getUTCHours(), 0);
  assert.equal(r.date.getUTCMinutes(), 0);
  assert.equal(r.date.getUTCSeconds(), 0);
  assert.equal(r.date.getUTCMilliseconds(), 0);
});

test('合法过去日期（远早于 now）→ ok', () => {
  const r = parseProcessFromDate('2020-12-31', NOW);
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.equal(r.date.toISOString(), '2020-12-31T00:00:00.000Z');
});

// ——————————————————————————————————————————————————————————
// 解析失败 → kind:'invalid'（调用方映射 EXIT_USAGE / 退出码 2）
// ——————————————————————————————————————————————————————————

const INVALID: ReadonlyArray<[string, string]> = [
  ['越界月日（2026-13-99）', '2026-13-99'],
  ['JS 进位归一的非真日期（2026-02-30）', '2026-02-30'],
  ['2 月 29 非闰年（2026-02-29）', '2026-02-29'],
  ['非零填充（2026-1-5）', '2026-1-5'],
  ['带时间分量（2026-01-15T14:00）', '2026-01-15T14:00'],
  ['带时间分量（2026-01-15T00:00:00Z）', '2026-01-15T00:00:00Z'],
  ['空串', ''],
  ['仅空白', '   '],
  ['月 00（2026-00-10）', '2026-00-10'],
  ['日 00（2026-06-00）', '2026-06-00'],
  ['月 13（2026-13-01）', '2026-13-01'],
  ['日 32（2026-06-32）', '2026-06-32'],
  ['斜杠分隔（2026/06/24）', '2026/06/24'],
  ['前后空白（ 2026-06-24 ）', ' 2026-06-24 '],
  ['非数字（abcd-ef-gh）', 'abcd-ef-gh'],
];

for (const [label, s] of INVALID) {
  test(`解析失败 → invalid：${label}`, () => {
    const r = parseProcessFromDate(s, NOW);
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.kind, 'invalid', `应判 invalid: ${JSON.stringify(s)}`);
  });
}

// ——————————————————————————————————————————————————————————
// 严格未来 → kind:'future'
// ——————————————————————————————————————————————————————————

test('严格未来（次日，parsedUtcMidnight > now）→ future', () => {
  // now = 2026-06-24T12:00Z；2026-06-25 的 UTC 零点 > now → future。
  const r = parseProcessFromDate('2026-06-25', NOW);
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.kind, 'future');
});

test('严格未来（远期）→ future', () => {
  const r = parseProcessFromDate('2099-01-01', NOW);
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.kind, 'future');
});

// ——————————————————————————————————————————————————————————
// 今天不被误拒：parsedUtcMidnight ≤ now → 放行（**非** date-to-date `>=` 误判）
// ——————————————————————————————————————————————————————————

test('今天（now 在当天正午，传当天 UTC date-string）→ ok（UTC 零点 ≤ now）', () => {
  // 当天 UTC 零点 (2026-06-24T00:00Z) ≤ now (2026-06-24T12:00Z) → 非未来、放行。
  const r = parseProcessFromDate('2026-06-24', NOW);
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.equal(r.date.toISOString(), '2026-06-24T00:00:00.000Z');
});

test('今天（东于 UTC 的时区：now 取当天 UTC 早晨 00:30Z）→ ok（不被误拒）', () => {
  // 东于 UTC（如东八区）当地当天，其 UTC 时刻可能仍是当天凌晨。模拟 now = 当天 UTC 00:30。
  // 当天 UTC 零点 (00:00Z) ≤ now (00:30Z) → 放行；若实现误用 date-to-date `>=` 会把「今天」当未来误拒。
  const earlyNow = new Date('2026-06-24T00:30:00.000Z');
  const r = parseProcessFromDate('2026-06-24', earlyNow);
  assert.equal(r.ok, true, '今天（UTC 零点 ≤ now）必须放行，不被 date-to-date 误拒');
  assert.ok(r.ok);
  assert.equal(r.date.toISOString(), '2026-06-24T00:00:00.000Z');
});

test('今天边界（now 恰为当天 UTC 零点 00:00:00.000Z）→ ok（parsedUtcMidnight == now，非严格未来）', () => {
  // 边界：parsedUtcMidnight == now → `> now` 为 false → 放行（含界、不误判未来）。
  const midnightNow = new Date('2026-06-24T00:00:00.000Z');
  const r = parseProcessFromDate('2026-06-24', midnightNow);
  assert.equal(r.ok, true, 'parsedUtcMidnight == now 非严格未来 → 放行');
  assert.ok(r.ok);
});

// ——————————————————————————————————————————————————————————
// 默认 now：不传 now 参数时用 new Date()（确认默认分支可用、不抛）
// ——————————————————————————————————————————————————————————

test('默认 now（不传第二参）：合法过去日期仍 ok', () => {
  const r = parseProcessFromDate('2000-01-01');
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.equal(r.date.toISOString(), '2000-01-01T00:00:00.000Z');
});
