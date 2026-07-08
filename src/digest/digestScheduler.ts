// 一轮每日摘要编排（原 digestScheduler 的 runOnce 语义）。
//
// **DIGEST_TIMES / node-cron 调度已退役**（add-multi-trigger）：调度移到 `app.yaml` 的 `digest` 触发器
// cron 数组 + hangar daemon（脊柱通用多触发）。原 `startDigestSchedulers`/`parseDigestTimes`/`createSharedLockRunner`
// （进程内共享锁——现由 daemon 单活跃-run + per-app 序列化替代）已删；只留一轮编排供 pipeline 的 runDigest 复用。
//
// runDigestOnce（逐段提交 + 错误隔离）：build → 逐段 `if ((await notifyDigest(seg.text)).outcome !== 'sent') return;`
// 再 `markDigested(seg.messageRowIds)`——**每段发成功即 mark 该段**、遇首个非 sent 即停、其后段不发不 mark、
// 下轮重试；build 为 null → emit digest.empty 不推。审计经**注入的 emit seam**（pipeline runDigest 传 ctx.emit
// → 写 RunEvent；kind：digest.sent/digest.empty/digest.failed，非 PII）而非模块 logger。**自身不抛**
// （catch → emit digest.failed，记脱敏 errorName/errorCode）。

import { buildDigest } from './buildDigest.js';
import type { Notifier } from '../notify/notifier.js';
import { DIGEST_TYPE_DAILY, type MailRepo } from '../repo/mailRepo.js';

/** 一轮编排的最小依赖切片（注入式，使一轮编排可离线测试，不依赖真实 cron timing）。 */
export type DigestRunDeps = {
  /** 查候选 + 落库 + Top-N 频率快照 seam（buildDigest 读 listDigestCandidates+countRecentSenders；编排再 markDigested）。 */
  readonly repo: Pick<MailRepo, 'listDigestCandidates' | 'countRecentSenders' | 'markDigested'>;
  /** 摘要出口（逐段 notifyDigest）。 */
  readonly notifier: Pick<Notifier, 'notifyDigest'>;
  /** 调用时刻（注入 `() => Date` 时钟，使编排可测）。 */
  readonly now: () => Date;
  /**
   * 审计出口（非 PII kind：digest.sent/digest.empty/digest.failed）。pipeline 的 runDigest 注入 ctx.emit
   * → 写 RunEvent.payload_json；测试注入记录器断言。脊柱零域——kind 由本域码约定、刻意不撞脊柱 STATE_BY_KIND。
   */
  readonly emit: (kind: string, payload?: object) => void;
};

/**
 * 一轮摘要编排（逐段提交 + 运行期错误隔离，**不**含调度/锁——单活跃-run 由 hangar daemon 保证）。
 * build → 逐段：`if ((await notifyDigest(seg.text)).outcome !== 'sent') return;` 再 `markDigested(seg.messageRowIds)`
 * （**每段发成功即 mark 该段**、遇首个非 sent 即停、其后段不发不 mark、下轮重试）。build 为 null → emit digest.empty 返回。
 * catch → emit digest.failed（记**脱敏** errorName/errorCode，**绝不**记原始 error/cause/正文/收件人 PII/凭据）。**自身不抛**。
 */
export async function runDigestOnce(deps: DigestRunDeps): Promise<void> {
  const { repo, notifier, now, emit } = deps;
  const at = now();
  try {
    const d = await buildDigest(repo, at);
    if (d === null) {
      // 无可入摘要邮件（无 P1/P2 且 P3 计数为 0）→ 禁推空摘要，只审计（design / spec）。
      emit('digest.empty');
      return;
    }
    for (const seg of d.segments) {
      const result = await notifier.notifyDigest(seg.text);
      if (result.outcome !== 'sent') {
        // 遇首个非 sent（failed/skipped）即停：本段及其后段不 mark，下轮重试（不丢件）。
        emit('digest.failed', { outcome: result.outcome });
        return;
      }
      // 该段发成功即提交：markDigested 该段 row-ids（含 P3 段的 P3 row-ids），已 mark 段下轮不重发。
      await repo.markDigested(seg.messageRowIds, DIGEST_TYPE_DAILY, at);
      emit('digest.sent', { segmentRowCount: seg.messageRowIds.length });
    }
  } catch (err) {
    // 运行期错误隔离：只记**脱敏** errorName/errorCode（标量），**绝不**记原始 error/cause/正文/收件人 PII/凭据。
    const rawCode = (err as { code?: unknown })?.code;
    const errorCode =
      typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined;
    emit('digest.failed', {
      errorName: err instanceof Error ? err.name : 'unknown',
      errorCode,
    });
  }
}
