// renderTelegramText 单测（notification-mailbox-clarity 5.2）。
//
// 断言渲染层真实行为（对 telegram.ts renderTelegramText 实现）：
//   - P0 与 P4 用**同一字段模板**（统一字段序、统一前缀格式）；
//   - mailboxLabel：有 accountLabel 用之、缺失回落裸 accountId、**绝不空**（sanitize-then-fallback）；
//   - 分类渲染**中文 hashtag**（CATEGORY_LABELS、非英文枚举名）；
//   - riskFlags 空**不**出风险行、非空出（含 P0 非空也出——字段统一的行为变更）；
//   - **仅** P4 附安全提示；
//   - 渲染文本与 payload **不含** textBody/htmlBody（结构断言）；
//   - **来源净化**：accountLabel/email 含 \p{Cc}/\p{Cf}/U+202E/U+2028 时渲染已剥除；
//   - **净化后非空**：accountLabel 为纯 bidi/控制（净化后空）→ 回落裸 accountId、`邮箱:` 行非空。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderTelegramText } from './telegram.js';
import type { NotificationPayload } from './notifier.js';
import { CATEGORY_LABELS } from './categoryLabels.js';

// 危险码点（用 String.fromCharCode 构造，保源码为纯 ASCII 文本——**禁**在源里写裸
// U+2028/U+2029/NUL 字面字符：U+2028 会断行 source、NUL 使文件被当二进制）。
// NUL(Cc) / 零宽空格 U+200B(Cf) / RTL-override U+202E(Cf) / 行分隔 U+2028(Zl，显式补) /
// bidi 隔离符 U+2066(Cf)。
const NUL = String.fromCharCode(0x0000);
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const LS = String.fromCharCode(0x2028);
const BIDI_ISOLATE = String.fromCharCode(0x2066);

const MAILBOX_PREFIX = '邮箱：';

/** 构造一个白名单 payload（默认 P0、空 riskFlags、设了 accountLabel）。 */
function makePayload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
  return {
    priority: 'P0',
    category: 'work',
    confidence: 0.9,
    subject: '测试主题',
    fromName: '发件人',
    fromEmail: 'sender@example.com',
    reason: '裁定原因',
    riskFlags: [],
    accountId: 'gmail:me@example.com',
    accountLabel: '公司邮箱',
    ...overrides,
  };
}

/** 取渲染文本里以「邮箱：」开头的那一行（无则 undefined）。 */
function mailboxLine(text: string): string | undefined {
  return text.split('\n').find((l) => l.startsWith(MAILBOX_PREFIX));
}

// ——————————————————————————————————————————————————————————
// P0/P4 单一模板：同一字段序、同一前缀
// ——————————————————————————————————————————————————————————

test('P0 与 P4 用同一字段模板（同字段序、同前缀格式）', () => {
  const p0 = renderTelegramText(makePayload({ priority: 'P0' }));
  const p4 = renderTelegramText(makePayload({ priority: 'P4' }));

  // 两者前 6 行的「字段名前缀」一致（仅优先级 token 与 P4 末尾安全提示不同）。
  const fieldPrefixes = (t: string) =>
    t
      .split('\n')
      .slice(0, 6)
      .map((l) => l.split('：')[0]);
  const p0Lines = p0.split('\n');
  const p4Lines = p4.split('\n');
  assert.ok(p0Lines[0]!.startsWith('[P0 邮件] '), 'P0 首行前缀 [P0 邮件]');
  assert.ok(p4Lines[0]!.startsWith('[P4 邮件] '), 'P4 首行前缀 [P4 邮件]');
  // 第 2..6 行字段名一致（邮箱/发件人/原因/分类/置信度）。
  assert.deepEqual(
    fieldPrefixes(p0).slice(1),
    fieldPrefixes(p4).slice(1),
    'P0/P4 字段名序列一致（单一模板）',
  );
  // 两者都含这五个字段行。
  for (const t of [p0, p4]) {
    assert.ok(t.includes('\n邮箱：'), '含邮箱行');
    assert.ok(t.includes('\n发件人：'), '含发件人行');
    assert.ok(t.includes('\n原因：'), '含原因行');
    assert.ok(t.includes('\n分类：#'), '含分类行（hashtag）');
    assert.ok(t.includes('\n置信度：'), '含置信度行');
  }
});

// ——————————————————————————————————————————————————————————
// mailboxLabel：有 accountLabel 用之、缺失回落裸 accountId、绝不空
// ——————————————————————————————————————————————————————————

test('mailboxLabel：设了 accountLabel（中文别名）→ 渲染该别名', () => {
  const text = renderTelegramText(makePayload({ accountLabel: '公司邮箱' }));
  assert.equal(mailboxLine(text), `${MAILBOX_PREFIX}公司邮箱`, '用 accountLabel 作来源标签');
});

test('mailboxLabel：accountLabel 为 email（NULL label 回落 email 经 accountLabel 注入）→ 渲染该 email', () => {
  const text = renderTelegramText(makePayload({ accountLabel: 'me@example.com' }));
  assert.equal(mailboxLine(text), `${MAILBOX_PREFIX}me@example.com`, '用 email 作来源标签');
});

test('mailboxLabel：缺失 accountLabel（穿透链漏填）→ 回落裸 accountId、绝不空', () => {
  const text = renderTelegramText(
    makePayload({ accountLabel: undefined, accountId: 'gmail:me@example.com' }),
  );
  const line = mailboxLine(text);
  assert.equal(line, `${MAILBOX_PREFIX}gmail:me@example.com`, '缺 accountLabel 回落裸 accountId');
  assert.ok(line!.length > MAILBOX_PREFIX.length, '邮箱行非空（绝不空来源）');
});

test('mailboxLabel：空字符串 accountLabel → 回落裸 accountId、绝不空', () => {
  const text = renderTelegramText(makePayload({ accountLabel: '', accountId: 'imap:a@h' }));
  assert.equal(mailboxLine(text), `${MAILBOX_PREFIX}imap:a@h`, '空 accountLabel 回落裸 accountId');
});

// ——————————————————————————————————————————————————————————
// 分类渲染中文 hashtag（CATEGORY_LABELS，非英文枚举名）
// ——————————————————————————————————————————————————————————

test('分类渲染中文 hashtag（覆盖各 category；禁渲染英文枚举名）', () => {
  for (const [cat, zh] of Object.entries(CATEGORY_LABELS)) {
    const text = renderTelegramText(
      makePayload({ category: cat as NotificationPayload['category'] }),
    );
    assert.ok(text.includes(`分类：#${zh}`), `${cat} → 中文 hashtag #${zh}`);
    // 不渲染英文枚举名（如 #system_alert）。
    assert.ok(!text.includes(`#${cat}`), `${cat}：不渲染英文枚举名 hashtag`);
  }
});

// ——————————————————————————————————————————————————————————
// riskFlags：空不出风险行、非空出（含 P0 非空也出——行为变更）
// ——————————————————————————————————————————————————————————

test('riskFlags 为空 → 不渲染风险行', () => {
  const text = renderTelegramText(makePayload({ riskFlags: [] }));
  assert.ok(!text.includes('风险：'), '空 riskFlags 不出风险行');
});

test('riskFlags 非空（P0）→ 渲染风险行（字段统一带来的 P0 行为变更）', () => {
  const text = renderTelegramText(
    makePayload({ priority: 'P0', riskFlags: ['可疑链接', '伪造发件人'] }),
  );
  assert.ok(text.includes('风险：'), 'P0 非空 riskFlags 也出风险行');
  assert.ok(text.includes('可疑链接') && text.includes('伪造发件人'), '风险行含各 flag');
});

test('riskFlags 非空（P4）→ 渲染风险行', () => {
  const text = renderTelegramText(makePayload({ priority: 'P4', riskFlags: ['验证码外泄'] }));
  assert.ok(text.includes('风险：') && text.includes('验证码外泄'), 'P4 非空 riskFlags 出风险行');
});

// ——————————————————————————————————————————————————————————
// 仅 P4 出安全提示
// ——————————————————————————————————————————————————————————

test('仅 P4 附安全核验提示；P0 不附', () => {
  const p0 = renderTelegramText(makePayload({ priority: 'P0' }));
  const p4 = renderTelegramText(makePayload({ priority: 'P4' }));
  assert.ok(!p0.includes('核验'), 'P0 不附安全提示');
  assert.ok(p4.includes('不要点击链接') && p4.includes('核验'), 'P4 附安全核验提示');
});

// ——————————————————————————————————————————————————————————
// 渲染文本 / payload 结构不含 textBody/htmlBody（杜绝正文泄露）
// ——————————————————————————————————————————————————————————

test('渲染文本与 payload 不含 textBody/htmlBody（结构断言）', () => {
  const payload = makePayload();
  // payload 类型层无 textBody/htmlBody；结构上断言键不存在。
  assert.ok(!('textBody' in payload), 'payload 结构无 textBody');
  assert.ok(!('htmlBody' in payload), 'payload 结构无 htmlBody');
  const text = renderTelegramText(payload);
  assert.ok(!text.includes('textBody') && !text.includes('htmlBody'), '渲染文本不含正文字段名');
});

// ——————————————————————————————————————————————————————————
// 来源净化（单点防御）：accountLabel/email 含危险码点 → 渲染已剥除
// ——————————————————————————————————————————————————————————

test('来源净化：accountLabel 含 \\p{Cc}/\\p{Cf}/U+202E/U+2028 → 渲染文本已剥除这些码点', () => {
  // 混入：零宽空格 U+200B(Cf) + RTL-override U+202E(Cf) + 行分隔 U+2028 + NUL(Cc)。
  const dirty = `comp${ZWSP}a${RLO}ny${LS}${NUL}邮箱`;
  const text = renderTelegramText(makePayload({ accountLabel: dirty }));
  const line = mailboxLine(text);
  assert.ok(line !== undefined, '有邮箱行');
  // 渲染输出不含任一危险码点。
  for (const cp of [NUL, ZWSP, RLO, LS]) {
    assert.ok(!text.includes(cp), `渲染文本已剥除码点 U+${cp.codePointAt(0)!.toString(16)}`);
  }
  // 净化只剥危险码点、保留可见字符（U+2028 被剥除，不真正断行 mailboxLine）。
  assert.equal(line, `${MAILBOX_PREFIX}company邮箱`, '净化后仅保留可见字符');
});

test('来源净化：email-回落（accountLabel 即 email）含 RTL-override U+202E → 渲染已剥除', () => {
  // 模拟未校验的 IMAP --email 经 accountLabel 注入 RTL-override 伪装来源。
  const dirtyEmail = `a${RLO}b@evil.example`;
  const text = renderTelegramText(makePayload({ accountLabel: dirtyEmail }));
  assert.ok(!text.includes(RLO), '渲染文本不含 RTL-override');
  assert.equal(mailboxLine(text), `${MAILBOX_PREFIX}ab@evil.example`, '净化后 email 去掉 U+202E');
});

// ——————————————————————————————————————————————————————————
// 净化后非空（守 sanitize-then-fallback）：纯 bidi/控制 accountLabel 净化成空 → 回落裸 accountId
// ——————————————————————————————————————————————————————————

test('净化后非空：accountLabel 纯 bidi/控制（净化后空）→ 回落裸 accountId、邮箱行非空', () => {
  // 纯危险码点：RTL-override + 零宽空格 + bidi 隔离 + NUL。pre-sanitize 非空、净化后为空 →
  // 必须回落裸 accountId（绝不空来源）。守 sanitize-then-fallback（防把净化包在 fallback 外层）。
  const pureBidi = `${RLO}${ZWSP}${BIDI_ISOLATE}${NUL}`;
  const text = renderTelegramText(
    makePayload({ accountLabel: pureBidi, accountId: 'gmail:me@example.com' }),
  );
  const line = mailboxLine(text);
  assert.equal(line, `${MAILBOX_PREFIX}gmail:me@example.com`, '净化成空 → 回落裸 accountId');
  // 邮箱行非空、且不含任何危险码点。
  assert.ok(line!.length > MAILBOX_PREFIX.length, '邮箱行非空（绝不空来源）');
  for (const cp of [RLO, ZWSP, BIDI_ISOLATE, NUL]) {
    assert.ok(!text.includes(cp), `回落后渲染文本仍不含危险码点 U+${cp.codePointAt(0)!.toString(16)}`);
  }
});
