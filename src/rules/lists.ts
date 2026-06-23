// 安全规则引擎用的内置默认名单（design「名单用内置默认」、spec「名单用内置默认」）。
//
// 本期（P2）这些名单一律来自代码内置常量，禁止依赖 YAML 或外部配置文件——
// 可配化是 P6（届时只换数据源、不改引擎）。参考 PROJECT_INIT §12.2 的示例。
//
// 关键词大小写：匹配方应在 applySafetyRules（组 B）里对主题/正文与关键词同做
// 小写归一后比较；此处常量统一以小写英文给出，中文不区分大小写。

import type { Classification } from '../classifier/schema.js';

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
 * 支付/安全/医院/保险关键词。主题或正文命中 → 强制 shouldMarkRead=false（护栏）。
 * 参考 §12.2 security_keywords。
 *
 * 承载硬约束、非示例列表，增删需对照硬约束（PROJECT_INIT 硬约束「敏感邮件不自动标已读」、
 * 「银行/医院/保险/支付/合同 永不自动标已读」）。
 * 医院/保险类关键词是该硬约束的**唯一确定性兜底**——9 类别枚举（schema.ts）无 medical/insurance
 * 对应项，故引入专用类别枚举属超范围（设计取舍：用确定性关键词轴守硬约束）。命中即必不标已读。
 * 全部以小写英文给出（匹配方对主题/正文同做小写归一），中文不区分大小写。
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
  // 医院/保险类（承载硬约束的确定性兜底，增删需对照硬约束——不得静默删词）。
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
];

/**
 * 敏感类别（类别轴）：最终 `category ∈ 此集合` → 强制 shouldMarkRead=false（护栏）。
 * 消费 LLM 透传的 `category`、引擎不改写。这些值均存在于 9 类别枚举（schema.ts）。
 *   - finance：银行类；security：安全类；transaction：支付/交易类。
 * 概率性广覆盖（召回广但非确定）——与 SECURITY_PAYMENT_KEYWORDS 的确定性兜底分层互补。
 * 医院/保险无对应类别枚举，由上面的关键词轴确定性守住，**不在此集合**。
 * 类型绑定到 `Classification['category']`：非法/拼错的类别值编译期即报错（守护此关键名单）。
 */
export const SENSITIVE_CATEGORIES: ReadonlySet<Classification['category']> = new Set<
  Classification['category']
>(['finance', 'security', 'transaction']);
