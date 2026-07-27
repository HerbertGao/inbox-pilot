// MailRepo seam：prisma 实现为真身，测试用内存实现。把 prisma 细节挡在 run()/域库外。
// migration §1.2：durable mail_actions 方法（record/update/enqueueRetry/markActionDeadLetter/
// selectDueRetries）+ IMAP 游标（get/setCursor）已剥离（不搬，破脊柱 #3/#8）；新增 getClassification
// （re-poll 复用分类）+ get/incrementRepollCount（死信门）。
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
import { normalizeFromAddress } from '../rules/applySafetyRules.js';
import { passesWatermark } from './watermark.js';

/** Gmail authJson 的默认 scope（scopes 缺省回落，避免写 scopes:undefined）。与 oauth.ts 同值、不耦合其重量级依赖。 */
const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/** 每日摘要的 digestType 值（去重命名空间 + digest_items.digestType 落点；daily-digest 决策 1）。 */
export const DIGEST_TYPE_DAILY = 'daily';

/**
 * 「最近高频发件人 TOP-N」频率快照的滚动窗（天）（noise-discovery 决策 5）。**独立命名常量**——
 * 与 `processFrom` 水位线 / 候选年龄上限正交：这是发现辅助的频率快照，不绑 onboarding-watermark、
 * 不引用任何摄入下界。`countRecentSenders` 的 since = now - 此天数。
 */
export const NOISE_TOPN_WINDOW_DAYS = 7;

/**
 * `countRecentSenders` 的单行结果（noise-discovery 决策 5）：归一后裸地址 + 窗口内出现计数。
 * **故意只含这两字段**——显式 select 白名单杜绝正文（无 `bodyText`/`htmlBody`）。
 */
export type SenderCount = {
  /** 归一后的发件人裸地址（小写、剥显示名/尖括号；空/非法已丢弃）。 */
  fromEmail: string;
  /** 该归一地址在窗口内的出现次数（含所有优先级 P0–P4、不经 digestItems 去重）。 */
  count: number;
};

/**
 * 归一发件人裸地址用于频率计数（noise-discovery 决策 5）：**就是匹配侧的 `normalizeFromAddress`**，
 * 不是它的副本。曾是一份逐字节复制，理由是「原函数未导出」——现已导出，而这个共用已从「免同一发件人
 * 裂成多变体」升级为**正确性前提**：`isAddableEntry` 的定义就是 `normalizeFromAddress` 的不动点集，
 * 而 `{text}` 腿的候选出自本函数；两份实现一旦漂移，真阳性候选会被静默丢掉。
 */
export { normalizeFromAddress as normalizeSenderForCount };

/**
 * 由一批 `fromEmail` 字段（窗口内全部已处理邮件、含 P0–P4、不去重）聚合归一计数（prisma 与内存共用）：
 * 归一（丢空/非法）→ 计数 → 降序（同计数按地址升序稳定 tie-break）。返回 `SenderCount[]`。
 */
export function tallySenderCounts(fromEmails: readonly string[]): SenderCount[] {
  const counts = new Map<string, number>();
  for (const raw of fromEmails) {
    const addr = normalizeFromAddress(raw);
    if (addr.length === 0) {
      continue;
    }
    counts.set(addr, (counts.get(addr) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([fromEmail, count]) => ({ fromEmail, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.fromEmail < b.fromEmail ? -1 : 1));
}

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

/**
 * 已存邮件行的最小投影：去重判定需 id + processedAt；`receivedAt` 供**重跑封入口死信门**在 get 前评估
 * staleness（design D3；用既存行的 receivedAt，不必先 get 才拿到 email.date）。
 */
export type StoredEmail = {
  id: string;
  processedAt: Date | null;
  receivedAt: Date;
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
  /**
   * per-account 起算日期水位线（onboarding-watermark 能力，UTC 语义）。NULL = 不设日期下界（保持现状）。
   * 从 DB 行穿透到 poller 内部决策点（摄入下界）与摘要层 `receivedAt` 下界。**禁止**泄进 `account list`
   * 输出白名单（CLI 仅打印 `{id,provider,email,enabled}`，由 account.ts 守）。
   */
  processFrom: Date | null;
  /**
   * per-account 展示别名（notification-mailbox-clarity）：面向运维渲染的可空显示名（允许中文/可见 Unicode）。
   * NULL（默认、存量不回填）→ 下游渲染回落账号 `email`。注册表/poller 处解析为「显示名 = label ?? email」
   * 穿透到通知。**绝不**进结构化日志字段（仅入通知 payload 白名单结构字段）。仅行创建写、update 保留（同 processFrom）。
   */
  label: string | null;
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
  /**
   * 起算日期水位线的**播种载体**（onboarding-watermark）。仅在 repo 的**行创建分支**生效：
   * create 写 `input.processFrom ?? new Date()`（默认精确瞬时）；`upsertAccount` 的 `update` 分支
   * 一律**不含**此字段（列不动 = 保留既有水位线）。CLI 一律透传 `--process-from` 值或 `undefined`、
   * 不分辨首次/re-auth——对既有账号 `add --process-from` 走 update 被忽略，改既有只能 `setProcessFrom`。
   */
  processFrom?: Date;
  /**
   * 展示别名的**播种载体**（notification-mailbox-clarity）。仅在 repo 的**行创建分支**生效：
   * create 写 `input.label ?? null`；`upsertAccount` 的 `update` 分支一律**不含**此字段（列不动 = 保留既有 label）。
   * CLI 在 add 处经 `validateLabel` 校验（拒控制/格式/bidi + trim + 限长）后透传；既有账号无改 label 入口（同 processFrom）。
   */
  label?: string;
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
   * 无条件覆盖账号的 `processFrom` 水位线（onboarding-watermark 运维命令 `set-process-from`）。
   * 可双向移动（无单调守卫）；把存量账号盖到指定 UTC 日期、使此前收到的历史积压从摄入与摘要排除。
   * **唯一**能改既有行 `processFrom` 的路径（行创建走 seed、update 一律不动该列）。
   */
  setProcessFrom(id: string, date: Date): Promise<void>;

  /**
   * 运行期 refresh 后**只更新 Gmail 账号 authJson 的 token 字段**（refreshToken + scopes），
   * **绝不触碰 `enabled`**——否则会把 scheduler 刚因 reauth 暂停（enabled=false）的账号重新启用。
   * `enabled:true` 仅保留给显式 CLI 重授权（cli/account.ts --gmail）。无 schema 迁移（写既有 authJson 列）。
   */
  updateGmailTokens(
    id: string,
    tokens: { refreshToken: string; scopes?: string[] },
  ): Promise<void>;

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
   * 读回某邮件**最新分类行**重建的 `FinalDecision`（re-poll 复用分类跳过 LLM，design D4）。
   * 复用 `rebuildFinalDecision`/`parseFinalDecisionBlock` + 最新行排序（`createdAt desc, id desc`）；
   * 无分类行 / rawAiJson malformed → `null`（→ 当无分类、重 LLM）。
   */
  getClassification(messageRowId: string): Promise<FinalDecision | null>;

  /** 读某邮件 re-poll 计数（死信门 `计数≥K` 判定，design D3）；无行视 0。 */
  getRepollCount(messageRowId: string): Promise<number>;

  /** re-poll 计数 +1 并返回新值（design D3：notify 耗尽后 run() 在重跑入口推进）。 */
  incrementRepollCount(messageRowId: string): Promise<number>;

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
   * 统计 `receivedAt >= since` 滚动窗内**全部已处理邮件**的归一 fromEmail 计数（noise-discovery 决策 5）。
   * **不复用 `listDigestCandidates`**——含**所有优先级（P0–P4）**、**不经 `digestItems` 去重**、
   * **显式 select 白名单（仅 `fromEmail` + 计数，绝不 `bodyText`/`htmlBody`）**。计数前归一发件人
   * （`normalizeSenderForCount`：裸地址 + 小写 + 丢空/非法），免同一发件人裂成多变体。
   * 返回 `SenderCount[]` 按计数降序（同计数地址升序稳定）；buildDigest 取前 N 渲染只读 Top-N 区块。
   */
  countRecentSenders(since: Date): Promise<SenderCount[]>;

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
      select: {
        id: true,
        provider: true,
        email: true,
        authJson: true,
        enabled: true,
        // 摄入水位线穿透（onboarding-watermark）：注册表加载读 enabled 行、经此带到 poller 内部决策点。
        processFrom: true,
        // 展示别名穿透（notification-mailbox-clarity）：注册表解析「显示名 = label ?? email」、经此带到通知。
        label: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      email: r.email,
      authJson: r.authJson,
      enabled: r.enabled,
      processFrom: r.processFrom,
      label: r.label,
    }));
  }

  async listAccounts(): Promise<StoredAccount[]> {
    // select 含 processFrom 以满足 StoredAccount 形状；CLI list 输出白名单（{id,provider,email,enabled}）
    // 由 account.ts 单独构造、**不**从 StoredAccount 透传，故此字段不泄进 list 输出。
    const rows = await prisma.mailAccount.findMany({
      select: {
        id: true,
        provider: true,
        email: true,
        authJson: true,
        enabled: true,
        processFrom: true,
        label: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      email: r.email,
      authJson: r.authJson,
      enabled: r.enabled,
      processFrom: r.processFrom,
      label: r.label,
    }));
  }

  async getAccountById(id: string): Promise<StoredAccount | null> {
    const r = await prisma.mailAccount.findUnique({
      where: { id },
      select: {
        id: true,
        provider: true,
        email: true,
        authJson: true,
        enabled: true,
        processFrom: true,
        label: true,
      },
    });
    if (r === null) {
      return null;
    }
    return {
      id: r.id,
      provider: r.provider,
      email: r.email,
      authJson: r.authJson,
      enabled: r.enabled,
      processFrom: r.processFrom,
      label: r.label,
    };
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
        // 行创建分支播种水位线：显式 --process-from（容器时区零点）优先，否则默认**精确瞬时** new Date()
        // （onboarding-watermark；容器时区零点仅用于 date-string，避免默认 seed 凭空提前 ≤24h）。
        processFrom: input.processFrom ?? new Date(),
        // 行创建分支写展示别名（notification-mailbox-clarity）：未给（undefined）→ NULL，下游渲染回落 email。
        label: input.label ?? null,
      },
      // 同邮箱重加 / re-auth：更新凭据/email/enabled（命中同一行、不分裂）。
      // **一律不含 processFrom**（Prisma 语义 = 列不动 = 保留既有水位线；re-auth/既有账号 add --process-from
      // 不改水位线，改既有只能 setProcessFrom）。**亦一律不含 label**（notification-mailbox-clarity 决策 5：
      // label 仅行创建写，update/re-auth 保留既有 label；既有账号无改 label 入口）。
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
        // IMAP 默认 add 的独立行创建路径同样播种水位线（onboarding-watermark）：显式优先，否则精确瞬时。
        processFrom: input.processFrom ?? new Date(),
        // 行创建分支写展示别名（notification-mailbox-clarity）：未给（undefined）→ NULL，下游渲染回落 email。
        label: input.label ?? null,
      },
    });
  }

  async setAccountEnabled(id: string, enabled: boolean): Promise<void> {
    await prisma.mailAccount.update({ where: { id }, data: { enabled } });
  }

  async setProcessFrom(id: string, date: Date): Promise<void> {
    // 无条件覆盖既有水位线（onboarding-watermark：唯一改既有行 processFrom 的路径）。
    await prisma.mailAccount.update({ where: { id }, data: { processFrom: date } });
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

  async findByDedupKey(
    accountId: string,
    providerMessageId: string,
  ): Promise<StoredEmail | null> {
    const row = await prisma.mailMessage.findUnique({
      where: { accountId_providerMessageId: { accountId, providerMessageId } },
      select: { id: true, processedAt: true, receivedAt: true },
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
      select: { id: true, processedAt: true, receivedAt: true },
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

  async getClassification(messageRowId: string): Promise<FinalDecision | null> {
    // 最新分类行（createdAt desc, id desc）；复用 rebuildFinalDecision 重建（不写第二个解码器，design D4）。
    const row = await prisma.mailClassification.findFirst({
      where: { messageId: messageRowId },
      select: { priority: true, category: true, confidence: true, reason: true, rawAiJson: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (row === null) {
      return null; // 无分类行 → 当无分类、重 LLM。
    }
    try {
      return rebuildFinalDecision({
        priority: row.priority,
        category: row.category,
        confidence: row.confidence,
        reason: row.reason,
        rawAiJson: row.rawAiJson,
      });
    } catch {
      return null; // rawAiJson malformed（shape 不符）→ 当无分类、重 LLM。
    }
  }

  async getRepollCount(messageRowId: string): Promise<number> {
    const row = await prisma.mailMessage.findUnique({
      where: { id: messageRowId },
      select: { repollCount: true },
    });
    return row?.repollCount ?? 0;
  }

  async incrementRepollCount(messageRowId: string): Promise<number> {
    const row = await prisma.mailMessage.update({
      where: { id: messageRowId },
      data: { repollCount: { increment: 1 } },
      select: { repollCount: true },
    });
    return row.repollCount;
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
        // 水位线下界的 join key（onboarding-watermark 决策 9）：现 select 缺 accountId、无法对账 processFrom。
        accountId: true,
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

    // 一次 findMany 取**全部账号**（**非**仅 enabled，否则 disabled 账号的已处理邮件其 accountId 缺 map
    // → passesWatermark 收到 undefined 仍放行，但 disabled 账号若设了 processFrom 本应受下界约束、会被误放；
    // 取全量即正确）的 processFrom 建 map（~3 账号、非 N+1）。
    const accounts = await prisma.mailAccount.findMany({
      select: { id: true, processFrom: true },
    });
    const processFromByAccount = new Map<string, Date | null>(
      accounts.map((a) => [a.id, a.processFrom]),
    );

    // JS 取最新分类、过滤、附 receivedAt/id 供确定性排序（优先级档不能在 SQL 表达，故在此排）。
    const enriched: Array<DigestCandidate & { receivedAt: Date; id: string }> = [];
    for (const row of rows) {
      // 水位线下界（onboarding-watermark）：排除 receivedAt < 该账号 processFrom 的接入前历史积压；
      // NULL（账号未设）或缺失 accountId（map 无此账号）⇒ passesWatermark 放行（不设下界）。
      if (!passesWatermark(row.receivedAt, processFromByAccount.get(row.accountId))) {
        continue;
      }
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

  async countRecentSenders(since: Date): Promise<SenderCount[]> {
    // 频率快照（noise-discovery 决策 5）：receivedAt ≥ since 窗内**全部已处理邮件**（含所有优先级、
    // 不 join digest_items 去重）。**显式 select 白名单（仅 fromEmail，杜绝正文）**——非 include。
    // 归一 + 计数在 JS 做（normalizeSenderForCount 剥显示名/小写，SQL distinct 做不到归一）。
    const rows = await prisma.mailMessage.findMany({
      where: { processedAt: { not: null }, receivedAt: { gte: since } },
      select: { fromEmail: true },
    });
    return tallySenderCounts(rows.map((r) => r.fromEmail));
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
