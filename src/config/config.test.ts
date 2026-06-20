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
