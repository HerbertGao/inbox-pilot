// 安全规则引擎 applySafetyRules（spec「规则引擎为最终动作的唯一权威」、design「确定性裁定，单调趋安全」）。
//
// 本项目最硬的安全边界「LLM 只给建议、动作由规则引擎裁定」落在此处：
//   - Classification 是 LLM 建议；FinalDecision 是规则引擎的权威裁定，下游只认 FinalDecision。
//   - 忽略 classification.should_*（三个建议动作布尔），全部从「最终优先级 + 护栏」重新派生。
//   - confidence 透传、不改写；riskFlags 透传、规则命中可追加。
//   - 纯函数：无 I/O、无副作用、确定性；可配置名单从 rules-config（getActiveRules()）取，
//     可经可选 `rules` 参注入测试快照（缺省 = getActiveRules()，保持同步纯函数与现有调用点不变）。
//     验证码关键词 / 敏感类别集保持代码内置（不经 YAML 覆盖）。
//   - 裁定单调趋安全：任一「强制不标已读」一旦置 false 即粘住，后续禁止翻回 true。
//
// 裁定顺序固定（design 决策 6 精确有序管线、终末阶段、空默认、加性）：
//   ① 最终优先级（验证码主题 P0 > P4 保持 > confidence<0.65 降 P1 > 取建议）
//   ② 算四轴敏感守卫 sensitiveGuardFired（类别 ∨ 关键词 ∨ 验证码关键词(主题/正文) ∨ 域名）
//   ③ marketing 轴：priority==='P2' ∧ ¬sensitiveGuardFired ∧ 命中 → P3（只动 P2）
//   ④ floor 轴（vip/important）：priority∈{P2,P3} ∧ (vip ∨ important) → P1（显式条件、非 max；marketing 在前）
//   ⑤ 从终末 priority 派生动作；shouldMarkRead 只算一次（敏感守卫 false 粘住）。

import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision, Priority } from './finalDecision.js';
import { SENSITIVE_CATEGORIES, VERIFICATION_KEYWORDS } from './lists.js';
import { getActiveRules, type ActiveRules } from './rulesConfig.js';

/** confidence 低于此阈值（严格小于）→ 降级 P1。confidence===0.65 不降级。 */
const CONFIDENCE_FLOOR = 0.65;

/** 任一关键词（已小写）出现在文本（已小写）中即命中。 */
function containsAny(haystackLower: string, keywords: readonly string[]): boolean {
  for (const kw of keywords) {
    if (haystackLower.includes(kw)) {
      return true;
    }
  }
  return false;
}

/**
 * 取 fromEmail 的 @ 后域部分并小写归一：剥除显示名/尖括号等包裹
 * （如 "Name <u@bank.com>" / "<u@bank.com>" → bank.com）——只保留合法域字符 [a-z0-9.-]，
 * 遇首个非法字符（如尾随 '>'）即止。无 @ 或域为空 → 返回空串。
 * 本期 fromEmail 由 normalizer/fixture 喂裸地址，此归一是对「敏感域永不自动标已读」硬约束的
 * defense-in-depth，并为 P3/P4 真实 provider 的显示名/尖括号形态预先兜底。
 */
function normalizeFromDomain(fromEmail: string): string {
  const at = fromEmail.lastIndexOf('@');
  if (at < 0) {
    return '';
  }
  const rawDomain = fromEmail.slice(at + 1).trim().toLowerCase();
  const domainMatch = rawDomain.match(/^[a-z0-9.-]+/);
  return domainMatch ? domainMatch[0] : '';
}

/**
 * 发件域命中给定域名列表：归一发件域后判断「等于某域 或 为其子域」
 * （如 mail.bank.com 命中 bank.com）。域名轴与 important_domains 轴共用此 helper。
 * 各域名列表项视为已小写（rules-config 与内置常量约定小写）。
 */
function matchesDomain(fromEmail: string, domains: readonly string[]): boolean {
  const domain = normalizeFromDomain(fromEmail);
  if (domain.length === 0) {
    return false;
  }
  for (const d of domains) {
    if (domain === d || domain.endsWith('.' + d)) {
      return true;
    }
  }
  return false;
}

/**
 * 归一发件人裸地址（剥显示名/尖括号得 user@host、小写）——用于 vip_senders 精确匹配。
 * 如 "Name <U@Example.com>" → "u@example.com"；无法定位裸地址时返回空串（不匹配）。
 */
function normalizeFromAddress(fromEmail: string): string {
  // 优先取尖括号内地址（显示名形态）；否则取整串。
  const angle = fromEmail.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : fromEmail).trim().toLowerCase();
  // 裸地址须形如 local@domain（domain 为合法域字符）。匹配失败 → 空串。
  const m = raw.match(/^[^\s<>@]+@[a-z0-9.-]+/);
  return m ? m[0] : '';
}

/**
 * 发件人精确命中 vip_senders（与归一后裸地址逐项小写精确比较；列表项视为已小写）。
 */
function matchesVipSender(fromEmail: string, vipSenders: readonly string[]): boolean {
  const addr = normalizeFromAddress(fromEmail);
  if (addr.length === 0) {
    return false;
  }
  for (const v of vipSenders) {
    if (addr === v) {
      return true;
    }
  }
  return false;
}

/**
 * 规则引擎的唯一权威裁定：把 LLM 建议（Classification）裁定为最终动作（FinalDecision）。
 * 纯函数、无副作用、确定性、单调趋安全。
 */
export function applySafetyRules(
  email: NormalizedEmail,
  classification: Classification,
  // 可选注入 seam：缺省取当前 rules-config 快照。保持同步纯函数；现有 2-arg 调用点不变。
  // 单测经此参注入快照（含 operator never_mark_read_domains / vip / important / marketing）测各轴。
  rules: ActiveRules = getActiveRules(),
): FinalDecision {
  const appliedRules: string[] = [];
  // riskFlags 透传（复制，避免别名共享 classification 内部数组）；规则命中可追加。
  const riskFlags: string[] = [...classification.risk_flags];

  // 小写归一文本（名单匹配方对主题/正文与关键词同做小写归一，见 lists.ts 注释）。
  const subjectLower = email.subject.toLowerCase();
  const bodyLower = (email.textBody ?? '').toLowerCase();

  // —— ① 最终优先级裁定（固定顺序、安全强制不被低置信度下调）——
  const subjectHasVerification = containsAny(subjectLower, VERIFICATION_KEYWORDS);

  let priority: Priority;
  if (subjectHasVerification) {
    // 仅主题命中验证码 → 强制 P0（对齐 §12 subjectContainsVerificationCode）。
    // P0 是确定性安全强制，不被 confidence<0.65 降级。
    priority = 'P0';
    appliedRules.push('subject-verification-code→P0');
    if (!riskFlags.includes('verification-code')) {
      riskFlags.push('verification-code');
    }
  } else if (classification.priority === 'P4') {
    // P4（风险）是确定性安全强制 → 保持，不被 confidence<0.65 降级为 P1。
    priority = 'P4';
    appliedRules.push('p4-risk→keep');
  } else if (classification.confidence < CONFIDENCE_FLOOR) {
    // 低置信度仅下调 LLM 的优先级建议 → 降级 P1。
    priority = 'P1';
    appliedRules.push('low-confidence→P1');
  } else {
    // 取 LLM 建议优先级。
    priority = classification.priority;
  }

  // —— ② 算四轴敏感守卫 sensitiveGuardFired（决定「强制不标已读」；与既有 block ③ 全部四守卫一致，
  //     含正文验证码轴，本期重写不得丢轴）。各轴命中仍 push 对应 appliedRules 审计。——
  // 类别轴：最终 category ∈ SENSITIVE_CATEGORIES（finance/security/transaction）。
  // 消费 LLM 透传的 category（引擎不改写，故等同于最终 decision.category）；概率性广覆盖，
  // 与确定性关键词轴分层互补。医院/保险无对应类别枚举，由 security 关键词轴守住。
  const categoryAxis = SENSITIVE_CATEGORIES.has(classification.category);
  if (categoryAxis) {
    appliedRules.push('sensitive-category→no-mark-read');
  }
  // 关键词轴：主题或正文命中 security 关键词（有效集 = 整个内置 SECURITY_PAYMENT_KEYWORDS ∪ YAML，
  // 只增不减；由 rules.securityKeywords 提供）。
  const keywordAxis =
    containsAny(subjectLower, rules.securityKeywords) ||
    containsAny(bodyLower, rules.securityKeywords);
  if (keywordAxis) {
    appliedRules.push('payment-security-keyword→no-mark-read');
  }
  // 验证码关键词轴：主题或正文命中内置 VERIFICATION_KEYWORDS（内置、不可 YAML 配）。
  // 主题命中验证码时优先级已在 ① 被强制 P0（P0 默认即不标已读）；此轴对「仅正文含验证码、
  // 主题未命中」的 P2/P3 邮件尤为关键——不强制 P0，但绝不自动标已读。
  const verificationAxis =
    containsAny(subjectLower, VERIFICATION_KEYWORDS) ||
    containsAny(bodyLower, VERIFICATION_KEYWORDS);
  if (verificationAxis) {
    appliedRules.push('verification-keyword→no-mark-read');
  }
  // 域名轴（可选、非决定性）：发件域命中 rules.neverMarkReadDomains（内置默认空、operator 经 YAML 配）。
  const domainAxis = matchesDomain(email.fromEmail, rules.neverMarkReadDomains);
  if (domainAxis) {
    appliedRules.push('sensitive-domain→no-mark-read');
    if (!riskFlags.includes('sensitive-domain')) {
      riskFlags.push('sensitive-domain');
    }
  }

  const sensitiveGuardFired = categoryAxis || keywordAxis || verificationAxis || domainAxis;

  // —— ③ 新增 marketing 轴（仅下调 P2→P3、绝不碰 P0/P1/P4/敏感，含高置信 P1）——
  // priority==='P2' ∧ ¬sensitiveGuardFired ∧ 命中 marketing_keywords（主题或正文）→ P3。
  if (
    priority === 'P2' &&
    !sensitiveGuardFired &&
    (containsAny(subjectLower, rules.marketingKeywords) ||
      containsAny(bodyLower, rules.marketingKeywords))
  ) {
    priority = 'P3';
    appliedRules.push('marketing→P3');
  }

  // —— ④ 新增 floor 轴（vip/important、urgency-floor 显式条件、禁 max() 字面量）——
  // priority∈{P2,P3} ∧ (发件人∈vip_senders ∨ 发件域∈important_domains) → P1；∈{P0,P1,P4} no-op。
  // marketing 在 floor 之前：vip 发来的广告先 P2→P3、再 P3→P1，终为 P1（vip 胜）。
  if (priority === 'P2' || priority === 'P3') {
    if (
      matchesVipSender(email.fromEmail, rules.vipSenders) ||
      matchesDomain(email.fromEmail, rules.importantDomains)
    ) {
      priority = 'P1';
      appliedRules.push('vip-important→P1');
    }
  }

  // —— ⑤ 从终末 priority 派生动作 ——
  //   P0/P4 → 通知、不标已读；P1 → 入摘要、不标已读；
  //   P2 → 标已读、入摘要；P3 → 标已读、只计数（不入摘要）。
  const shouldNotifyNow = priority === 'P0' || priority === 'P4';
  const shouldIncludeDigest = priority === 'P1' || priority === 'P2';
  // shouldMarkRead 只算一次：仅 P2/P3 默认标已读，且敏感守卫 false 即粘住（绝不翻回 true）。
  // floor 把 P2/P3 抬到 P1 → markRead 自然 false（安全方向）；marketing 只在 P2 非敏感时下调 → 语义一致。
  const shouldMarkRead = (priority === 'P2' || priority === 'P3') && !sensitiveGuardFired;

  // reason：保留 LLM 的人类可读原因；裁定细节由 appliedRules 审计承载。
  const reason = classification.reason;

  return {
    priority,
    category: classification.category,
    // confidence 透传，引擎不改写（仅作 <0.65 降级判断的输入）。
    confidence: classification.confidence,
    shouldNotifyNow,
    shouldMarkRead,
    shouldIncludeDigest,
    reason,
    riskFlags,
    appliedRules,
  };
}
