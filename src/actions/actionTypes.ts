// 动作类型与状态（design「executeActions + mail_actions 状态机」、spec「executeActions 按
// FinalDecision 分发并落 mail_actions」）。
//
// 用 union 类型 + const 对象（值伴生），不上重型 enum：
//   - ActionType：'reflect_priority'（调 ProviderActions.reflectPriority，打权威优先级标签）/
//     'mark_read'（调 ProviderActions.markRead）/ 'notify'（调 Notifier）。
//     摘要（shouldIncludeDigest）本期只持久化标记、不产生动作，故无 'digest' 动作类型。
//   - ActionStatus：中间态 = {pending, retrying}；终态 = {done, failed, skipped, dead_letter}。
//       pending     —— 唯一的「执行中」初态（recordAction 落点；崩溃残留行复用）。
//       done        —— 动作执行成功。
//       failed      —— **致命通道**终态：reauth（ProviderReauthRequired）/ repo-I/O 向上传播路径
//                      落此并 re-throw；**不可重试、不被 drain 选中**。仍是合法终态、禁从枚举丢掉
//                      （任何按「是否终态」门控的消费者须含 failed，否则误判）。
//       skipped     —— 不进入重试循环的有意跳过（如无渠道凭据的 notify）；区别于 failed。
//       retrying    —— durable-retry 中间态：发送态瞬时失败耗尽落此（带 retryCount/nextRetryAt），
//                      由 poll 内 drain 跨重启重试至成功或死信（durable-retry 决策 2）。
//       dead_letter —— durable-retry 终态：retryCount 达 MAX_DURABLE_ATTEMPTS 或超 notify staleness
//                      上界落此（可查 + 脱敏日志，**绝不**自动再试）。

/** 动作类型：reflect_priority（优先级标签，始终调）/ mark_read / notify。 */
export type ActionType = 'reflect_priority' | 'mark_read' | 'notify';

/**
 * 动作状态：中间态 = {pending, retrying}，终态 = {done, failed, skipped, dead_letter}。
 * `retrying`/`dead_letter` 为 durable-retry 新增（status 仍自由 String、无 enum 迁移）。
 */
export type ActionStatus =
  | 'pending'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'retrying'
  | 'dead_letter';

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
  Retrying: 'retrying',
  DeadLetter: 'dead_letter',
} as const satisfies Record<string, ActionStatus>;
