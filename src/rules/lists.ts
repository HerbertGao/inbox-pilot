// 安全规则引擎用的内置默认名单（design「名单用内置默认」、spec「名单用内置默认」）。
//
// 本期（P2）这些名单一律来自代码内置常量，禁止依赖 YAML 或外部配置文件——
// 可配化是 P6（届时只换数据源、不改引擎）。参考 PROJECT_INIT §12.2 的示例。
//
// 关键词大小写：匹配方应在 applySafetyRules（组 B）里对主题/正文与关键词同做
// 小写归一后比较；此处常量统一以小写英文给出，中文不区分大小写。

/**
 * 验证码关键词。主题命中→强制 P0（仅主题，对齐 §12 subjectContainsVerificationCode）；
 * 正文命中→走「强制不标已读护栏」，不强制 P0。
 */
export const VERIFICATION_KEYWORDS: readonly string[] = [
  '验证码',
  'verification code',
  'verification-code',
  'one-time code',
  'one time password',
  'otp',
  '动态码',
  '校验码',
];

/**
 * 支付/安全关键词。主题或正文命中 → 强制 shouldMarkRead=false（护栏）。
 * 参考 §12.2 security_keywords。
 */
export const SECURITY_PAYMENT_KEYWORDS: readonly string[] = [
  'invoice',
  'payment',
  'password reset',
  'reset your password',
  'suspicious login',
  'unusual activity',
  'contract',
  '账单',
  '支付',
  '付款',
  '异常登录',
  '安全提醒',
  '重置密码',
  '合同',
];

/**
 * 敏感发件域名（银行/医院/保险/支付/合同类）。发件域命中 → 强制
 * shouldMarkRead=false（护栏）。参考 §12.2 never_mark_read_domains。
 * 匹配方应对发件域同做小写归一，并按「等于该域或为其子域」判断。
 */
export const SENSITIVE_DOMAINS: readonly string[] = [
  'bank.com',
  'hospital.com',
  'insurance.com',
  // 支付/合同类（硬约束「银行/医院/保险/支付/合同」明列五类，发件域轴需对齐枚举）。
  // 占位示例，真实/完整名单 P6 YAML 可配（内容轴另由 SECURITY_PAYMENT_KEYWORDS 覆盖）。
  'payment.com',
  'contract.com',
];
