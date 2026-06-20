// ProviderActions seam（design「ProviderActions（markRead(email)…）：本期假 provider…，
// 真实 IMAP/Gmail 在 P3/P4」、spec「动作 I/O 经可注入 seam（本期假 provider）」）。
//
// 真正的标已读/移动文件夹等 provider I/O 必须经此可注入 seam，让整条流水线离线可测。
// 本期只提供「假 provider」（记录调用、不连真实邮箱）；真实 IMAP/Gmail 实现属 P3/P4。
//
// 硬约束：本 seam 只做读侧动作（标已读等），绝不发送/回复邮件——通知走 Notifier 推聊天渠道。

import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

/**
 * provider 侧动作 seam。executeActions 经此发起标已读，禁止分类器/规则引擎自行调用 provider I/O。
 * 真实实现（P3/P4）与本期假 provider 共用此契约。按需扩展方法（移动文件夹等留后续阶段）。
 */
export type ProviderActions = {
  /** 把指定邮件标为已读（真实实现应幂等：重复标已读不报错）。 */
  markRead(email: NormalizedEmail): Promise<void>;
};

/**
 * 假 provider：记录被请求标已读的邮件（用于离线断言），不连真实邮箱、不发任何网络请求、
 * 绝不发送/回复邮件。测试可读 `markReadCalls` 断言 executeActions 是否按 FinalDecision 发起标已读。
 */
export class FakeProviderActions implements ProviderActions {
  /** 所有被请求标已读的邮件（按调用顺序）。 */
  readonly markReadCalls: NormalizedEmail[] = [];

  async markRead(email: NormalizedEmail): Promise<void> {
    this.markReadCalls.push(email);
  }
}
