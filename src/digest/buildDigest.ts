// buildDigest（daily-digest 决策 2/4/5）：查候选 → 组装文案 → 按渠道 UTF-16 上限有界分段，
// **纯函数**（只 READS via repo.listDigestCandidates，不发送、不写库）。
//
// 决策 2：`buildDigest(repo, now) → { segments: Array<{ text, messageRowIds }> } | null`；
//   无 P1/P2 且 P3 计数为 0 → null（编排层据此记 digest-empty 不推送）。
// 决策 4：{P1,P2} 逐条渲染、{P3} 仅计数；两子集 row-ids 都进所在段的 messageRowIds（含 P3 段）。
// 决策 5：长度单位 **`text.length`（UTF-16 单位）**——禁 `[...text].length`（码点低估致超限）；
//   单一 `truncateUtf16(s,max)`（代理对安全：丢末尾孤高代理）字段级 + 整行级两处都用；
//   有界渲染器对发件人/主题/原因各截到 FIELD_CAP、整行最终无条件再截到 < SEGMENT_MAX；
//   按整条行分段、P3 计数行并入末段；P3 计数行**不**写「已标记已读」字样。

import type { DigestCandidate, MailRepo, SenderCount } from '../repo/mailRepo.js';
import { DIGEST_TYPE_DAILY, NOISE_TOPN_WINDOW_DAYS } from '../repo/mailRepo.js';

/** 段预算：Telegram sendMessage 上限 4096 UTF-16 单位，留余量（决策 5）。`text.length <= SEGMENT_MAX`。 */
export const SEGMENT_MAX = 4000;

/**
 * 单字段（发件人/主题/原因）截断上限（决策 5）。须满足 `3*FIELD_CAP + 分隔符 + 前缀 ≤ SEGMENT_MAX`：
 * 3*200 + 2*` - `(6) + 行前缀 ≪ 4000，余量充足；整行级硬兜底仍始终执行（不依赖此取值）。
 */
export const FIELD_CAP = 200;

/** 发件人两者皆空时的占位（复用既有 telegram 的同值串，见 decision 5）。 */
const UNKNOWN_SENDER = '（未知发件人）';

/** 渲染行字段分隔符（结构 `发件人 - 主题 - 原因`）。 */
const SEP = ' - ';

/** 摘要文案头行。 */
const HEADER = '邮件摘要';

/** P1/P2 行前缀（标注优先级档）。 */
const PRIORITY_PREFIX: Record<'P1' | 'P2', string> = {
  P1: '[P1] ',
  P2: '[P2] ',
};

/**
 * 去内联换行（`\r`/`\n` → 空格）：发件人/主题/原因均含攻击者可影响内容，带换行会把一封邮件
 * 渲染成多行、伪造摘要结构（假 P1 条目 / 假 P3 计数）。组装行前对各字段归一，杜绝换行注入。
 */
function stripInlineBreaks(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * 按 **UTF-16 code unit**（`s.length`）截断到 `max`，代理对安全：
 * 为省略号预留 1 个单位（slice 到 max-1），若末尾是落单的**高代理**（0xD800–0xDBFF，其低代理被切掉了）则丢弃该单位，
 * 避免裂出孤代理；截断发生时追加 `…`（省略号计 1 个 UTF-16 单位）。结果长度 `result.length <= max`。
 * 字段级与整行级两处共用此单一 helper（决策 5）。
 */
export function truncateUtf16(s: string, max: number): string {
  if (max <= 0) {
    return '';
  }
  if (s.length <= max) {
    return s;
  }
  let cut = s.slice(0, max - 1);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  // 末尾若是孤高代理（0xD800–0xDBFF），其配对低代理已被切掉 → 丢弃，避免孤代理。
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut + '…';
}

/**
 * 有界渲染单条 P1/P2 行（决策 5）：发件人(fromName/fromEmail)/主题/原因各截到 FIELD_CAP、保留 ` - ` 分隔符、
 * 发件人两者皆空 → 占位 `（未知发件人）`；前缀标 P1/P2；**整行最终无条件再截到 < SEGMENT_MAX**（始终执行、
 * 不依赖字段上限取值）。结构保 `发件人 - 主题 - 原因`（含前缀仍是 `^.+ - .+ - .+$`）。
 */
export function renderItemLine(c: DigestCandidate): string {
  // 先去内联换行（防换行注入伪造多行），再截断：发件人/主题/原因均攻击者可影响。
  const fromName = c.fromName !== undefined ? stripInlineBreaks(c.fromName) : '';
  const fromEmail = stripInlineBreaks(c.fromEmail);
  const rawSender =
    fromName.length > 0 ? fromName : fromEmail.length > 0 ? fromEmail : UNKNOWN_SENDER;
  const sender = truncateUtf16(rawSender, FIELD_CAP);
  const subject = truncateUtf16(stripInlineBreaks(c.subject), FIELD_CAP) || '（无主题）';
  const reason = truncateUtf16(stripInlineBreaks(c.reason), FIELD_CAP) || '（无原因）';
  const prefix = c.priority === 'P1' ? PRIORITY_PREFIX.P1 : PRIORITY_PREFIX.P2;
  const line = prefix + [sender, subject, reason].join(SEP);
  // 整行硬兜底：无条件再截到 < SEGMENT_MAX（防超长字段组合 / 前缀使整行越界）。SEGMENT_MAX-1 保严格 <。
  return truncateUtf16(line, SEGMENT_MAX - 1);
}

/** P3 计数行（仅条数、**不**写「已标记已读」——markRead 可能未执行/失败，摘要不核验，见决策 5）。 */
export function renderP3CountLine(count: number): string {
  return `P3 广告营销：${count} 封`;
}

/** 「最近高频发件人 TOP-N」展示条数（noise-discovery 决策 5）。 */
export const NOISE_TOPN = 5;

/** Top-N 区块头行（noise-discovery 决策 5）。 */
const NOISE_HEADER = `最近高频发件人 TOP${NOISE_TOPN}（可加入 noise_senders 降噪）`;

/**
 * 渲染只读「最近高频发件人 TOP-N」区块（noise-discovery 决策 5）：取计数降序前 N，每行 `地址 - N 封`。
 * **纯只读**（零入站面、不触发动作、不泄正文——SenderCount 仅含 fromEmail+count）。数据不足 → 列出已有的若干；
 * 无任何发件人 → 返回 `null`（调用方省略该区块，优雅退化、不产空行）。
 * 发件人地址做字段级有界截断 + 去内联换行（防注入/超限），同 renderItemLine 纪律。
 */
export function renderNoiseTopN(senders: readonly SenderCount[]): string | null {
  if (senders.length === 0) {
    return null;
  }
  const lines = senders.slice(0, NOISE_TOPN).map((s) => {
    const addr = truncateUtf16(stripInlineBreaks(s.fromEmail), FIELD_CAP) || UNKNOWN_SENDER;
    return `${addr} - ${s.count} 封`;
  });
  // 整块兜底截到 < SEGMENT_MAX（N 小、单地址已截 FIELD_CAP，正常远不触发；防御性保每段有界）。
  return truncateUtf16([NOISE_HEADER, ...lines].join('\n'), SEGMENT_MAX - 1);
}

type Segment = { text: string; messageRowIds: string[] };

/**
 * 把已渲染的 P1/P2 行（每行带其 messageRowId）按整条行分段，每段 `text.length <= SEGMENT_MAX`，
 * 决不切断单行（单行已在 renderItemLine 兜底到 < SEGMENT_MAX）。头行进首段。
 */
function packLines(
  lines: Array<{ text: string; messageRowId: string }>,
): Segment[] {
  const segments: Segment[] = [];
  let curText = HEADER;
  let curIds: string[] = [];
  for (const { text, messageRowId } of lines) {
    const candidate = curText + '\n' + text;
    if (candidate.length > SEGMENT_MAX) {
      // 当前段已满 → 收尾，另起新段（新段以头行起，保每段有上下文）。
      segments.push({ text: curText, messageRowIds: curIds });
      curText = HEADER + '\n' + text;
      curIds = [messageRowId];
    } else {
      curText = candidate;
      curIds.push(messageRowId);
    }
  }
  segments.push({ text: curText, messageRowIds: curIds });
  return segments;
}

/** Top-N 频率快照的滚动窗起点：now - NOISE_TOPN_WINDOW_DAYS（noise-discovery 决策 5；独立于 processFrom）。 */
function noiseWindowSince(now: Date): Date {
  return new Date(now.getTime() - NOISE_TOPN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * 组装每日摘要（纯函数，决策 2/4/5 + noise-discovery 决策 5）。
 * @param repo 最小 repo 切片（listDigestCandidates + countRecentSenders）——测试可注入假 repo。
 * @param now 调用时刻；noise Top-N 的滚动窗 since = now - NOISE_TOPN_WINDOW_DAYS（其余沿用既有语义）。
 * @returns `{ segments }`（每段 text.length ≤ SEGMENT_MAX、携带该段 messageRowIds）；
 *   无 P1/P2 且 P3 计数为 0 → `null`（此时**不**附 Top-N、不单独推送——既有空摘要抑制不变）。
 */
export async function buildDigest(
  repo: Pick<MailRepo, 'listDigestCandidates' | 'countRecentSenders'>,
  now: Date,
): Promise<{ segments: Segment[] } | null> {
  const candidates = await repo.listDigestCandidates(DIGEST_TYPE_DAILY);

  const items = candidates.filter((c) => c.priority === 'P1' || c.priority === 'P2');
  const p3 = candidates.filter((c) => c.priority === 'P3');

  // null 条件：无 P1/P2 条目 **且** P3 计数为 0（决策 2）。Top-N **只随非空摘要附带**——此处早返回
  // 即保证「无常规内容时不为 Top-N 单独推送」（noise-discovery 决策 5、不改既有空摘要抑制）。
  if (items.length === 0 && p3.length === 0) {
    return null;
  }

  // P1/P2 逐条渲染（listDigestCandidates 已确定性排序 P1<P2<P3、receivedAt/id 升序，逐条沿用其序）。
  const lines = items.map((c) => ({
    text: renderItemLine(c),
    messageRowId: c.messageRowId,
  }));

  const segments = packLines(lines);

  // P3 计数行并入末段（决策 4/5）：行本身短，且 P3 的 row-ids 全进末段的 messageRowIds（使其被 mark）。
  if (p3.length > 0) {
    const last = segments[segments.length - 1]!;
    const p3Line = renderP3CountLine(p3.length);
    const withP3 = last.text + '\n' + p3Line;
    if (withP3.length <= SEGMENT_MAX) {
      last.text = withP3;
      last.messageRowIds.push(...p3.map((c) => c.messageRowId));
    } else {
      // 末段加不下 P3 行 → 另起一段承载（仍保每段 ≤ SEGMENT_MAX）。
      segments.push({
        text: HEADER + '\n' + p3Line,
        messageRowIds: p3.map((c) => c.messageRowId),
      });
    }
  }

  // 只读 Top-N 区块（noise-discovery 决策 5）：仅随非空摘要附带（已过上面的 null 短路）。独占一段、
  // **messageRowIds 为空**——它是频率快照、不绑 digest_items，绝不让其计数行被 markDigested。
  // 数据不足/无邮件 → renderNoiseTopN 返回 null → 优雅省略该区块（不产空段、不报错）。
  const recent = await repo.countRecentSenders(noiseWindowSince(now));
  const noiseBlock = renderNoiseTopN(recent);
  if (noiseBlock !== null) {
    segments.push({ text: noiseBlock, messageRowIds: [] });
  }

  return { segments };
}
