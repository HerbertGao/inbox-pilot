// MailRepo seam（design「MailRepo（findByDedupKey / saveEmail / saveClassification /
// recordAction+updateAction / markProcessed）：prisma 实现为真身，测试用内存实现。把 prisma
// 细节挡在 processEmail 外」、spec「落库处理记录」「动作 I/O 经可注入 seam」）。
//
// 账号真相源（design 决策 1/2）：`MailAccount` 是**唯一账号真相源**——行本身即账号、`id`===accountId、
// `authJson` 含真实凭据（不再有「env 是真相源、DB 仅锚定空 authJson」的旧模型）。账号写入路径
// （createAccount/upsertAccount）显式设 `id`、列举枚举凭据 authJson；注册表加载读 enabled 行。
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

/** Gmail authJson 的默认 scope（scopes 缺省回落，避免写 scopes:undefined）。与 oauth.ts 同值、不耦合其重量级依赖。 */
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/** 已存邮件行的最小投影（processEmail 去重判定只需 id + processedAt）。 */
export type StoredEmail = {
  id: string;
  processedAt: Date | null;
};

/**
 * 注册表加载读到的 `MailAccount` 行（design 决策 1/2：`MailAccount` 是唯一账号真相源）。
 * `authJson` 含真实凭据（imap:`{host,port,user,password,tls}` / gmail:`{refreshToken,scopes}`）——
 * **绝不整体记录**（logger 整体 redact `authJson`；解析失败也只记 `{id, provider}`，见 accountRegistry）。
 * `id` === accountId（去重键命名空间 + 游标落点）。
 */
export type StoredAccount = {
  /** = accountId（写入路径显式设、覆盖 @default(cuid())）。 */
  id: string;
  /** provider 字符串（注册表加载校验 ∈ {imap,gmail}，未知者跳过）。 */
  provider: string;
  email: string;
  /** 凭据子树（绝不整体入日志）。形状校验由 accountRegistry 落地。 */
  authJson: unknown;
  enabled: boolean;
};

/**
 * 账号写入路径入参（CLI add / 一次性迁移 / 测试共用，取代被移除的 ensureAccountAnchor）。
 * `id` **显式设 = 派生 accountId**（覆盖 @default(cuid())，否则 mail_messages.accountId 外键违约
 * 或去重键换命名空间致历史重处理，见 spec「accountId 与 MailAccount.id 同一」）；`email` 非空。
 * 口令/refresh token 在 `authJson` 内（整体 redact，绝不明文入日志）。
 */
export type AccountWriteInput = {
  /** = 派生 accountId（gmail `gmail:<email>` / imap `--account-id`‖`imap:<user>@<host>`）。 */
  id: string;
  provider: 'imap' | 'gmail';
  /** NOT NULL；gmail=getProfile 邮箱、imap=`--email`‖`user@host`（best-effort）。 */
  email: string;
  /** 真实凭据子树（imap/gmail 各自形状）；绝不明文入日志。 */
  authJson: unknown;
  /** 默认 enabled=true（恢复/re-auth 路径显式置 true 以解除 reauth-suspend）。 */
  enabled?: boolean;
};

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
 * 与 mail_accounts（账号注册表：`MailAccount` 是唯一账号真相源——CRUD + lastSyncCursor 游标）。
 * MVP 单 seam 省事（YAGNI、与既有 seam 一致），后续若需可拆出 `AccountRepo`。
 */
export type MailRepo = {
  /**
   * 列出所有 enabled=true 的 `MailAccount` 行（注册表加载用，见 accountRegistry）。
   * `MailAccount` 是唯一账号真相源（不再有空 authJson 锚定行；行本身即账号、含真实凭据）。
   * 无 enabled 账号 → 返回 []（服务正常启动、仅不轮询）。
   */
  listEnabledAccounts(): Promise<StoredAccount[]>;

  /**
   * 列出**所有** `MailAccount` 行（不按 enabled 过滤）——`account list` 用，使运营者能看到被
   * reauth-suspend / 手动禁用（enabled=false）的账号并据此重授权/重启。仍**不**含凭据明文（authJson
   * 整体 redact、CLI 仅打印 id/provider/email/enabled）。
   */
  listAccounts(): Promise<StoredAccount[]>;

  /**
   * 按 id 取单行（CLI 的「正在重新启用」探测用：re-auth 翻转一个 enabled=false 行时提示）。
   * 无行 → null。仍不含凭据明文（authJson 整体 redact）。
   */
  getAccountById(id: string): Promise<StoredAccount | null>;

  /**
   * 显式写入账号行（CLI add / 一次性迁移 / 测试共用，取代被移除的 ensureAccountAnchor）。
   * **主键 upsert**（不模糊查既有行）：`id` 显式 = 派生 accountId（覆盖 @default(cuid())）、
   * `email` 非空、`authJson` 含真实凭据。已存 id → 更新凭据/email/enabled（同邮箱不分裂）。
   * 这是 spec「注册表行必须先于该账号被调度而存在」的建行路径；首次 saveEmail 的 FK 天然成立。
   */
  upsertAccount(input: AccountWriteInput): Promise<void>;

  /**
   * 创建账号行（CLI `account add --imap` 的 reject-on-exists 路径用——id 已存在则抛）。
   * 与 upsertAccount 共用同一显式 id / authJson 写入约束；语义差别仅「已存即拒」。
   */
  createAccount(input: AccountWriteInput): Promise<void>;

  /**
   * 置 `MailAccount.enabled`（reauth-suspend 持久化 / CLI disable 用）——复用既有 enabled 列、
   * 无 schema 迁移。`setAccountEnabled(id, false)` 使下次启动不再加载该账号。
   */
  setAccountEnabled(id: string, enabled: boolean): Promise<void>;

  /**
   * 运行期 refresh 后**只更新 Gmail 账号 authJson 的 token 字段**（refreshToken + scopes），
   * **绝不触碰 `enabled`**——否则会把 scheduler 刚因 reauth 暂停（enabled=false）的账号重新启用。
   * `enabled:true` 仅保留给显式 CLI 重授权（cli/account.ts --gmail）。无 schema 迁移（写既有 authJson 列）。
   */
  updateGmailTokens(
    id: string,
    tokens: { refreshToken: string; scopes?: string[] },
  ): Promise<void>;

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
  async listEnabledAccounts(): Promise<StoredAccount[]> {
    const rows = await prisma.mailAccount.findMany({
      where: { enabled: true },
      select: { id: true, provider: true, email: true, authJson: true, enabled: true },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      email: r.email,
      authJson: r.authJson,
      enabled: r.enabled,
    }));
  }

  async listAccounts(): Promise<StoredAccount[]> {
    const rows = await prisma.mailAccount.findMany({
      select: { id: true, provider: true, email: true, authJson: true, enabled: true },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      email: r.email,
      authJson: r.authJson,
      enabled: r.enabled,
    }));
  }

  async getAccountById(id: string): Promise<StoredAccount | null> {
    const r = await prisma.mailAccount.findUnique({
      where: { id },
      select: { id: true, provider: true, email: true, authJson: true, enabled: true },
    });
    if (r === null) {
      return null;
    }
    return { id: r.id, provider: r.provider, email: r.email, authJson: r.authJson, enabled: r.enabled };
  }

  async upsertAccount(input: AccountWriteInput): Promise<void> {
    const authJson = input.authJson as object;
    const enabled = input.enabled ?? true;
    await prisma.mailAccount.upsert({
      where: { id: input.id },
      // 显式 id = 派生 accountId（覆盖 @default(cuid())，FK 成立 / 去重命名空间稳定的硬要求）。
      create: {
        id: input.id,
        provider: input.provider,
        email: input.email,
        authJson,
        enabled,
      },
      // 同邮箱重加 / re-auth：更新凭据/email/enabled（命中同一行、不分裂）。
      update: { provider: input.provider, email: input.email, authJson, enabled },
    });
  }

  async createAccount(input: AccountWriteInput): Promise<void> {
    // reject-on-exists：id 已存在 → prisma 抛唯一键冲突（CLI --imap 默认拒绝路径）。
    await prisma.mailAccount.create({
      data: {
        id: input.id,
        provider: input.provider,
        email: input.email,
        authJson: input.authJson as object,
        enabled: input.enabled ?? true,
      },
    });
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<void> {
    await prisma.mailAccount.update({ where: { id }, data: { enabled } });
  }

  async updateGmailTokens(
    id: string,
    tokens: { refreshToken: string; scopes?: string[] },
  ): Promise<void> {
    // 只更新 authJson 的 token 字段、**不触碰 enabled**（保 reauth-suspend 的 enabled=false 不被复活）。
    // scopes 未提供时回落 [GMAIL_MODIFY_SCOPE]（绝不写 scopes:undefined）。
    const authJson = {
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes ?? [GMAIL_MODIFY_SCOPE],
    };
    await prisma.mailAccount.update({ where: { id }, data: { authJson } });
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
