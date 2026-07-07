// Gmail 运行期客户端封装（按 refresh token 构造、自动 refresh）——spec gmail-integration
// 「需求:Gmail OAuth 授权与 token 持久化」运行期 refresh 子句、design 决策 4、tasks 4.2。
//
// 职责：
//   - 用 env app 凭据 + 账号 refresh token 构造 OAuth2Client（自动用 refresh token 换 access token）。
//   - 暴露最小 `GmailApi`（messages.list/get/modify、labels.list/create）给 poller / actions 消费。
//   - 运行期 refresh 后**只回写 refreshToken（仅当 Google 轮换了它）**——**绝不**把
//     access_token/expiry 写入 authJson（保 access token 不落 at-rest）。
//   - 回写持久化失败：只记 `code`+固定 kind，**禁记原始 Prisma 错误**（其 params 可能含轮换的
//     refresh_token，key-redact 清不掉字符串子串）。
//   - refresh 失败（token 撤销/过期）：只记 `error.code`+固定 kind（**禁记 GaxiosError
//     `.response`/`.config`/cause**），**抛 `ProviderReauthRequired`**（与 403 同类型，使 guard
//     suspend + enabled=false——console 撤销/过期 token 跨重启停轮询，不只本轮 isolate）。
//
// **全代码无 messages.send 路径**（GmailApi 不暴露 send；硬约束「绝不发送」由代码落地）。

import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

import { logger } from '../../logger.js';
import { ProviderReauthRequired } from '../provider.js';

/**
 * Gmail API 的**最小结构子集**（poller / actions 用到的方法）。用结构接口而非具体 gmail_v1.Gmail，
 * 使测试可注入假 client、并使「无 send 路径」可结构性断言（本类型故意**不含** messages.send）。
 */
// 每方法可选 `signal?: AbortSignal`（design D7 best-effort 取消）：run() 的 per-email/list 超时 abort 时
// 传入，Gaxios(googleapis 传输层) 尽力中止在途 socket——**不保证**毁 socket，真正的 anti-wedge 靠 run()
// 侧 fence + 吞诺（见 pipeline.ts raceTimeout）。缺省 undefined，既有调用点不受影响。
export type GmailApi = {
  users: {
    messages: {
      list(params: {
        userId: string;
        q?: string;
        pageToken?: string;
        maxResults?: number;
        signal?: AbortSignal;
      }): Promise<{ data: { messages?: Array<{ id?: string | null }> | null; nextPageToken?: string | null } }>;
      get(params: {
        userId: string;
        id: string;
        format?: string;
        signal?: AbortSignal;
      }): Promise<{ data: GmailMessage }>;
      modify(params: {
        userId: string;
        id: string;
        requestBody: { addLabelIds?: string[]; removeLabelIds?: string[] };
        signal?: AbortSignal;
      }): Promise<{ data: unknown }>;
    };
    labels: {
      list(params: { userId: string; signal?: AbortSignal }): Promise<{
        data: { labels?: Array<{ id?: string | null; name?: string | null }> | null };
      }>;
      create(params: {
        userId: string;
        requestBody: { name: string; labelListVisibility?: string; messageListVisibility?: string };
        signal?: AbortSignal;
      }): Promise<{ data: { id?: string | null; name?: string | null } }>;
    };
  };
};

/** messages.get(format='full') 返回的邮件结构子集（映射 RawEmail 用）。 */
export type GmailMessage = {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  payload?: GmailMessagePart | null;
};

/** Gmail payload part（递归；body.data 为 base64url）。 */
export type GmailMessagePart = {
  mimeType?: string | null;
  filename?: string | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null;
  parts?: GmailMessagePart[] | null;
};

/** refresh 后只回写 refreshToken（仅轮换时）的持久化 seam。 */
export type RefreshTokenPersist = (accountId: string, refreshToken: string) => Promise<void>;

/** createGmailClient 的依赖（4.5 离线测试注入假 OAuth2Client / 假 persist）。 */
export type GmailClientDeps = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** 回写轮换后的 refreshToken（仅当 Google 轮换）；省略则不持久化（best-effort）。 */
  persistRefreshToken?: RefreshTokenPersist;
  /** 注入 OAuth2Client（测试断言「不写 access_token 入 authJson」「refresh 失败抛 reauth」）。 */
  oauthClient?: OAuth2ClientLike;
  /** 注入 GmailApi 工厂（测试注入假 gmail client）。默认走 googleapis。 */
  makeGmailApi?: (auth: OAuth2ClientLike) => GmailApi;
};

/** OAuth2Client 运行期用到的最小子集（结构接口，便于测试注入）。 */
export type OAuth2ClientLike = {
  setCredentials(creds: { refresh_token?: string | null }): void;
  on(event: 'tokens', listener: (tokens: { refresh_token?: string | null }) => void): unknown;
};

/** 真身 OAuth2Client 工厂。 */
function defaultOAuthClient(args: { clientId: string; clientSecret: string }): OAuth2ClientLike {
  return new OAuth2Client({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
  }) as unknown as OAuth2ClientLike;
}

/** 真身 GmailApi 工厂（googleapis）。auth 经 unknown 转接（google-auth-library 多版本私有字段差异）。 */
function defaultMakeGmailApi(auth: OAuth2ClientLike): GmailApi {
  const opts = { version: 'v1', auth } as unknown as Parameters<typeof google.gmail>[0];
  return google.gmail(opts) as unknown as GmailApi;
}

/**
 * 构造一个按 refresh token 自动 refresh 的 GmailApi。
 *
 * 自动 refresh 的回写纪律（spec / tasks 4.2）：
 *   - 监听 OAuth2Client 的 `tokens` 事件：**仅** `tokens.refresh_token` 存在（Google 轮换了它）时
 *     才回写——**绝不**把 access_token/expiry 写入 authJson。
 *   - 回写失败：只记 `code`+固定 kind（**禁记原始 Prisma 错误**——params 含轮换的 refresh_token）。
 *
 * refresh 失败（runtime 调 API 时 token 撤销/过期）由 poller/actions 的调用点 catch googleapis
 * 抛的 GaxiosError，识别 401/403 → 抛 `ProviderReauthRequired`（见 mapGmailAuthError）。
 */
export function createGmailClient(accountId: string, deps: GmailClientDeps): GmailApi {
  const client = deps.oauthClient ?? defaultOAuthClient(deps);
  const makeGmailApi = deps.makeGmailApi ?? defaultMakeGmailApi;

  // 仅设 refresh_token（不设 access_token/expiry）——access token 运行期由库自动换、不长存、不落 at-rest。
  client.setCredentials({ refresh_token: deps.refreshToken });

  // 监听轮换：仅 refresh_token 存在才回写；access_token/expiry 一律不持久化。
  client.on('tokens', (tokens) => {
    const rotated = tokens.refresh_token;
    if (typeof rotated !== 'string' || rotated.length === 0) {
      return; // 普通 access token 刷新（无 refresh_token 轮换）：不回写、不落 at-rest。
    }
    const persist = deps.persistRefreshToken;
    if (persist === undefined) {
      return;
    }
    // 回写失败：只记 code+固定 kind，**禁记原始 Prisma 错误**（params 含轮换的 refresh_token）。
    void persist(accountId, rotated).catch((err: unknown) => {
      logger.warn(
        {
          kind: 'gmail-refresh-token-persist-failed',
          accountId,
          code: readErrorCode(err),
        },
        '回写轮换后的 refreshToken 失败（仅记 code+kind，禁记原始错误）',
      );
    });
  });

  return makeGmailApi(client);
}

/**
 * 从未知 error 安全取 `code`（GaxiosError / Prisma error 的数字/字符串 code），其余 → undefined。
 * **只取标量 code**，绝不返回原始 error 对象（防 `.response`/`.config`/params 内嵌凭据入日志）。
 */
export function readErrorCode(err: unknown): string | number | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') {
      return code;
    }
  }
  return undefined;
}

/** 从未知 error 安全取 HTTP status（GaxiosError 顶层 `status` 或 `response.status`）。 */
export function readHttpStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') {
    return undefined;
  }
  const top = (err as { status?: unknown }).status;
  if (typeof top === 'number') {
    return top;
  }
  // 不整体记 .response（含凭据）；仅**读取**其 status 标量，不外泄。
  const response = (err as { response?: unknown }).response;
  if (response !== null && typeof response === 'object') {
    const status = (response as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
}

/**
 * 从 GaxiosError 安全取**标量** error reason（`err.errors[0].reason` 或
 * `err.response.data.error.errors[0].reason`），其余 → undefined。**只取标量字符串**，绝不返回原始
 * error/response 对象（防 .config/.headers bearer / response.data 凭据子串入日志）。
 */
export function readErrorReason(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') {
    return undefined;
  }
  // 形态 1：err.errors[0].reason（Gaxios 顶层）。
  const top = (err as { errors?: unknown }).errors;
  const fromTop = firstReason(top);
  if (fromTop !== undefined) {
    return fromTop;
  }
  // 形态 2：err.response.data.error.errors[0].reason（HTTP body）。仅穿透取标量 reason、不外泄对象。
  const response = (err as { response?: unknown }).response;
  if (response !== null && typeof response === 'object') {
    const data = (response as { data?: unknown }).data;
    if (data !== null && typeof data === 'object') {
      const error = (data as { error?: unknown }).error;
      if (error !== null && typeof error === 'object') {
        const fromBody = firstReason((error as { errors?: unknown }).errors);
        if (fromBody !== undefined) {
          return fromBody;
        }
      }
    }
  }
  return undefined;
}

/** 从 `[{ reason }]` 形态的数组取首个标量 reason 字符串；非数组/无 reason → undefined。 */
function firstReason(arr: unknown): string | undefined {
  if (!Array.isArray(arr) || arr.length === 0) {
    return undefined;
  }
  const first = arr[0];
  if (first !== null && typeof first === 'object') {
    const reason = (first as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) {
      return reason;
    }
  }
  return undefined;
}

/** 403 的瞬时（速率/配额）reason 集——这些是暂时的，**不**应 reauth-suspend 健康账号。 */
const TRANSIENT_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
]);

/**
 * 判定一个 403 错误是否应**真正 reauth**（auth/scope 失配）而非瞬时（速率/配额）。
 * Gmail 对「权限/scope 不足」与「配额/限流」都返回 403——只有前者是账号级致命（需重授权）。
 *   - reason ∈ {rateLimitExceeded, userRateLimitExceeded, quotaExceeded, dailyLimitExceeded} → 瞬时（false）。
 *   - reason ∈ {insufficientPermissions, forbidden} → reauth（true）。
 *   - reason 缺失/不明 → **默认瞬时（false）**：误判瞬时只是下轮重试（真 scope 失败会复发、可由后续显式信号
 *     suspend），比误 suspend 健康账号更安全。
 * 调用方仅在 403 时调用本函数（401 一律视为 reauth、不经此）。**只读标量 reason**、绝不外泄原始对象。
 */
export function isReauth403(err: unknown): boolean {
  const reason = readErrorReason(err);
  if (reason === undefined) {
    return false; // 不明 → 默认瞬时（安全侧：宁可下轮重试，不误 suspend 健康账号）。
  }
  if (TRANSIENT_403_REASONS.has(reason)) {
    return false;
  }
  return reason === 'insufficientPermissions' || reason === 'forbidden';
}

/**
 * 判定错误是否为 OAuth token 端点的 `invalid_grant`（refresh token 撤销/过期/失效）。
 * 这是**账号级致命**（应 reauth-suspend，绝非瞬时重试——token 不会自愈，每 tick 重试只会徒劳打 Google）。
 *
 * 关键：token 端点的错误体是 `{ error: 'invalid_grant', error_description }`（`error` 是**字符串**，
 * HTTP **400**），区别于 Gmail API 的 `error.errors[0].reason`（对象）——故 `isReauth403`/`readErrorReason`
 * 都识别不到它，必须单独判。google-auth-library 还把 `GaxiosError.message` 设为 `'invalid_grant'`（兜底）。
 * **只读标量字符串**、绝不返回/记录原始 error/response 对象（防 .config/.headers bearer 泄露）。
 */
export function isInvalidGrant(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  // 主判：response.data.error === 'invalid_grant'（token 端点标准错误体）。
  const response = (err as { response?: unknown }).response;
  if (response !== null && typeof response === 'object') {
    const data = (response as { data?: unknown }).data;
    if (data !== null && typeof data === 'object') {
      if ((data as { error?: unknown }).error === 'invalid_grant') {
        return true;
      }
    }
  }
  // 兜底：google-auth-library 把 GaxiosError.message 设为 'invalid_grant'。
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message === 'invalid_grant';
}

/**
 * 把「refresh / auth 失败」的 GaxiosError 转为 `ProviderReauthRequired`（不挂 cause、不泄露原始对象）。
 * 401/403（含 invalid_grant 等 token 撤销/过期）→ 抛 reauth；只记 code + 固定 kind。
 * **调用方**在识别到 401/403 时调用本函数；其它错误（429/5xx）不在此处理（见各调用点）。
 */
export function throwReauth(accountId: string, err: unknown): never {
  logger.warn(
    { kind: 'gmail-reauth-required', accountId, code: readErrorCode(err) },
    'Gmail token 失效（撤销/过期/scope 漂移）：标记需重授权（仅记 code+kind，禁记原始错误）',
  );
  throw new ProviderReauthRequired(accountId);
}
