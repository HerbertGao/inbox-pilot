// 流水线 processEmail（spec「去重幂等、重启不重复」「流水线顺序与重启安全」、design §10）。
//
// 编排单封已规范化邮件的完整处理：去重 → 落库 → 分类 → 规则裁定 → 落库分类 → 执行动作 → 标记处理完。
// 接收**已规范化**的单封 NormalizedEmail —— provider 在调用前完成 normalize + 单封 throw 隔离
// （P3/P4 轮询循环的义务）；本期 processEmail 不承担批量 normalize 与隔离。
//
// 固定顺序与重启安全（design §10，逐条对应 spec）：
//   findByDedupKey(accountId, providerMessageId)
//     → 命中且 processedAt 非空 → **跳过**（直接 return：不分类、不执行任何动作、不新增 mail_actions）
//     → saveEmail（幂等 upsert，拿到 messageRowId；崩溃重跑复用未处理行，不二次插入触发唯一键冲突）
//     → classifyEmail（LLM 建议；P1 已尽量返回降级 Classification 而非抛）
//     → applySafetyRules（规则引擎的权威裁定 → FinalDecision）
//     → saveClassification（落 raw vs final 可恢复映射）
//     → executeActions（按 FinalDecision 分发动作、落 mail_actions）
//     → **最后** markProcessed（置 processedAt）。
//
//   markProcessed **必须放最后**：崩在动作中途（未置 processedAt）→ 下次 processEmail 重跑
//   （at-least-once；标已读幂等；推送 at-least-once 极端可能重复一次，MVP 接受）。
//   markProcessed **不以通知成功为前提** —— executeActions 不抛（失败只落 mail_actions）；
//   P0/P4 通知重试耗尽仍 failed 时 markProcessed 仍照常，该邮件不再重试（at-most-once-after-retry）。
//
//   若 classifyEmail 抛出（耗尽 P1 重试）→ processEmail **不吞异常、不置 processedAt**，向上抛留待重跑。

import { logger } from '../logger.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { Classification } from '../classifier/schema.js';
import { classifyEmail } from '../classifier/classifyEmail.js';
import { applySafetyRules } from '../rules/applySafetyRules.js';
import { PrismaMailRepo, type MailRepo } from '../repo/mailRepo.js';
import { defaultNotifier, type Notifier } from '../notify/notifier.js';
import type { ProviderActions } from '../actions/providerActions.js';
import { executeActions } from '../actions/executeActions.js';

/** classifyEmail 的 seam 形状（默认真身 classifyEmail；测试注入假 classify）。 */
export type ClassifyFn = (email: NormalizedEmail) => Promise<Classification>;

/**
 * processEmail 的可注入依赖（design「三个可注入 seam」）。
 * 默认接真身、测试注入假体；唯独 provider 无默认 —— 本期无真实实现。
 */
export type ProcessEmailDeps = {
  /** 落库 seam。默认 new PrismaMailRepo()（真身）；测试注入 InMemoryMailRepo。 */
  readonly repo?: MailRepo;
  /**
   * provider 侧动作 seam（标已读）。**必须注入**、无静默假默认 ——
   * 真实 IMAP/Gmail 标已读属 P3/P4，缺省假默认会在未来真实运行时静默 no-op 标已读。
   * ponytail: P3/P4 注入真实 provider（IMAP/Gmail），测试注入 FakeProviderActions。
   */
  readonly provider: ProviderActions;
  /** 通知 seam。默认 defaultNotifier（telegram from config）；测试注入假渠道。 */
  readonly notifier?: Notifier;
  /** 分类 seam。默认真身 classifyEmail；测试注入假 classify。 */
  readonly classify?: ClassifyFn;
};

/**
 * 处理单封已规范化邮件（固定顺序见文件头）。幂等：已处理（processedAt 非空）的邮件直接跳过。
 *
 * @param email 已经 normalizeEmail 收敛过的单封邮件（provider 负责 normalize + 单封隔离）。
 * @param deps  可注入 seam；provider 必须注入（无默认），其余默认接真身。
 */
export async function processEmail(
  email: NormalizedEmail,
  deps: ProcessEmailDeps,
): Promise<void> {
  const repo: MailRepo = deps.repo ?? new PrismaMailRepo();
  const notifier: Notifier = deps.notifier ?? defaultNotifier;
  const classify: ClassifyFn = deps.classify ?? classifyEmail;
  const provider = deps.provider;

  // —— 去重幂等：命中且已处理 → 跳过（不分类、不执行任何动作、不新增 mail_actions）——
  const existing = await repo.findByDedupKey(email.accountId, email.providerMessageId);
  if (existing !== null && existing.processedAt !== null) {
    logger.info(
      { kind: 'process-skip-already-done', messageRowId: existing.id },
      '邮件已处理（processedAt 非空），跳过',
    );
    return;
  }

  // —— 先落库使去重键存在（幂等 upsert）；崩溃重跑复用已存未处理行，不二次插入 ——
  const stored = await repo.saveEmail(email);
  const messageRowId = stored.id;

  // —— 分类（LLM 建议）。若抛出 → 不吞异常、不置 processedAt、向上抛留待重跑 ——
  const classification = await classify(email);

  // —— 规则引擎的权威裁定（下游只认 FinalDecision）——
  const decision = applySafetyRules(email, classification);

  // —— 落库分类/裁定（raw vs final 可恢复映射）——
  await repo.saveClassification(messageRowId, classification, decision);

  // —— 按 FinalDecision 分发动作（落 mail_actions）。executeActions 不抛：单动作失败只落终态 ——
  await executeActions(email, decision, messageRowId, { repo, provider, notifier });

  // —— 最后置 processedAt（放在所有动作之后：崩在动作中途 → 下次重跑）——
  await repo.markProcessed(messageRowId);
}
