// IMAP provider 的 ProviderActions 实现（spec「经规则引擎裁定执行真实标已读」、design 决策 3/7）。
//
// 职责：
//   - `markRead`：对 executeActions 裁定要标已读的邮件按其活动 uid `messageFlagsAdd(['\\Seen'])`，幂等。
//   - `reflectPriority`：IMAP 本期 **no-op**（优先级标签是 Gmail 的权威 AI/* 标签能力，IMAP 不打标签）。
//
// CRITICAL 架构点 1（连接共享）：markRead 由 executeActions 在 processEmail 内发起，而
// processEmail 由 poller 在**持有当前已打开连接**时逐封调用——故本 provider 必须操作 poller
// 当前那条连接，**禁止**自己再开一条。所以这里是个工厂 createImapProvider(connection)，由
// poller 每轮用打开的连接构造、作为 processEmail 的 `provider` 注入。
//
// 两条硬约束（spec / design 决策 7）：
//   (1) uid 缺失 → **fail-loud** 抛结构化错误，**禁**静默 no-op（避免「报告成功但实际没标」）。
//   (2) 底层 imapflow 异常 → **脱敏为固定 kind 串、零插值**（不得含 host/IP/port/user/口令/
//       mailbox/IMAP 命令文本）；原始错误只在 debug 日志另记。executeActions 的 redactError 仅
//       截断到 200 字、不剥前缀里的 host，故脱敏**必须**在本层落地（测试断言重抛消息**等于**固定串）。

import { logger } from '../../logger.js';
import type { NormalizedEmail } from '../../normalizer/normalizeEmail.js';
import type { ProviderActions } from '../../actions/providerActions.js';
import type { ImapConnection } from './imapClient.js';

/**
 * markRead 失败时对外抛出的**固定 kind 串**（零插值）。测试断言重抛消息严格等于此串。
 * 改动需同步更新 5.2 断言（这是脱敏契约的一部分，非示例文案）。
 */
export const IMAP_MARK_READ_FAILED = 'imap-mark-read-failed';

/** uid 缺失（poller 未填充）时抛出的**固定 kind 串**（与上面区分，便于审计 fail-loud 路径）。 */
export const IMAP_MARK_READ_MISSING_UID = 'imap-mark-read-missing-uid';

/**
 * markRead 抛出的结构化错误：message **只能**是上面两个固定 kind 串之一，零服务器/账号插值。
 * `kind` 与 message 同值，便于上游按 kind 分支（而非解析 message 文本）。
 */
export class ImapMarkReadError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.name = 'ImapMarkReadError';
    this.kind = kind;
  }
}

/**
 * 用一条**已打开**的 ImapConnection 构造 ProviderActions（连接共享，见文件头 CRITICAL 架构点 1）。
 * poller 每轮拿到打开的连接后调用本工厂，把返回的 provider 注入 processEmail。
 */
export function createImapProvider(connection: ImapConnection): ProviderActions {
  return {
    // reflectPriority：IMAP 本期 no-op（不打优先级标签；幂等、与 markRead 失败隔离天然成立）。
    async reflectPriority(): Promise<void> {},

    async markRead(email: NormalizedEmail): Promise<void> {
      // (1) uid 缺失 → fail-loud（禁静默 no-op）。固定 kind 串，零插值。
      if (typeof email.uid !== 'number' || !Number.isFinite(email.uid)) {
        logger.warn(
          { kind: 'imap-mark-read-missing-uid', providerMessageId: email.providerMessageId },
          'markRead 收到缺活动 uid 的邮件：fail-loud 抛错（禁静默 no-op）',
        );
        throw new ImapMarkReadError(IMAP_MARK_READ_MISSING_UID);
      }

      try {
        // 幂等：messageFlagsAdd 重复加 \Seen 不报错。
        await connection.addSeenFlag(email.uid);
      } catch (err) {
        // (2) 对外抛**固定 kind 串、零插值**；只记标量 code/name（**禁记原始 IMAP 错误 message**——
        // 其内嵌的 host/IMAP 命令文本不受 key-redact 保护，契约禁原始 IMAP 错误文本入日志）。
        logger.warn(
          {
            kind: 'imap-mark-read-failed',
            providerMessageId: email.providerMessageId,
            code: (err as { code?: unknown })?.code,
            errorName: err instanceof Error ? err.name : 'unknown',
          },
          'markRead 底层调用失败（对外脱敏为固定 kind 串；仅记 code/name，不记原始 IMAP 错误文本）',
        );
        throw new ImapMarkReadError(IMAP_MARK_READ_FAILED);
      }
    },
  };
}
