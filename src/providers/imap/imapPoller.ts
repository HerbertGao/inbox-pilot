// IMAP 轮询（spec「轮询并收敛为 NormalizedEmail」「增量 UID 游标避免重复 FETCH」、design 决策 3/4/6）。
//
// 一轮 pollOnce 的流程：
//   1. openInbox → 读当前 UIDVALIDITY 与 UIDNEXT。
//   2. getCursor → 判定**增量轮**（游标存在且 uidValidity 匹配）还是**退化轮**（首轮 / uidValidity
//      不一致）。
//        - 退化轮：SEARCH UNSEEN（{ seen:false }）——处理当前未读积压，禁 FETCH 整箱历史。
//        - 增量轮：SEARCH `UID 游标+1:*`（{ uid:'<lo>:*' }）——不带 seen 过滤（保崩溃重取）；
//          空结果集 no-op、游标不变（uidValidity 已匹配、无需重写）。
//   3. 取回 UID **升序**逐封：fetchByUid → 映射 RawEmail（fromEmail 裸地址、fromName 显示名、
//      providerMessageId = 规范化 Message-ID 优先 / `imap-uid:<uidValidity>-<uid>` 兜底、携带 uid）
//      → normalizeEmail → processEmail（注入连接绑定的 provider，使 markRead 走当前连接）。
//      逐封 try/catch+skip+log（4.4）：单封 normalize/process 抛出被跳过、不中断整批。
//   4. 推进游标 = **取回 UID 序列上**「连续已处理前缀」高水位（4.3，规则见 advanceHighWater）。
//   5. 轮末 setCursor（增量轮 / 退化轮 floor 优先级见 computeCursorToWrite）；logout。
//
// CRITICAL 架构点 1（连接共享）：本轮打开的连接构造 provider（createImapProvider），markRead 经
// 它操作当前连接，禁止另开连接。
// CRITICAL 架构点 2（注入）：pollOnce 接受注入的 ImapConnection + MailRepo + provider 工厂 +
// processEmail 函数 + classify，使 4.5 离线（假 imap + InMemoryMailRepo + FakeProvider + 假 classify）。

import { logger } from '../../logger.js';
import {
  normalizeEmail,
  type NormalizedEmail,
  type RawEmail,
} from '../../normalizer/normalizeEmail.js';
import type { Classification } from '../../classifier/schema.js';
import type { MailRepo } from '../../repo/mailRepo.js';
import type { ProviderActions } from '../../actions/providerActions.js';
import {
  processEmail as defaultProcessEmail,
  type ProcessEmailDeps,
} from '../../pipeline/processEmail.js';
import { defaultNotifier, type Notifier } from '../../notify/notifier.js';
import {
  drainAccountRetries,
  type DrainDeadline,
} from '../../actions/retryQueue.js';
import { DRAIN_TIME_BUDGET_MS } from '../../actions/retryConstants.js';
import { createImapProvider } from './imapActions.js';
import {
  createRealImapConnection,
  type FetchedMessage,
  type ImapConnection,
  type MailboxStatus,
} from './imapClient.js';
import type { ImapAccount } from '../provider.js';

/**
 * 单封处理结果（供 advanceHighWater 计算「连续已处理前缀」）。
 * - 'processed'：processEmail 成功完成（含 dedup 早退跳过——视同已处理、计入推进）。
 * - 'failed'：fetch/normalize/process 抛出（未 markProcessed）——游标不越过它、下轮重取。
 */
type FetchOutcome = { uid: number; status: 'processed' | 'failed' };

/** pollOnce 的可注入依赖（4.5 离线测试注入假体；prod 注入真身）。 */
export type PollDeps = {
  /** 本轮已打开的连接（prod 由 createRealImapConnection 给出；测试注入假连接）。 */
  readonly connection: ImapConnection;
  /** 落库 / 游标 seam（prod: PrismaMailRepo；测试: InMemoryMailRepo）。 */
  readonly repo: MailRepo;
  /**
   * 起算日期水位线（UTC 语义）；NULL/缺省 = 不设日期下界（保持全量 UNSEEN）。
   * 关键最后一跳（design 决策 6）：经此进 pollOnce 内部决策点，退化轮按它合取 SINCE（4.2）；
   * 漏此跳则水位线静默 no-op。由 pollAccount 从 `account.processFrom` 转入（**非** accountId 位置参）。
   */
  readonly processFrom?: Date | null;
  /**
   * 由连接构造 provider 的工厂（连接共享）。默认 createImapProvider；
   * 测试可注入 FakeProviderActions 工厂以离线断言标已读。
   */
  readonly makeProvider?: (connection: ImapConnection) => ProviderActions;
  /**
   * processEmail 注入点。默认真身；4.5 注入闭包以传入 InMemoryMailRepo + FakeProvider + 假 classify。
   * 仅覆盖 deps.repo / deps.provider / deps.classify——其余（notifier）默认。
   */
  readonly processEmail?: (email: NormalizedEmail, deps: ProcessEmailDeps) => Promise<void>;
  /** 分类 seam（透传给 processEmail）。默认不传（processEmail 用真身 classifyEmail）。 */
  readonly classify?: (email: NormalizedEmail) => Promise<Classification>;
  /**
   * 通知 seam（durable-retry：drain 重试 notify 动作账号无关、非 connection-bound）。
   * 默认 defaultNotifier（telegram from config）；测试注入假渠道。镜像 processEmail 的默认方式。
   * 5.1（组 E）经此字段从 main.ts 显式透传；此处只加字段 + 默认 + 用于 drain。
   */
  readonly notifier?: Notifier;
  /**
   * drain 时钟 seam（durable-retry）。默认 `() => new Date()`；测试注入可控时钟以驱动
   * staleness / nextRetryAt 计算无需真实等待。
   */
  readonly clock?: () => Date;
  /**
   * drain 软 deadline seam（durable-retry 决策 6）。默认捕获 drain 起点单调 elapsed +
   * DRAIN_TIME_BUDGET_MS；测试注入可控 elapsedMs 桩值断言「超软 deadline 提前退出」零真实等待。
   */
  readonly drainDeadline?: DrainDeadline;
};

/**
 * 执行一轮轮询（连接已由调用方打开、用完由调用方 logout——见 pollAccount）。
 *
 * @param accountId 账号去重键命名空间 + 游标落点。
 * @param deps      注入的连接 / repo / provider 工厂 / processEmail / classify。
 */
export async function pollOnce(accountId: string, deps: PollDeps): Promise<void> {
  const { connection, repo } = deps;
  const makeProvider = deps.makeProvider ?? createImapProvider;
  const runProcessEmail = deps.processEmail ?? defaultProcessEmail;
  const notifier = deps.notifier ?? defaultNotifier;
  const provider = makeProvider(connection);

  // —— 1. 打开 INBOX，读当前 UIDVALIDITY 与 UIDNEXT ——
  const status = await connection.openInbox();
  const { uidValidity } = status;

  // —— 2. 读游标，判定增量轮 vs 退化轮 ——
  const cursor = await repo.getCursor(accountId);
  const parsed = parseCursor(cursor);
  // 退化轮：无游标（首轮）或当前 uidValidity 与游标内记录不一致。
  const isDegraded = parsed === null || parsed.uidValidity !== uidValidity;

  let uids: number[];
  if (isDegraded) {
    // 退化轮：SEARCH UNSEEN（处理当前未读积压，禁 FETCH 整箱历史）。
    // processFrom 非空 → 合取 SINCE（`UNSEEN AND SINCE`，粗粒度日期下界 design 决策 5）；
    // NULL/缺省 → 全量 UNSEEN（不附 since）。仅退化轮受约束（增量轮按 UID 游标、不带日期下界）。
    const since = deps.processFrom ?? undefined;
    uids = await connection.search(since !== undefined ? { seen: false, since } : { seen: false });
  } else {
    // 增量轮：SEARCH `UID 游标+1:*`（不带 seen 过滤，保崩溃重取）。
    // 注：按 RFC 3501，`N:*` 即使无 UID ≥ N 也总返回最高 UID，故空增量轮可能重取最顶一封——
    // 这是 dedup 安全的（processedAt 命中即早退）、游标重写幂等，不会重复处理或回退。
    uids = await connection.search({ uid: `${parsed.uid + 1}:*` });
  }

  // —— 3. 按 UID 升序逐封处理（单封 try/catch+skip+log）——
  const sortedUids = [...uids].sort((a, b) => a - b);
  const outcomes: FetchOutcome[] = [];
  for (const uid of sortedUids) {
    outcomes.push(
      await processOne(uid, uidValidity, accountId, {
        connection,
        repo,
        provider,
        runProcessEmail,
        classify: deps.classify,
      }),
    );
  }

  // —— 4 + 5. 算高水位、按轮类型 + floor 优先级算要写的游标、setCursor ——
  const highWater = advanceHighWater(outcomes);
  const allSucceeded = outcomes.every((o) => o.status === 'processed');
  // outcomes 按 UID 升序（sortedUids）→ 首个 failed 即最低失败封 UID（退化轮首封即失败时锚点）。
  const firstFailedUid = outcomes.find((o) => o.status === 'failed')?.uid ?? null;
  const toWrite = computeCursorToWrite({
    isDegraded,
    uidValidity,
    uidNext: status.uidNext,
    highWater,
    allSucceeded,
    firstFailedUid,
    incrementalCursor: parsed,
  });
  if (typeof toWrite === 'string') {
    await repo.setCursor(accountId, toWrite);
  } else if (toWrite !== null) {
    // 哨兵 need-max-uid（退化轮空集——无失败封——且 UIDNEXT 缺失）：禁写 `:0`（下轮 `UID 1:*` 无界重扫整箱历史）。
    // 经既有 search seam 取邮箱现有最大 UID 写 `uidValidity:<maxUid>`、下轮转增量（design 决策 8）。
    // **已知接受的竞态**：此 `1:*` 搜索在退化轮空 SINCE 搜索之后，二者之间到达的新邮件（UID maxUid+1）
    // 会被纳入游标却未处理 → 下次 uidValidity 重置前漏收。窗口亚秒、仅一次性退化轮、换掉旧 `:0` 全量重扫，
    // 显式接受（design 决策 8 / tasks 4.3 accepted-degraded）。
    const allUids = await connection.search({ uid: '1:*' });
    if (allUids.length > 0) {
      const maxUid = Math.max(...allUids);
      await repo.setCursor(accountId, `${uidValidity}:${maxUid}`);
    }
    // 邮箱本就空（`1:*` 也空）→ 不写、保持退化轮（下轮仍空、无害、无进度需求）。
  }

  // —— 6. 折叠进 poll 的 durable 重试 drain（durable-retry 决策 1，tasks 4.1/4.3）——
  // 新邮件处理 + 游标落库**之后**、调用方 logout **之前**：用本轮 live 连接构造的 provider
  // （reflectPriority/markRead）+ 注入的 notifier（notify、账号无关）排空该账号到期重试。
  // 软 deadline 用单调 elapsed（起点在 drain 开始时捕获；ponytail：不在 drain 内取 Date.now 以保可测）。
  // drain 抛 ProviderReauthRequired **不吞**——沿 pollOnce → pollAccount → guard 既有路径隔离账号
  // （触发 suspend）；普通瞬时异常由 drain 逐条隔离内部处理。
  const clock = deps.clock ?? (() => new Date());
  const drainStartMs = Date.now();
  const deadline: DrainDeadline = deps.drainDeadline ?? {
    elapsedMs: () => Date.now() - drainStartMs,
    budgetMs: DRAIN_TIME_BUDGET_MS,
  };
  await drainAccountRetries(accountId, { provider, notifier, repo, clock, deadline });
}

/** processOne 的内部依赖（已解析的 provider / processEmail / classify）。 */
type ProcessOneDeps = {
  connection: ImapConnection;
  repo: MailRepo;
  provider: ProviderActions;
  runProcessEmail: (email: NormalizedEmail, deps: ProcessEmailDeps) => Promise<void>;
  classify?: (email: NormalizedEmail) => Promise<Classification>;
};

/**
 * 处理单封（fetch → 映射 → normalize → processEmail），逐封 try/catch+skip+log（4.4）。
 * - fetchByUid 返回 null（如 expunge）：视同跳过、status='failed'（不计入连续已处理前缀），
 *   但因 expunge 空洞按**取回序列**推进，缺失 UID 不在 outcomes 中、不卡死高水位（4.3）。
 *   注：此处 null 走「失败/跳过」分支即可——expunge 的 UID 通常根本不在 search 取回结果里；
 *   若服务器在 search 后 fetch 前删除导致 null，按未成功处理停在其前一位、下轮重取，安全。
 * - normalize/process 抛出：catch+log，status='failed'（游标不越过它、下轮重取重试）。
 */
async function processOne(
  uid: number,
  uidValidity: number,
  accountId: string,
  deps: ProcessOneDeps,
): Promise<FetchOutcome> {
  try {
    const fetched = await deps.connection.fetchByUid(uid);
    if (fetched === null) {
      logger.warn(
        { kind: 'imap-fetch-missing', uid },
        'FETCH 返回空（该 UID 已不存在，如 expunge）：跳过、游标不越过',
      );
      return { uid, status: 'failed' };
    }
    const raw = toRawEmail(fetched, uidValidity, accountId);
    const normalized = normalizeEmail(raw);
    const processDeps: ProcessEmailDeps = {
      repo: deps.repo,
      provider: deps.provider,
    };
    if (deps.classify !== undefined) {
      (processDeps as { classify?: typeof deps.classify }).classify = deps.classify;
    }
    await deps.runProcessEmail(normalized, processDeps);
    return { uid, status: 'processed' };
  } catch (err) {
    // 单封失败隔离：记录脱敏摘要后继续整批；游标不越过它（status='failed'）。
    logger.warn(
      {
        kind: 'imap-poll-message-failed',
        uid,
        errorName: err instanceof Error ? err.name : 'unknown',
        errorCode: (err as { code?: unknown })?.code,
      },
      '单封轮询处理失败，跳过该封、不推进游标过它（下轮重取重试）',
    );
    return { uid, status: 'failed' };
  }
}

/**
 * 把 FETCH 回来的邮件映射为 normalizeEmail 的 RawEmail 入参。
 * - fromEmail = 裸地址 mailbox@host（envelope.from[0].address）；fromName = 显示名。
 * - providerMessageId = 规范化 Message-ID 优先（首尾去空白、保留尖括号内逐字、不大小写折叠）；
 *   缺失回退 `imap-uid:<uidValidity>-<uid>`（同一 UIDVALIDITY 期 + 服务重启间稳定）。
 * - 携带活动 uid（markRead 依赖）；textBody 缺失回落空串（不因正文缺失丢弃邮件）。
 */
function toRawEmail(
  fetched: FetchedMessage,
  uidValidity: number,
  accountId: string,
): RawEmail {
  const normalizedMessageId = normalizeMessageId(fetched.messageId);
  const providerMessageId =
    normalizedMessageId ?? `imap-uid:${uidValidity}-${fetched.uid}`;
  return {
    accountId,
    provider: 'imap',
    providerMessageId,
    uid: fetched.uid,
    // messageId 透传规范化后的值（供审计 / 落库 messageId 列）；缺失时不设。
    messageId: normalizedMessageId,
    subject: fetched.subject,
    fromName: fetched.fromName,
    fromEmail: fetched.fromEmail,
    to: fetched.to,
    cc: fetched.cc,
    date: fetched.date,
    textBody: fetched.textBody ?? '',
  };
}

/**
 * Message-ID 规范化：首尾去空白、保留尖括号内内容**逐字**、**不**大小写折叠。
 * 空 / 全空白 → undefined（回退 UID 合成键）。
 */
function normalizeMessageId(messageId?: string): string | undefined {
  if (typeof messageId !== 'string') {
    return undefined;
  }
  const trimmed = messageId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 游标内容 `<uidValidity>:<uid>` 解析。任何非有限/格式不符 → null（按首轮/退化处理）。
 */
function parseCursor(cursor: string | null): { uidValidity: number; uid: number } | null {
  if (cursor === null) {
    return null;
  }
  // 严格 `<digits>:<digits>` 格式：拒绝空串/前导符号/小数/科学计数/`5:`/`:5`
  // （Number 的强制会把这些当作 0/有限值，绕过校验）。
  if (!/^\d+:\d+$/.test(cursor)) {
    return null;
  }
  const idx = cursor.indexOf(':');
  const uidValidity = Number(cursor.slice(0, idx));
  const uid = Number(cursor.slice(idx + 1));
  if (!Number.isSafeInteger(uidValidity) || !Number.isSafeInteger(uid)) {
    return null;
  }
  return { uidValidity, uid };
}

/**
 * 取回序列上「连续已处理前缀」高水位（4.3）：UID 升序遍历 outcomes，推到其及之前**全部**已处理
 * （status==='processed'，含 dedup 早退视同已处理）的最高 UID，遇首个未成功（'failed'）即停、
 * 不越过。**非 dense 整数区间**——只看实际取回的 UID，故 expunge 空洞不卡死。
 * 全失败 / 空集 → null（无连续高水位）。
 */
function advanceHighWater(outcomes: FetchOutcome[]): number | null {
  let high: number | null = null;
  for (const o of outcomes) {
    if (o.status === 'processed') {
      high = o.uid;
    } else {
      break; // 首个未成功即停、不越过。
    }
  }
  return high;
}

/** computeCursorToWrite 入参。 */
type ComputeCursorArgs = {
  isDegraded: boolean;
  uidValidity: number;
  uidNext?: number;
  highWater: number | null;
  allSucceeded: boolean;
  /** 首个（最低 UID）失败封的 UID；无失败封则 null。退化轮首封即失败时锚定到其前一位转增量重取。 */
  firstFailedUid: number | null;
  incrementalCursor: { uidValidity: number; uid: number } | null;
};

/**
 * computeCursorToWrite 结果：
 *   - `string`：直接要写入的游标字符串（含退化轮首封失败 → 锚到 `<uidValidity>:<firstFailedUid-1>`、下轮增量重取）。
 *   - `null`：**不写**（仅增量轮空集 no-op / 增量轮首封即失败时——游标不变、下轮重取）。
 *   - `{ kind: 'need-max-uid' }`：**退化轮空集（`allSucceeded`、无失败封）且 UIDNEXT 缺失**——不能写 `:0`（会令下轮 `UID 1:*`
 *     无界重扫整箱历史，正是本提案要消除的刷屏）。须由 `pollOnce`（async）经 `search({uid:'1:*'})`
 *     取邮箱现有最大 UID 写 `uidValidity:<maxUid>` 兑现（design 决策 8；本纯同步函数无 connection、
 *     不能 await，故返哨兵）。邮箱本就空（`1:*` 也空）则保持退化轮、不写。
 */
type CursorToWrite = string | null | { kind: 'need-max-uid' };

/**
 * 算轮末要写入的游标；见 CursorToWrite。
 *
 * 增量轮（uidValidity 已匹配）：
 *   - 有连续高水位 → `<uidValidity>:<高水位>`。
 *   - 无高水位（空集 no-op，或全失败）：
 *       · 空集（无取回）→ null（no-op，游标不变；uidValidity 已匹配、无需重写）。
 *       · 全失败（有取回但首封即失败）→ null（游标不越过首个失败封、保持原值、下轮重取）。
 *
 * 退化轮（首轮 / uidValidity 变化）floor 优先级（spec §增量 UID 游标 ①②③④）——
 * **即使空集也必须写当前 uidValidity**（否则反复 UNSEEN）：
 *   ① 全成功（含空集）且 UIDNEXT 为正整数 → `<uidValidity>:<UIDNEXT-1>`。
 *   ② 有取回封失败（!allSucceeded）→ `<uidValidity>:<取回连续高水位>`（失败封下轮重取）。
 *   ③ UIDNEXT 缺失/非正 → 退化为取回连续高水位（若有）。
 *   首封即失败（!allSucceeded、无连续高水位、firstFailedUid=F）→ `<uidValidity>:<F-1>`、下轮转**增量**
 *     `UID F:*` 重取失败封 F（无论它仍 unseen 还是 markRead 后才崩、已变 read——增量不带 UNSEEN 过滤都能兜回，
 *     dedup 兜底不重复）。受 F 下界约束（**非** :0 无界重扫），收敛到既有增量 poison 钉扎语义。**不**落 ④
 *     越过失败封 UID（守 :245 契约 + 修 P2-crash 首封孤儿：已 read 的失败封 SEARCH UNSEEN 不再返回它）。
 *   ④ 空集（`allSucceeded`、**无失败封**）且无 UIDNEXT（连高水位也无）→ 哨兵 `need-max-uid`（**禁** `:0` 无界重扫，
 *      由 pollOnce 经 `search({uid:'1:*'})` 取现有最大 UID 兑现，design 决策 8）。
 * **禁** NaN / prev-uid（旧命名空间）作 floor。
 */
function computeCursorToWrite(args: ComputeCursorArgs): CursorToWrite {
  const { isDegraded, uidValidity, uidNext, highWater, allSucceeded, firstFailedUid } = args;

  if (!isDegraded) {
    // —— 增量轮 ——
    if (highWater !== null) {
      return `${uidValidity}:${highWater}`;
    }
    // 无连续高水位：空集 no-op 或首封即失败 → 游标不变（不写）。
    return null;
  }

  // —— 退化轮：即使空集也必须写当前 uidValidity ——
  const uidNextValid = typeof uidNext === 'number' && Number.isInteger(uidNext) && uidNext > 0;

  // ① 全成功（含空集）且 UIDNEXT 正整数 → UIDNEXT-1（当前 UID 上界）。
  if (allSucceeded && uidNextValid) {
    return `${uidValidity}:${uidNext - 1}`;
  }
  // ② 有失败 → 取回连续高水位（失败封下轮重取）。
  if (!allSucceeded && highWater !== null) {
    return `${uidValidity}:${highWater}`;
  }
  // ③ UIDNEXT 缺失/非正 → 退化为取回连续高水位（若有）。
  if (highWater !== null) {
    return `${uidValidity}:${highWater}`;
  }
  // 退化轮首封即失败（无连续高水位）→ 把游标锚到**首个失败封 UID 前一位**，使下轮转**增量**
  // `UID firstFailedUid:*`（增量不带 UNSEEN 过滤）重取该失败封：无论它仍 unseen（fetch/normalize 抛）
  // 还是已 markRead 后才崩（markProcessed 抛、已变 read、SEARCH UNSEEN 不再返回它）都能经增量兜回，
  // dedup（processedAt 命中早退）兜底不重复处理。受 firstFailedUid 下界约束（**非** :0 无界全箱重扫），
  // 收敛到既有增量 poison 钉扎语义（每轮重取首个失败封、游标钉其前）。④ 哨兵仅退化轮**空集**触发。
  // （`!allSucceeded` 必有失败 outcome ⇒ `firstFailedUid !== null`；该 `&& firstFailedUid !== null` 仅类型守卫。）
  // 边界 firstFailedUid=1（最低 UID 那封失败）→ 锚 `uidValidity:0` → 下轮增量 `UID 1:*` 即单轮全箱重扫，
  // 但 dedup 兜底、UID1 成功即自纠收敛——仅此一轮、且仅**最小** UID 失败才触发，严格窄于旧 ④「所有首封失败写 :0」。
  if (!allSucceeded && firstFailedUid !== null) {
    return `${uidValidity}:${firstFailedUid - 1}`;
  }
  // ④ 空集（allSucceeded、无失败封）且无 UIDNEXT（连高水位也无）→ 哨兵：禁写 `:0`（无界重扫），由 pollOnce 取现有最大 UID 兑现。
  return { kind: 'need-max-uid' };
}

/**
 * prod 入口：每轮新建连接 → pollOnce → logout（连接生命周期归此处，design 决策 4）。
 * connect/logout 自身失败不在此吞——由调度器（6.1）的 try/finally 锁释放兜底（异常路径锁不死）。
 *
 * durable-retry 5.1：`notifier` 经此入口显式透传进 `pollOnce` deps（drain 重试 notify 动作账号无关、
 * 非 connection-bound）。缺省 `defaultNotifier`，使既有调用（测试/无 notifier）行为不变；main.ts 显式传入。
 * clock/drainDeadline 用 pollOnce 内默认 seam（每轮 drain 起点捕获单调 elapsed），无需在此显式注入。
 */
export async function pollAccount(
  account: ImapAccount,
  repo: MailRepo,
  classify?: (email: NormalizedEmail) => Promise<Classification>,
  notifier?: Notifier,
): Promise<void> {
  const connection = await createRealImapConnection(account);
  try {
    // processFrom 经 deps 转入 pollOnce 内部决策点（**不**改 accountId 位置参数；design 决策 6）。
    await pollOnce(account.accountId, {
      connection,
      repo,
      classify,
      notifier,
      processFrom: account.processFrom,
    });
  } finally {
    // 用完即关；logout 失败不掩盖 pollOnce 的原始异常（仅记一条）。
    try {
      await connection.logout();
    } catch (err) {
      logger.warn(
        {
          kind: 'imap-logout-failed',
          errorName: err instanceof Error ? err.name : 'unknown',
          errorCode: (err as { code?: unknown })?.code,
        },
        'IMAP logout 失败（本轮已结束，下轮新建连接）',
      );
    }
  }
}
