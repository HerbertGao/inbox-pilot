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
import { logger } from '../logger.js';
import {
  buildRawAiJson,
  sortDigestCandidates,
  type AccountWriteInput,
  type DigestCandidate,
  type MailRepo,
  type RawAiJson,
  type StoredAccount,
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

/** 内存 digest_items 行（摘要去重存在性 + markDigested 落点；对应 prisma DigestItem）。 */
type DigestItemRow = {
  messageRowId: string;
  digestType: string;
  sentAt: Date;
};

/** 内存账号行（注册表加载 / 写入路径；authJson 含真实凭据，绝不整体记录）。 */
type AccountRow = {
  id: string;
  provider: string;
  email: string;
  authJson: unknown;
  enabled: boolean;
};

export class InMemoryMailRepo implements MailRepo {
  private readonly emailsById = new Map<string, EmailRow>();
  private readonly emailIdByDedupKey = new Map<string, string>();
  /** 账号行：id → 行（`MailAccount` 是唯一账号真相源）。游标存其 lastSyncCursor 字段。 */
  private readonly accountsById = new Map<string, AccountRow>();
  /** id → 同步游标（lastSyncCursor）。仅对已写入账号有效（未写入即抛，见 setCursor）。 */
  private readonly cursorsByAccountId = new Map<string, string | null>();
  /** 暴露给测试断言；按插入顺序。 */
  readonly classifications: ClassificationRow[] = [];
  /** 暴露给测试断言；按插入顺序。 */
  readonly actions: ActionRow[] = [];
  /** digest_items 行（摘要去重存在性）；暴露给测试断言，按插入顺序。重复 (rowId,type) 行容忍。 */
  readonly digestItems: DigestItemRow[] = [];

  private seq = 0;

  async listEnabledAccounts(): Promise<StoredAccount[]> {
    const rows: StoredAccount[] = [];
    for (const row of this.accountsById.values()) {
      if (row.enabled) {
        rows.push({ ...row });
      }
    }
    return rows;
  }

  async listAccounts(): Promise<StoredAccount[]> {
    // 所有行（不按 enabled 过滤）——account list 用，使被禁用/reauth-suspend 的行可见。
    const rows: StoredAccount[] = [];
    for (const row of this.accountsById.values()) {
      rows.push({ ...row });
    }
    return rows;
  }

  async getAccountById(id: string): Promise<StoredAccount | null> {
    const row = this.accountsById.get(id);
    return row === undefined ? null : { ...row };
  }

  async updateGmailTokens(
    id: string,
    tokens: { refreshToken: string; scopes?: string[] },
  ): Promise<void> {
    // 只更新 authJson 的 token 字段、**不触碰 enabled**（保 reauth-suspend 不被复活）。
    const row = this.accountsById.get(id);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.updateGmailTokens: 未知 accountId ${id}`);
    }
    row.authJson = {
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes ?? ['https://www.googleapis.com/auth/gmail.modify'],
    };
  }

  async upsertAccount(input: AccountWriteInput): Promise<void> {
    // 主键 upsert：显式 id（覆盖 cuid）、authJson 含真实凭据、email 非空、enabled 默认 true。
    this.accountsById.set(input.id, {
      id: input.id,
      provider: input.provider,
      email: input.email,
      authJson: input.authJson,
      enabled: input.enabled ?? true,
    });
    // 写入路径即「播种」游标命名空间（取代旧 ensureAccountAnchor）；幂等：已存不重置游标。
    if (!this.cursorsByAccountId.has(input.id)) {
      this.cursorsByAccountId.set(input.id, null);
    }
  }

  async createAccount(input: AccountWriteInput): Promise<void> {
    // reject-on-exists（与 prisma create 的唯一键冲突语义一致）。
    if (this.accountsById.has(input.id)) {
      throw new Error(`InMemoryMailRepo.createAccount: 账号已存在 ${input.id}`);
    }
    await this.upsertAccount(input);
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<void> {
    const row = this.accountsById.get(id);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.setAccountEnabled: 未知 accountId ${id}`);
    }
    row.enabled = enabled;
  }

  async getCursor(accountId: string): Promise<string | null> {
    return this.cursorsByAccountId.get(accountId) ?? null;
  }

  async setCursor(accountId: string, cursor: string): Promise<void> {
    // 与 PrismaMailRepo.setCursor（update→未知账号即抛）保持契约一致：账号未写入即抛，
    // 使「漏调 createAccount/upsertAccount」在测试就暴露、而非到生产才报。
    if (!this.cursorsByAccountId.has(accountId)) {
      throw new Error(`InMemoryMailRepo.setCursor: 未写入的 accountId ${accountId}`);
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

  async listDigestCandidates(digestType: string): Promise<DigestCandidate[]> {
    // 谓词 + 排序与 PrismaMailRepo 同（测试忠实）：processedAt != null 且无对应 digestType 的 digest_items
    // 行（读侧存在性去重、无年龄窗）；JS 取最新分类（getLatestClassification：createdAt desc, seq desc）；
    // 缺分类行排除 + debug；只保留 P1/P2/P3。
    const enriched: Array<DigestCandidate & { receivedAt: Date; id: string }> = [];
    for (const row of this.emailsById.values()) {
      if (row.processedAt === null) {
        continue;
      }
      if (
        this.digestItems.some(
          (d) => d.messageRowId === row.id && d.digestType === digestType,
        )
      ) {
        continue;
      }
      const latest = this.getLatestClassification(row.id);
      if (latest === null) {
        logger.debug(
          { kind: 'digest-candidate-missing-classification', messageRowId: row.id },
          'digest candidate skipped: no classification row',
        );
        continue;
      }
      if (
        latest.priority !== 'P1' &&
        latest.priority !== 'P2' &&
        latest.priority !== 'P3'
      ) {
        continue;
      }
      const email = row.email;
      enriched.push({
        messageRowId: row.id,
        priority: latest.priority,
        category: latest.category,
        subject: email.subject,
        fromEmail: email.fromEmail,
        ...(email.fromName !== undefined ? { fromName: email.fromName } : {}),
        reason: latest.reason,
        // prisma 用 MailMessage.receivedAt = new Date(email.date)；内存镜像同一映射。
        receivedAt: new Date(email.date),
        id: row.id,
      });
    }
    return sortDigestCandidates(enriched).map(
      ({ receivedAt: _receivedAt, id: _id, ...candidate }) => candidate,
    );
  }

  async markDigested(
    messageRowIds: string[],
    digestType: string,
    sentAt: Date,
  ): Promise<void> {
    // 与 prisma createMany 语义一致：直插、重复 (rowId, digestType) 行容忍（无唯一约束、不抛）。
    for (const messageRowId of messageRowIds) {
      this.digestItems.push({ messageRowId, digestType, sentAt });
    }
  }
}
