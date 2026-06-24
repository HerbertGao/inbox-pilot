// parseProcessFromDate 直接单测（onboarding-watermark 6.7；watermark-date-container-tz 2.1）——
// 共享 `--process-from` / `set-process-from` 日期 parse+validate helper。注入固定 `now` 使确定性。
//
// 时区口径（decision 4，watermark-date-container-tz）：本文件经**进程前置 `TZ`** 跑（`package.json`
// 脚本 `test:tz` = `TZ=Asia/Shanghai …`、`test:tz-utc` = `TZ=UTC …`），**不**靠用例内 `process.env.TZ=`、
// **不**靠宿主 ambient TZ。断言分两类：
//   ① **TZ-robust（恒绿、任何 TZ 下跑）**——解析结果用**本地字段**核对（`getFullYear/Month/Date` == 入参、
//      时分秒毫秒全 0）；本地「今天」（注入 `now`=当地午后）放行、本地「明天」拒、非法/进位归一/带时间分量/
//      空串拒。
//   ② **绝对瞬时断言按 `process.env.TZ` 守卫**（不匹配 zone 直接 skip、绝不 false-red）：
//      `Asia/Shanghai` → `2026-01-15` = `2026-01-14T16:00:00.000Z`；`UTC` → `2026-01-15` =
//      `2026-01-15T00:00:00.000Z`（固化「未设/UTC = 旧语义」容器默认路径）。
//
// 注：「时分秒毫秒全 0」的 bulk 断言假定 runner 在**无午夜 DST 跳变的时区**（三个 mandated zone：
// Asia/Shanghai / UTC / 开发机 ambient 均满足；见 design 决策 1）；若 CI 迁到零点跳变区（如
// America/Sao_Paulo）需复核。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseProcessFromDate } from './processFromDate.js';

// 固定基准 now：本地 2026-06-24 当天午后（12:00 本地）。相对**本地午夜**表达，任何进程 TZ 下都是「当天稍晚」，
// 故「当天」本地零点 ≤ now、「次日」本地零点 > now——不硬编码某个 UTC 瞬时。
const NOW = new Date(2026, 5, 24, 12, 0, 0, 0);

/** 断言 `date` 在**进程本地 TZ** 下为给定年月日的当日零点（TZ-robust：本地字段 + 时分秒毫秒全 0）。 */
function assertLocalMidnight(date: Date, year: number, month1to12: number, day: number): void {
  assert.equal(date.getFullYear(), year, '本地年份');
  assert.equal(date.getMonth(), month1to12 - 1, '本地月份');
  assert.equal(date.getDate(), day, '本地日');
  assert.equal(date.getHours(), 0, '本地时为 0');
  assert.equal(date.getMinutes(), 0, '本地分为 0');
  assert.equal(date.getSeconds(), 0, '本地秒为 0');
  assert.equal(date.getMilliseconds(), 0, '本地毫秒为 0');
}

// ——————————————————————————————————————————————————————————
// ① TZ-robust：合法 → 本地时区零点 Date（本地字段核对，任何 TZ 下恒绿）
// ——————————————————————————————————————————————————————————

test('合法 2026-01-15 → ok、Date 为该日本地时区零点（本地字段 + 时分秒毫秒全 0）', () => {
  const r = parseProcessFromDate('2026-01-15', NOW);
  assert.equal(r.ok, true);
  assert.ok(r.ok); // narrow
  assertLocalMidnight(r.date, 2026, 1, 15);
});

test('合法过去日期（远早于 now）→ ok、本地时区零点', () => {
  const r = parseProcessFromDate('2020-12-31', NOW);
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assertLocalMidnight(r.date, 2020, 12, 31);
});

// ——————————————————————————————————————————————————————————
// ② 绝对瞬时断言（按 process.env.TZ 守卫；不匹配 zone 直接 return = 空跑通过、绝不 false-red）
// ——————————————————————————————————————————————————————————

test('绝对瞬时（仅 TZ=Asia/Shanghai）：2026-01-15 → 2026-01-14T16:00:00.000Z', () => {
  if (process.env.TZ !== 'Asia/Shanghai') return; // 非匹配 zone 跳过、不断言
  const r = parseProcessFromDate('2026-01-15', NOW);
  assert.ok(r.ok);
  assert.equal(r.date.toISOString(), '2026-01-14T16:00:00.000Z');
});

test('绝对瞬时（仅 TZ=UTC，固化未设/UTC = 旧语义）：2026-01-15 → 2026-01-15T00:00:00.000Z', () => {
  if (process.env.TZ !== 'UTC') return; // 非匹配 zone 跳过、不断言
  const r = parseProcessFromDate('2026-01-15', NOW);
  assert.ok(r.ok);
  assert.equal(r.date.toISOString(), '2026-01-15T00:00:00.000Z');
});

// ——————————————————————————————————————————————————————————
// ① TZ-robust：解析失败 → kind:'invalid'（调用方映射 EXIT_USAGE / 退出码 2）
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
// ① TZ-robust：严格未来（本地明天，parsedLocalMidnight > now）→ kind:'future'
// ——————————————————————————————————————————————————————————

test('严格未来（本地明天 2026-06-25，parsedLocalMidnight > now）→ future', () => {
  // now = 本地 2026-06-24 12:00；本地 2026-06-25 的零点 > now → future（任何 TZ 下成立）。
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
// ① TZ-robust：本地今天不被误拒（parsedLocalMidnight ≤ now → 放行）
// ——————————————————————————————————————————————————————————

test('本地今天（now 在当天午后，传当天 date-string）→ ok（本地零点 ≤ now）', () => {
  // 本地当天零点 ≤ now（本地午后）→ 非未来、放行（消除旧 UTC 口径「东于 UTC 时区今天被误拒」的坑）。
  const r = parseProcessFromDate('2026-06-24', NOW);
  assert.equal(r.ok, true, '本地今天（本地零点 ≤ now）必须放行');
  assert.ok(r.ok);
  assertLocalMidnight(r.date, 2026, 6, 24);
});

test('本地今天边界（now 恰为当天本地零点）→ ok（parsedLocalMidnight == now，非严格未来）', () => {
  // 边界：parsedLocalMidnight == now → `> now` 为 false → 放行（含界、不误判未来）。任何 TZ 下成立。
  const midnightNow = new Date(2026, 5, 24, 0, 0, 0, 0);
  const r = parseProcessFromDate('2026-06-24', midnightNow);
  assert.equal(r.ok, true, 'parsedLocalMidnight == now 非严格未来 → 放行');
  assert.ok(r.ok);
  assertLocalMidnight(r.date, 2026, 6, 24);
});

test('本地今天（now 取当天本地凌晨 00:30）→ ok（不被误拒）', () => {
  // 当天本地凌晨亦放行：本地零点 (00:00) ≤ now (00:30) → 放行；若误用 date-to-date `>=` 会把今天当未来误拒。
  const earlyNow = new Date(2026, 5, 24, 0, 30, 0, 0);
  const r = parseProcessFromDate('2026-06-24', earlyNow);
  assert.equal(r.ok, true, '本地今天（本地零点 ≤ now）必须放行，不被 date-to-date 误拒');
  assert.ok(r.ok);
  assertLocalMidnight(r.date, 2026, 6, 24);
});

// ——————————————————————————————————————————————————————————
// ① TZ-robust：默认 now（不传第二参时用 new Date()，确认默认分支可用、不抛）
// ——————————————————————————————————————————————————————————

test('默认 now（不传第二参）：合法过去日期仍 ok、本地时区零点', () => {
  const r = parseProcessFromDate('2000-01-01');
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assertLocalMidnight(r.date, 2000, 1, 1);
});
