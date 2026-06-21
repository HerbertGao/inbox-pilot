// FIX 1 验收：configSchema 空串→默认值预处理，杜绝 OPENROUTER_BASE_URL='' 回退 api.openai.com。
// 直接对导出的 configSchema 做 parse/safeParse，不触碰 import 时加载的 frozen config。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { configSchema } from './config.js';

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
