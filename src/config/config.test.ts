// FIX 1 验收：configSchema 空串→默认值预处理，杜绝 OPENROUTER_BASE_URL='' 回退 api.openai.com。
// 直接对导出的 configSchema 做 parse/safeParse，不触碰 import 时加载的 frozen config。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configSchema,
  isGmailOnboardingAvailable,
  isValidGmailRedirectUri,
} from './config.js';

const DB = 'postgresql://u:p@localhost:5432/db';

test('configSchema：OPENROUTER_BASE_URL 空串 → 回落 OpenRouter 默认（不指向 api.openai.com）', () => {
  const result = configSchema.parse({ DATABASE_URL: DB, OPENROUTER_BASE_URL: '' });
  assert.equal(result.OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1');
  assert.notEqual(new URL(result.OPENROUTER_BASE_URL).host, 'api.openai.com');
});

test('configSchema：OPENROUTER_BASE_URL 省略 → 同一 OpenRouter 默认', () => {
  const result = configSchema.parse({ DATABASE_URL: DB });
  assert.equal(result.OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1');
  assert.notEqual(new URL(result.OPENROUTER_BASE_URL).host, 'api.openai.com');
});

test('configSchema：OPENROUTER_MODEL 空串 → 回落默认模型', () => {
  const result = configSchema.parse({ DATABASE_URL: DB, OPENROUTER_MODEL: '' });
  assert.equal(result.OPENROUTER_MODEL, 'google/gemini-2.5-flash-lite');
});

test('configSchema：缺 DATABASE_URL → safeParse 失败（P0 不变量）', () => {
  const result = configSchema.safeParse({});
  assert.equal(result.success, false);
});

test('configSchema：显式指向 api.openai.com → 拒绝（硬约束：仅经 OpenRouter）', () => {
  for (const u of ['http://api.openai.com', 'https://api.openai.com/v1', 'https://API.OpenAI.com']) {
    const result = configSchema.safeParse({ DATABASE_URL: DB, OPENROUTER_BASE_URL: u });
    assert.equal(result.success, false, `应拒绝 openai.com host: ${u}`);
  }
});

test('configSchema：OpenRouter 兼容代理 / 自建网关 URL → 接受（不强绑 openrouter.ai）', () => {
  const result = configSchema.parse({
    DATABASE_URL: DB,
    OPENROUTER_BASE_URL: 'https://my-proxy.example.com/v1',
  });
  assert.equal(result.OPENROUTER_BASE_URL, 'https://my-proxy.example.com/v1');
});

// ── P3 IMAP（§1.5）：config 层仅解析 optional，不做 IMAP 跨字段校验 ──
// 「host 有而凭据缺→报错」属 accountService 层（断言见 §3.3），不在此处。

test('configSchema：IMAP 项齐全 → 解析出连接参数（端口/TLS 正确）', () => {
  const result = configSchema.parse({
    DATABASE_URL: DB,
    IMAP_HOST: 'imap.example.com',
    IMAP_PORT: '143',
    IMAP_USER: 'me@example.com',
    IMAP_PASSWORD: 'secret',
    IMAP_TLS: 'false',
    IMAP_ACCOUNT_ID: 'imap:custom',
    POLL_INTERVAL_SECONDS: '60',
  });
  assert.equal(result.IMAP_HOST, 'imap.example.com');
  assert.equal(result.IMAP_PORT, 143);
  assert.equal(result.IMAP_USER, 'me@example.com');
  assert.equal(result.IMAP_PASSWORD, 'secret');
  assert.equal(result.IMAP_TLS, false);
  assert.equal(result.IMAP_ACCOUNT_ID, 'imap:custom');
  assert.equal(result.POLL_INTERVAL_SECONDS, 60);
});

test('configSchema：IMAP 各键空串 → undefined（host/user/password/account_id），端口/TLS/轮询回落默认', () => {
  const result = configSchema.parse({
    DATABASE_URL: DB,
    IMAP_HOST: '',
    IMAP_PORT: '',
    IMAP_USER: '',
    IMAP_PASSWORD: '',
    IMAP_TLS: '',
    IMAP_ACCOUNT_ID: '',
    POLL_INTERVAL_SECONDS: '',
  });
  assert.equal(result.IMAP_HOST, undefined);
  assert.equal(result.IMAP_USER, undefined);
  assert.equal(result.IMAP_PASSWORD, undefined);
  assert.equal(result.IMAP_ACCOUNT_ID, undefined);
  // 带默认的键：空串经 emptyToUndefined 归一后回落默认（非落成 0/''）。
  assert.equal(result.IMAP_PORT, 993);
  assert.equal(result.IMAP_TLS, true);
  assert.equal(result.POLL_INTERVAL_SECONDS, 180);
});

test('configSchema：IMAP 全省略 → IMAP 视为禁用（host undefined）且解析成功（可选 provider）', () => {
  const result = configSchema.safeParse({ DATABASE_URL: DB });
  assert.equal(result.success, true);
  assert.equal(result.data?.IMAP_HOST, undefined);
  // 带默认键即便省略仍恒有值。
  assert.equal(result.data?.IMAP_PORT, 993);
  assert.equal(result.data?.IMAP_TLS, true);
  assert.equal(result.data?.POLL_INTERVAL_SECONDS, 180);
});

test('configSchema：缺 IMAP_HOST 但有凭据 → 仍解析成功（跨字段校验属 accountService 层，不在 config）', () => {
  const result = configSchema.safeParse({
    DATABASE_URL: DB,
    IMAP_USER: 'me@example.com',
    IMAP_PASSWORD: 'secret',
  });
  assert.equal(result.success, true);
  assert.equal(result.data?.IMAP_HOST, undefined);
});

test('configSchema：IMAP_TLS 省略或非 false 值 → 默认 true（仅显式 false 关 TLS）', () => {
  assert.equal(configSchema.parse({ DATABASE_URL: DB }).IMAP_TLS, true);
  assert.equal(configSchema.parse({ DATABASE_URL: DB, IMAP_TLS: 'TRUE' }).IMAP_TLS, true);
  assert.equal(configSchema.parse({ DATABASE_URL: DB, IMAP_TLS: 'whatever' }).IMAP_TLS, true);
  assert.equal(configSchema.parse({ DATABASE_URL: DB, IMAP_TLS: 'False' }).IMAP_TLS, false);
});

// ── P4 Gmail app 凭据（§1.5）：可选解析 + redirect_uri 校验 + onboarding 可用性 ──

test('configSchema：GMAIL_* 项齐全 → 解析出 app 凭据', () => {
  const result = configSchema.parse({
    DATABASE_URL: DB,
    GMAIL_CLIENT_ID: 'cid',
    GMAIL_CLIENT_SECRET: 'csecret',
    GMAIL_REDIRECT_URI: 'http://127.0.0.1/oauth2/callback',
  });
  assert.equal(result.GMAIL_CLIENT_ID, 'cid');
  assert.equal(result.GMAIL_CLIENT_SECRET, 'csecret');
  assert.equal(result.GMAIL_REDIRECT_URI, 'http://127.0.0.1/oauth2/callback');
});

test('configSchema：GMAIL_* 各键空串 → undefined（空串归一）', () => {
  const result = configSchema.parse({
    DATABASE_URL: DB,
    GMAIL_CLIENT_ID: '',
    GMAIL_CLIENT_SECRET: '',
    GMAIL_REDIRECT_URI: '',
  });
  assert.equal(result.GMAIL_CLIENT_ID, undefined);
  assert.equal(result.GMAIL_CLIENT_SECRET, undefined);
  assert.equal(result.GMAIL_REDIRECT_URI, undefined);
});

test('configSchema：缺 GMAIL_* → 解析成功（服务仍可启动，Gmail onboarding 后续判定不可用）', () => {
  const result = configSchema.safeParse({ DATABASE_URL: DB });
  assert.equal(result.success, true);
  assert.equal(result.data?.GMAIL_CLIENT_ID, undefined);
  // 缺 GMAIL_* → onboarding 不可用，但 config 解析不失败（仅禁用 Gmail 功能）。
  assert.equal(isGmailOnboardingAvailable(result.data!), false);
});

test('isValidGmailRedirectUri：host==127.0.0.1 且 path==/oauth2/callback → 合法（忽略端口）', () => {
  assert.equal(isValidGmailRedirectUri('http://127.0.0.1/oauth2/callback'), true);
  // env 里写了端口也被忽略（端口运行时绑定），仍合法。
  assert.equal(isValidGmailRedirectUri('http://127.0.0.1:54321/oauth2/callback'), true);
});

test('isValidGmailRedirectUri：非 loopback / localhost / [::1] / 错误 path → 非法', () => {
  // localhost：解析歧义（可能落 ::1），禁。
  assert.equal(isValidGmailRedirectUri('http://localhost/oauth2/callback'), false);
  assert.equal(isValidGmailRedirectUri('http://localhost:3000/oauth2/callback'), false);
  // [::1]（IPv6）：到不了 IPv4 监听，禁。
  assert.equal(isValidGmailRedirectUri('http://[::1]/oauth2/callback'), false);
  // 非 loopback host。
  assert.equal(isValidGmailRedirectUri('http://example.com/oauth2/callback'), false);
  // 错误 path（旧值）。
  assert.equal(isValidGmailRedirectUri('http://127.0.0.1/oauth/gmail/callback'), false);
  assert.equal(isValidGmailRedirectUri('http://127.0.0.1/oauth2/callback/extra'), false);
  // 非 URL。
  assert.equal(isValidGmailRedirectUri('not-a-url'), false);
});

test('isGmailOnboardingAvailable：三者齐全且 redirect_uri 合法 → 可用', () => {
  const c = configSchema.parse({
    DATABASE_URL: DB,
    GMAIL_CLIENT_ID: 'cid',
    GMAIL_CLIENT_SECRET: 'csecret',
    GMAIL_REDIRECT_URI: 'http://127.0.0.1:8080/oauth2/callback',
  });
  assert.equal(isGmailOnboardingAvailable(c), true);
});

test('isGmailOnboardingAvailable：redirect_uri 非 loopback/错误 path → onboarding 不可用（其余服务仍启动）', () => {
  for (const uri of [
    'http://localhost:3000/oauth/gmail/callback', // 旧值：localhost + 旧 path
    'http://localhost/oauth2/callback',
    'http://[::1]/oauth2/callback',
    'http://127.0.0.1/wrong/path',
  ]) {
    const c = configSchema.parse({
      DATABASE_URL: DB,
      GMAIL_CLIENT_ID: 'cid',
      GMAIL_CLIENT_SECRET: 'csecret',
      GMAIL_REDIRECT_URI: uri,
    });
    // config 解析成功（服务能启动），仅 onboarding 不可用。
    assert.equal(isGmailOnboardingAvailable(c), false, `应 onboarding 不可用: ${uri}`);
  }
});

test('isGmailOnboardingAvailable：client_id/secret 缺一 → onboarding 不可用', () => {
  const base = {
    DATABASE_URL: DB,
    GMAIL_REDIRECT_URI: 'http://127.0.0.1/oauth2/callback',
  };
  assert.equal(
    isGmailOnboardingAvailable(configSchema.parse({ ...base, GMAIL_CLIENT_SECRET: 'csecret' })),
    false,
  );
  assert.equal(
    isGmailOnboardingAvailable(configSchema.parse({ ...base, GMAIL_CLIENT_ID: 'cid' })),
    false,
  );
});
