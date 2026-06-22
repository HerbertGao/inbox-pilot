// 动作类型与状态（design「executeActions + mail_actions 状态机」、spec「executeActions 按
// FinalDecision 分发并落 mail_actions」）。
//
// 用 union 类型 + const 对象（值伴生），不上重型 enum：
//   - ActionType：'reflect_priority'（调 ProviderActions.reflectPriority，打权威优先级标签）/
//     'mark_read'（调 ProviderActions.markRead）/ 'notify'（调 Notifier）。
//     摘要（shouldIncludeDigest）本期只持久化标记、不产生动作，故无 'digest' 动作类型。
//   - ActionStatus：'pending' 是唯一中间态；'done' / 'failed' / 'skipped' 为终态。
//       done    —— 动作执行成功。
//       failed  —— 执行失败（含 error；单次 executeActions 调用内有界重试耗尽仍失败）。
//       skipped —— 不进入重试循环的有意跳过（如无渠道凭据的 notify）；区别于 failed。

/** 动作类型：reflect_priority（优先级标签，始终调）/ mark_read / notify。 */
export type ActionType = 'reflect_priority' | 'mark_read' | 'notify';

/** 动作状态：pending 唯一中间态，{done,failed,skipped} 终态。 */
export type ActionStatus = 'pending' | 'done' | 'failed' | 'skipped';

/** ActionType 取值（运行期引用，避免裸字符串散落）。 */
export const ActionType = {
  ReflectPriority: 'reflect_priority',
  MarkRead: 'mark_read',
  Notify: 'notify',
} as const satisfies Record<string, ActionType>;

/** ActionStatus 取值（运行期引用）。 */
export const ActionStatus = {
  Pending: 'pending',
  Done: 'done',
  Failed: 'failed',
  Skipped: 'skipped',
} as const satisfies Record<string, ActionStatus>;
