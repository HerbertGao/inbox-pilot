// ProviderActions seam（design 决策 3「ProviderActions（markRead, reflectPriority）」、
// spec account-registry「需求:Provider 抽象统一两种 provider」）。
//
// 真正的标已读 / 优先级标签等 provider I/O 必须经此可注入 seam，让整条流水线离线可测。
// executeActions 持有本 seam（由 pollOnce 在**本轮连接内**构造注入，IMAP 连接共享硬约束）。
// 真实实现：IMAP（imapActions：markRead 加 \Seen / reflectPriority no-op）、Gmail（后续组）。
//
// 硬约束：本 seam 只做读侧动作（标已读 / 打标签等），绝不发送/回复邮件——通知走 Notifier。

import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';

/**
 * provider 侧动作 seam。executeActions 经此发起标已读与优先级落地，禁止分类器/规则引擎自行调用
 * provider I/O。真实实现（IMAP/Gmail）与测试假 provider 共用此契约。
 *
 * **账号级致命错误**：方法遇 token 撤销 / scope 403 等账号级失效须抛 `ProviderReauthRequired`
 * （src/providers/provider.ts），executeActions 重抛、scheduler 隔离该账号——区别于发送态瞬时失败。
 */
// 每方法可选 `signal?: AbortSignal`（design D7 best-effort 取消）：executeActions 由 per-email 超时 abort
// 时透传，底层 gmail.modify 尽力中止在途调用；缺省 undefined，既有调用点不受影响。
export type ProviderActions = {
  /** 把指定邮件标为已读（真实实现应幂等：重复标已读不报错）。 */
  markRead(email: NormalizedEmail, signal?: AbortSignal): Promise<void>;
  /**
   * 把最终优先级落到 provider 维度（Gmail 加权威 `AI/P*` 标签；IMAP 本期 no-op）。
   * **始终**被 executeActions 调用（标签是分类可见性，不被 shouldMarkRead 门控）；**幂等**。
   */
  reflectPriority(email: NormalizedEmail, decision: FinalDecision, signal?: AbortSignal): Promise<void>;
};
