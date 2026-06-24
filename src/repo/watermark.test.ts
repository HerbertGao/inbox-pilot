// passesWatermark 纯函数单测（onboarding-date-watermark task 6.5、design 决策 9）。
//
// 五分支：null / undefined / `<` / `==` / `>`。`null`（账号未设下界）与 `undefined`（`map.get(accountId)`
// 对 map 中缺失账号返回 undefined）都必须放行——接受 `undefined` 是为挡「缺失 accountId →
// undefined.getTime() 抛/NaN → 静默丢候选」（决策 9）。边界含界（`receivedAt == processFrom` 纳入）。
//
// passesWatermark 是两 repo（Prisma / InMemory）的单一真源谓词，覆盖它即覆盖两 repo 的判定逻辑。
// map-build / 缺失-accountId 的残缺另由 inMemoryMailRepo.test.ts 的「混入缺失 accountId」用例闭合。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { passesWatermark } from './watermark.js';

const RECEIVED = new Date('2026-06-20T12:00:00.000Z');

test('passesWatermark: processFrom === null ⇒ 放行（账号未设下界）', () => {
  // null 必须放行，即便 receivedAt 任意早（远早于任何水位线）。
  assert.equal(passesWatermark(new Date('2000-01-01T00:00:00.000Z'), null), true);
  assert.equal(passesWatermark(RECEIVED, null), true);
});

test('passesWatermark: processFrom === undefined ⇒ 放行（map 缺失该账号、不静默丢）', () => {
  // undefined = `map.get(accountId)` 对 map 中缺失账号的返回值；必须放行（不得 throw / NaN）。
  // 这是决策 9 接受 undefined 的核心理由：否则 undefined.getTime() 抛或 NaN 致候选被静默丢。
  assert.equal(passesWatermark(new Date('2000-01-01T00:00:00.000Z'), undefined), true);
  assert.equal(passesWatermark(RECEIVED, undefined), true);
});

test('passesWatermark: receivedAt < processFrom ⇒ 排除（接入前历史积压）', () => {
  const processFrom = new Date('2026-06-20T12:00:00.000Z');
  const earlier = new Date('2026-06-20T11:59:59.999Z'); // 早 1ms
  assert.equal(passesWatermark(earlier, processFrom), false);
  // 远早（数月前积压）同样排除。
  assert.equal(passesWatermark(new Date('2026-01-01T00:00:00.000Z'), processFrom), false);
});

test('passesWatermark: receivedAt == processFrom ⇒ 纳入（含界）', () => {
  const processFrom = new Date('2026-06-20T12:00:00.000Z');
  // 同刻（同一毫秒）必须纳入——边界含界（`receivedAt >= processFrom`）。
  assert.equal(passesWatermark(new Date('2026-06-20T12:00:00.000Z'), processFrom), true);
  // 不依赖对象同一性：用一个独立 Date 实例、相同时刻，仍纳入。
  assert.equal(passesWatermark(processFrom, processFrom), true);
});

test('passesWatermark: receivedAt > processFrom ⇒ 纳入（停机期间收到）', () => {
  const processFrom = new Date('2026-06-20T12:00:00.000Z');
  const later = new Date('2026-06-20T12:00:00.001Z'); // 晚 1ms
  assert.equal(passesWatermark(later, processFrom), true);
  // 远晚同样纳入。
  assert.equal(passesWatermark(new Date('2026-07-01T00:00:00.000Z'), processFrom), true);
});
