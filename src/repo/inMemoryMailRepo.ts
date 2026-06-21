// MailRepo 的内存实现（design「测试用内存实现」、spec「离线全链路可测」）。
//
// 让组 F 离线断言：去重跳过、rawAiJson 读回（createdAt desc, id desc 取最新行）、动作行查询、
// saveEmail 重跑复用同一行。不连 postgres、不发网络；仅进程内 Map/数组。
//
// latest-wins 读取语义：saveClassification 重跑可能 append 多行；getLatestClassification
// 按 createdAt desc, id desc 取最新行（与 prisma 实现及 spec「落库处理记录」一致；id 序号单调，
// 仅在内存中作 createdAt 同刻时的稳定 tie-break，对应 cuid() 非严格单调的 best-effort 语义）。

import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import type { ActionStatus, ActionType } from '../actions/actionTypes.js';
import {
  buildAnchorUpsertArgs,
  buildRawAiJson,
  type AnchorAccount,
  type AnchorUpsertArgs,
  type MailRepo,
  type RawAiJson,
  type StoredEmail,
} from './mailRepo.js';

/** 内存邮件行（保留去重键以支持 findByDedupKey / saveEmail 幂等）。 */
type EmailRow = {
  id: string;
  accountId: string;
  providerMessageId: string;
  email: NormalizedEmail;
  processedAt: Date | null;
};

/** 内存分类行（含 latest-wins 排序所需的 createdAt / 自增序号 seq）。 */
export type ClassificationRow = {
  id: string;
  seq: number;
  messageRowId: string;
  priority: FinalDecision['priority'];
  category: FinalDecision['category'];
  confidence: number;
  reason: string;
  rawAiJson: RawAiJson;
  createdAt: Date;
};

/** 内存动作行（供组 F 断言动作类型 + 终态 + error）。 */
export type ActionRow = {
  id: string;
  messageRowId: string;
  actionType: ActionType;
  status: ActionStatus;
  error: string | null;
  createdAt: Date;
};

export class InMemoryMailRepo implements MailRepo {
  private readonly emailsById = new Map<string, EmailRow>();
  private readonly emailIdByDedupKey = new Map<string, string>();
  /** 锚定行：accountId → 同步游标（lastSyncCursor）。供 4.5 离线测试与游标推进断言。 */
  private readonly cursorsByAccountId = new Map<string, string | null>();
  /**
   * call-shape spy：每次 ensureAccountAnchor 记下构造出的 upsert 参数（供 3.3 断言
   * where.id === create.id === accountId 且 authJson === {}，无需真库即在 CI 捕获 id≠accountId 回归）。
   */
  readonly anchorUpsertCalls: AnchorUpsertArgs[] = [];
  /** 暴露给测试断言；按插入顺序。 */
  readonly classifications: ClassificationRow[] = [];
  /** 暴露给测试断言；按插入顺序。 */
  readonly actions: ActionRow[] = [];

  private seq = 0;

  async ensureAccountAnchor(account: AnchorAccount): Promise<void> {
    // 复用与 prisma 同一纯函数构造参数（call-shape 一致）；幂等：已存行不覆盖游标。
    const args = buildAnchorUpsertArgs(account);
    this.anchorUpsertCalls.push(args);
    if (!this.cursorsByAccountId.has(account.accountId)) {
      this.cursorsByAccountId.set(account.accountId, null);
    }
  }

  async getCursor(accountId: string): Promise<string | null> {
    return this.cursorsByAccountId.get(accountId) ?? null;
  }

  async setCursor(accountId: string, cursor: string): Promise<void> {
    // 与 PrismaMailRepo.setCursor（update→未知账号即抛）保持契约一致：未锚定即抛，
    // 使「漏调 ensureAccountAnchor」在测试就暴露、而非到生产才报。
    if (!this.cursorsByAccountId.has(accountId)) {
      throw new Error(`InMemoryMailRepo.setCursor: 未锚定的 accountId ${accountId}`);
    }
    this.cursorsByAccountId.set(accountId, cursor);
  }

  private dedupKey(accountId: string, providerMessageId: string): string {
    // 以 (NUL) 分隔，避免 accountId / providerMessageId 边界歧义（NUL 不会出现在二者内容中）。
    return `${accountId}\u0000${providerMessageId}`;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  async findByDedupKey(
    accountId: string,
    providerMessageId: string,
  ): Promise<StoredEmail | null> {
    const id = this.emailIdByDedupKey.get(this.dedupKey(accountId, providerMessageId));
    if (id === undefined) {
      return null;
    }
    const row = this.emailsById.get(id);
    if (row === undefined) {
      return null;
    }
    return { id: row.id, processedAt: row.processedAt };
  }

  async saveEmail(email: NormalizedEmail): Promise<StoredEmail> {
    const key = this.dedupKey(email.accountId, email.providerMessageId);
    // 幂等：已存去重键复用同一行（崩溃重跑路径），不二次插入。
    const existingId = this.emailIdByDedupKey.get(key);
    if (existingId !== undefined) {
      const existing = this.emailsById.get(existingId)!;
      return { id: existing.id, processedAt: existing.processedAt };
    }
    const id = this.nextId('msg');
    const row: EmailRow = {
      id,
      accountId: email.accountId,
      providerMessageId: email.providerMessageId,
      email,
      processedAt: null,
    };
    this.emailsById.set(id, row);
    this.emailIdByDedupKey.set(key, id);
    return { id: row.id, processedAt: row.processedAt };
  }

  async saveClassification(
    messageRowId: string,
    classification: Classification,
    decision: FinalDecision,
  ): Promise<string> {
    this.seq += 1;
    const seq = this.seq;
    const id = `cls_${seq}`;
    const row: ClassificationRow = {
      id,
      seq,
      messageRowId,
      // priority/category/reason ← FinalDecision（裁定后最终值）。
      priority: decision.priority,
      category: decision.category,
      reason: decision.reason,
      // confidence ← 透传的 Classification.confidence。
      confidence: classification.confidence,
      // rawAiJson 审计块复用 mailRepo.buildRawAiJson，与 prisma 实现一致。
      rawAiJson: buildRawAiJson(classification, decision),
      createdAt: new Date(),
    };
    this.classifications.push(row);
    return id;
  }

  /**
   * 取某邮件最新分类行（latest-wins）：按 createdAt desc, seq desc。
   * 组 F 用它读回 rawAiJson / 专列做落库可恢复断言。无行返回 null。
   */
  getLatestClassification(messageRowId: string): ClassificationRow | null {
    let latest: ClassificationRow | null = null;
    for (const row of this.classifications) {
      if (row.messageRowId !== messageRowId) {
        continue;
      }
      if (
        latest === null ||
        row.createdAt.getTime() > latest.createdAt.getTime() ||
        (row.createdAt.getTime() === latest.createdAt.getTime() && row.seq > latest.seq)
      ) {
        latest = row;
      }
    }
    return latest;
  }

  async recordAction(
    messageRowId: string,
    actionType: ActionType,
  ): Promise<string> {
    const id = this.nextId('act');
    const row: ActionRow = {
      id,
      messageRowId,
      actionType,
      status: 'pending',
      error: null,
      createdAt: new Date(),
    };
    this.actions.push(row);
    return id;
  }

  async updateAction(
    actionRowId: string,
    status: Exclude<ActionStatus, 'pending'>,
    error?: string,
  ): Promise<void> {
    const row = this.actions.find((a) => a.id === actionRowId);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.updateAction: 未知 actionRowId ${actionRowId}`);
    }
    row.status = status;
    row.error = error ?? null;
  }

  async markProcessed(messageRowId: string): Promise<void> {
    const row = this.emailsById.get(messageRowId);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.markProcessed: 未知 messageRowId ${messageRowId}`);
    }
    row.processedAt = new Date();
  }

  /** 取某邮件的所有动作行（组 F 断言用），按插入顺序。 */
  getActions(messageRowId: string): ActionRow[] {
    return this.actions.filter((a) => a.messageRowId === messageRowId);
  }
}
