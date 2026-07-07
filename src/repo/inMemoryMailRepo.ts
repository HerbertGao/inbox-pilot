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
import { logger } from '../logger.js';
import {
  buildRawAiJson,
  rebuildFinalDecision,
  sortDigestCandidates,
  tallySenderCounts,
  type AccountWriteInput,
  type DigestCandidate,
  type MailRepo,
  type RawAiJson,
  type SenderCount,
  type StoredAccount,
  type StoredEmail,
} from './mailRepo.js';
import { passesWatermark } from './watermark.js';

/** 内存邮件行（保留去重键以支持 findByDedupKey / saveEmail 幂等）。 */
type EmailRow = {
  id: string;
  accountId: string;
  providerMessageId: string;
  email: NormalizedEmail;
  processedAt: Date | null;
  /** re-poll 计数（design D3 死信门；镜像 mail_messages.repollCount）。 */
  repollCount: number;
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
  /** 起算日期水位线（onboarding-watermark；NULL = 不设下界）。镜像 StoredAccount.processFrom。 */
  processFrom: Date | null;
  /** 展示别名（notification-mailbox-clarity；NULL → 下游渲染回落 email）。镜像 StoredAccount.label；仅 create 写、update 保留。 */
  label: string | null;
};

/**
 * 克隆水位线 Date：防外部经引用改内部状态，并与 PrismaMailRepo（每次读从 PG 反序列化出全新 Date）的
 * 值语义对齐——本内存双件在存/取边界不外泄、不 retain 可变 Date 引用（避免双件与真实 repo 的值语义漂移）。
 */
function cloneProcessFrom(d: Date | null): Date | null {
  return d === null ? null : new Date(d.getTime());
}

export class InMemoryMailRepo implements MailRepo {
  private readonly emailsById = new Map<string, EmailRow>();
  private readonly emailIdByDedupKey = new Map<string, string>();
  /** 账号行：id → 行（`MailAccount` 是唯一账号真相源）。游标存其 lastSyncCursor 字段。 */
  private readonly accountsById = new Map<string, AccountRow>();
  /** 暴露给测试断言；按插入顺序。 */
  readonly classifications: ClassificationRow[] = [];
  /** digest_items 行（摘要去重存在性）；暴露给测试断言，按插入顺序。重复 (rowId,type) 行容忍。 */
  readonly digestItems: DigestItemRow[] = [];

  private seq = 0;

  async listEnabledAccounts(): Promise<StoredAccount[]> {
    const rows: StoredAccount[] = [];
    for (const row of this.accountsById.values()) {
      if (row.enabled) {
        rows.push({ ...row, processFrom: cloneProcessFrom(row.processFrom) });
      }
    }
    return rows;
  }

  async listAccounts(): Promise<StoredAccount[]> {
    // 所有行（不按 enabled 过滤）——account list 用，使被禁用/reauth-suspend 的行可见。
    const rows: StoredAccount[] = [];
    for (const row of this.accountsById.values()) {
      rows.push({ ...row, processFrom: cloneProcessFrom(row.processFrom) });
    }
    return rows;
  }

  async getAccountById(id: string): Promise<StoredAccount | null> {
    const row = this.accountsById.get(id);
    return row === undefined ? null : { ...row, processFrom: cloneProcessFrom(row.processFrom) };
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
    // 水位线 get-before-set（onboarding-watermark 决策 7，顺序 load-bearing）：读必须先于下面的 .set，
    // 因 .set 会整行替换、clobber 既有 processFrom。existing 存在（update/re-auth）⇒ 保留 existing.processFrom、
    // **忽略 input**（Prisma 经省略字段达成相同语义）；不存在（create）⇒ input.processFrom ?? 精确瞬时。
    const existing = this.accountsById.get(input.id);
    // existing（update/re-auth）保留内部 Date 引用（已是本件私有）；create 分支克隆外部 input.processFrom
    // （或种精确瞬时 new Date()），不 retain 调用方可变引用——与 Prisma 值语义对齐。
    const processFrom =
      existing !== undefined
        ? existing.processFrom
        : cloneProcessFrom(input.processFrom ?? null) ?? new Date();
    // 展示别名 get-before-set（notification-mailbox-clarity 决策 5，与 processFrom 同一 preserve 路径）：
    // existing（update/re-auth）⇒ 保留 existing.label、**忽略 input**（Prisma 经省略字段达成相同语义）；
    // 不存在（create）⇒ input.label ?? null。
    const label = existing !== undefined ? existing.label : input.label ?? null;
    // 主键 upsert：显式 id（覆盖 cuid）、authJson 含真实凭据、email 非空、enabled 默认 true。
    this.accountsById.set(input.id, {
      id: input.id,
      provider: input.provider,
      email: input.email,
      authJson: input.authJson,
      enabled: input.enabled ?? true,
      processFrom,
      label,
    });
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

  async setProcessFrom(id: string, date: Date): Promise<void> {
    // 无条件覆盖既有水位线（onboarding-watermark：唯一改既有行 processFrom 的路径，与 prisma 一致）。
    const row = this.accountsById.get(id);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.setProcessFrom: 未知 accountId ${id}`);
    }
    row.processFrom = cloneProcessFrom(date); // 克隆外部 Date（不 retain 调用方可变引用）。
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
    return { id: row.id, processedAt: row.processedAt, receivedAt: new Date(row.email.date) };
  }

  async saveEmail(email: NormalizedEmail): Promise<StoredEmail> {
    const key = this.dedupKey(email.accountId, email.providerMessageId);
    // 幂等：已存去重键复用同一行（崩溃重跑路径），不二次插入。
    const existingId = this.emailIdByDedupKey.get(key);
    if (existingId !== undefined) {
      const existing = this.emailsById.get(existingId)!;
      return { id: existing.id, processedAt: existing.processedAt, receivedAt: new Date(existing.email.date) };
    }
    const id = this.nextId('msg');
    const row: EmailRow = {
      id,
      accountId: email.accountId,
      providerMessageId: email.providerMessageId,
      email,
      processedAt: null,
      repollCount: 0,
    };
    this.emailsById.set(id, row);
    this.emailIdByDedupKey.set(key, id);
    return { id: row.id, processedAt: row.processedAt, receivedAt: new Date(row.email.date) };
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

  async getClassification(messageRowId: string): Promise<FinalDecision | null> {
    // 最新分类行（getLatestClassification：createdAt desc, seq desc）；复用 rebuildFinalDecision（design D4）。
    const latest = this.getLatestClassification(messageRowId);
    if (latest === null) {
      return null; // 无分类行 → 当无分类、重 LLM。
    }
    try {
      return rebuildFinalDecision({
        priority: latest.priority,
        category: latest.category,
        confidence: latest.confidence,
        reason: latest.reason,
        rawAiJson: latest.rawAiJson,
      });
    } catch {
      return null; // rawAiJson malformed → 当无分类、重 LLM。
    }
  }

  async getRepollCount(messageRowId: string): Promise<number> {
    const row = this.emailsById.get(messageRowId);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.getRepollCount: 未知 messageRowId ${messageRowId}`);
    }
    return row.repollCount;
  }

  async incrementRepollCount(messageRowId: string): Promise<number> {
    const row = this.emailsById.get(messageRowId);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.incrementRepollCount: 未知 messageRowId ${messageRowId}`);
    }
    row.repollCount += 1;
    return row.repollCount;
  }

  async markProcessed(messageRowId: string): Promise<void> {
    const row = this.emailsById.get(messageRowId);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.markProcessed: 未知 messageRowId ${messageRowId}`);
    }
    row.processedAt = new Date();
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
      // 水位线下界（onboarding-watermark 决策 9，与 prisma 同一谓词）：排除 receivedAt < 该账号 processFrom
      // 的接入前历史积压；NULL 或账号缺失（accountsById 无此行）⇒ undefined ⇒ passesWatermark 放行。
      // prisma 用 MailMessage.receivedAt = new Date(email.date)；内存镜像同一映射。
      const receivedAt = new Date(row.email.date);
      if (!passesWatermark(receivedAt, this.accountsById.get(row.accountId)?.processFrom)) {
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
        // 复用上面水位线判定算出的 receivedAt（= new Date(email.date)，与 prisma MailMessage.receivedAt 一致）。
        receivedAt,
        id: row.id,
      });
    }
    return sortDigestCandidates(enriched).map(
      ({ receivedAt: _receivedAt, id: _id, ...candidate }) => candidate,
    );
  }

  async countRecentSenders(since: Date): Promise<SenderCount[]> {
    // 与 prisma 同谓词（noise-discovery 决策 5）：processedAt != null 且 receivedAt ≥ since 窗内**全部**已处理
    // 邮件——含所有优先级（不读分类行）、不查 digestItems 去重。归一 + 计数共用 tallySenderCounts（测试忠实）。
    // receivedAt = new Date(email.date)（与 prisma MailMessage.receivedAt 同一映射）。
    const fromEmails: string[] = [];
    for (const row of this.emailsById.values()) {
      if (row.processedAt === null) {
        continue;
      }
      if (new Date(row.email.date).getTime() < since.getTime()) {
        continue;
      }
      fromEmails.push(row.email.fromEmail);
    }
    return tallySenderCounts(fromEmails);
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
