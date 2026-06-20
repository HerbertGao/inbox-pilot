// 安全规则引擎 applySafetyRules（spec「规则引擎为最终动作的唯一权威」、design「确定性裁定，单调趋安全」）。
//
// 本项目最硬的安全边界「LLM 只给建议、动作由规则引擎裁定」落在此处：
//   - Classification 是 LLM 建议；FinalDecision 是规则引擎的权威裁定，下游只认 FinalDecision。
//   - 忽略 classification.should_*（三个建议动作布尔），全部从「最终优先级 + 护栏」重新派生。
//   - confidence 透传、不改写；riskFlags 透传、规则命中可追加。
//   - 纯函数：无 I/O、无副作用、确定性；名单只用内置默认常量（禁读 YAML/外部配置）。
//   - 裁定单调趋安全：任一「强制不标已读」一旦置 false 即粘住，后续禁止翻回 true。
//
// 裁定顺序固定：①最终优先级（验证码主题 P0 > P4 保持 > confidence<0.65 降 P1 > 取建议）
// → ②按 §5 派生默认动作 → ③施加强制不标已读护栏（敏感域名 / 支付·安全关键词命中）。

import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision, Priority } from './finalDecision.js';
import {
  SECURITY_PAYMENT_KEYWORDS,
  SENSITIVE_DOMAINS,
  VERIFICATION_KEYWORDS,
} from './lists.js';

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
 * 发件域命中敏感域名：取 fromEmail 的 @ 后域部分，小写归一后判断
 * 「等于敏感域 或 为其子域」（如 mail.bank.com 命中 bank.com）。
 */
function matchesSensitiveDomain(fromEmail: string): boolean {
  const at = fromEmail.lastIndexOf('@');
  if (at < 0) {
    return false;
  }
  // 取 @ 后的域并归一：剥除显示名/尖括号等包裹（如 "Name <u@bank.com>" / "<u@bank.com>"
  // → bank.com）——只保留合法域字符 [a-z0-9.-]，遇首个非法字符（如尾随 '>'）即止。
  // 本期 fromEmail 由 normalizer/fixture 喂裸地址，此归一是对「敏感域永不自动标已读」硬约束的
  // defense-in-depth，并为 P3/P4 真实 provider 的显示名/尖括号形态预先兜底（防敏感域邮件
  // 因地址形态被静默自动标已读）。
  const rawDomain = fromEmail.slice(at + 1).trim().toLowerCase();
  const domainMatch = rawDomain.match(/^[a-z0-9.-]+/);
  const domain = domainMatch ? domainMatch[0] : '';
  if (domain.length === 0) {
    return false;
  }
  for (const sensitive of SENSITIVE_DOMAINS) {
    if (domain === sensitive || domain.endsWith('.' + sensitive)) {
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

  // —— ② 按 §5 优先级模型派生默认动作 ——
  //   P0/P4 → 通知、不标已读；P1 → 入摘要、不标已读；
  //   P2 → 标已读、入摘要；P3 → 标已读、只计数（不入摘要）。
  const shouldNotifyNow = priority === 'P0' || priority === 'P4';
  const shouldIncludeDigest = priority === 'P1' || priority === 'P2';
  // P0/P1/P4 默认不标已读；仅 P2/P3 默认标已读。
  let shouldMarkRead = priority === 'P2' || priority === 'P3';

  // —— ③ 强制不标已读护栏（覆盖 P2/P3 的标已读；单调趋安全：本块只把 shouldMarkRead 置 false、
  //     绝不翻回 true，故直接赋值即满足单调性）——
  // 敏感域名命中。
  if (matchesSensitiveDomain(email.fromEmail)) {
    shouldMarkRead = false;
    appliedRules.push('sensitive-domain→no-mark-read');
    if (!riskFlags.includes('sensitive-domain')) {
      riskFlags.push('sensitive-domain');
    }
  }
  // 支付/安全关键词命中（主题或正文）。
  if (
    containsAny(subjectLower, SECURITY_PAYMENT_KEYWORDS) ||
    containsAny(bodyLower, SECURITY_PAYMENT_KEYWORDS)
  ) {
    shouldMarkRead = false;
    appliedRules.push('payment-security-keyword→no-mark-read');
  }
  // 验证码词命中（主题或正文）→ 强制不标已读（spec 场景「正文验证码不强制 P0 但不标已读」）。
  // 主题命中验证码时优先级已在 ① 被强制 P0（P0 默认即不标已读）；此护栏对「仅正文含验证码、
  // 主题未命中」的 P2/P3 邮件尤为关键——不强制 P0，但绝不自动标已读。
  if (
    containsAny(subjectLower, VERIFICATION_KEYWORDS) ||
    containsAny(bodyLower, VERIFICATION_KEYWORDS)
  ) {
    shouldMarkRead = false;
    appliedRules.push('verification-keyword→no-mark-read');
  }

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
