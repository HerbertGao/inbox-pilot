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
import { logger } from '../logger.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import type { FinalDecision } from '../rules/finalDecision.js';
import { ActionStatus } from '../actions/actionTypes.js';
import type { ActionType } from '../actions/actionTypes.js';

/** Gmail authJson 的默认 scope（scopes 缺省回落，避免写 scopes:undefined）。与 oauth.ts 同值、不耦合其重量级依赖。 */
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/** 每日摘要的 digestType 值（去重命名空间 + digest_items.digestType 落点；daily-digest 决策 1）。 */
export const DIGEST_TYPE_DAILY = 'daily';

/**
 * 摘要候选邮件的最小投影（daily-digest 决策 4）。**故意无 `bodyText`/`htmlBody`**——正文绝不进摘要
 * 投影对象（显式 select 白名单保证；DigestCandidate 类型层再钉一遍）。
 * `messageRowId` = `MailMessage.id`（行主键），**非** RFC 头 `MailMessage.messageId`——后者非 FK 目标，
 * 误用会破坏 digest_items 外键与去重（spec「标识用行主键而非 RFC 头」）。
 * `priority`/`category`/`reason` 取该邮件**最新分类行**（规则裁定后的最终值），`priority ∈ {P1,P2,P3}`
 * （P0/P4 已在候选过滤阶段丢弃）。
 */
export type DigestCandidate = {
  /** = `MailMessage.id`（行主键 / 去重键 / digest_items FK 目标）。 */
  messageRowId: string;
  /** 最新分类的最终优先级（候选过滤后 ∈ {P1,P2,P3}）。 */
  priority: FinalDecision['priority'];
  /** 最新分类的类别。 */
  category: FinalDecision['category'];
  subject: string;
  fromEmail: string;
  fromName?: string;
  /** 最新分类的裁定原因（人类可读，渲染进摘要行）。 */
  reason: string;
};

/** 已存邮件行的最小投影（processEmail 去重判定只需 id + processedAt）。 */
export type StoredEmail = {
  id: string;
  processedAt: Date | null;
};

/**
 * `recordAction` 的活跃行分流信号（durable-retry 决策 4）。`recordAction` 改为对 `(messageId, actionType)`
 * 活跃行 upsert，返回行 id + 处置信号供 executeActions 据此 SKIP / 继续：
 *   - `proceed`：命中活跃 `pending`（崩溃残留、复用同行）或无活跃行（INSERT pending）→ 正常执行该动作。
 *   - `already-retrying`：命中活跃 `retrying` 行（drain 拥有它）→ executeActions **SKIP 本轮内联执行**，
 *     保持 retrying 原样、不清零 retryCount/nextRetryAt（避免清零 durable 进度 / 留孤儿 pending）。
 */
export type RecordActionDisposition = 'proceed' | 'already-retrying';

/** `recordAction` 返回：动作行 id + 活跃行分流信号。 */
export type RecordActionResult = {
  actionRowId: string;
  disposition: RecordActionDisposition;
};

/**
 * `selectDueRetries` 选中的一条到期重试动作（决策 5/6）。**先选 retry 动作行、再 LEFT join/单独 fetch
 * 重建输入**——关联行缺失（`mail_classifications` 无 FK 保护）的动作仍被选中、以 `rebuild` 的可识别
 * "缺失"返回值流向永久死信路径（禁 INNER join 丢行）。
 */
export type DueRetryAction = {
  /** mail_actions 行 id（drain 据此 enqueueRetry / markActionDeadLetter / updateAction）。 */
  actionRowId: string;
  actionType: ActionType;
  /** 当前 retryCount（drain 推进时 +1 后判 `≥MAX_DURABLE_ATTEMPTS`）。 */
  retryCount: number;
  /** 邮件的 receivedAt（notify staleness 上界判定基准；markRead/reflectPriority 不用）。 */
  receivedAt: Date;
  /**
   * 重建输入结果（决策 5）：
   *   - `{ ok: true, email, decision }`：成功重建 action-input-sufficient 投影；drain 据此复发原动作。
   *   - `{ ok: false }`：**永久重建失败**（mail_messages/mail_classifications 行查询返回 null，
   *     或 rawAiJson 不可解析 / finalDecision shape 校验失败）→ drain 落 `dead_letter`、不崩。
   * 注：**瞬时 DB I/O 错误不走此判别**——它在 `selectDueRetries` 的行查询本身抛出、向上传播（保持
   * retrying、不推进 retryCount、不死信），绝不表现为 `{ ok: false }`。
   */
  rebuild: RebuildResult;
};

/** 重建输入的可识别结果（决策 5：永久失败 = `{ ok: false }`，瞬时 DB 错误向上传播不入此类型）。 */
export type RebuildResult =
  | { ok: true; email: NormalizedEmail; decision: FinalDecision }
  | { ok: false };

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

  /**
   * 对 `(messageId, actionType)` 活跃行 **upsert**，按既有活跃态分流并返回处置信号（durable-retry 决策 4）。
   * 活跃 = `status ∈ {pending, retrying}`。配合活跃态 partial unique index 强制至多一条活跃行，使 re-poll
   * 重跑既不产生第二条活跃行、也不清零 durable 进度：
   *   - 命中活跃 `retrying` 行 → **保持 `retrying` 原样、不清零 retryCount/nextRetryAt**，返回
   *     `disposition='already-retrying'`（drain 拥有它，executeActions SKIP 内联执行）。
   *   - 命中活跃 `pending` 行（崩溃残留）→ 复用同行，返回 `disposition='proceed'`。
   *   - 无活跃行 → INSERT `pending`，返回 `disposition='proceed'`。
   * 终态行（done/failed/skipped/dead_letter）可多条、不受活跃约束、不被命中。
   */
  recordAction(
    messageRowId: string,
    actionType: ActionType,
  ): Promise<RecordActionResult>;

  /** 把 mail_actions 行更新为终态（done|failed|skipped|dead_letter，+error）。 */
  updateAction(
    actionRowId: string,
    status: Exclude<ActionStatus, 'pending' | 'retrying'>,
    error?: string,
  ): Promise<void>;

  /**
   * 把 mail_actions 行落 `retrying`（durable-retry 决策 2）：发送态瞬时失败耗尽（首次入队
   * retryCount=0）或 drain 失败推进（retryCount+1、未达上限）时调用。写 retryCount/nextRetryAt/error。
   */
  enqueueRetry(
    actionRowId: string,
    retryCount: number,
    nextRetryAt: Date,
    error?: string,
  ): Promise<void>;

  /**
   * 把 mail_actions 行落终态 `dead_letter`（durable-retry 决策 2/3）：retryCount 达 MAX_DURABLE_ATTEMPTS
   * 或超 notify staleness 上界或永久重建失败时调用。写脱敏 error（kind 摘要、绝不正文/凭据/PII）。
   */
  markActionDeadLetter(actionRowId: string, retryCount: number, error?: string): Promise<void>;

  /**
   * 选取该账号到期可重试动作并重建输入（durable-retry 决策 5/6、tasks 1.2）。
   * **先选 retry 动作行**（`status='retrying' ∧ nextRetryAt ≤ now ∧ message.accountId=accountId`，
   * 按 nextRetryAt 升序、至多 `limit` 条），**再以 LEFT join/单独 fetch 取重建输入**（mail_messages 行 +
   * 最新 mail_classifications 行 `[{createdAt:'desc'},{id:'desc'}] take 1`）。**禁 INNER join**——关联行
   * 缺失的 retry 动作仍被选中、以 `rebuild.ok===false` 流向永久死信路径。
   * **瞬时 DB I/O 错误**（行读取本身抛出）**向上传播**（不返回 `ok:false`、不死信）——同 repo-I/O 通道。
   */
  selectDueRetries(
    accountId: string,
    now: Date,
    limit: number,
  ): Promise<DueRetryAction[]>;

  /** 置 mail_messages.processedAt（流水线最后一步，标记处理完）。 */
  markProcessed(messageRowId: string): Promise<void>;

  /**
   * 列出摘要候选邮件（daily-digest 决策 4）：`processedAt != null` 且**无**对应 `digestType` 的
   * `digest_items` 行（去重唯一真相源是「≥1 行即排除」的读侧存在性谓词，**无年龄窗**——停机期间积压
   * 的旧邮件仍入摘要、不被永久排除）。取每邮件最新分类后**只保留 `priority ∈ {P1,P2,P3}`**（P0/P4
   * 丢弃，其出口是即时推送）；缺分类行的已处理邮件被**排除**（记 debug 日志，非 error/非每轮刷屏）。
   * **确定性排序**：优先级档（P1<P2<P3）、同档 `receivedAt` 升序、再 `id` 升序——使分段边界跨重复 build
   * 稳定。投影为 `DigestCandidate`（显式 select 白名单，**无 bodyText**）。
   */
  listDigestCandidates(digestType: string): Promise<DigestCandidate[]>;

  /**
   * 落 `digest_items` 标记一批邮件已进摘要（daily-digest 决策 1/3）：批量插入
   * `(messageId=messageRowId, digestType, sentAt)`。`digest_items` **无唯一约束**，重复
   * `(messageRowId, digestType)` 行**容忍**（读侧只看存在性）；**不用 `skipDuplicates`**（无唯一索引时
   * 它是 no-op、徒增误解）。若后续加唯一约束（非目标）须同步改 skipDuplicates/upsert。
   */
  markDigested(
    messageRowIds: string[],
    digestType: string,
    sentAt: Date,
  ): Promise<void>;
};

/** 优先级档排序权重（P1<P2<P3；候选已过滤掉 P0/P4，故只需这三档）。 */
const DIGEST_PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 };

/**
 * 摘要候选的确定性排序（daily-digest 决策 4，prisma 与内存实现共用——使两实现排序一致、测试忠实）：
 * 优先级档（P1<P2<P3）、同档 `receivedAt` 升序、再 `id`（行主键）升序。**入参须各 candidate 附 `receivedAt`
 * 与 `id`** 用于 tie-break。注：fixture 应用各异 `receivedAt` 以避「同刻并列时 in-memory(seq) vs
 * prisma(cuid id) 排序差异」（见 task 2.5）。
 */
export function sortDigestCandidates<
  T extends { priority: string; receivedAt: Date; id: string },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const pa = DIGEST_PRIORITY_RANK[a.priority] ?? Number.MAX_SAFE_INTEGER;
    const pb = DIGEST_PRIORITY_RANK[b.priority] ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) {
      return pa - pb;
    }
    const ra = a.receivedAt.getTime();
    const rb = b.receivedAt.getTime();
    if (ra !== rb) {
      return ra - rb;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

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
 * 最新分类行的重建输入投影（prisma 与内存实现共用，行查询结果在各自实现内取出后传入此处组装）。
 * `rawAiJson` 已是 DB JSONB 解析后的 JS 值（unknown），本函数对其 `finalDecision` 块做 shape 校验。
 */
type ClassificationRebuildInput = {
  priority: string;
  category: string;
  confidence: number;
  reason: string;
  rawAiJson: unknown;
};

/**
 * 把账号行的自由 String `provider` 派生为 `'gmail'|'imap'`（决策 5）；非法值返回 null →
 * 视为永久重建失败（不应发生：注册表加载已校验 provider，但行查询不再保证、防御性兜底）。
 */
function coerceProvider(provider: string): 'gmail' | 'imap' | null {
  return provider === 'gmail' || provider === 'imap' ? provider : null;
}

/** mail_messages 行的重建输入投影（action-input-sufficient 字段；prisma 与内存共用）。 */
type MessageRebuildInput = {
  providerMessageId: string;
  messageId: string | null;
  threadId: string | null;
  uid: number | null;
  subject: string;
  fromEmail: string;
  fromName: string | null;
  snippet: string | null;
  bodyText: string | null;
  receivedAt: Date;
  hasAttachments: boolean;
};

/**
 * 校验并取出 rawAiJson 的 `finalDecision` 块（决策 5：永久判别）。**调用方须把此函数包在独立解析 `try` 内**：
 * 任何 throw（不可解析的 rawAiJson 上游已是 JS 值，但 shape 不符在此 throw）= **永久重建失败**。
 * `finalDecision` 块缺字段/类型不符即 throw（shape-invalid → 永久）。
 */
function parseFinalDecisionBlock(rawAiJson: unknown): RawAiJson['finalDecision'] {
  if (rawAiJson === null || typeof rawAiJson !== 'object') {
    throw new Error('rawAiJson 非对象（shape-invalid，永久）');
  }
  const fd = (rawAiJson as Record<string, unknown>).finalDecision;
  if (fd === null || typeof fd !== 'object') {
    throw new Error('rawAiJson.finalDecision 缺失或非对象（shape-invalid，永久）');
  }
  const block = fd as Record<string, unknown>;
  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  const isStrArr = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (
    !isStrArr(block.appliedRules) ||
    !isBool(block.shouldNotifyNow) ||
    !isBool(block.shouldMarkRead) ||
    !isBool(block.shouldIncludeDigest) ||
    !isStrArr(block.riskFlags)
  ) {
    throw new Error('rawAiJson.finalDecision 字段缺失/类型不符（shape-invalid，永久）');
  }
  return {
    appliedRules: block.appliedRules,
    shouldNotifyNow: block.shouldNotifyNow,
    shouldMarkRead: block.shouldMarkRead,
    shouldIncludeDigest: block.shouldIncludeDigest,
    riskFlags: block.riskFlags,
  };
}

/**
 * 从行重建 **action-input-sufficient 投影** `NormalizedEmail`（决策 5、tasks 1.4，prisma 与内存共用）。
 * `mail_messages` 不存 `to`/`cc`/`headers`/`htmlBody`/`provider`——重建**合成** `to:[]`、`headers:{}`，
 * `provider` 由 `MailAccount.provider` 派生传入。安全前提：三动作 sink 不读 to/headers（断言测试守，tasks 4.4）。
 */
export function rebuildNormalizedEmail(
  accountId: string,
  provider: 'gmail' | 'imap',
  msg: MessageRebuildInput,
): NormalizedEmail {
  const email: NormalizedEmail = {
    accountId,
    provider,
    providerMessageId: msg.providerMessageId,
    subject: msg.subject,
    fromEmail: msg.fromEmail,
    to: [], // 合成（库中无；action-input-sufficient 投影，三动作 sink 不读）。
    date: msg.receivedAt.toISOString(),
    hasAttachments: msg.hasAttachments,
    headers: {}, // 合成（库中无；三动作 sink 不读）。
  };
  if (msg.threadId !== null) {
    email.providerThreadId = msg.threadId;
  }
  if (msg.uid !== null) {
    email.uid = msg.uid;
  }
  if (msg.messageId !== null) {
    email.messageId = msg.messageId;
  }
  if (msg.fromName !== null) {
    email.fromName = msg.fromName;
  }
  if (msg.snippet !== null) {
    email.snippet = msg.snippet;
  }
  if (msg.bodyText !== null) {
    email.textBody = msg.bodyText;
  }
  return email;
}

/**
 * 从最新分类行重建 `FinalDecision`（决策 5、tasks 1.4，prisma 与内存共用）：priority/category/confidence/
 * reason 专列 + `rawAiJson.finalDecision` 块。**调用方须在独立解析 `try` 内调用**（parseFinalDecisionBlock
 * 的 shape 校验 throw = 永久重建失败）。
 */
export function rebuildFinalDecision(cls: ClassificationRebuildInput): FinalDecision {
  const block = parseFinalDecisionBlock(cls.rawAiJson);
  return {
    priority: cls.priority as FinalDecision['priority'],
    category: cls.category as FinalDecision['category'],
    confidence: cls.confidence,
    reason: cls.reason,
    shouldNotifyNow: block.shouldNotifyNow,
    shouldMarkRead: block.shouldMarkRead,
    shouldIncludeDigest: block.shouldIncludeDigest,
    riskFlags: block.riskFlags,
    appliedRules: block.appliedRules,
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
  ): Promise<RecordActionResult> {
    // 对 (messageId, actionType) 活跃行 upsert（决策 4）：先查活跃行（status ∈ {pending, retrying}）。
    // 逐账号串行化前提（drain 与 re-poll 同受 per-account isPolling 锁）下，单实例 find-then-insert 无并发竞态。
    const active = await prisma.mailAction.findFirst({
      where: {
        messageId: messageRowId,
        actionType,
        status: { in: ['pending', 'retrying'] },
      },
      select: { id: true, status: true },
    });
    if (active !== null) {
      if (active.status === 'retrying') {
        // 命中活跃 retrying：保持原样、不清零 retryCount/nextRetryAt；executeActions SKIP 内联执行。
        return { actionRowId: active.id, disposition: 'already-retrying' };
      }
      // 命中活跃 pending（崩溃残留）：复用同行继续执行。
      return { actionRowId: active.id, disposition: 'proceed' };
    }
    // 无活跃行：INSERT pending（status 走 schema 默认）。
    const row = await prisma.mailAction.create({
      data: { messageId: messageRowId, actionType },
      select: { id: true },
    });
    return { actionRowId: row.id, disposition: 'proceed' };
  }

  async updateAction(
    actionRowId: string,
    status: Exclude<ActionStatus, 'pending' | 'retrying'>,
    error?: string,
  ): Promise<void> {
    await prisma.mailAction.update({
      where: { id: actionRowId },
      data: { status, error: error ?? null },
    });
  }

  async enqueueRetry(
    actionRowId: string,
    retryCount: number,
    nextRetryAt: Date,
    error?: string,
  ): Promise<void> {
    // 落 retrying（决策 2）：写 retryCount/nextRetryAt/error。首次入队 retryCount=0；drain 推进 +1（未达上限）。
    await prisma.mailAction.update({
      where: { id: actionRowId },
      data: {
        status: ActionStatus.Retrying,
        retryCount,
        nextRetryAt,
        error: error ?? null,
      },
    });
  }

  async markActionDeadLetter(actionRowId: string, retryCount: number, error?: string): Promise<void> {
    // 落终态 dead_letter（决策 2/3）：脱敏 error（kind 摘要，绝不正文/凭据/PII）。nextRetryAt 不再相关、清空。
    // 落**死亡时的 retryCount**（max-attempts 死亡 = MAX；staleness/rebuild 死亡 = 当前未推进值）。
    await prisma.mailAction.update({
      where: { id: actionRowId },
      data: {
        status: ActionStatus.DeadLetter,
        retryCount,
        nextRetryAt: null,
        error: error ?? null,
      },
    });
  }

  async selectDueRetries(
    accountId: string,
    now: Date,
    limit: number,
  ): Promise<DueRetryAction[]> {
    // 先选 retry 动作行（决策 5/6）：status='retrying' ∧ nextRetryAt ≤ now ∧ message.accountId=accountId，
    // 按 nextRetryAt 升序、至多 limit 条。**禁 INNER join 重建输入**——关联行缺失的动作仍须被选中，
    // 故经动作行的 message 关联过滤 accountId（mail_messages 受 Restrict FK 保护、必在），分类行另查（LEFT 语义）。
    const rows = await prisma.mailAction.findMany({
      where: {
        status: ActionStatus.Retrying,
        nextRetryAt: { lte: now },
        message: { accountId },
      },
      select: {
        id: true,
        actionType: true,
        retryCount: true,
        // mail_messages 行（受 Restrict FK 保护、必在）：重建 NormalizedEmail 投影 + receivedAt（staleness 基准）。
        message: {
          select: {
            accountId: true,
            providerMessageId: true,
            messageId: true,
            threadId: true,
            uid: true,
            subject: true,
            fromEmail: true,
            fromName: true,
            snippet: true,
            bodyText: true,
            receivedAt: true,
            hasAttachments: true,
            // 派生 provider（'gmail'|'imap'）；mail_messages 不存 provider，取自账号行。
            account: { select: { provider: true } },
            // 最新分类行（LEFT 语义：无分类行 → classifications=[] → 永久重建失败，不丢动作行）。
            classifications: {
              select: {
                priority: true,
                category: true,
                confidence: true,
                reason: true,
                rawAiJson: true,
              },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
            },
          },
        },
      },
      orderBy: [{ nextRetryAt: 'asc' }],
      take: limit,
    });

    // 行读取本身（上面的 findMany）抛 I/O 错误 = 瞬时，已自然向上传播（不入此循环、不返回 ok:false）。
    return rows.map((row) => {
      const msg = row.message;
      const provider = coerceProvider(msg.account.provider);
      const latest = msg.classifications[0];
      // 重建分流（决策 5）：行缺失（无分类行 / provider 非法）→ 永久；rawAiJson 解析/shape 失败 → 永久（独立 try）。
      let rebuild: RebuildResult;
      if (latest === undefined || provider === null) {
        rebuild = { ok: false };
      } else {
        try {
          const email = rebuildNormalizedEmail(msg.accountId, provider, {
            providerMessageId: msg.providerMessageId,
            messageId: msg.messageId,
            threadId: msg.threadId,
            uid: msg.uid,
            subject: msg.subject,
            fromEmail: msg.fromEmail,
            fromName: msg.fromName,
            snippet: msg.snippet,
            bodyText: msg.bodyText,
            receivedAt: msg.receivedAt,
            hasAttachments: msg.hasAttachments,
          });
          const decision = rebuildFinalDecision({
            priority: latest.priority,
            category: latest.category,
            confidence: latest.confidence,
            reason: latest.reason,
            rawAiJson: latest.rawAiJson,
          });
          rebuild = { ok: true, email, decision };
        } catch {
          // rawAiJson 不可解析 / finalDecision shape 不符 = 永久（独立 try 内 throw，决策 5）。
          rebuild = { ok: false };
        }
      }
      return {
        actionRowId: row.id,
        actionType: row.actionType as ActionType,
        retryCount: row.retryCount,
        receivedAt: msg.receivedAt,
        rebuild,
      };
    });
  }

  async markProcessed(messageRowId: string): Promise<void> {
    await prisma.mailMessage.update({
      where: { id: messageRowId },
      data: { processedAt: new Date() },
    });
  }

  async listDigestCandidates(digestType: string): Promise<DigestCandidate[]> {
    // 谓词：已处理（processedAt != null）且无对应 digestType 的 digest_items 行（读侧存在性去重、无年龄窗）。
    // 显式 select 白名单（**非 include**，否则把整行 MailMessage 含 bodyText 拉进结果）。
    // 确定性排序：优先级档无法在 SQL 直接表达（priority 在分类行），故 SQL 仅按 [receivedAt asc, id asc]
    // 排稳定基序，优先级档在 JS 取最新分类后做稳定二次排序（决策 4：P1<P2<P3、同档 receivedAt/id 升序）。
    const rows = await prisma.mailMessage.findMany({
      where: {
        processedAt: { not: null },
        digestItems: { none: { digestType } },
      },
      select: {
        id: true,
        subject: true,
        fromEmail: true,
        fromName: true,
        receivedAt: true,
        classifications: {
          select: { priority: true, category: true, reason: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });

    // JS 取最新分类、过滤、附 receivedAt/id 供确定性排序（优先级档不能在 SQL 表达，故在此排）。
    const enriched: Array<DigestCandidate & { receivedAt: Date; id: string }> = [];
    for (const row of rows) {
      const latest = row.classifications[0];
      if (latest === undefined) {
        // 缺分类行的已处理邮件：排除，记 debug（非 error、非每轮 error 刷屏）。
        logger.debug(
          { kind: 'digest-candidate-missing-classification', messageRowId: row.id },
          'digest candidate skipped: no classification row',
        );
        continue;
      }
      // 只保留 P1/P2/P3（P0/P4 丢弃，其出口是即时推送）。
      if (
        latest.priority !== 'P1' &&
        latest.priority !== 'P2' &&
        latest.priority !== 'P3'
      ) {
        continue;
      }
      enriched.push({
        messageRowId: row.id,
        priority: latest.priority as DigestCandidate['priority'],
        category: latest.category as DigestCandidate['category'],
        subject: row.subject,
        fromEmail: row.fromEmail,
        ...(row.fromName !== null ? { fromName: row.fromName } : {}),
        reason: latest.reason,
        receivedAt: row.receivedAt,
        id: row.id,
      });
    }
    // 确定性排序后剥掉排序辅助字段（receivedAt/id），返回纯 DigestCandidate（messageRowId 仍是 id）。
    return sortDigestCandidates(enriched).map(
      ({ receivedAt: _receivedAt, id: _id, ...candidate }) => candidate,
    );
  }

  async markDigested(
    messageRowIds: string[],
    digestType: string,
    sentAt: Date,
  ): Promise<void> {
    if (messageRowIds.length === 0) {
      return;
    }
    // createMany 批量插；**不用 skipDuplicates**（digest_items 无唯一约束、它是 no-op、徒增误解）。
    // 重复 (messageId, digestType) 行容忍——读侧只看存在性（决策 1/3）。
    await prisma.digestItem.createMany({
      data: messageRowIds.map((messageId) => ({ messageId, digestType, sentAt })),
    });
  }
}
