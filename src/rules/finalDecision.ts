// 规则引擎的权威裁定 FinalDecision（design「FinalDecision 与 Classification 分离」）。
//
// Classification（src/classifier/schema.ts）是 LLM 的「建议」；FinalDecision 是
// applySafetyRules 的「裁定」。下游动作（executeActions/notifier）只认 FinalDecision，
// 禁止直接读原始 Classification 驱动标已读/通知动作。
//
// 字段映射（Classification snake_case → FinalDecision camelCase，见 design 字段表）：
//   should_mark_read       → shouldMarkRead       （忽略建议值，重新派生）
//   should_notify_now      → shouldNotifyNow      （忽略建议值，重新派生）
//   should_include_digest  → shouldIncludeDigest  （忽略建议值，重新派生）
//   risk_flags             → riskFlags            （透传；规则可追加）
//   confidence             → confidence           （透传，引擎不改写）
//   —（规则产出）          → appliedRules         （命中的规则名，便于审计）

import type { Classification } from '../classifier/schema.js';

/** 最终优先级 P0–P4，与 Classification.priority 同枚举。 */
export type Priority = Classification['priority'];

/** 分类，与 Classification.category 同 9 枚举。 */
export type Category = Classification['category'];

/**
 * 规则引擎裁定的最终动作。下游只读它、不读原始 Classification。
 */
export type FinalDecision = {
  /** 最终优先级（规则裁定后，可能覆盖 LLM 建议）。 */
  priority: Priority;
  /** 分类，与 Classification 一致的 9 枚举。 */
  category: Category;
  /** 置信度 0..1，从 Classification.confidence 透传，引擎不改写。 */
  confidence: number;
  /** 是否即时推送（最终优先级 ∈ {P0,P4}）。 */
  shouldNotifyNow: boolean;
  /** 是否标已读（受护栏约束，单调趋安全：一旦置 false 不得翻回）。 */
  shouldMarkRead: boolean;
  /** 是否入摘要（最终优先级 ∈ {P1,P2}）。 */
  shouldIncludeDigest: boolean;
  /** 裁定原因（人类可读，简短）。 */
  reason: string;
  /** 风险标记：Classification.risk_flags 透传，规则命中可追加。 */
  riskFlags: string[];
  /** 命中的规则名（审计用）。 */
  appliedRules: string[];
};
