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
import type { ActionType } from '../actions/actionTypes.js';
import { ActionStatus } from '../actions/actionTypes.js';
import { logger } from '../logger.js';
import {
  buildRawAiJson,
  rebuildFinalDecision,
  rebuildNormalizedEmail,
  sortDigestCandidates,
  type AccountWriteInput,
  type DigestCandidate,
  type DueRetryAction,
  type MailRepo,
  type RawAiJson,
  type RebuildResult,
  type RecordActionResult,
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

/** 内存动作行（供组 F 断言动作类型 + 终态 + error；durable-retry 加 retryCount/nextRetryAt）。 */
export type ActionRow = {
  id: string;
  messageRowId: string;
  actionType: ActionType;
  status: ActionStatus;
  error: string | null;
  /** durable-retry：重试计数（初值 0；retrying 推进时写）。 */
  retryCount: number;
  /** durable-retry：下次到期时刻（仅 retrying 行有值，其余 null）。 */
  nextRetryAt: Date | null;
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
    // 水位线 get-before-set（onboarding-watermark 决策 7，顺序 load-bearing）：读必须先于下面的 .set，
    // 因 .set 会整行替换、clobber 既有 processFrom。existing 存在（update/re-auth）⇒ 保留 existing.processFrom、
    // **忽略 input**（Prisma 经省略字段达成相同语义）；不存在（create）⇒ input.processFrom ?? 精确瞬时。
    const existing = this.accountsById.get(input.id);
    const processFrom =
      existing !== undefined ? existing.processFrom : input.processFrom ?? new Date();
    // 主键 upsert：显式 id（覆盖 cuid）、authJson 含真实凭据、email 非空、enabled 默认 true。
    this.accountsById.set(input.id, {
      id: input.id,
      provider: input.provider,
      email: input.email,
      authJson: input.authJson,
      enabled: input.enabled ?? true,
      processFrom,
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

  async setProcessFrom(id: string, date: Date): Promise<void> {
    // 无条件覆盖既有水位线（onboarding-watermark：唯一改既有行 processFrom 的路径，与 prisma 一致）。
    const row = this.accountsById.get(id);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.setProcessFrom: 未知 accountId ${id}`);
    }
    row.processFrom = date;
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
  ): Promise<RecordActionResult> {
    // 对 (messageRowId, actionType) 活跃行 upsert（决策 4）：活跃 = status ∈ {pending, retrying}。
    // 忠实建模 partial unique index + upsert 分流：命中活跃 retrying → already-retrying（保持原样、不清零）；
    // 命中活跃 pending（崩溃残留）→ 复用同行 proceed；无活跃行 → INSERT pending proceed。
    const active = this.actions.find(
      (a) =>
        a.messageRowId === messageRowId &&
        a.actionType === actionType &&
        (a.status === 'pending' || a.status === 'retrying'),
    );
    if (active !== undefined) {
      if (active.status === 'retrying') {
        // 保持 retrying 原样、不清零 retryCount/nextRetryAt（drain 拥有它）。
        return { actionRowId: active.id, disposition: 'already-retrying' };
      }
      return { actionRowId: active.id, disposition: 'proceed' };
    }
    const id = this.nextId('act');
    const row: ActionRow = {
      id,
      messageRowId,
      actionType,
      status: 'pending',
      error: null,
      retryCount: 0,
      nextRetryAt: null,
      createdAt: new Date(),
    };
    this.actions.push(row);
    return { actionRowId: id, disposition: 'proceed' };
  }

  async updateAction(
    actionRowId: string,
    status: Exclude<ActionStatus, 'pending' | 'retrying'>,
    error?: string,
  ): Promise<void> {
    const row = this.actions.find((a) => a.id === actionRowId);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.updateAction: 未知 actionRowId ${actionRowId}`);
    }
    row.status = status;
    row.error = error ?? null;
    // 离开 retrying 落终态：清空 nextRetryAt（维持「仅 retrying 行有 nextRetryAt」不变量，与 prisma 一致）。
    row.nextRetryAt = null;
  }

  async enqueueRetry(
    actionRowId: string,
    retryCount: number,
    nextRetryAt: Date,
    error?: string,
  ): Promise<void> {
    // 落 retrying（决策 2）：写 retryCount/nextRetryAt/error（首次入队 retryCount=0；drain 推进 +1）。
    const row = this.actions.find((a) => a.id === actionRowId);
    if (row === undefined) {
      throw new Error(`InMemoryMailRepo.enqueueRetry: 未知 actionRowId ${actionRowId}`);
    }
    row.status = ActionStatus.Retrying;
    row.retryCount = retryCount;
    row.nextRetryAt = nextRetryAt;
    row.error = error ?? null;
  }

  async markActionDeadLetter(actionRowId: string, retryCount: number, error?: string): Promise<void> {
    // 落终态 dead_letter（决策 2/3）：写死亡时的 retryCount、清空 nextRetryAt、写脱敏 error（绝不正文/凭据/PII）。
    const row = this.actions.find((a) => a.id === actionRowId);
    if (row === undefined) {
      throw new Error(
        `InMemoryMailRepo.markActionDeadLetter: 未知 actionRowId ${actionRowId}`,
      );
    }
    row.status = ActionStatus.DeadLetter;
    row.retryCount = retryCount;
    row.nextRetryAt = null;
    row.error = error ?? null;
  }

  async selectDueRetries(
    accountId: string,
    now: Date,
    limit: number,
  ): Promise<DueRetryAction[]> {
    // 先选 retry 动作行（决策 5/6）：status='retrying' ∧ nextRetryAt ≤ now ∧ message.accountId=accountId，
    // 按 nextRetryAt 升序、至多 limit 条。再对每条 LEFT 语义重建输入（关联分类行缺失 → 永久、不丢动作行）。
    const due = this.actions
      .filter((a) => {
        if (a.status !== 'retrying' || a.nextRetryAt === null) {
          return false;
        }
        if (a.nextRetryAt.getTime() > now.getTime()) {
          return false;
        }
        const msg = this.emailsById.get(a.messageRowId);
        return msg !== undefined && msg.accountId === accountId;
      })
      .sort((x, y) => {
        // nextRetryAt 升序（两者非 null，上面已过滤）；同刻按 id 稳定 tie-break。
        const dx = x.nextRetryAt!.getTime();
        const dy = y.nextRetryAt!.getTime();
        if (dx !== dy) {
          return dx - dy;
        }
        return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
      })
      .slice(0, limit);

    return due.map((action) => {
      const msg = this.emailsById.get(action.messageRowId)!;
      // receivedAt 与 prisma 一致：MailMessage.receivedAt = new Date(email.date)。
      const receivedAt = new Date(msg.email.date);
      const rebuild = this.rebuildInput(action.messageRowId, msg, accountId);
      return {
        actionRowId: action.id,
        actionType: action.actionType,
        retryCount: action.retryCount,
        receivedAt,
        rebuild,
      };
    });
  }

  /**
   * 重建一条到期重试动作的输入（忠实建模 prisma 的 LEFT join + 分流，决策 5）：
   *   - 无最新分类行 → 永久（`{ ok: false }`）；
   *   - rawAiJson 的 finalDecision shape 不符 → rebuildFinalDecision throw → 永久；
   *   - 否则 → `{ ok: true, email, decision }`。
   * provider 由账号行派生（与 prisma 共用 rebuildNormalizedEmail）；账号行缺失/非法时回落 email 行的
   * provider（内存写入约束保证合法，二者本就一致）。
   * // ponytail: prisma 的 coerceProvider 对**非法 account.provider** 返回 null → {ok:false}（永久死信）；
   * //   内存此处回落 email.provider（恒合法）→ 复现不了该永久路径，故「非法 provider→死信」仅 prisma 端
   * //   正确、离线 harness 不测（已知保真度缺口；内存测不建账号模型，强行对齐需新增账号建模、超出该 nit 价值）。
   */
  private rebuildInput(
    messageRowId: string,
    msg: { accountId: string; email: NormalizedEmail },
    accountId: string,
  ): RebuildResult {
    const latest = this.getLatestClassification(messageRowId);
    if (latest === null) {
      return { ok: false };
    }
    const account = this.accountsById.get(accountId);
    const provider =
      account?.provider === 'gmail' || account?.provider === 'imap'
        ? account.provider
        : msg.email.provider;
    try {
      const email = rebuildNormalizedEmail(msg.accountId, provider, {
        providerMessageId: msg.email.providerMessageId,
        messageId: msg.email.messageId ?? null,
        threadId: msg.email.providerThreadId ?? null,
        uid: msg.email.uid ?? null,
        subject: msg.email.subject,
        fromEmail: msg.email.fromEmail,
        fromName: msg.email.fromName ?? null,
        snippet: msg.email.snippet ?? null,
        bodyText: msg.email.textBody ?? null,
        receivedAt: new Date(msg.email.date),
        hasAttachments: msg.email.hasAttachments,
      });
      const decision = rebuildFinalDecision({
        priority: latest.priority,
        category: latest.category,
        confidence: latest.confidence,
        reason: latest.reason,
        rawAiJson: latest.rawAiJson,
      });
      return { ok: true, email, decision };
    } catch {
      // rawAiJson finalDecision shape 不符 = 永久（独立解析 try 内 throw，决策 5）。
      return { ok: false };
    }
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
