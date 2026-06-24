// 统一邮件模型 NormalizedEmail（PROJECT_INIT §7）与单点收敛函数 normalizeEmail。
//
// 所有 provider（P3 Gmail / P4 IMAP，后续阶段实现）的原始邮件在进入分类器之前
// 必须先经此函数收敛为 NormalizedEmail；分类器禁止接收任何未规范化的原始 provider 对象。
// 本期不接 provider、不落库、不执行任何动作——入参是「provider 无关的原始公共形状」，
// 由 fixture / 测试驱动；provider→raw 的具体映射放 P3/P4。

/**
 * 统一邮件模型（PROJECT_INIT §7 全字段集）。所有 provider 原始邮件都必须先收敛为此结构。
 */
export type NormalizedEmail = {
  accountId: string;
  /**
   * 通知用显示名 = `label ?? email`（design 决策 1）；缺省 = 不携（渲染回落裸 accountId）。
   * 注册表/poller 解析、经 RawEmail.accountLabel 透传至此、再投影进通知 payload（穿透链末跳前）。
   */
  accountLabel?: string;
  provider: 'gmail' | 'imap';

  providerMessageId: string;
  providerThreadId?: string;
  uid?: number;

  messageId?: string;
  subject: string;
  fromName?: string;
  fromEmail: string;
  to: string[];
  cc?: string[];

  date: string;
  snippet?: string;
  textBody?: string;
  htmlBody?: string;

  hasAttachments: boolean;
  headers: Record<string, string>;

  mailbox?: string;
  labels?: string[];
};

/**
 * normalizeEmail 的入参：provider 无关的原始公共形状。所有字段都是宽松类型，
 * 由本函数做结构化不变量校验、默认值补齐与归一。
 */
export type RawEmail = {
  accountId?: unknown;
  /** 通知用显示名 = `label ?? email`（design 决策 1）；poller 由账号穿透填入、normalize 原样透传。 */
  accountLabel?: unknown;
  provider?: unknown;

  providerMessageId?: unknown;
  providerThreadId?: unknown;
  uid?: unknown;

  messageId?: unknown;
  subject?: unknown;
  fromName?: unknown;
  fromEmail?: unknown;
  to?: unknown;
  cc?: unknown;

  date?: unknown;
  snippet?: unknown;
  textBody?: unknown;
  htmlBody?: unknown;

  hasAttachments?: unknown;
  headers?: unknown;

  mailbox?: unknown;
  labels?: unknown;
};

const VALID_PROVIDERS = new Set(['gmail', 'imap']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 把任意 ISO/可解析日期值归一为 ISO 字符串；缺失或非法时返回 undefined（由调用方回落到摄入时刻）。
 */
function toIsoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return undefined;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return parsed.toISOString();
}

/**
 * 把原始 headers 归一为 Record<string, string>：key 统一 toLowerCase()；
 * 仅大小写不同的同名冲突按 last-non-empty-wins 合并——
 * - 已有非空值时，禁止用空值覆盖（避免静默丢失 authentication-results 等安全 header）；
 * - 两者均非空时按源迭代顺序后写覆盖（last-written-wins），使规则对所有冲突形态完备。
 */
function mergeHeader(result: Record<string, string>, rawKey: string, rawVal: unknown): void {
  const key = rawKey.toLowerCase();
  const next = typeof rawVal === 'string' ? rawVal : rawVal == null ? '' : String(rawVal);
  const existing = result[key];
  if (existing === undefined) {
    result[key] = next;
    return;
  }
  // last-non-empty-wins：非空才覆盖；均非空时后写覆盖；空值不覆盖已有非空值。
  if (next.length > 0) {
    result[key] = next;
  }
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (value === null || typeof value !== 'object') {
    return result;
  }
  // 数组形态（标准 Headers/.entries() 的 [key, value] 对数组）：必须先于 Object.entries
  // 分支处理——数组 typeof === 'object' 且非 null，走对象路径会被 Object.entries 当成
  // 索引键产出数字 key，静默丢掉 authentication-results 等安全 header。
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') {
        mergeHeader(result, entry[0], entry[1]);
      }
      // 非 [string, value] 二元组的畸形项跳过。
    }
    return result;
  }
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    mergeHeader(result, rawKey, rawVal);
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 把 provider 无关的原始邮件对象收敛为统一模型 NormalizedEmail。
 *
 * 结构化不变量（单点 fail-fast）：accountId / provider（须为 'gmail'|'imap'）/ providerMessageId
 * 均须存在且非空，否则抛出明确错误——去重键 `(accountId, providerMessageId)` 与 provider 路由
 * 依赖三者完整，禁止产出结构化字段缺失的 NormalizedEmail 流入后续阶段。
 *
 * 失败隔离：该 throw 仅中止当封邮件。后续阶段（P2 processEmail 轮询循环——此为 P2 义务、
 * 非 P1 交付物）的批量消费者必须逐封 catch+skip 该异常、跳过并记录该封，禁止让单封失败中断
 * 整批轮询；缺去重键的邮件是有意丢弃（无法满足「重启不重复处理」），不是漏处理泄漏。
 *
 * 必填字段默认与归一：subject→`(无主题)`、fromEmail→`''`、date→摄入时刻 ISO、to→[]、
 * hasAttachments→false、headers→{}（key 统一小写、同名冲突 last-non-empty-wins）。
 * 可选字段缺失时保持未设置。
 */
export function normalizeEmail(raw: RawEmail): NormalizedEmail {
  // —— 结构化不变量：缺失/空/非法即 fail-fast ——
  if (!isNonEmptyString(raw.accountId)) {
    throw new Error('normalizeEmail: accountId 缺失或为空（去重键依赖，拒绝该封）');
  }
  if (!isNonEmptyString(raw.provider) || !VALID_PROVIDERS.has(raw.provider)) {
    throw new Error(
      `normalizeEmail: provider 缺失或非法（须为 'gmail'|'imap'），拒绝该封`,
    );
  }
  if (!isNonEmptyString(raw.providerMessageId)) {
    throw new Error(
      'normalizeEmail: providerMessageId 缺失或为空（去重键依赖，拒绝该封）',
    );
  }

  const provider = raw.provider as 'gmail' | 'imap';

  // —— 必填字段默认与归一（杜绝 undefined 必填字段）——
  const subject = isNonEmptyString(raw.subject) ? raw.subject : '(无主题)';
  // 空发件人本身可作为 P4 风险信号，交由模型/规则判断，禁止在 normalize 阶段因其缺失而丢弃邮件。
  const fromEmail = typeof raw.fromEmail === 'string' && raw.fromEmail.length > 0 ? raw.fromEmail : '';
  const date = toIsoOrUndefined(raw.date) ?? new Date().toISOString();
  const to = normalizeStringArray(raw.to) ?? [];
  const hasAttachments = typeof raw.hasAttachments === 'boolean' ? raw.hasAttachments : false;
  const headers = normalizeHeaders(raw.headers);

  const normalized: NormalizedEmail = {
    accountId: raw.accountId,
    provider,
    providerMessageId: raw.providerMessageId,
    subject,
    fromEmail,
    to,
    date,
    hasAttachments,
    headers,
  };

  // —— 可选字段：仅在有合法值时设置，缺失时保持未设置 ——
  // accountLabel：注册表/poller 解析的显示名（label ?? email），原样透传（不改既有字段）。
  if (isNonEmptyString(raw.accountLabel)) {
    normalized.accountLabel = raw.accountLabel;
  }
  if (isNonEmptyString(raw.providerThreadId)) {
    normalized.providerThreadId = raw.providerThreadId;
  }
  if (typeof raw.uid === 'number' && Number.isFinite(raw.uid)) {
    normalized.uid = raw.uid;
  }
  if (isNonEmptyString(raw.messageId)) {
    normalized.messageId = raw.messageId;
  }
  if (isNonEmptyString(raw.fromName)) {
    normalized.fromName = raw.fromName;
  }
  const cc = normalizeStringArray(raw.cc);
  if (cc !== undefined) {
    normalized.cc = cc;
  }
  if (isNonEmptyString(raw.snippet)) {
    normalized.snippet = raw.snippet;
  }
  if (typeof raw.textBody === 'string') {
    normalized.textBody = raw.textBody;
  }
  if (typeof raw.htmlBody === 'string') {
    normalized.htmlBody = raw.htmlBody;
  }
  if (isNonEmptyString(raw.mailbox)) {
    normalized.mailbox = raw.mailbox;
  }
  const labels = normalizeStringArray(raw.labels);
  if (labels !== undefined) {
    normalized.labels = labels;
  }

  return normalized;
}
