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

// ── POLL_INTERVAL_SECONDS：空串/省略 → 默认 180，显式值 → coerce ──
// （IMAP_* env 键已退役——账号凭据走 DB authJson，不再经 config 解析。）

test('configSchema：POLL_INTERVAL_SECONDS 空串/省略 → 180，显式值 → coerce 为数字', () => {
  assert.equal(configSchema.parse({ DATABASE_URL: DB }).POLL_INTERVAL_SECONDS, 180);
  assert.equal(configSchema.parse({ DATABASE_URL: DB, POLL_INTERVAL_SECONDS: '' }).POLL_INTERVAL_SECONDS, 180);
  assert.equal(configSchema.parse({ DATABASE_URL: DB, POLL_INTERVAL_SECONDS: '60' }).POLL_INTERVAL_SECONDS, 60);
});

// ── DIGEST_TIMES：裸 z.string().optional()，区分缺省(undefined) vs 显式空('') vs 显式值 ──
// 关键：env 缺省 → undefined（digestScheduler 层兜底默认）；显式 '' → 原样 ''（**不**被归一为
// undefined、**不**落成默认）——保住"显式空 → 不调度"语义；显式值 → 透传。
// （若 DIGEST_TIMES 被错误地包 emptyToUndefined，'' 会变 undefined，本测试即失败。）

test('configSchema：DIGEST_TIMES env 缺省 → undefined', () => {
  assert.equal(configSchema.parse({ DATABASE_URL: DB }).DIGEST_TIMES, undefined);
});

test('configSchema：DIGEST_TIMES 显式空串 → 原样空串（不归一为 undefined、不落默认）', () => {
  const result = configSchema.parse({ DATABASE_URL: DB, DIGEST_TIMES: '' });
  assert.equal(result.DIGEST_TIMES, '');
  assert.notEqual(result.DIGEST_TIMES, undefined);
});

test('configSchema：DIGEST_TIMES 显式值 → 透传', () => {
  assert.equal(
    configSchema.parse({ DATABASE_URL: DB, DIGEST_TIMES: '12:30,21:30' }).DIGEST_TIMES,
    '12:30,21:30',
  );
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
