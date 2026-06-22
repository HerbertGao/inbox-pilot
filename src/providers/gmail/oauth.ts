// Gmail OAuth（Desktop-app loopback + 防护）——spec gmail-integration「需求:Gmail OAuth 授权与
// token 持久化」、design 决策 4、tasks 4.1。
//
// 流程（loopback 一次性回调）：
//   1. **先**绑 127.0.0.1 的临时空闲端口（端口 0），拿到 bound-port。
//   2. 用该 bound-port 构造**唯一精确** `redirect_uri = http://127.0.0.1:<bound-port>/oauth2/callback`，
//      授权 URL 与 getToken 两处用**同一精确串**（Google installed-app loopback 硬要求，否则
//      redirect_uri_mismatch）。
//   3. PKCE（S256，generateCodeVerifierAsync）+ access_type=offline + prompt=consent + state（randomBytes）。
//   4. 监听一次性回调：路径精确匹配 /oauth2/callback；state 先长度检查再常量时间比较（缺失/不等长
//      按非匹配、不抛、不消费 one-shot）；error= 干净中止；匹配的 code/state 只消费一次。
//   5. getToken({ codeVerifier })；缺 refresh token → 显式失败（不建残缺账号）。
//   6. account email **仅**取 users.getProfile().emailAddress 并**仅小写**（不剥点/+tag）。
//
// 安全纪律（spec / logger.ts 安全约定）：
//   - 回调处理日志**只记 `{ kind, stateResult, path }`**——绝不记 code/state/完整回调 URL。
//   - scope **恰等** `{https://www.googleapis.com/auth/gmail.modify}`——**全代码无 messages.send 路径**。
//   - 缺 refresh token / 绑定失败 / 超时 → 抛固定 kind 串（GmailOAuthError），零凭据插值。
//   - 本地 DoS 加固：限请求行/头大小 + 连接数 + 同意超时。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

import { logger } from '../../logger.js';

/** OAuth scope：**恰等**单元素集（全 URL 形式贯穿全文，禁 send/compose/openid/email/全权限）。 */
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify' as const;

/** loopback 回调路径（精确匹配；噪声如 /favicon.ico 不消费 one-shot）。 */
const CALLBACK_PATH = '/oauth2/callback';

/** 默认同意超时（ms）：超时丢弃 verifier+state、关监听（与单次消费互斥）。 */
const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60_000;

/** 本地 DoS 加固上限（请求行/头大小、最大并发连接数）。 */
const MAX_HEADER_SIZE = 8 * 1024;
const MAX_CONNECTIONS = 8;

/**
 * OAuth 失败固定 kind 串（零凭据/URL 插值；测试断言重抛 message 等于这些串）。
 * 改动需同步更新 4.5 断言（脱敏契约的一部分）。
 */
export const GMAIL_OAUTH_BIND_FAILED = 'gmail-oauth-bind-failed';
export const GMAIL_OAUTH_CONSENT_TIMEOUT = 'gmail-oauth-consent-timeout';
export const GMAIL_OAUTH_ACCESS_DENIED = 'gmail-oauth-access-denied';
export const GMAIL_OAUTH_NO_REFRESH_TOKEN = 'gmail-oauth-no-refresh-token';
export const GMAIL_OAUTH_TOKEN_EXCHANGE_FAILED = 'gmail-oauth-token-exchange-failed';
export const GMAIL_OAUTH_PROFILE_FAILED = 'gmail-oauth-profile-failed';

/** OAuth 失败结构化错误：message **只能**是固定 kind 串（零凭据/URL 插值）。 */
export class GmailOAuthError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.name = 'GmailOAuthError';
    this.kind = kind;
  }
}

/** OAuth app 凭据（env app 凭据；GMAIL_REDIRECT_URI 仅约定 host/path，端口运行时绑定）。 */
export type GmailOAuthAppCredentials = {
  clientId: string;
  clientSecret: string;
};

/** authorizeGmailAccount 的可注入依赖（4.5 离线测试用；prod 用真身默认）。 */
export type GmailOAuthDeps = {
  /**
   * 把授权 URL 交给用户（默认打印到日志/stdout 提示）。返回后等待 loopback 回调。
   * 测试可注入「模拟用户点开 URL → 向 loopback 发回调」的驱动。
   */
  openAuthUrl?: (url: string) => void | Promise<void>;
  /** 同意超时（ms）。默认 5 分钟。 */
  consentTimeoutMs?: number;
  /** 注入 OAuth2Client 工厂（测试用假 client 断言 PKCE verifier 全程一致 / 无 send）。 */
  makeOAuthClient?: (args: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }) => OAuth2ClientLike;
  /** 注入 getProfile（测试断言 email 仅小写、且不剥点/+tag）。默认走 googleapis gmail。 */
  getProfileEmail?: (client: OAuth2ClientLike) => Promise<string>;
};

/** OAuth 授权产物（写入路径据此建/更新账号；refreshToken 绝不入日志）。 */
export type GmailAuthResult = {
  /** 派生 accountId 用的邮箱（仅小写）。 */
  email: string;
  /** refresh token（存 authJson；缺失则上游已显式失败、不产出本结果）。 */
  refreshToken: string;
  /** 授权 scope（恰等 `{gmail.modify}`）。 */
  scopes: string[];
};

/**
 * OAuth2Client 的最小结构子集（本模块用到的方法）。用结构接口而非具体类，使测试可注入假 client、
 * 断言「发起侧 PKCE verifier == token 交换用 verifier」「无 messages.send 路径」。
 */
export type OAuth2ClientLike = {
  generateAuthUrl(opts: {
    access_type: string;
    prompt: string;
    scope: string[];
    state: string;
    code_challenge: string;
    code_challenge_method: string;
    redirect_uri: string;
  }): string;
  getToken(opts: {
    code: string;
    codeVerifier: string;
    redirect_uri: string;
  }): Promise<{ tokens: { refresh_token?: string | null; scope?: string | null } }>;
  setCredentials(tokens: { refresh_token?: string | null }): void;
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge: string }>;
};

/** 真身 OAuth2Client 工厂（google-auth-library）。 */
function defaultMakeOAuthClient(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): OAuth2ClientLike {
  return new OAuth2Client({
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    redirectUri: args.redirectUri,
  }) as unknown as OAuth2ClientLike;
}

/**
 * 真身 getProfile：用授权后的 client 调 gmail.users.getProfile，取 emailAddress。
 * **禁** id_token（其需 openid/email scope，违反 scope 恰等约束）。
 */
async function defaultGetProfileEmail(client: OAuth2ClientLike): Promise<string> {
  const opts = { version: 'v1', auth: client } as unknown as Parameters<typeof google.gmail>[0];
  const gmail = google.gmail(opts);
  const res = await gmail.users.getProfile({ userId: 'me' });
  const email = res.data.emailAddress;
  if (typeof email !== 'string' || email.length === 0) {
    throw new GmailOAuthError(GMAIL_OAUTH_PROFILE_FAILED);
  }
  return email;
}

/**
 * 常量时间 state 比较：**先长度检查再 timingSafeEqual**（长度非密；timingSafeEqual 对不等长会抛，
 * 故缺失/不等长按「非匹配」返回 false、不抛崩监听）。
 */
function stateMatches(expected: string, received: string | undefined): boolean {
  if (typeof received !== 'string') {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/** 回调解析结果（one-shot 消费判定用）。 */
type CallbackOutcome =
  | { kind: 'matched'; code: string }
  | { kind: 'access-denied' }
  | { kind: 'non-match' };

/**
 * 解析 loopback 回调请求（不消费副作用）：路径精确匹配 + state 校验 + error=。
 * 噪声路径（如 /favicon.ico）/ state 不匹配 → 'non-match'（**不**消费 one-shot）。
 */
function parseCallback(req: IncomingMessage, expectedState: string): {
  path: string;
  outcome: CallbackOutcome;
} {
  // 仅用绝对 base 解析 query；base 仅供 URL 构造、不入日志。
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (path !== CALLBACK_PATH) {
    return { path, outcome: { kind: 'non-match' } };
  }
  // **先**校验 state（含 error= 分支）：state 缺失/不匹配 → 'non-match'（不消费 one-shot、不
  // 中止流程）。否则任意本地「错误 state + ?error=」请求都能杀死在途同意（与成功路径的「state
  // 不匹配不消费」规则一致）。Google 真实的 error 重定向带匹配的 state。
  const state = url.searchParams.get('state') ?? undefined;
  if (!stateMatches(expectedState, state)) {
    // state 不匹配：**不**消费 one-shot 名额（防错误 state 洪泛饿死合法回调）。
    return { path, outcome: { kind: 'non-match' } };
  }
  const error = url.searchParams.get('error');
  if (error !== null) {
    // state 已匹配且 error=（如 access_denied）：干净中止、消费 one-shot 以结束流程。
    return { path, outcome: { kind: 'access-denied' } };
  }
  const code = url.searchParams.get('code');
  if (typeof code !== 'string' || code.length === 0) {
    return { path, outcome: { kind: 'non-match' } };
  }
  return { path, outcome: { kind: 'matched', code } };
}

/** 回写极简响应（不回显任何 query；body 固定文案）。 */
function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * 起 loopback 监听并等待一次性回调，返回授权 code。
 * - 监听**先绑** 127.0.0.1 端口 0（临时空闲端口），返回 bound-port 给 onBound 构造 redirect_uri。
 * - one-shot：仅匹配成功 / access-denied 消费名额；非匹配请求回 404/204、不消费。
 * - finally 关监听 + 同意超时（与消费互斥）。
 */
function awaitLoopbackCode(args: {
  expectedState: string;
  consentTimeoutMs: number;
  onBound: (boundPort: number) => void | Promise<void>;
}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let server: Server | undefined;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void): void => {
      if (settled) {
        return; // 与单次消费/超时互斥：已结算则忽略后续（含超时）。
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      // finally 关监听（用完即关，不留悬挂端口）。
      if (server !== undefined) {
        server.close();
      }
      fn();
    };

    server = createServer({ maxHeaderSize: MAX_HEADER_SIZE }, (req, res) => {
      // 已结算（one-shot 已消费 / 超时）后到来的迟到重复回调：回固定 410、不再 parse/不再当成功响应
      // （防迟到的重复匹配回调被二次处理）。
      if (settled) {
        respond(res, 410, '');
        return;
      }
      // 回调处理日志**只记 { kind, stateResult, path }**——绝不记 code/state/完整 URL。
      const { path, outcome } = parseCallback(req, args.expectedState);
      if (outcome.kind === 'non-match') {
        // 非匹配（噪声路径 / state 不匹配 / 缺 code）：回应但**不**消费 one-shot。
        logger.info(
          { kind: 'gmail-oauth-callback', stateResult: 'non-match', path },
          'loopback 回调非匹配（不消费 one-shot）',
        );
        respond(res, 204, '');
        return;
      }
      if (outcome.kind === 'access-denied') {
        logger.info(
          { kind: 'gmail-oauth-callback', stateResult: 'access-denied', path },
          'loopback 回调用户拒绝授权（干净中止）',
        );
        respond(res, 200, '授权被拒绝，可关闭本页。');
        finish(() => reject(new GmailOAuthError(GMAIL_OAUTH_ACCESS_DENIED)));
        return;
      }
      // matched：state/code 只消费一次（后续并发/重复回调会被 settled 短路）。
      logger.info(
        { kind: 'gmail-oauth-callback', stateResult: 'matched', path },
        'loopback 回调匹配成功（消费 one-shot、开始换 token）',
      );
      respond(res, 200, '授权成功，可关闭本页返回终端。');
      finish(() => resolve(outcome.code));
    });

    server.maxConnections = MAX_CONNECTIONS;
    server.on('error', () => {
      finish(() => reject(new GmailOAuthError(GMAIL_OAUTH_BIND_FAILED)));
    });

    // 同意超时：超时丢弃 verifier+state、关监听（与单次消费互斥，settled 守卫）。
    timer = setTimeout(() => {
      finish(() => reject(new GmailOAuthError(GMAIL_OAUTH_CONSENT_TIMEOUT)));
    }, args.consentTimeoutMs);

    // **先**绑临时空闲端口（端口 0）、仅绑 127.0.0.1，再据 bound-port 构造 redirect_uri。
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (addr === null || typeof addr === 'string') {
        finish(() => reject(new GmailOAuthError(GMAIL_OAUTH_BIND_FAILED)));
        return;
      }
      Promise.resolve(args.onBound(addr.port)).catch(() => {
        finish(() => reject(new GmailOAuthError(GMAIL_OAUTH_BIND_FAILED)));
      });
    });
  });
}

/**
 * 跑一次 Gmail OAuth（Desktop-app loopback），返回 { email, refreshToken, scopes }。
 *
 * 不可违反（spec / tasks 4.1）：
 *   - **先**绑端口再构造唯一 redirect_uri，授权 URL 与 getToken 两处用**同一精确串**（含端口）。
 *   - PKCE verifier **全程一致**：发起 challenge 的 verifier == getToken 用 verifier。
 *   - scope 恰等 `{gmail.modify}`；**全代码无 messages.send**。
 *   - 缺 refresh token → 显式失败（GMAIL_OAUTH_NO_REFRESH_TOKEN），不建残缺账号。
 *   - email 仅取 getProfile().emailAddress 并**仅小写**（不剥点/+tag）。
 *   - 回调日志只 { kind, stateResult, path }；任何失败 message 是固定 kind 串、零凭据/URL 插值。
 */
export async function authorizeGmailAccount(
  app: GmailOAuthAppCredentials,
  deps: GmailOAuthDeps = {},
): Promise<GmailAuthResult> {
  const makeClient = deps.makeOAuthClient ?? defaultMakeOAuthClient;
  const getProfileEmail = deps.getProfileEmail ?? defaultGetProfileEmail;
  const consentTimeoutMs = deps.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
  const openAuthUrl =
    deps.openAuthUrl ??
    ((url: string): void => {
      // 默认仅提示用户在浏览器打开（不记 query；URL 本身需用户可见）。
      logger.info({ kind: 'gmail-oauth-open-url' }, '请在浏览器打开下面的授权链接完成 Gmail 授权');
      // eslint-disable-next-line no-console
      console.log(url);
    });

  // state：crypto.randomBytes（base64url）。
  const state = randomBytes(32).toString('base64url');

  // 端口绑定后用 bound-port 构造唯一 client + redirect_uri，该 client 同时用于 generateAuthUrl 与
  // getToken（两处 redirect_uri 精确一致）；redirectUri 经闭包捕获、getToken 用同一精确串。
  let pkceVerifier = '';
  let authClient: OAuth2ClientLike | undefined;
  let boundRedirectUri: string | undefined;

  const code = await awaitLoopbackCode({
    expectedState: state,
    consentTimeoutMs,
    onBound: async (boundPort) => {
      // 唯一精确 redirect_uri（含 bound-port）——授权 URL 与 getToken 两处同一串。
      const redirectUri = `http://127.0.0.1:${boundPort}${CALLBACK_PATH}`;
      boundRedirectUri = redirectUri;
      authClient = makeClient({
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri,
      });
      const verifier = await authClient.generateCodeVerifierAsync();
      pkceVerifier = verifier.codeVerifier;
      const authUrl = authClient.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [GMAIL_MODIFY_SCOPE],
        state,
        code_challenge: verifier.codeChallenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri,
      });
      await openAuthUrl(authUrl);
    },
  });

  if (authClient === undefined || boundRedirectUri === undefined) {
    // 不可达（onBound 必先于 resolve(code) 设置）；防御性固定 kind。
    throw new GmailOAuthError(GMAIL_OAUTH_BIND_FAILED);
  }

  // getToken：**回传 PKCE verifier**（与发起侧同一 verifier）+ **同一精确 redirect_uri**（含端口）。
  let tokens: { refresh_token?: string | null; scope?: string | null };
  try {
    tokens = (
      await authClient.getToken({
        code,
        codeVerifier: pkceVerifier,
        redirect_uri: boundRedirectUri,
      })
    ).tokens;
  } catch {
    throw new GmailOAuthError(GMAIL_OAUTH_TOKEN_EXCHANGE_FAILED);
  }

  const refreshToken = tokens.refresh_token;
  // 缺 refresh token → 显式失败（不建残缺账号；prompt=consent 已尽量保证返回）。
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new GmailOAuthError(GMAIL_OAUTH_NO_REFRESH_TOKEN);
  }

  // 授权后用同一 client 取 profile（凭据已在 client 内）。email **仅小写**（不剥点/+tag）。
  authClient.setCredentials({ refresh_token: refreshToken });
  let rawEmail: string;
  try {
    rawEmail = await getProfileEmail(authClient);
  } catch (err) {
    if (err instanceof GmailOAuthError) {
      throw err;
    }
    throw new GmailOAuthError(GMAIL_OAUTH_PROFILE_FAILED);
  }
  const email = rawEmail.toLowerCase();

  return {
    email,
    refreshToken,
    // 返回的是**请求侧** scope（onboarding 的 scope 关口）；运行期实际能力以 token 携带的 scope 为准
    // （spec：scope 政策变更需重授权）。
    scopes: [GMAIL_MODIFY_SCOPE],
  };
}
