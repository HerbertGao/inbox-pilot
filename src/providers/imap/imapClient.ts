// IMAP 客户端封装（design 决策 4：每轮连接、用完即关）。
//
// 职责：把 imapflow 的连接 / mailboxOpen('INBOX') / search / fetchOne / messageFlagsAdd / logout
// 包成一个**窄接口** ImapConnection，让 poller（4.2）与 markRead（5.1）只依赖这个接口、不直接
// 触碰 imapflow。这样：
//   - 离线测试（4.5 / 5.2）注入假连接即可全链路跑通（无网络）。
//   - markRead 与 poller 共享**同一条已打开连接**（design 决策 4 + CRITICAL 架构点 1）——
//     markRead 由 executeActions 在 processEmail 内发起，而 processEmail 由 poller 在持有
//     当前连接时逐封调用，故 markRead 必须操作 poller 当前打开的那条连接，**禁止**自己再开一条。
//
// 连接生命周期归 poller：poller 每轮 `connect()` 得到一个 ImapConnection，逐封处理后 `logout()`。

import { ImapFlow, type FetchQueryObject } from 'imapflow';
import type { ImapAccount } from '../provider.js';

/**
 * 打开 INBOX 后读到的邮箱状态。
 * - `uidValidity`：UID 命名空间标识（服务端重置时变）。imapflow 给出 bigint，这里归一为
 *   number（INBOX 的 UIDVALIDITY 不会超出安全整数范围；用于拼游标 `<uidValidity>:<uid>`）。
 * - `uidNext`：下一封将分配的 UID（当前 UID 上界）。RFC 3501 rev1 允许服务器省略 →
 *   imapflow 可能给出非正/缺失值，故这里是 `number | undefined`（poller 退化轮 floor 优先级
 *   ③④ 据此兜底，**禁**写 NaN）。
 */
export type MailboxStatus = {
  uidValidity: number;
  uidNext?: number;
};

/**
 * FETCH 回来的单封原始邮件（已从 imapflow 的 FetchMessageObject 取出 poller 需要的字段）。
 * 字段全部宽松/可选——映射为 RawEmail 的归一与默认由 poller + normalizeEmail 负责。
 */
export type FetchedMessage = {
  /** 活动 UID（当前 UIDVALIDITY 下）。markRead 与 UID 合成兜底键依赖。 */
  uid: number;
  /** Message-ID 头（providerMessageId 优先取此，规范化在 poller 做）。 */
  messageId?: string;
  subject?: string;
  /** From 头第一个地址的显示名。 */
  fromName?: string;
  /** From 头第一个地址的裸地址 mailbox@host（不含显示名/尖括号）。 */
  fromEmail?: string;
  to?: string[];
  cc?: string[];
  /** 邮件日期（envelope.date）。 */
  date?: Date;
  /** text/plain 正文（缺失时 poller 回落空串，不因正文缺失丢弃邮件）。 */
  textBody?: string;
};

/**
 * poller / markRead 依赖的**窄连接接口**（注入点）。真身 RealImapConnection 包 imapflow；
 * 测试注入假连接（4.5 / 5.2）。所有 UID 相关操作都按 **UID**（非 sequence number）寻址。
 */
export type ImapConnection = {
  /**
   * 打开 INBOX 并读取当前 UIDVALIDITY 与 UIDNEXT。每轮轮询开头调用一次。
   */
  openInbox(): Promise<MailboxStatus>;

  /**
   * 按给定 IMAP SEARCH 条件检索，返回命中的 **UID 列表**（按服务器返回，poller 自行升序排序）。
   * - 退化轮（首轮 / UIDVALIDITY 变化）：`{ seen: false }` → SEARCH UNSEEN（当前未读积压）；
   *   `processFrom` 非空时 `{ seen: false, since }` → SEARCH `UNSEEN SINCE`（合取日期下界）。
   * - 增量轮：`{ uid: '<游标+1>:*' }` → SEARCH `UID 游标+1:*`（不带 seen 过滤，保崩溃重取）。
   * - `{ uid: '1:*' }`：退化轮空集且 UIDNEXT 缺失时取邮箱现有最大 UID（design 决策 8）。
   * 空结果集返回 `[]`。
   */
  search(criteria: ImapSearchCriteria): Promise<number[]>;

  /**
   * 按**活动 UID** FETCH envelope + 文本正文。命中返回 FetchedMessage；该 UID 已不存在
   * （如 expunge）返回 null（poller 视同跳过、不计入连续高水位推进的「已处理」）。
   */
  fetchByUid(uid: number): Promise<FetchedMessage | null>;

  /**
   * 按**活动 UID** 给邮件加 `\Seen` 标志（幂等）。markRead（5.1）经此落地真实标已读。
   */
  addSeenFlag(uid: number): Promise<void>;

  /** logout（每轮用完即关）。 */
  logout(): Promise<void>;
};

/**
 * search 条件（窄化的 imapflow SearchObject 子集，poller 只用到两种形态）。
 * - `{ seen: false, since? }`：SEARCH UNSEEN（退化轮）；`since` 非空时与 UNSEEN **合取**
 *   （`UNSEEN AND SINCE`，按 INTERNALDATE 粗粒度日期下界，design 决策 5）——`since` **不**替换
 *   `seen`，否则会丢 UNSEEN 过滤摄入已读旧邮件。
 * - `{ uid: '<lo>:*' }`：SEARCH `UID <lo>:*`（增量轮，含崩溃重取；不带日期下界）。
 */
export type ImapSearchCriteria =
  | { seen: false; since?: Date }
  | { uid: string };

/** FETCH 时请求的字段（envelope + text/plain 正文）；poller 与真身实现共用。 */
const FETCH_QUERY: FetchQueryObject = {
  uid: true,
  envelope: true,
  // text/plain 部分：'1' 是单段纯文本邮件的常见正文 part；缺失时由 poller 回落空串。
  bodyParts: ['1', 'text'],
};

/**
 * imapflow 真身实现。每轮由 poller 经 createRealImapConnection 构造、connect 后使用、logout 关闭。
 * 注：原始 imapflow 错误**不**在此层抛 message——markRead 的脱敏在 imapActions（5.1）落地、
 * poller 的单封 catch 只记脱敏摘要；此处仅做类型收敛。
 */
export class RealImapConnection implements ImapConnection {
  constructor(private readonly client: ImapFlow) {}

  async openInbox(): Promise<MailboxStatus> {
    const mailbox = await this.client.mailboxOpen('INBOX');
    // uidValidity 是 bigint；INBOX 的值在安全整数内，归一为 number 拼游标。
    const uidValidity = Number(mailbox.uidValidity);
    // 缺失/非正安全整数 → 抛固定 kind 错（零插值原始值）：本轮失败、不写 NaN 游标，
    // 调度器 catch 记录并下轮重试（与 UIDNEXT 缺失同属 RFC 可选性兜底）。
    if (!Number.isSafeInteger(uidValidity) || uidValidity <= 0) {
      throw new Error('imap-invalid-uidvalidity');
    }
    const uidNext = Number.isFinite(mailbox.uidNext) ? mailbox.uidNext : undefined;
    return { uidValidity, uidNext };
  }

  async search(criteria: ImapSearchCriteria): Promise<number[]> {
    // search 第二参 { uid: true } → 返回 UID（非 sequence number）。
    const result = await this.client.search(criteria, { uid: true });
    // imapflow search 在零命中可能返回 false；归一为空数组（增量分支据此 no-op）。
    return Array.isArray(result) ? result : [];
  }

  async fetchByUid(uid: number): Promise<FetchedMessage | null> {
    const msg = await this.client.fetchOne(String(uid), FETCH_QUERY, { uid: true });
    if (msg === false) {
      return null;
    }
    // uid 非有限（理论上不应发生）→ 视同跳过（同 expunge/false 路径），不喂坏的高水位输入。
    if (!Number.isFinite(msg.uid)) {
      return null;
    }
    const env = msg.envelope;
    const first = env?.from?.[0];
    return {
      uid: msg.uid,
      messageId: env?.messageId,
      subject: env?.subject,
      fromName: first?.name,
      fromEmail: first?.address,
      to: env?.to?.map((a) => a.address ?? '').filter((a) => a.length > 0),
      cc: env?.cc?.map((a) => a.address ?? '').filter((a) => a.length > 0),
      date: env?.date,
      textBody: extractTextBody(msg.bodyParts),
    };
  }

  async addSeenFlag(uid: number): Promise<void> {
    await this.client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }
}

/**
 * 从 fetchOne 的 bodyParts Map 取 text/plain 正文（utf-8 解码）。
 * 缺失/非文本时返回 undefined——poller 回落空串，**不**因正文缺失丢弃邮件（design 风险条）。
 */
function extractTextBody(bodyParts?: Map<string, Buffer>): string | undefined {
  const buf = bodyParts?.get('1') ?? bodyParts?.get('text');
  return buf?.toString('utf-8');
}

/**
 * 构造并连接一条真身 imapflow 连接（poller 每轮调用）。口令只在内存账号对象（不入日志）；
 * imapflow 自身日志禁用（logger: false），避免协议层把账号/服务器值写进日志。
 */
export async function createRealImapConnection(
  account: ImapAccount,
): Promise<ImapConnection> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: { user: account.user, pass: account.password },
    // 禁用 imapflow 自身日志：协议层会打印服务器/账号片段，与脱敏约束相悖。
    logger: false,
    // 仅轮询，不需要 IDLE 长连。
    disableAutoIdle: true,
    // 显式时间上界：per-email 超时的取消手段是 AbortSignal，而 ImapConnection 的方法**不收 signal**
    // （imapflow 的 fetch/search 无法中途取消），故一次卡住的 IMAP 调用只能靠 socket 层封顶。
    // 不设时 imapflow 默认是 connect 90s / greeting 16s / socket 300s——单个卡住的 fetch 能把
    // per-run 墙钟（10min）顶穿，而 hangar 的 in-flight 闸要求 run() 自限时长，挂死会让该 app 再不被调度。
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });
  await client.connect();
  return new RealImapConnection(client);
}
