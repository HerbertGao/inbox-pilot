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
import {
  SECURITY_PAYMENT_KEYWORDS,
  SENSITIVE_CATEGORIES,
} from './lists.js';
import type { ActiveRules } from './rulesConfig.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

// 内置默认快照（security = 整个内置常量；其余轴空）——对齐 getActiveRules() 同步初始化默认。
// 域名/marketing/vip/important 轴用例经 makeRules({...}) 注入 operator 配置的快照测；
// 不显式注入时 applySafetyRules 缺省取 getActiveRules()（默认 security=整集、其余空）。
function makeRules(overrides: Partial<ActiveRules> = {}): ActiveRules {
  return {
    securityKeywords: SECURITY_PAYMENT_KEYWORDS,
    neverMarkReadDomains: [],
    vipSenders: [],
    importantDomains: [],
    marketingKeywords: [],
    noiseSenders: [],
    ...overrides,
  };
}

// operator 配置的敏感域名表（迁移本文件原依赖内置示例域名的域名轴用例用）。
const OPERATOR_NMR_DOMAINS = ['bank.com', 'hospital.com', 'insurance.com', 'payment.com', 'contract.com'] as const;

// 一封合法 NormalizedEmail（给默认值，按需覆盖 subject/fromEmail/textBody）。
// 默认 fromEmail 用中性域、subject/textBody 不含任何护栏关键词。
// 注意：默认域须避开仓库示例 rules/rules.yaml 的 vip_senders/important_domains（如 example.com）——
// 否则不注入 rules 的缺省用例会被 floor 轴抬升、行为不再对齐 §5 默认。用 example.test（中性、未被任何轴配置）。
function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'acct-1',
    provider: 'gmail',
    providerMessageId: 'msg-1',
    subject: '普通主题 ordinary subject',
    fromEmail: 'sender@example.test',
    to: ['me@example.test'],
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

// 域名轴（迁移后经注入 rules 参的 operator never_mark_read_domains 快照测——保域名轴仍被测、不 vacuous）。
test('域名轴（operator 配 bank.com）覆盖 P2 的标已读 → shouldMarkRead=false', () => {
  const sensitive = OPERATOR_NMR_DOMAINS[0]; // bank.com
  const d = applySafetyRules(
    makeEmail({ fromEmail: `user@${sensitive}` }),
    makeClassification({ priority: 'P2' }),
    makeRules({ neverMarkReadDomains: [...OPERATOR_NMR_DOMAINS] }),
  );
  assert.equal(d.priority, 'P2'); // 优先级不变，仅护栏改 shouldMarkRead
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
  assert.ok(d.riskFlags.includes('sensitive-domain'));
});

test('域名轴子域（mail.bank.com）也命中 → shouldMarkRead=false', () => {
  const sensitive = OPERATOR_NMR_DOMAINS[0];
  const d = applySafetyRules(
    makeEmail({ fromEmail: `noreply@mail.${sensitive}` }),
    makeClassification({ priority: 'P2' }),
    makeRules({ neverMarkReadDomains: [...OPERATOR_NMR_DOMAINS] }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
});

test('域名轴覆盖 P3 的标已读 → shouldMarkRead=false', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: `x@${OPERATOR_NMR_DOMAINS[1]}` }),
    makeClassification({ priority: 'P3' }),
    makeRules({ neverMarkReadDomains: [...OPERATOR_NMR_DOMAINS] }),
  );
  assert.equal(d.priority, 'P3');
  assert.equal(d.shouldMarkRead, false);
});

test('域名轴（支付/合同域、无关键词命中）也覆盖 P2/P3 标已读', () => {
  // 发件域命中 operator 配的支付/合同类域、但主题/正文无任何关键词 → 仍必须不标已读。
  const rules = makeRules({ neverMarkReadDomains: [...OPERATOR_NMR_DOMAINS] });
  const p2 = applySafetyRules(
    makeEmail({ fromEmail: 'noreply@payment.com', subject: '账户更新' }),
    makeClassification({ priority: 'P2' }),
    rules,
  );
  const p3 = applySafetyRules(
    makeEmail({ fromEmail: 'docs@contract.com', subject: 'document ready' }),
    makeClassification({ priority: 'P3' }),
    rules,
  );
  assert.equal(p2.shouldMarkRead, false);
  assert.ok(p2.appliedRules.includes('sensitive-domain→no-mark-read'));
  assert.equal(p3.shouldMarkRead, false);
});

test('域名轴内置默认空：未配 never_mark_read_domains → 域名轴对敏感域 no-op（不命中）', () => {
  // 注入 makeRules 默认（neverMarkReadDomains=[]）；纯靠域名、无内容轴命中 → 域名轴不触发。
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'user@bank.com', subject: '账户更新' }),
    makeClassification({ priority: 'P2', category: 'work' }),
    makeRules(), // neverMarkReadDomains=[]（内置默认空）
  );
  // 域名轴空 + 无内容轴命中 → 域名轴不触发（诚实边界：仅域名可识别、内容轴漏判者落入残留缺口）。
  assert.ok(!d.appliedRules.includes('sensitive-domain→no-mark-read'));
  assert.equal(d.shouldMarkRead, true); // 残留缺口：标已读（内容轴是决定性保证、域名轴非决定性）
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

test('域名轴带尖括号/显示名形态 "Name <u@bank.com>" 也命中 → 不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: '客服 <noreply@bank.com>' }),
    makeClassification({ priority: 'P2' }),
    makeRules({ neverMarkReadDomains: [...OPERATOR_NMR_DOMAINS] }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
});

// ——————————————————————————————————————————————————————————
// 类别轴：finance/security/transaction 覆盖 P2/P3 的标已读（无需域名表）
// ——————————————————————————————————————————————————————————

test('类别轴 finance（P3 银行营销邮件）→ 不标已读（无需发件域命中白名单）', () => {
  // 发件域非敏感、主题/正文无任何关键词，仅靠 LLM 透传 category=finance。
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'promo@some-bank-marketing.example', subject: '本月理财活动' }),
    makeClassification({ priority: 'P3', category: 'finance' }),
  );
  assert.equal(d.priority, 'P3'); // 优先级不变，仅护栏改 shouldMarkRead
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-category→no-mark-read'));
});

test('类别轴 transaction（P2）→ 不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'noreply@shop.example', subject: '您的订单已发货' }),
    makeClassification({ priority: 'P2', category: 'transaction' }),
  );
  assert.equal(d.priority, 'P2');
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-category→no-mark-read'));
});

test('类别轴 security（P3）→ 不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'alerts@svc.example', subject: '账户活动通知' }),
    makeClassification({ priority: 'P3', category: 'security' }),
  );
  assert.equal(d.priority, 'P3');
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-category→no-mark-read'));
});

test('SENSITIVE_CATEGORIES 每个成员（P2）→ 不标已读（防漏类别静默破坏护栏）', () => {
  for (const category of SENSITIVE_CATEGORIES) {
    const d = applySafetyRules(
      makeEmail({ fromEmail: 'x@non-sensitive.example' }),
      makeClassification({ priority: 'P2', category: category as Classification['category'] }),
    );
    assert.equal(d.shouldMarkRead, false, `category=${category} 应不标已读`);
    assert.ok(
      d.appliedRules.includes('sensitive-category→no-mark-read'),
      `category=${category} 应命中类别轴`,
    );
  }
});

test('非敏感类别（work，无任何关键词/域名命中）的 P2 → 仍标已读（类别轴不误伤）', () => {
  // 确保类别轴只在敏感类别命中，非敏感类别保持 §5 默认（P2 标已读）。
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'colleague@company.example', subject: '周会纪要' }),
    makeClassification({ priority: 'P2', category: 'work' }),
  );
  assert.equal(d.shouldMarkRead, true);
  assert.ok(!d.appliedRules.includes('sensitive-category→no-mark-read'));
});

// ——————————————————————————————————————————————————————————
// 医院/保险关键词轴：非敏感类别 + conf≥0.65 + P2/P3 仍不标已读（确定性兜底硬约束）
// ——————————————————————————————————————————————————————————

// 代表性医院/保险关键词（spec 场景明列）。逐词断言：漏掉任一词 → 静默破坏硬约束。
const HOSPITAL_INSURANCE_KEYWORDS = [
  '医院',
  '医疗',
  '挂号',
  '病历',
  '诊断',
  '保险',
  '保单',
  '理赔',
  'hospital',
  'clinic',
  'medical',
  'insurance',
] as const;

test('医院/保险关键词（主题，类别=personal/work 非敏感、conf≥0.65、P2/P3）→ 不标已读', () => {
  // 关键先决：类别非敏感（不靠类别轴）、置信高（不降 P1）、P2/P3（默认会标已读）。
  // 仅靠确定性关键词轴守住硬约束。逐词覆盖，防漏词。
  for (const kw of HOSPITAL_INSURANCE_KEYWORDS) {
    const d = applySafetyRules(
      makeEmail({ subject: `关于您的${kw}事项`, fromEmail: 'info@non-sensitive.example' }),
      makeClassification({ priority: 'P2', category: 'personal', confidence: 0.9 }),
    );
    assert.equal(d.priority, 'P2', `kw=${kw} 优先级应保持 P2（conf≥0.65 不降级）`);
    assert.equal(d.shouldMarkRead, false, `医院/保险关键词「${kw}」应令 P2 不标已读`);
    assert.ok(
      d.appliedRules.includes('payment-security-keyword→no-mark-read'),
      `医院/保险关键词「${kw}」应命中关键词轴`,
    );
  }
});

test('医院/保险关键词（正文，类别=work 非敏感、P3）→ 不标已读', () => {
  for (const kw of HOSPITAL_INSURANCE_KEYWORDS) {
    const d = applySafetyRules(
      makeEmail({ subject: '普通通知', textBody: `提醒：请处理${kw}相关材料`, fromEmail: 'svc@non-sensitive.example' }),
      makeClassification({ priority: 'P3', category: 'work', confidence: 0.88 }),
    );
    assert.equal(d.priority, 'P3', `kw=${kw} 优先级应保持 P3`);
    assert.equal(d.shouldMarkRead, false, `医院/保险关键词「${kw}」（正文）应令 P3 不标已读`);
    assert.ok(
      d.appliedRules.includes('payment-security-keyword→no-mark-read'),
      `医院/保险关键词「${kw}」（正文）应命中关键词轴`,
    );
  }
});

test('英文医院/保险关键词大小写归一（Insurance/HOSPITAL 主题）→ 不标已读', () => {
  for (const kw of ['Insurance Renewal Notice', 'HOSPITAL Appointment', 'Your Medical Bill']) {
    const d = applySafetyRules(
      makeEmail({ subject: kw, fromEmail: 'noreply@non-sensitive.example' }),
      makeClassification({ priority: 'P2', category: 'personal', confidence: 0.9 }),
    );
    assert.equal(d.shouldMarkRead, false, `主题「${kw}」应不标已读（小写归一命中）`);
    assert.ok(d.appliedRules.includes('payment-security-keyword→no-mark-read'));
  }
});

// ——————————————————————————————————————————————————————————
// 单调趋安全：force-no-read 一旦置 false 不翻回 true
// ——————————————————————————————————————————————————————————

test('单调趋安全：域名轴 + 支付关键词同时命中 P2 → 仍 false（不翻回）', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: `u@${OPERATOR_NMR_DOMAINS[0]}`, subject: 'payment due' }),
    makeClassification({ priority: 'P2', should_mark_read: true }),
    makeRules({ neverMarkReadDomains: [...OPERATOR_NMR_DOMAINS] }),
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
  const d = applySafetyRules(
    makeEmail({ fromEmail: `u@${OPERATOR_NMR_DOMAINS[0]}` }),
    cls,
    makeRules({ neverMarkReadDomains: [...OPERATOR_NMR_DOMAINS] }),
  );
  // 引擎追加 sensitive-domain 到 riskFlags，但不污染原始 classification.risk_flags。
  assert.deepEqual(cls.risk_flags, ['existing-flag']);
  assert.ok(d.riskFlags.includes('existing-flag'));
  assert.ok(d.riskFlags.includes('sensitive-domain'));
});

test('reason 透传 LLM 的人类可读原因', () => {
  const d = applySafetyRules(makeEmail(), makeClassification({ reason: '工作通知' }));
  assert.equal(d.reason, '工作通知');
});

// ——————————————————————————————————————————————————————————
// 新增轴精确有序管线（design 决策 6、safety-rules spec 场景）
// 经注入 rules 参驱动；security 默认仍为内置整集（makeRules 缺省）。
// ——————————————————————————————————————————————————————————

// —— YAML 覆盖生效（经注入 rules 参）——

test('security_keywords 整集 ∪ YAML：operator 增配词命中 → 不标已读', () => {
  // 注入「内置整集 ∪ 自定义词」，断言自定义词也守护栏（模拟 rulesConfig 整集并集）。
  const d = applySafetyRules(
    makeEmail({ subject: '关于您的 mycustomsecword 事项', fromEmail: 'x@neutral.example' }),
    makeClassification({ priority: 'P2', category: 'personal', confidence: 0.9 }),
    makeRules({ securityKeywords: [...SECURITY_PAYMENT_KEYWORDS, 'mycustomsecword'] }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('payment-security-keyword→no-mark-read'));
});

test('never_mark_read_domains（operator YAML）命中发件域 → 不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'noreply@myco-internal.example', subject: '账户更新' }),
    makeClassification({ priority: 'P2', category: 'work' }),
    makeRules({ neverMarkReadDomains: ['myco-internal.example'] }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-domain→no-mark-read'));
});

// —— 三轴空默认 → 既有用例不变（marketing/vip/important 默认空 → 全 no-op）——

test('三轴空默认（makeRules 缺省）：P2 非敏感 → 仍标已读、无新增轴命中', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '周会纪要 sale discount 50% off', fromEmail: 'vip@boss.example' }),
    makeClassification({ priority: 'P2', category: 'work' }),
    makeRules(), // marketing/vip/important 全空 → 三轴 no-op
  );
  // marketing 空 → 不下调；vip/important 空 → 不抬升；行为与现状一致（P2 标已读）。
  assert.equal(d.priority, 'P2');
  assert.equal(d.shouldMarkRead, true);
  assert.ok(!d.appliedRules.includes('marketing→P3'));
  assert.ok(!d.appliedRules.includes('vip-important→P1'));
});

// —— floor 轴：P0/P4 + vip/important → 不下调 ——

test('P0（验证码主题）+ vip/important → floor no-op（仍 P0、shouldNotifyNow 不丢）', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '您的验证码是 123456', fromEmail: 'ceo@vip.example' }),
    makeClassification({ priority: 'P2', confidence: 0.9 }),
    makeRules({ vipSenders: ['ceo@vip.example'], importantDomains: ['vip.example'] }),
  );
  assert.equal(d.priority, 'P0'); // 禁止 max('P0','P1') 把 P0 下调为 P1
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
  assert.ok(!d.appliedRules.includes('vip-important→P1'));
});

test('P4 + vip/important → floor no-op（仍 P4、shouldNotifyNow 不丢）', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'risk@vip.example' }),
    makeClassification({ priority: 'P4', confidence: 0.9 }),
    makeRules({ vipSenders: ['risk@vip.example'], importantDomains: ['vip.example'] }),
  );
  assert.equal(d.priority, 'P4');
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
  assert.ok(!d.appliedRules.includes('vip-important→P1'));
});

test('floor 轴对 P1（高置信非降级）no-op：vip/important 不动 P1', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'vip@boss.example' }),
    makeClassification({ priority: 'P1', confidence: 0.9 }),
    makeRules({ vipSenders: ['vip@boss.example'], importantDomains: ['boss.example'] }),
  );
  assert.equal(d.priority, 'P1');
  assert.ok(!d.appliedRules.includes('vip-important→P1'));
});

test('floor 轴：P2 命中 important_domains → 抬升 P1（子域归一匹配）', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'team@mail.boss.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ importantDomains: ['boss.example'] }),
  );
  assert.equal(d.priority, 'P1');
  assert.ok(d.appliedRules.includes('vip-important→P1'));
  // P1 → 不标已读、入摘要、不通知。
  assert.equal(d.shouldMarkRead, false);
  assert.equal(d.shouldIncludeDigest, true);
  assert.equal(d.shouldNotifyNow, false);
});

test('floor 轴：P3 命中 vip_senders（精确归一匹配）→ 抬升 P1', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: '老板 <Boss@VIP.Example>' }), // 显示名 + 大小写 → 归一为 boss@vip.example
    makeClassification({ priority: 'P3', category: 'work', confidence: 0.9 }),
    makeRules({ vipSenders: ['boss@vip.example'] }),
  );
  assert.equal(d.priority, 'P1');
  assert.ok(d.appliedRules.includes('vip-important→P1'));
});

test('vip_senders 精确匹配：仅域同（地址不同）不命中 vip 轴', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'someone-else@vip.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ vipSenders: ['boss@vip.example'] }), // 只配精确地址、不配域
  );
  assert.equal(d.priority, 'P2'); // 地址不同 → vip 轴不命中、important 也未配 → 不抬升
  assert.ok(!d.appliedRules.includes('vip-important→P1'));
});

// —— marketing 轴：只动 P2、绝不碰 P0/P1/P4/敏感 ——

test('marketing 轴：P2 非敏感命中 marketing → 下调 P3', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '限时大促 sale 50% off', fromEmail: 'promo@shop.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ marketingKeywords: ['sale', '大促'] }),
  );
  assert.equal(d.priority, 'P3');
  assert.ok(d.appliedRules.includes('marketing→P3'));
  // P3 非敏感 → 标已读。
  assert.equal(d.shouldMarkRead, true);
  assert.equal(d.shouldIncludeDigest, false);
});

test('高置信 P1 + marketing → 不下调 P3、不翻 shouldMarkRead', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '限时 sale 大促', fromEmail: 'promo@shop.example' }),
    makeClassification({ priority: 'P1', category: 'work', confidence: 0.95 }),
    makeRules({ marketingKeywords: ['sale', '大促'] }),
  );
  assert.equal(d.priority, 'P1'); // marketing 只动 P2
  assert.ok(!d.appliedRules.includes('marketing→P3'));
  assert.equal(d.shouldMarkRead, false); // P1 不标已读、不被 marketing 翻 true
});

test('P0（验证码）+ marketing 词 → 不下调 P3、不翻 shouldMarkRead', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '您的验证码 sale 123456', fromEmail: 'promo@shop.example' }),
    makeClassification({ priority: 'P2', confidence: 0.9 }),
    makeRules({ marketingKeywords: ['sale'] }),
  );
  assert.equal(d.priority, 'P0'); // 主题验证码 → P0；marketing 不碰 P0
  assert.ok(!d.appliedRules.includes('marketing→P3'));
  assert.equal(d.shouldMarkRead, false);
  assert.equal(d.shouldNotifyNow, true);
});

test('敏感 P2 + marketing → marketing no-op、护栏粘住（shouldMarkRead 仍 false）', () => {
  // P2 + category=finance（敏感轴）+ 主题含 marketing 词 → sensitiveGuardFired 为真 → marketing no-op。
  const d = applySafetyRules(
    makeEmail({ subject: '理财 sale 大促', fromEmail: 'promo@bankmkt.example' }),
    makeClassification({ priority: 'P2', category: 'finance', confidence: 0.9 }),
    makeRules({ marketingKeywords: ['sale', '大促'] }),
  );
  assert.equal(d.priority, 'P2'); // marketing 因 sensitiveGuardFired 不下调
  assert.ok(!d.appliedRules.includes('marketing→P3'));
  assert.equal(d.shouldMarkRead, false); // 护栏粘住（类别轴）
  assert.ok(d.appliedRules.includes('sensitive-category→no-mark-read'));
});

// —— vip + 广告 → P1（vip 胜：marketing 先 P2→P3、floor 再 P3→P1）——

test('vip + 广告 → 终末 P1（marketing 先 P2→P3、floor 再 P3→P1）、shouldMarkRead=false', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '限时 sale 大促', fromEmail: 'boss@vip.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ marketingKeywords: ['sale', '大促'], vipSenders: ['boss@vip.example'] }),
  );
  assert.equal(d.priority, 'P1'); // vip 胜
  assert.ok(d.appliedRules.includes('marketing→P3'));
  assert.ok(d.appliedRules.includes('vip-important→P1'));
  assert.equal(d.shouldMarkRead, false); // P1 → 不标已读（floor 抬升使 markRead 自然 false）
  assert.equal(d.shouldIncludeDigest, true);
});

// —— 提升轴 + 敏感轴 → markRead 粘 false（不被 priority 改动重派为 true）——

test('提升轴（important）+ 敏感关键词轴 → 抬升 P1，shouldMarkRead 仍 false（护栏粘住）', () => {
  // P2 命中 important_domains 被抬升、同时主题含 security 关键词（敏感轴）。
  const d = applySafetyRules(
    makeEmail({ subject: 'invoice 账单', fromEmail: 'billing@boss.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ importantDomains: ['boss.example'] }),
  );
  assert.equal(d.priority, 'P1');
  assert.ok(d.appliedRules.includes('vip-important→P1'));
  assert.ok(d.appliedRules.includes('payment-security-keyword→no-mark-read'));
  assert.equal(d.shouldMarkRead, false); // 敏感守卫 false 粘住、不被抬升重派 true
});

// —— 正文含验证码（主题无）的 P2/非敏感类别 → shouldMarkRead=false（经 applySafetyRules）——

test('正文含验证码（主题无、非敏感类别、无 security 词）→ sensitiveGuardFired 真、不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '普通通知', textBody: '您的 OTP 是 998877', fromEmail: 'svc@neutral.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules(), // 默认（域名/marketing/vip/important 空）；验证码轴内置
  );
  assert.equal(d.priority, 'P2'); // 正文验证码不强制 P0
  assert.equal(d.shouldMarkRead, false); // 验证码关键词轴（正文）→ 护栏
  assert.ok(d.appliedRules.includes('verification-keyword→no-mark-read'));
});

// —— 域名轴空 → 敏感邮件仍由内容轴守住 ——

test('域名轴空（默认）：敏感邮件仍由关键词轴守住 → 不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ subject: '账单 invoice 提醒', fromEmail: 'noreply@some-bank.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ neverMarkReadDomains: [] }), // 域名轴空
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('payment-security-keyword→no-mark-read'));
  assert.ok(!d.appliedRules.includes('sensitive-domain→no-mark-read')); // 域名轴未命中
});

test('域名轴空（默认）：敏感邮件仍由类别轴守住 → 不标已读', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'promo@some-bank.example', subject: '本月理财活动' }),
    makeClassification({ priority: 'P2', category: 'finance', confidence: 0.9 }),
    makeRules({ neverMarkReadDomains: [] }),
  );
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('sensitive-category→no-mark-read'));
});

// ——————————————————————————————————————————————————————————
// noise 轴（marketing 后、floor 前、¬sensitiveGuardFired 门控、降至 P3、绝不碰 P4/敏感）
// ——————————————————————————————————————————————————————————

test('noise 轴：非敏感 P2（发件人精确命中 noise_senders）→ P3、静默已读、不入摘要、不通知', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'nas@noisy.example', subject: 'NAS 每日报告' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ noiseSenders: ['nas@noisy.example'] }),
  );
  assert.equal(d.priority, 'P3');
  assert.ok(d.appliedRules.includes('noise→P3'));
  assert.equal(d.shouldMarkRead, true); // P3 非敏感 → 静默已读
  assert.equal(d.shouldIncludeDigest, false); // P3 只计数
  assert.equal(d.shouldNotifyNow, false);
});

test('noise 轴：非敏感 P0（发件域命中 noise_senders）→ P3、静默已读', () => {
  // P0 建议（高置信、非验证码主题）→ 命中 noise 域 → 降 P3。
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'alert@mail.noisy.example', subject: '每周巡检' }),
    makeClassification({ priority: 'P0', category: 'work', confidence: 0.9 }),
    makeRules({ noiseSenders: ['noisy.example'] }), // 域命中（子域归一）
  );
  assert.equal(d.priority, 'P3');
  assert.ok(d.appliedRules.includes('noise→P3'));
  assert.equal(d.shouldMarkRead, true);
  assert.equal(d.shouldNotifyNow, false); // 原 P0 的即时推送被降噪掉
});

test('noise 轴：非敏感 P1 命中 noise_senders → P3、静默已读（P1 在降级集合）', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'hkss@noisy.example' }),
    makeClassification({ priority: 'P1', category: 'work', confidence: 0.9 }),
    makeRules({ noiseSenders: ['hkss@noisy.example'] }),
  );
  assert.equal(d.priority, 'P3');
  assert.ok(d.appliedRules.includes('noise→P3'));
  assert.equal(d.shouldMarkRead, true);
});

test('noise 轴：命中敏感守卫（类别轴）时 no-op、保原优先级、shouldMarkRead 仍 false（硬底线）', () => {
  // 发件人在 noise_senders，但 category=finance（敏感）→ ¬sensitiveGuardFired 门控为假 → noise no-op。
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'nas@noisy.example', subject: '账户对账单' }),
    makeClassification({ priority: 'P2', category: 'finance', confidence: 0.9 }),
    makeRules({ noiseSenders: ['nas@noisy.example'] }),
  );
  assert.equal(d.priority, 'P2'); // noise 因 sensitiveGuardFired 不下调
  assert.ok(!d.appliedRules.includes('noise→P3'));
  assert.equal(d.shouldMarkRead, false); // 敏感「不自动已读」硬底线粘住
  assert.ok(d.appliedRules.includes('sensitive-category→no-mark-read'));
});

test('noise 轴：命中敏感守卫（验证码正文轴）时 no-op 且保未读', () => {
  // 主题无验证码（不强制 P0）、正文含验证码 → verificationAxis 命中 → noise 门控为假。
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'nas@noisy.example', subject: 'NAS 通知', textBody: '您的验证码是 246810' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({ noiseSenders: ['nas@noisy.example'] }),
  );
  assert.equal(d.priority, 'P2');
  assert.ok(!d.appliedRules.includes('noise→P3'));
  assert.equal(d.shouldMarkRead, false);
  assert.ok(d.appliedRules.includes('verification-keyword→no-mark-read'));
});

test('noise 轴：绝不碰 P4（P4 命中 noise_senders）→ no-op、shouldNotifyNow=true、shouldMarkRead=false', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'risk@noisy.example' }),
    makeClassification({ priority: 'P4', confidence: 0.9 }),
    makeRules({ noiseSenders: ['risk@noisy.example'] }),
  );
  assert.equal(d.priority, 'P4'); // P4 不在降级集合
  assert.ok(!d.appliedRules.includes('noise→P3'));
  assert.equal(d.shouldNotifyNow, true);
  assert.equal(d.shouldMarkRead, false);
});

test('noise 轴：P3 已是 P3 → no-op（不重复 push、行为不变）', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'nas@noisy.example' }),
    makeClassification({ priority: 'P3', category: 'work', confidence: 0.9 }),
    makeRules({ noiseSenders: ['nas@noisy.example'] }),
  );
  assert.equal(d.priority, 'P3');
  assert.ok(!d.appliedRules.includes('noise→P3')); // P3 不在降级集合 {P0,P1,P2}
  assert.equal(d.shouldMarkRead, true);
});

test('noise 轴空默认（makeRules 缺省）：发件人不在任何 noise 名单 → no-op', () => {
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'nas@noisy.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules(), // noiseSenders=[] → noise 轴 no-op，行为与现状一致
  );
  assert.equal(d.priority, 'P2');
  assert.ok(!d.appliedRules.includes('noise→P3'));
  assert.equal(d.shouldMarkRead, true);
});

test('vip 救回被 noise 误降（floor 在 noise 之后）：noise+vip → noise 先 P3、floor 再 P1（vip 胜）', () => {
  // 非敏感 P1，发件人同时在 noise_senders 与 vip_senders。
  const d = applySafetyRules(
    makeEmail({ fromEmail: 'boss@vip.example' }),
    makeClassification({ priority: 'P1', category: 'work', confidence: 0.9 }),
    makeRules({ noiseSenders: ['boss@vip.example'], vipSenders: ['boss@vip.example'] }),
  );
  assert.equal(d.priority, 'P1'); // vip 胜
  assert.ok(d.appliedRules.includes('noise→P3')); // round-trip 两条共存（预期审计语义）
  assert.ok(d.appliedRules.includes('vip-important→P1'));
  assert.equal(d.shouldMarkRead, false); // floor 抬回 P1 → markRead 自然 false
  assert.equal(d.shouldIncludeDigest, true);
});

test('marketing→noise→floor 顺序：P2 广告 + noise + vip → 终末 P1（三轴各自如实记录）', () => {
  // P2 命中 marketing（P2→P3）；发件人在 noise（P3 已是 P3、noise no-op）；同时 vip（floor P3→P1）。
  const d = applySafetyRules(
    makeEmail({ subject: '限时 sale 大促', fromEmail: 'boss@vip.example' }),
    makeClassification({ priority: 'P2', category: 'work', confidence: 0.9 }),
    makeRules({
      marketingKeywords: ['sale', '大促'],
      noiseSenders: ['boss@vip.example'],
      vipSenders: ['boss@vip.example'],
    }),
  );
  assert.equal(d.priority, 'P1'); // vip 胜
  assert.ok(d.appliedRules.includes('marketing→P3')); // marketing 先把 P2→P3
  assert.ok(!d.appliedRules.includes('noise→P3')); // noise 见到 P3、不在降级集合 → no-op
  assert.ok(d.appliedRules.includes('vip-important→P1')); // floor 再 P3→P1
  assert.equal(d.shouldMarkRead, false);
});
