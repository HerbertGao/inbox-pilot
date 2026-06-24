// Gmail 轮询（list-unread + 穷尽翻页 + DB 预去重 + 最旧优先 + get 预算）——spec gmail-integration
// 「需求:Gmail 轮询并收敛为 NormalizedEmail」、design 决策 5、tasks 4.3。实现 MailProvider.poll()。
//
// 一轮 poll() 流程：
//   1. messages.list(q='is:unread')，**穷尽所有 nextPageToken 页**（纯 id、轻）。
//   2. 每页拿到的 message id **先**对去重键 `(accountId, providerMessageId)`+`processedAt` 预去重
//      （命中已处理 → 跳过、**不** messages.get）。收集未处理 id。
//   3. list 默认最新优先 → 未处理 id **逆序**（最旧优先），取至 **get 预算**（// ponytail: 默认 ≤200/轮）；
//      超出者本轮不处理、下轮穷尽 list 再被发现处理（DB processedAt 即持久进度、无 Gmail 游标）。
//   4. 逐封 messages.get(format='full') → 映射 RawEmail → normalizeEmail → processEmail。
//   5. 逐封 map/parse 错误 try/catch+skip+log（只记 code+kind+accountId+providerMessageId，
//      **不记原始 GaxiosError、不整体记 NormalizedEmail**）；但 **429/配额 与 ProviderReauthRequired(403)
//      绕过逐封 skip、上抛结束本轮并隔离**（否则逐封 skip 继续翻页反而加剧限流）。
//
// 不调 getCursor/setCursor（Gmail 无游标，lastSyncCursor 留空）。

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
import type { GmailApi, GmailMessage, GmailMessagePart } from './gmailClient.js';
import { isInvalidGrant, isReauth403, readErrorCode, readHttpStatus, throwReauth } from './gmailClient.js';

/** 每轮处理上限（get 预算，在 get 数而非翻页数）。// ponytail: 默认 ≤200/轮。 */
const DEFAULT_GET_BUDGET = 200;

/** 分类器白名单的安全/退订轴头（仅这些 payload.headers 映射进 NormalizedEmail.headers）。 */
const HEADER_WHITELIST = new Set([
  'reply-to',
  'return-path',
  'list-unsubscribe',
  'authentication-results',
]);

/** gmailPoll 的可注入依赖（4.5 离线测试注入假 gmail client + repo + processEmail）。 */
export type GmailPollDeps = {
  /** 已构造（自动 refresh）的 GmailApi（prod 由 createGmailClient 给出；测试注入假 client）。 */
  readonly gmail: GmailApi;
  /** 落库 / 去重 seam（prod: PrismaMailRepo；测试: InMemoryMailRepo）。 */
  readonly repo: MailRepo;
  /** executeActions 持有的动作 sink（Gmail markRead/reflectPriority；测试可注入 Fake 或真 gmailActions）。 */
  readonly provider: ProviderActions;
  /**
   * 起算日期水位线（UTC 语义）；NULL/缺省 = 不设日期下界（保持全量 `is:unread`）。
   * 关键最后一跳（design 决策 6）：非空时给查询附加 `after:<floor(epoch 秒)>`（4.4）；漏此跳则水位线
   * 静默 no-op。由 createGmailPoller 接收、main.ts 接线从 `account.processFrom` 放进 deps。
   */
  readonly processFrom?: Date | null;
  /**
   * 通知用显示名 = `label ?? email`（design 决策 1）；缺省 = 不携（下游渲染回落裸 accountId）。
   * 镜像 processFrom 同款穿透：main.ts 接线从 `account.accountLabel` 放进 deps、经 toRawEmail 填进 RawEmail。
   */
  readonly accountLabel?: string;
  /** 每轮 get 预算（默认 200）。 */
  readonly getBudget?: number;
  /** processEmail 注入点。默认真身；测试注入闭包传 InMemoryMailRepo + provider + 假 classify。 */
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
 * 执行一轮 Gmail 轮询。
 *
 * @param accountId 账号去重键命名空间（= MailAccount.id `gmail:<email>`）。
 * @param deps      注入的 gmail client / repo / provider / processEmail / classify。
 */
export async function gmailPoll(accountId: string, deps: GmailPollDeps): Promise<void> {
  const { gmail, repo, provider } = deps;
  const getBudget = deps.getBudget ?? DEFAULT_GET_BUDGET;
  const runProcessEmail = deps.processEmail ?? defaultProcessEmail;
  const notifier = deps.notifier ?? defaultNotifier;
  // processFrom 非空 → 附加 `after:<floor(epoch 秒)>`（Gmail 内部收到时间下界，design 决策 5）；
  // NULL/缺省 → 全量 `is:unread`（不附 after:）。dedup 仍兜底重复（Gmail 无游标、每轮全量）。
  const q = buildUnreadQuery(deps.processFrom ?? undefined);

  // —— 1. 穷尽翻页 list(q)（纯 id、轻）。429/配额绕过 → 结束本轮并隔离 ——
  const allUnreadIds: string[] = [];
  let pageToken: string | undefined;
  do {
    let res: Awaited<ReturnType<GmailApi['users']['messages']['list']>>;
    try {
      res = await gmail.users.messages.list({
        userId: 'me',
        q,
        pageToken,
      });
    } catch (err) {
      // 读侧 429/配额 与 401/403 → 上抛结束本轮（不逐封 skip 继续翻页、加剧限流）。
      handleReadError(accountId, err);
      throw err; // handleReadError 已脱敏记录 / 必要时抛 reauth；非 reauth 的 429/配额原样上抛结束本轮。
    }
    const ids = (res.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    allUnreadIds.push(...ids);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken !== undefined && pageToken !== '');

  // —— 2. 预去重：list-id 对 `(accountId, providerMessageId)`+processedAt 命中已处理 → 跳过（不 get）——
  const unprocessed: string[] = [];
  for (const id of allUnreadIds) {
    const existing = await repo.findByDedupKey(accountId, id);
    if (existing !== null && existing.processedAt !== null) {
      continue; // 已处理（DB 权威）：跳过、不 get（含「已处理长期未读」）。
    }
    unprocessed.push(id);
  }

  // —— 3. 最旧优先（list 最新优先故逆序），取至 get 预算 ——
  const oldestFirst = [...unprocessed].reverse();
  const toProcess = oldestFirst.slice(0, getBudget);

  // —— 4. 逐封 get(format='full') → 映射 → normalize → processEmail ——
  //
  // 错误语义（M-a：窄化逐封 skip，只吞 messages.get/映射/normalize 错误）：
  //   - **读侧 get/映射/normalize 失败** → 逐封 skip+log（但 429/401/403 绕过 skip、结束本轮并隔离，
  //     与读侧 list 一致——否则逐封 skip 继续翻页反而加剧限流 / 漏掉账号级致命）。
  //   - **processEmail 的终态错误**（ProviderReauthRequired / 终态 DB I/O 故障）**不**被逐封 skip 吞掉，
  //     而是上抛结束本轮：与动作错误模型一致——账号级致命隔离 + suspend；终态落库故障由 at-least-once
  //     下轮经 processedAt 幂等重跑兜底（不当成「该封跳过」永久静默）。
  for (const id of toProcess) {
    let normalized: NormalizedEmail;
    try {
      const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      const raw = toRawEmail(res.data, accountId, deps.accountLabel);
      normalized = normalizeEmail(raw);
    } catch (err) {
      // 读侧 429/配额 与 401/403 **绕过逐封 skip**、上抛结束本轮并隔离（不逐封继续翻页加剧限流）。
      const status = readHttpStatus(err);
      if (status === 429) {
        logger.warn(
          { kind: 'gmail-read-quota', accountId, code: readErrorCode(err) },
          'Gmail 读侧 429/配额：结束本轮（仅记 code+kind，禁记原始 GaxiosError）',
        );
        throw err;
      }
      if (status === 401) {
        throwReauth(accountId, err); // 401 是无歧义 auth 失败 → 抛 reauth（隔离账号）。
      }
      if (status === 403) {
        // 403 拆分（FIX3 配额-vs-scope）：insufficientPermissions/forbidden → reauth+suspend；
        // rateLimit/quota/缺 reason → **瞬时**：仅记标量、上抛原始 err 结束本轮（不 suspend 健康账号）。
        if (isReauth403(err)) {
          throwReauth(accountId, err); // scope 失配 → 抛 reauth（隔离账号）。
        }
        logger.warn(
          { kind: 'gmail-read-quota-403', accountId, code: readErrorCode(err), status },
          'Gmail 读侧 403 速率/配额（非 scope 失配）：结束本轮（仅记 code+status+kind，禁记原始 GaxiosError）',
        );
        throw err; // 瞬时 403：上抛原始 err 结束本轮、不 suspend（下轮重试）。
      }
      // invalid_grant（refresh token 撤销/过期，HTTP 400）→ 账号级致命：抛 reauth（隔离 + suspend），
      // **不**逐封 skip（token 已失效，逐封继续 get 只会全失败、徒劳打 token 端点）。
      if (isInvalidGrant(err)) {
        throwReauth(accountId, err);
      }
      // 其余（缺 From / payload 截断 / 映射抛出）：逐封 skip+log（只记 code+kind+accountId+id，
      // **不记原始 GaxiosError、不整体记 NormalizedEmail**——其 to/cc 是第三方 PII、5xx 的
      // .config.headers.Authorization 含 bearer）。
      logger.warn(
        {
          kind: 'gmail-poll-message-failed',
          accountId,
          providerMessageId: id,
          code: readErrorCode(err),
          errorName: err instanceof Error ? err.name : 'unknown',
        },
        '单封 Gmail 轮询 get/映射/normalize 失败，跳过该封（下轮重列重试，DB 去重兜底）',
      );
      continue;
    }
    // processEmail 在 try 外：其终态错误（ProviderReauthRequired / 终态 DB I/O）**propagate** 结束本轮，
    // **不**被逐封 skip 吞掉（与动作错误模型一致；at-least-once 经 processedAt 幂等重跑兜底）。
    const processDeps: ProcessEmailDeps = { repo, provider };
    if (deps.classify !== undefined) {
      (processDeps as { classify?: typeof deps.classify }).classify = deps.classify;
    }
    await runProcessEmail(normalized, processDeps);
  }

  // —— 折叠进 poll 的 durable 重试 drain（durable-retry 决策 1，tasks 4.2/4.3）——
  // 新邮件循环之后：用同一 gmail client + provider（reflectPriority/markRead）+ 注入的 notifier
  // （notify、账号无关）排空该账号到期重试。软 deadline 用单调 elapsed（起点在 drain 开始时捕获）。
  // drain 抛 ProviderReauthRequired **不吞**——沿既有 poll reauth 路径隔离账号（触发 suspend）；
  // 普通瞬时异常由 drain 逐条隔离内部处理。
  const clock = deps.clock ?? (() => new Date());
  const drainStartMs = Date.now();
  const deadline: DrainDeadline = deps.drainDeadline ?? {
    elapsedMs: () => Date.now() - drainStartMs,
    budgetMs: DRAIN_TIME_BUDGET_MS,
  };
  await drainAccountRetries(accountId, { provider, notifier, repo, clock, deadline });
}

/**
 * 构造 Gmail list 查询：`is:unread`；`processFrom` 非空时合取 `after:<floor(processFrom 的 epoch 秒)>`
 * （Gmail `after:` 按内部收到时间、秒粒度；epoch 秒经 `Math.floor(ms/1000)`）。NULL/缺省 → 全量
 * `is:unread`（不附 after:，保持现状）。4.4 / design 决策 5。
 */
function buildUnreadQuery(processFrom: Date | undefined): string {
  if (processFrom === undefined) {
    return 'is:unread';
  }
  const epochSeconds = Math.floor(processFrom.getTime() / 1000);
  return `is:unread after:${epochSeconds}`;
}

/**
 * 读侧 list 错误处理：401 → 抛 reauth；403 经 isReauth403 拆分（scope 失配抛 reauth、速率/配额瞬时）；
 * 429/配额/其它 → 脱敏记录（由调用方上抛结束本轮）。
 * **绝不**记原始 GaxiosError（含 .config.headers.Authorization bearer），只取 code+status。
 */
function handleReadError(accountId: string, err: unknown): void {
  const status = readHttpStatus(err);
  if (status === 401) {
    throwReauth(accountId, err); // 401 是无歧义 auth 失败 → 抛 ProviderReauthRequired（隔离 + suspend）。
  }
  if (status === 403 && isReauth403(err)) {
    // 403 scope 失配（insufficientPermissions/forbidden）→ 抛 reauth（隔离 + suspend）。
    throwReauth(accountId, err);
  }
  // invalid_grant（refresh token 撤销/过期，HTTP 400、token 端点 body error='invalid_grant'）→ 账号级
  // 致命：抛 reauth（隔离 + suspend）。不会自愈，绝不当瞬时每 tick 重试徒劳打 Google token 端点。
  if (isInvalidGrant(err)) {
    throwReauth(accountId, err);
  }
  // 其余（403 速率/配额/缺 reason、429、其它）→ **瞬时**：仅脱敏记录，由调用方上抛原始 err 结束本轮、
  // 不 suspend 健康账号（下轮重试）。
  logger.warn(
    { kind: 'gmail-read-failed', accountId, code: readErrorCode(err), status },
    'Gmail 读侧 list 失败：结束本轮（仅记 code+status+kind，禁记原始 GaxiosError）',
  );
}

/**
 * 把 messages.get(format='full') 的邮件映射为 normalizeEmail 的 RawEmail 入参。
 * - providerMessageId = message id（跨重启稳定）；providerThreadId = threadId；snippet → snippet。
 * - text/plain → textBody；**无 text/plain 则 text/html 先剔 <script>/<style> 再去标签 → textBody**。
 * - htmlBody 可选保留（审计）；全无正文 → 不设 textBody（normalize 后以 subject+headers 分类）。
 * - payload.headers 仅取分类器白名单 → headers；From/Subject 经各自字段（不塞 headers）。
 */
export function toRawEmail(message: GmailMessage, accountId: string, accountLabel?: string): RawEmail {
  const payload = message.payload ?? undefined;
  const headerMap = collectHeaders(payload);

  const fromRaw = headerMap['from'] ?? '';
  const { fromEmail, fromName } = parseFrom(fromRaw);
  const subject = headerMap['subject'];
  const dateHeader = headerMap['date'];

  const textPlain = findBodyByMime(payload, 'text/plain');
  const textHtml = textPlain === undefined ? findBodyByMime(payload, 'text/html') : undefined;
  const textBody =
    textPlain !== undefined
      ? textPlain
      : textHtml !== undefined
        ? htmlToText(textHtml)
        : undefined;

  const whitelistHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerMap)) {
    if (HEADER_WHITELIST.has(key)) {
      whitelistHeaders[key] = value;
    }
  }

  const raw: RawEmail = {
    accountId,
    provider: 'gmail',
    providerMessageId: message.id ?? undefined,
    subject,
    fromEmail,
    headers: whitelistHeaders,
    hasAttachments: detectAttachments(payload),
  };
  // accountLabel（显示名 label??email）：穿透链承载，缺省不设（normalize 后下游回落裸 accountId）。
  if (accountLabel !== undefined) {
    raw.accountLabel = accountLabel;
  }
  if (typeof message.threadId === 'string' && message.threadId.length > 0) {
    raw.providerThreadId = message.threadId;
  }
  if (typeof message.snippet === 'string' && message.snippet.length > 0) {
    raw.snippet = message.snippet;
  }
  if (fromName !== undefined) {
    raw.fromName = fromName;
  }
  if (typeof dateHeader === 'string' && dateHeader.length > 0) {
    raw.date = dateHeader;
  }
  if (textBody !== undefined) {
    raw.textBody = textBody;
  }
  // htmlBody 可选保留（审计）；分类器不读 htmlBody，仅落库/审计。
  if (textHtml !== undefined) {
    raw.htmlBody = textHtml;
  }
  return raw;
}

/** 收集 payload 树上所有 header（key 小写、last-non-empty-wins 由 normalizeEmail 兜底）。 */
function collectHeaders(part: GmailMessagePart | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (part === undefined) {
    return result;
  }
  const walk = (p: GmailMessagePart): void => {
    for (const h of p.headers ?? []) {
      if (typeof h.name === 'string' && typeof h.value === 'string') {
        const key = h.name.toLowerCase();
        // 顶层优先：仅在未设时写（顶层 part 先遍历，子 part 不覆盖顶层 From/Subject 等）。
        if (result[key] === undefined) {
          result[key] = h.value;
        }
      }
    }
    for (const child of p.parts ?? []) {
      walk(child);
    }
  };
  walk(part);
  return result;
}

/** 从 `Name <addr@host>` / `addr@host` 解析裸地址 + 显示名。 */
function parseFrom(raw: string): { fromEmail: string; fromName?: string } {
  const trimmed = raw.trim();
  const m = /^(.*?)<([^>]+)>\s*$/.exec(trimmed);
  if (m !== null) {
    const name = m[1].trim().replace(/^"(.*)"$/, '$1').trim();
    const addr = m[2].trim();
    return name.length > 0 ? { fromEmail: addr, fromName: name } : { fromEmail: addr };
  }
  return { fromEmail: trimmed };
}

/** 在 payload 树中按 mimeType 找首个有 body.data 的 part，base64url 解码为文本；无则 undefined。 */
function findBodyByMime(part: GmailMessagePart | undefined, mime: string): string | undefined {
  if (part === undefined) {
    return undefined;
  }
  if ((part.mimeType ?? '').toLowerCase() === mime) {
    const data = part.body?.data;
    if (typeof data === 'string' && data.length > 0) {
      return decodeBase64Url(data);
    }
  }
  for (const child of part.parts ?? []) {
    const found = findBodyByMime(child, mime);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** base64url（Gmail body.data 编码）→ utf8 文本。 */
function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * 轻量 HTML → 纯文本（// ponytail: 轻量去标签足够，完整 HTML 解析属后续）：
 * **先剔除 `<script>`/`<style>` 块**（否则 CSS/JS 文本污染分类输入），再去标签、解码常见实体、压空白。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 检测是否含附件（任一 part 有 filename 或 body.attachmentId）。 */
function detectAttachments(part: GmailMessagePart | undefined): boolean {
  if (part === undefined) {
    return false;
  }
  if (typeof part.filename === 'string' && part.filename.length > 0) {
    return true;
  }
  if (typeof part.body?.attachmentId === 'string' && part.body.attachmentId.length > 0) {
    return true;
  }
  for (const child of part.parts ?? []) {
    if (detectAttachments(child)) {
      return true;
    }
  }
  return false;
}

/**
 * 构造一个绑定 accountId + GmailApi 的 MailProvider.poll()（per-account/per-poll）。
 * scheduler 迭代该工厂；deps 由 main/scheduler 在每轮注入（gmail client / repo / provider）。
 */
export function createGmailPoller(
  accountId: string,
  deps: GmailPollDeps,
): { poll(): Promise<void> } {
  return {
    poll: () => gmailPoll(accountId, deps),
  };
}
