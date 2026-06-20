import { z } from 'zod';

// 分类输出的唯一合法形状（PROJECT_INIT §4.4）。
// zod `safeParse` 是运行期权威校验：任何未过此 schema 的模型输出禁止被采纳。
export const ClassificationSchema = z.object({
  priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']),
  category: z.enum([
    'personal',
    'work',
    'finance',
    'system_alert',
    'security',
    'newsletter',
    'marketing',
    'transaction',
    'unknown',
  ]),
  should_notify_now: z.boolean(),
  should_mark_read: z.boolean(),
  should_include_digest: z.boolean(),
  confidence: z.number().min(0).max(1),
  // reason 长度 ≤120 为权威上限（§11 的「不超过80字」只是给模型的软提示，本期不强制）。
  reason: z.string().max(120),
  risk_flags: z.array(z.string()),
});

export type Classification = z.infer<typeof ClassificationSchema>;

// 用 zod 4 原生 `z.toJSONSchema` 从同一个 schema 派生 json_schema——单一真相源、
// 零漂移、无新依赖。仅作模型 structured-output（json_schema 模式）提示；
// 模型不遵守时仍由上面的 `ClassificationSchema.safeParse` + 重试状态机兜底。
export const classificationJsonSchema = z.toJSONSchema(ClassificationSchema);
