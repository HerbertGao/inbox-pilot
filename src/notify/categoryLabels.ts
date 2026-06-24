// category 英文枚举 → 中文 hashtag 标签的单点映射（design 决策 2、spec notifications「中文分类」）。
//
// 渲染层只读本表，禁止直接渲染英文枚举名（如 system_alert）。
// 用 `Record<Category, string>` 作类型：新增 category 枚举臂若漏配中文映射 → **构建期失败**
// （`tsc --noEmit` 守门，验收 6.1）；switch+default 会静默回退英文，故弃。
// 5.1 运行期遍历 ClassificationSchema 全枚举臂断言都有映射作双保险。

import type { Category } from '../rules/finalDecision.js';

/** category → 中文展示名（覆盖全部 9 枚举；缺一臂即编译失败）。 */
export const CATEGORY_LABELS: Record<Category, string> = {
  personal: '个人',
  work: '工作',
  finance: '财务',
  system_alert: '系统告警',
  security: '安全',
  newsletter: '资讯',
  marketing: '营销',
  transaction: '交易',
  unknown: '未知',
};
