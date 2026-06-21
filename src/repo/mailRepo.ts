// MailRepo seam（design「MailRepo（findByDedupKey / saveEmail / saveClassification /
// recordAction+updateAction / markProcessed）：prisma 实现为真身，测试用内存实现。把 prisma
// 细节挡在 processEmail 外」、spec「落库处理记录」「动作 I/O 经可注入 seam」）。
//
// processEmail / executeActions 只依赖此接口，prisma 细节不外泄；测试注入内存实现离线可测。
//
// 落库映射（design「落库映射（raw vs final 可恢复，无需迁移）」硬规格）：
//   - mail_classifications.confidence  ← 透传的 Classification.confidence（引擎不改写）。
//   - mail_classifications.priority/category/reason ← FinalDecision（规则裁定后的最终值）。
//   - rawAiJson ← { aiClassification: <原始 Classification>, finalDecision: <审计块> }。
//     finalDecision 块**不含** final priority/category/reason/confidence——它们在专列、不重复。

import { prisma } from '../db/prisma.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { ActionStatus, ActionType } from '../actions/actionTypes.js';

/** 已存邮件行的最小投影（processEmail 去重判定只需 id + processedAt）。 */
export type StoredEmail = {
  id: string;
  processedAt: Date | null;
};

/**
 * DB 锚定行的最小入参（design 决策 1：env 是真相源，DB 仅存一行锚定）。
 * id = accountId（去重键），provider/email 为只写 denormalization、非真相源。
 * 口令绝不入此结构——仍只在 env / accountService 的内存对象（authJson 永远是空对象）。
 */
export type AnchorAccount = {
  accountId: string;
  /** best-effort denormalization（IMAP_USER 可能是登录名而非邮箱）；非真相源。 */
  email: string;
};

/**
 * mail_accounts 锚定 upsert 的调用参数形状（spec「需求:IMAP 账号加载与持久化锚定」）。
 * 与 prisma upsert 的 where/create/update 对齐。**两处必须钉死**：
 *   (a) where.id === create.id === accountId（覆盖 @default(cuid())，否则 id≠accountId、
 *       mail_messages.accountId 外键仍违约）；
 *   (b) create.authJson 为**非空空对象** {}（列为非空 Json、无默认，置 null 触发 NOT NULL
 *       违约——口令仍只在 env、绝不入此行）。
 */
export type AnchorUpsertArgs = {
  where: { id: string };
  create: {
    id: string;
    provider: 'imap';
    email: string;
    authJson: Record<string, never>;
    enabled: true;
  };
  update: Record<string, never>;
};

/**
 * 由账号纯函数构造锚定 upsert 参数（无副作用、无 DB——供 3.3 call-shape spy 在 CI 捕获
 * id≠accountId 回归）。PrismaMailRepo.ensureAccountAnchor 直接喂给 prisma.mailAccount.upsert。
 */
export function buildAnchorUpsertArgs(account: AnchorAccount): AnchorUpsertArgs {
  return {
    where: { id: account.accountId },
    create: {
      // (a) 显式 id = accountId，覆盖 @default(cuid())。
      id: account.accountId,
      provider: 'imap',
      // best-effort denormalization；非真相源。
      email: account.email,
      // (b) 非空空对象 {}（口令绝不入此行）。
      authJson: {},
      enabled: true,
    },
    update: {},
  };
}

/**
 * rawAiJson 的审计块：原始 AI 建议 + 最终裁定的「非专列」字段。
 * 不含 final priority/category/reason/confidence——它们已落 mail_classifications 专列、不重复存储。
 * 完整 FinalDecision = 专列（priority/category/reason + 透传 confidence）+ 此块。
 */
export type RawAiJson = {
  aiClassification: Classification;
  finalDecision: {
    appliedRules: string[];
    shouldNotifyNow: boolean;
    shouldMarkRead: boolean;
    shouldIncludeDigest: boolean;
    riskFlags: string[];
  };
};

/**
 * 落库 / provider seam（除真正的标已读/通知 I/O，那走 ProviderActions / Notifier）。
 * 方法语义见各方法注释；prisma 实现见 PrismaMailRepo，测试用 InMemoryMailRepo。
 *
 * 注：MailRepo 由此**有意跨两个聚合**——mail_messages 行（邮件落库/去重/分类/动作）
 * 与 mail_accounts 同步状态（锚定行 + lastSyncCursor 游标）。MVP 单 seam 省事（YAGNI、
 * 与既有 seam 一致），后续若有多账号/账号 CRUD 需求可拆出 `AccountSyncRepo`。
 */
export type MailRepo = {
  /**
   * 调度器启动前**无条件、幂等**确保 mail_accounts 存在 accountId 对应锚定行
   * （spec「锚定行先于调度建立」）——否则首次 saveEmail 触发 FK 违约、被 poller
   * per-email catch 静默吞掉每封。create.id 显式 = accountId（覆盖 @default(cuid())）、
   * authJson 为非空空对象 {}（置 null 触发 NOT NULL 违约）；update 留空（已存行不改）。
   */
  ensureAccountAnchor(account: AnchorAccount): Promise<void>;

  /** 读 mail_accounts.lastSyncCursor（增量游标）；无行 / 未设返回 null。 */
  getCursor(accountId: string): Promise<string | null>;

  /** 写 mail_accounts.lastSyncCursor（轮末持久化增量游标）。 */
  setCursor(accountId: string, cursor: string): Promise<void>;

  /** 按去重键查已存行（含 processedAt）；未命中返回 null。 */
  findByDedupKey(
    accountId: string,
    providerMessageId: string,
  ): Promise<StoredEmail | null>;

  /**
   * 落库邮件，对去重键 (accountId, providerMessageId) **幂等**（upsert / get-or-create）：
   * 崩溃重跑时复用已存未处理行、不二次插入触发唯一键冲突。返回行（含 id）。
   */
  saveEmail(email: NormalizedEmail): Promise<StoredEmail>;

  /**
   * 落分类/裁定一行（落库映射见文件头）。重跑可能 append 一行，本期接受；
   * 读取时按 createdAt desc, id desc 取最新行。返回新行 id。
   */
  saveClassification(
    messageRowId: string,
    classification: Classification,
    decision: FinalDecision,
  ): Promise<string>;

  /** 以 pending 落 mail_actions 一行，返回行 id。 */
  recordAction(messageRowId: string, actionType: ActionType): Promise<string>;

  /** 把 mail_actions 行更新为终态（done|failed|skipped，+error）。 */
  updateAction(
    actionRowId: string,
    status: Exclude<ActionStatus, 'pending'>,
    error?: string,
  ): Promise<void>;

  /** 置 mail_messages.processedAt（流水线最后一步，标记处理完）。 */
  markProcessed(messageRowId: string): Promise<void>;
};

/** 由 saveClassification 的落库映射构造 rawAiJson 审计块（prisma 与内存实现共用）。 */
export function buildRawAiJson(
  classification: Classification,
  decision: FinalDecision,
): RawAiJson {
  return {
    aiClassification: classification,
    finalDecision: {
      appliedRules: decision.appliedRules,
      shouldNotifyNow: decision.shouldNotifyNow,
      shouldMarkRead: decision.shouldMarkRead,
      shouldIncludeDigest: decision.shouldIncludeDigest,
      riskFlags: decision.riskFlags,
    },
  };
}

/**
 * prisma 真身实现。把 mail_messages / mail_classifications / mail_actions 的 SQL 细节
 * 挡在流水线外。注：prisma 唯一键/SQL 行为的真测在接真实 DB 时验证（design 风险条已列）。
 */
export class PrismaMailRepo implements MailRepo {
  async ensureAccountAnchor(account: AnchorAccount): Promise<void> {
    // 调度器 arm 前 await 完成；幂等（重复启动复用已存行，update 留空）。
    // 参数经 buildAnchorUpsertArgs 钉死 where.id===create.id===accountId、authJson==={}。
    await prisma.mailAccount.upsert(buildAnchorUpsertArgs(account));
  }

  async getCursor(accountId: string): Promise<string | null> {
    const row = await prisma.mailAccount.findUnique({
      where: { id: accountId },
      select: { lastSyncCursor: true },
    });
    return row?.lastSyncCursor ?? null;
  }

  async setCursor(accountId: string, cursor: string): Promise<void> {
    await prisma.mailAccount.update({
      where: { id: accountId },
      data: { lastSyncCursor: cursor },
    });
  }

  async findByDedupKey(
    accountId: string,
    providerMessageId: string,
  ): Promise<StoredEmail | null> {
    const row = await prisma.mailMessage.findUnique({
      where: { accountId_providerMessageId: { accountId, providerMessageId } },
      select: { id: true, processedAt: true },
    });
    return row;
  }

  async saveEmail(email: NormalizedEmail): Promise<StoredEmail> {
    // upsert on 去重键：已存行不覆盖（update 留空，复用已存未处理行），不存则插入。
    const row = await prisma.mailMessage.upsert({
      where: {
        accountId_providerMessageId: {
          accountId: email.accountId,
          providerMessageId: email.providerMessageId,
        },
      },
      update: {},
      create: {
        accountId: email.accountId,
        providerMessageId: email.providerMessageId,
        messageId: email.messageId ?? null,
        threadId: email.providerThreadId ?? null,
        uid: email.uid ?? null,
        subject: email.subject,
        fromEmail: email.fromEmail,
        fromName: email.fromName ?? null,
        receivedAt: new Date(email.date),
        snippet: email.snippet ?? null,
        bodyText: email.textBody ?? null,
        hasAttachments: email.hasAttachments,
      },
      select: { id: true, processedAt: true },
    });
    return row;
  }

  async saveClassification(
    messageRowId: string,
    classification: Classification,
    decision: FinalDecision,
  ): Promise<string> {
    const row = await prisma.mailClassification.create({
      data: {
        messageId: messageRowId,
        // priority/category/reason ← FinalDecision（裁定后最终值）。
        priority: decision.priority,
        category: decision.category,
        reason: decision.reason,
        // confidence ← 透传的 Classification.confidence（引擎不改写）。
        confidence: classification.confidence,
        // rawAiJson ← { aiClassification, finalDecision(审计块) }。
        rawAiJson: buildRawAiJson(classification, decision) as object,
      },
      select: { id: true },
    });
    return row.id;
  }

  async recordAction(
    messageRowId: string,
    actionType: ActionType,
  ): Promise<string> {
    const row = await prisma.mailAction.create({
      // status 走 schema 默认 'pending'。
      data: { messageId: messageRowId, actionType },
      select: { id: true },
    });
    return row.id;
  }

  async updateAction(
    actionRowId: string,
    status: Exclude<ActionStatus, 'pending'>,
    error?: string,
  ): Promise<void> {
    await prisma.mailAction.update({
      where: { id: actionRowId },
      data: { status, error: error ?? null },
    });
  }

  async markProcessed(messageRowId: string): Promise<void> {
    await prisma.mailMessage.update({
      where: { id: messageRowId },
      data: { processedAt: new Date() },
    });
  }
}
