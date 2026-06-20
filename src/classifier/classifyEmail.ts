// AI 分类内核：纯函数 classifyEmail(email, deps?) → 校验过的 Classification。
//
// 设计要点（逐条对应 spec）：
//   - 模型调用置于可注入 seam `ChatFn` 之后，离线可测（测试注入假 chat）。
//   - 单次重试、≤2 次模型调用的确定性状态机，按第 1 次失败类别分流，单一计数器硬上限 2。
//   - 最小化送模型输入：buildClassifierInput 只投影必要字段、白名单 header、不发 htmlBody。
//   - 彻底失败 → 完整 8 字段安全默认（P1/不标已读/入摘要），绝不抛未捕获异常。
//   - 只产出建议、绝不执行任何标已读/收发动作（本期无动作 API，确认不 import / 不调用）。
//   - 失败日志只写结构化字段 { kind, model, attempt, zodIssuePaths }，禁止写原始输出 / SDK 错误 / payload。

import { config } from '../config/config.js';
import { logger } from '../logger.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';
import { openRouterChat, type ChatMessage } from './openrouterClient.js';
import { CLASSIFIER_SYSTEM_PROMPT } from './prompt.js';
import { ClassificationSchema, type Classification } from './schema.js';

// —— seam 类型（3.4）——
// 真实实现（openRouterChat）与测试假实现共用此契约：messages + responseFormat + model → 原始字符串 / 抛传输错误。
// 与 openrouterClient.openRouterChat 的签名结构兼容，便于默认注入与 P2 复用。
export type ChatFn = (args: {
  messages: ChatMessage[];
  responseFormat: 'json_schema' | 'json_object';
  model: string;
}) => Promise<string>;

// classifyEmail 的可注入依赖。chat 默认真实 OpenRouter 调用；apiKey 默认取 config，
// 测试可传 apiKey:undefined 模拟「缺 key」而无需改 frozen config。
export type ClassifyDeps = {
  chat?: ChatFn;
  apiKey?: string;
};

// textBody 截断上限（约 6000 字符，§11）。
const TEXT_BODY_MAX = 6000;

// 送模型 header 的固定闭集白名单（仅这些 key 可进入模型输入，其余一律剔除）。
const HEADER_WHITELIST = [
  'reply-to',
  'return-path',
  'list-unsubscribe',
  'authentication-results',
] as const;

// 第 1 次失败后的分流类别。
type FailureKind = 'auth' | 'content' | 'transport' | 'catch-all';

// 送往模型的最小化输入投影。
export type ClassifierInput = {
  from: string;
  fromName?: string;
  subject: string;
  date: string;
  snippet?: string;
  textBody?: string;
  headers: Record<string, string>;
  hasAttachments: boolean;
};

/**
 * 最小化送模型输入（spec「最小化送模型输入，不外泄正文」）：
 *   - 只取 from(=fromEmail)/fromName/subject/date/snippet/textBody/headers/hasAttachments。
 *   - textBody 截断到 ~6000 字符。
 *   - 绝不含 htmlBody。
 *   - header 只保留闭集白名单 { reply-to, return-path, list-unsubscribe, authentication-results }，
 *     其余一律剔除（使「只发白名单」可确定性断言）。
 */
export function buildClassifierInput(email: NormalizedEmail): ClassifierInput {
  const headers: Record<string, string> = {};
  for (const key of HEADER_WHITELIST) {
    const value = email.headers[key];
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }

  const input: ClassifierInput = {
    from: email.fromEmail,
    subject: email.subject,
    date: email.date,
    headers,
    hasAttachments: email.hasAttachments,
  };

  if (email.fromName !== undefined) {
    input.fromName = email.fromName;
  }
  if (email.snippet !== undefined) {
    input.snippet = email.snippet;
  }
  if (email.textBody !== undefined) {
    input.textBody = email.textBody.slice(0, TEXT_BODY_MAX);
  }

  // htmlBody 绝不进入投影（spec：禁止发送 htmlBody）。
  return input;
}

/**
 * 彻底失败的安全默认（spec「彻底失败的安全默认」）：完整 8 字段元组。
 * P1 / 不立即通知 / 不标已读 / 入摘要 / confidence 0 / unknown / 降级理由 / 无风险标记。
 */
function safeDefault(): Classification {
  return {
    priority: 'P1',
    category: 'unknown',
    should_notify_now: false,
    should_mark_read: false,
    should_include_digest: true,
    confidence: 0,
    reason: 'AI 分类失败，降级 P1',
    risk_flags: [],
  };
}

/**
 * 把第 1 次调用抛出的错误分流为失败类别（判定顺序 auth → content → transport → catch-all，互斥）。
 * 通过结构化读取 error.status / error.code / error.message（不依赖 instanceof，使假实现抛的普通错误也可分类）：
 *   - 恰好 401/403            → auth（不重试，同 key 必再失败）。
 *   - 4xx 且 code/message 指示不支持 json_schema/response_format → content（同主模型降级 json_object 重试）。
 *   - status>=500 或 无 status（超时/网络）→ transport（换 fallback 模型重试）。
 *   - 其余（429/402/404/通用 4xx/判不出）→ catch-all（不重试，直接安全默认）。
 */
function classifyError(err: unknown): FailureKind {
  const status = readStatus(err);

  // auth 先判，避免与 content-4xx 重叠。
  if (status === 401 || status === 403) {
    return 'auth';
  }

  // content：4xx 且错误信息指示不支持 json_schema / response_format。
  if (status !== undefined && status >= 400 && status < 500) {
    if (indicatesUnsupportedResponseFormat(err)) {
      return 'content';
    }
    // 其余 4xx（429/402/404/通用/判不出）→ catch-all。
    return 'catch-all';
  }

  // transport：5xx，或无 status（连接超时/网络异常，APIConnectionError 的 status 为 undefined）。
  if (status === undefined || status >= 500) {
    return 'transport';
  }

  // 兜底（理论不可达：<400 的 status）→ catch-all。
  return 'catch-all';
}

function readStatus(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
}

function indicatesUnsupportedResponseFormat(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const haystack = [
    typeof code === 'string' ? code : '',
    typeof message === 'string' ? message : '',
  ]
    .join(' ')
    .toLowerCase();
  return (
    haystack.includes('json_schema') ||
    haystack.includes('response_format') ||
    haystack.includes('structured output') ||
    haystack.includes('structured_output')
  );
}

// 解析 + zod 校验一次模型返回的原始字符串；成功返回 Classification，失败返回 zod issue 路径（供脱敏日志）。
type ParseResult =
  | { ok: true; value: Classification }
  | { ok: false; zodIssuePaths: string[] };

function parseAndValidate(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, zodIssuePaths: ['<json-parse>'] };
  }
  const result = ClassificationSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    zodIssuePaths: result.error.issues.map((issue) => issue.path.join('.') || '(root)'),
  };
}

// 失败结构化日志：只写 { kind, model, attempt, zodIssuePaths }，禁止写原始输出 / SDK 错误对象 / payload。
function logFailure(args: {
  kind: 'content' | 'transport' | 'auth' | 'catch-all' | 'parse' | 'no-api-key';
  model: string;
  attempt: number;
  zodIssuePaths?: string[];
}): void {
  logger.warn(
    {
      kind: args.kind,
      model: args.model,
      attempt: args.attempt,
      zodIssuePaths: args.zodIssuePaths,
    },
    'AI 分类失败，降级安全默认',
  );
}

/**
 * 纯函数分类内核。
 *
 * - email：已经 normalizeEmail 收敛过的统一模型。
 * - deps.chat：模型调用 seam，默认真实 OpenRouter 调用，测试可注入假实现。
 * - deps.apiKey：默认 config.OPENROUTER_API_KEY；缺失 → 不构造、不调用 chat、直接安全默认（不抛异常）。
 *
 * 只产出建议（含安全默认），绝不执行任何 IMAP/Gmail 标已读或发送动作（本期无动作 API）。
 */
export async function classifyEmail(
  email: NormalizedEmail,
  deps: ClassifyDeps = {},
): Promise<Classification> {
  const chat = deps.chat ?? openRouterChat;
  const apiKey = 'apiKey' in deps ? deps.apiKey : config.OPENROUTER_API_KEY;

  // 缺 key 短路：不构造、不发起任何网络调用，直接安全默认、不抛异常（spec「密钥缺失」场景）。
  if (apiKey === undefined || apiKey === '') {
    logFailure({ kind: 'no-api-key', model: config.OPENROUTER_MODEL, attempt: 0 });
    return safeDefault();
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(buildClassifierInput(email)) },
  ];

  const primaryModel = config.OPENROUTER_MODEL;
  const fallbackModel = config.OPENROUTER_FALLBACK_MODEL;

  // 单一全局计数器贯穿两条重试路径，硬上限 2（4.5）。
  let calls = 0;

  // —— 第 1 次：主模型 + json_schema ——
  let firstRaw: string;
  try {
    calls += 1;
    firstRaw = await chat({ messages, responseFormat: 'json_schema', model: primaryModel });
  } catch (err) {
    // 抛错 → 按类别分流。
    const kind = classifyError(err);
    if (kind === 'auth' || kind === 'catch-all') {
      // 不重试，直接安全默认（auth：同 key 必再失败；catch-all：429/402/404/通用 4xx/判不出）。
      logFailure({ kind, model: primaryModel, attempt: 1 });
      return safeDefault();
    }
    // content（4xx 不支持 json_schema）→ 同主模型 + json_object 重试 1 次。
    // transport（5xx/超时/网络）→ fallback 模型 + json_object 重试 1 次。
    const retryModel = kind === 'transport' ? fallbackModel : primaryModel;
    logFailure({ kind, model: primaryModel, attempt: 1 });
    return retryOnce({ chat, messages, model: retryModel, calls });
  }

  // 第 1 次返回字符串 → 解析 + zod。
  const firstParsed = parseAndValidate(firstRaw);
  if (firstParsed.ok) {
    return firstParsed.value;
  }

  // 内容失败（200 但解析/zod 失败）→ 同主模型 + json_object 重试 1 次。
  logFailure({ kind: 'content', model: primaryModel, attempt: 1, zodIssuePaths: firstParsed.zodIssuePaths });
  return retryOnce({ chat, messages, model: primaryModel, calls });
}

/**
 * 第 2 次调用（json_object）。任何失败（抛错 / 解析 / zod）→ 安全默认。
 * `calls` 由调用方传入（第 1 次已 +1），本函数再 +1 并断言总调用 ≤ 2（硬上限的内层防线）。
 */
async function retryOnce(args: {
  chat: ChatFn;
  messages: ChatMessage[];
  model: string;
  calls: number;
}): Promise<Classification> {
  const totalCalls = args.calls + 1; // 此刻为第 2 次，硬上限。
  if (totalCalls > 2) {
    // 不可达防线：状态机线性、无循环，最多两次。若越界则安全默认而非超额调用。
    logFailure({ kind: 'catch-all', model: args.model, attempt: totalCalls });
    return safeDefault();
  }
  let raw: string;
  try {
    raw = await args.chat({ messages: args.messages, responseFormat: 'json_object', model: args.model });
  } catch (err) {
    // 第 2 次抛错（任何类别）→ 安全默认。
    logFailure({ kind: classifyError(err), model: args.model, attempt: 2 });
    return safeDefault();
  }

  const parsed = parseAndValidate(raw);
  if (parsed.ok) {
    return parsed.value;
  }
  logFailure({ kind: 'content', model: args.model, attempt: 2, zodIssuePaths: parsed.zodIssuePaths });
  return safeDefault();
}
