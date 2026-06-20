// 离线验收（组 F §7.1）：applySafetyRules 纯函数单测（node:test）。
//
// 把 safety-rules/spec.md 的每个场景 + tasks §7.1 的断言清单逐条兑现为断言：
//   - 验证码主题→P0/通知/不读；P4→通知/不读；confidence<0.65→P1/不读/digest；
//   - 敏感域名 & 支付/安全关键词覆盖 P2/P3→不读；
//   - §5 派生表（P0/P4 notify、P1/P2 digest、P2/P3 read、P3 不入摘要）；
//   - 单调趋安全（强制不标已读不翻回）；
//   - 边界：confidence===0.65（不降级）、P4+低置信→保持 P4、P0(验证码)+低置信→保持 P0。
//
// 断言一律针对 applySafetyRules 的返回值（FinalDecision），不断言喂进去的 Classification。
// 纯函数：无 I/O、无注入；只用内置默认名单（lists.ts）构造命中/不命中的 fixture。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applySafetyRules } from './applySafetyRules.js';
import { SENSITIVE_DOMAINS, SECURITY_PAYMENT_KEYWORDS } from './lists.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

// 一封合法 NormalizedEmail（给默认值，按需覆盖 subject/fromEmail/textBody）。
// 默认 fromEmail 用非敏感域、subject/textBody 不含任何护栏关键词。
function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'acct-1',
    provider: 'gmail',
    providerMessageId: 'msg-1',
    subject: '普通主题 ordinary subject',
    fromEmail: 'sender@example.com',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
    ...overrides,
  };
}

// 一个满足 Classification 的合法分类（snake_case）。默认 P2 + 高置信、无 risk_flags。
// 三个 should_* 建议布尔默认给「与最终裁定相反」的值，借此佐证引擎忽略建议、重新派生。
function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    priority: 'P2',
    category: 'work',
    should_notify_now: true, // 建议 notify=true（P2 应被引擎重新派生为 false）
    should_mark_read: false, // 建议 mark_read=false（P2 应被引擎重新派生为 true）
    should_include_digest: false, // 建议 digest=false（P2 应被重新派生为 true）
    confidence: 0.9,
    reason: '测试分类',
    risk_flags: [],
    ...overrides,
  };
}

// ——————————————————————————————————————————————————————————
// 优先级强制裁定 + 派生动作
// ——————————————————————————————————————————————————————————

test('验证码主题 → 强制 P0、shouldNotifyNow=true、shouldMarkRead=false（覆盖建议）', () => {
  const email = makeEmail({ subject: '您的验证码是 123456' });
  // 建议给 P3 + mark_read=true，验证主题验证码强制 P0 覆盖一切建议。
  const cls = makeClassification({ priority: 'P3', should_mark_read: true, should_notify_now: false });

  const d = applySafetyRules(email, cls);

  assert.equal(d.priority, 'P0');
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('subject-verification-code→P0'));
  assert.ok(d.riskFlags.includes('verification-code'));
});

test('英文验证码主题 verification code → 同样强制 P0', () => {
  const d = applySafetyRules(
    makeEmail({ subject: 'Your verification code' }),
    makeClassification({ priority: 'P2' }),
  );
  assert.equal(d.priority, 'P0');
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
});

test('P4 → 保持 P4、shouldNotifyNow=true、shouldMarkRead=false', () => {
  const d = applySafetyRules(
    makeEmail(),
    makeClassification({ priority: 'P4', should_mark_read: true }),
  );
  assert.equal(d.priority, 'P4');
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
  assert.equal(d.shouldIncludeDigest, false); // P4 不入摘要
});

test('confidence<0.65（且非验证码、非 P4）→ 降级 P1、不标已读、入摘要', () => {
  const d = applySafetyRules(
    makeEmail(),
    makeClassification({ priority: 'P2', confidence: 0.5, should_mark_read: true }),
  );
  assert.equal(d.priority, 'P1');
  assert.equal(d.shouldMarkRead, false);
  assert.equal(d.shouldIncludeDigest, true);
  assert.equal(d.shouldNotifyNow, false);
  assert.ok(d.appliedRules.includes('low-confidence→P1'));
});

// ——————————————————————————————————————————————————————————
// §5 派生表逐行：P0/P4 notify、P1/P2 digest、P2/P3 read、P3 不入摘要
// ——————————————————————————————————————————————————————————

test('§5 派生表 P2 → read + digest + 不 notify', () => {
  const d = applySafetyRules(makeEmail(), makeClassification({ priority: 'P2' }));
  assert.equal(d.priority, 'P2');
  assert.equal(d.shouldMarkRead, true);
  assert.equal(d.shouldIncludeDigest, true);
  assert.equal(d.shouldNotifyNow, false);
});

test('§5 派生表 P3 → read + 不 digest（只计数）+ 不 notify', () => {
  const d = applySafetyRules(makeEmail(), makeClassification({ priority: 'P3' }));
  assert.equal(d.priority, 'P3');
  assert.equal(d.shouldMarkRead, true);
  assert.equal(d.shouldIncludeDigest, false);
  assert.equal(d.shouldNotifyNow, false);
});

test('§5 派生表 P1 → 不 read + digest + 不 notify', () => {
  const d = applySafetyRules(makeEmail(), makeClassification({ priority: 'P1' }));
  assert.equal(d.priority, 'P1');
  assert.equal(d.shouldMarkRead, false);
  assert.equal(d.shouldIncludeDigest, true);
  assert.equal(d.shouldNotifyNow, false);
});

test('§5 派生表 P0（建议 P0、高置信）→ notify + 不 read + 不 digest', () => {
  const d = applySafetyRules(makeEmail(), makeClassification({ priority: 'P0' }));
  assert.equal(d.priority, 'P0');
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
  assert.equal(d.shouldIncludeDigest, false);
});

// ——————————————————————————————————————————————————————————
// 强制不标已读护栏：敏感域名 + 支付/安全关键词覆盖 P2/P3
// ——————————————————————————————————————————————————————————

test('敏感域名（bank.com）覆盖 P2 的标已读 → shouldMarkRead=false', () => {
  const sensitive = SENSITIVE_DOMAINS[0]; // bank.com
  const d = applySafetyRules(
    makeEmail({ fromEmail: `user@${sensitive}` }),
    makeClassification({ priority: 'P2' }),
  );
  assert.equal(d.priority, 'P2'); // 优先级不变，仅护栏改 shouldMarkRead
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
  assert.ok(d.riskFlags.includes('sensitive-domain'));
});

test('敏感域名子域（mail.bank.com）也命中 → shouldMarkRead=false', () => {
  const sensitive = SENSITIVE_DOMAINS[0];
  const d = applySafetyRules(
    makeEmail({ fromEmail: `noreply@mail.${sensitive}` }),
    makeClassification({ priority: 'P2' }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
});

test('敏感域名覆盖 P3 的标已读 → shouldMarkRead=false', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: `x@${SENSITIVE_DOMAINS[1]}` }),
    makeClassification({ priority: 'P3' }),
  );
  assert.equal(d.priority, 'P3');
  assert.equal(d.shouldMarkRead, false);
});

test('支付/合同敏感域名（无关键词命中）也覆盖 P2/P3 标已读', () => {
  // 发件域命中支付/合同类敏感域、但主题/正文无任何关键词 → 仍必须不标已读（硬约束枚举对齐）。
  const p2 = applySafetyRules(
    makeEmail({ fromEmail: 'noreply@payment.com', subject: '账户更新' }),
    makeClassification({ priority: 'P2' }),
  );
  const p3 = applySafetyRules(
    makeEmail({ fromEmail: 'docs@contract.com', subject: 'document ready' }),
    makeClassification({ priority: 'P3' }),
  );
  assert.equal(p2.shouldMarkRead, false);
  assert.ok(p2.appliedRules.includes('sensitive-domain→no-mark-read'));
  assert.equal(p3.shouldMarkRead, false);
});

test('支付/安全关键词（主题）覆盖 P2 标已读 → shouldMarkRead=false', () => {
  const d = applySafetyRules(
    makeEmail({ subject: 'Your invoice is ready' }), // invoice ∈ SECURITY_PAYMENT_KEYWORDS
    makeClassification({ priority: 'P2' }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('payment-security-keyword→no-mark-read'));
});

test('支付/安全关键词（正文）覆盖 P3 标已读 → shouldMarkRead=false', () => {
  const kw = SECURITY_PAYMENT_KEYWORDS.find((k) => k === '异常登录') ?? '异常登录';
  const d = applySafetyRules(
    makeEmail({ subject: '普通主题', textBody: `检测到您的账户有${kw}行为` }),
    makeClassification({ priority: 'P3' }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('payment-security-keyword→no-mark-read'));
});

test('正文验证码（主题不含）→ 不强制 P0 但护栏令 shouldMarkRead=false（spec 场景）', () => {
  // 建议 P2 高置信、主题无验证码词、正文含「验证码」。
  const d = applySafetyRules(
    makeEmail({ subject: '普通通知', textBody: '您的验证码是 246810，5 分钟内有效' }),
    makeClassification({ priority: 'P2' }),
  );
  // 不强制 P0（仅主题命中才强制 P0）。
  assert.equal(d.priority, 'P2');
  // 但走护栏：绝不自动标已读。
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('verification-keyword→no-mark-read'));
});

test('正文英文 otp（主题不含）→ P3 仍不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ subject: 'newsletter', textBody: 'Your OTP is 135790' }),
    makeClassification({ priority: 'P3' }),
  );
  assert.equal(d.priority, 'P3');
  assert.equal(d.shouldMarkRead, false);
  // 把不标已读的成因钉在验证码护栏（防未来改 P3 默认时此断言空转）。
  assert.ok(d.appliedRules.includes('verification-keyword→no-mark-read'));
});

test('敏感域名带尖括号/显示名形态 "Name <u@bank.com>" 也命中 → 不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: '客服 <noreply@bank.com>' }),
    makeClassification({ priority: 'P2' }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
});

// ——————————————————————————————————————————————————————————
// 单调趋安全：force-no-read 一旦置 false 不翻回 true
// ——————————————————————————————————————————————————————————

test('单调趋安全：敏感域名 + 支付关键词同时命中 P2 → 仍 false（不翻回）', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: `u@${SENSITIVE_DOMAINS[0]}`, subject: 'payment due' }),
    makeClassification({ priority: 'P2', should_mark_read: true }),
  );
  // 两条护栏都命中，shouldMarkRead 始终 false（任一规则置 false 后不被后续翻回）。
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
  assert.ok(d.appliedRules.includes('payment-security-keyword→no-mark-read'));
});

test('单调趋安全：P1（默认不读）即便发件域非敏感也保持 false', () => {
  // P1 默认 shouldMarkRead=false；无任何规则能把它翻回 true。
  const d = applySafetyRules(makeEmail(), makeClassification({ priority: 'P1' }));
  assert.equal(d.shouldMarkRead, false);
});

// ——————————————————————————————————————————————————————————
// 边界
// ——————————————————————————————————————————————————————————

test('边界：confidence===0.65 → 不降级（严格小于才降级）', () => {
  const d = applySafetyRules(
    makeEmail(),
    makeClassification({ priority: 'P2', confidence: 0.65 }),
  );
  assert.equal(d.priority, 'P2'); // 0.65 不 < 0.65，保持建议 P2
  assert.ok(!d.appliedRules.includes('low-confidence→P1'));
});

test('边界：P4 + 低置信 → 保持 P4（安全级别不被低置信下调）', () => {
  const d = applySafetyRules(
    makeEmail(),
    makeClassification({ priority: 'P4', confidence: 0.1 }),
  );
  assert.equal(d.priority, 'P4');
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('p4-risk→keep'));
  assert.ok(!d.appliedRules.includes('low-confidence→P1'));
});

test('边界：P0(验证码主题) + 低置信 → 保持 P0（安全强制不被低置信下调）', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '验证码 654321' }),
    makeClassification({ priority: 'P2', confidence: 0.05 }),
  );
  assert.equal(d.priority, 'P0');
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('subject-verification-code→P0'));
  assert.ok(!d.appliedRules.includes('low-confidence→P1'));
});

// ——————————————————————————————————————————————————————————
// 引擎契约：透传 + 忽略建议 + 纯函数无副作用
// ——————————————————————————————————————————————————————————

test('confidence 透传、引擎不改写（final === raw）', () => {
  const cls = makeClassification({ priority: 'P2', confidence: 0.77 });
  const d = applySafetyRules(makeEmail(), cls);
  assert.equal(d.confidence, 0.77);
});

test('忽略 classification.should_* 建议，全部重新派生（P2 建议全反 → 裁定按 §5）', () => {
  // 建议 notify=true/mark_read=false/digest=false，最终 P2 应被重新派生为
  // notify=false/mark_read=true/digest=true。
  const d = applySafetyRules(
    makeEmail(),
    makeClassification({
      priority: 'P2',
      should_notify_now: true,
      should_mark_read: false,
      should_include_digest: false,
    }),
  );
  assert.equal(d.shouldNotifyNow, false);
  assert.equal(d.shouldMarkRead, true);
  assert.equal(d.shouldIncludeDigest, true);
});

test('纯函数：不改写入参的 risk_flags（riskFlags 为副本）', () => {
  const cls = makeClassification({ priority: 'P2', risk_flags: ['existing-flag'] });
  const d = applySafetyRules(makeEmail({ fromEmail: `u@${SENSITIVE_DOMAINS[0]}` }), cls);
  // 引擎追加 sensitive-domain 到 riskFlags，但不污染原始 classification.risk_flags。
  assert.deepEqual(cls.risk_flags, ['existing-flag']);
  assert.ok(d.riskFlags.includes('existing-flag'));
  assert.ok(d.riskFlags.includes('sensitive-domain'));
});

test('reason 透传 LLM 的人类可读原因', () => {
  const d = applySafetyRules(makeEmail(), makeClassification({ reason: '工作通知' }));
  assert.equal(d.reason, '工作通知');
});
