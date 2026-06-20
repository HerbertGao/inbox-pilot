// 离线验收测试（组 E §5.1）：node:test + 注入假 chat（chatSpy），无需联网。
//
// 设计纪律（与任务要求逐条对应）：
//   - 断言一律针对 classifyEmail 的返回值与 chatSpy 的调用次数/参数，
//     禁止只断言喂进去的假响应。
//   - 「恰好一次重试」靠断言 chatSpy.calls.length === 2 才能证伪——必须断言调用次数。
//   - 缺 key 用 deps.apiKey:undefined 注入（组 D 的注入点），不改 frozen config。
//   - 第 2 次用 fallback 的用例断言 model === config.OPENROUTER_FALLBACK_MODEL。
//   - 模型断言用 config.OPENROUTER_MODEL / config.OPENROUTER_FALLBACK_MODEL（实际加载值），
//     不写死字面量——使断言对 .env 覆盖默认值的环境仍稳健。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { config } from '../config/config.js';
import {
  classifyEmail,
  buildClassifierInput,
  type ChatFn,
} from './classifyEmail.js';
import type { Classification } from './schema.js';
import {
  normalizeEmail,
  type NormalizedEmail,
  type RawEmail,
} from '../normalizer/normalizeEmail.js';

// —— 假 chat（chatSpy）——
// 记录每次调用的 args（model / responseFormat / messages），按脚本序列逐次返回字符串或 throw。
// 脚本项：{ return: '...' } 返回原始字符串；{ throw: <obj> } 抛出（obj 可带 .status 模拟 HTTP 状态）。
type ChatCall = Parameters<ChatFn>[0];
type ScriptStep = { return: string } | { throw: unknown };

function makeChatSpy(script: ScriptStep[]): ChatFn & { calls: ChatCall[] } {
  const calls: ChatCall[] = [];
  const fn = (async (args: ChatCall): Promise<string> => {
    const index = calls.length;
    calls.push(args);
    const step = script[index];
    if (step === undefined) {
      // 脚本耗尽却仍被调用 → 测试期望被违反（调用次数超过脚本），显式炸出便于定位。
      throw new Error(`chatSpy 调用次数超出脚本长度（第 ${index + 1} 次调用，脚本仅 ${script.length} 项）`);
    }
    if ('throw' in step) {
      throw step.throw;
    }
    return step.return;
  }) as ChatFn & { calls: ChatCall[] };
  fn.calls = calls;
  return fn;
}

// 带 .status 的假 HTTP 错误（模拟 SDK 抛出的 401/403/429/404/500 等）。
function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// 一封合法的 NormalizedEmail（直接构造，绕过 normalizeEmail 的细节，聚焦分类器逻辑）。
function sampleEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'acct-1',
    provider: 'gmail',
    providerMessageId: 'msg-1',
    subject: '测试主题',
    fromEmail: 'sender@example.com',
    to: ['me@example.com'],
    date: '2026-06-20T00:00:00.000Z',
    hasAttachments: false,
    headers: {},
    ...overrides,
  };
}

// 一个满足 ClassificationSchema 的合法分类 JSON 字符串。
function validClassificationJson(
  overrides: Partial<Classification> = {},
): string {
  const base: Classification = {
    priority: 'P2',
    category: 'work',
    should_notify_now: false,
    should_mark_read: false,
    should_include_digest: true,
    confidence: 0.8,
    reason: '工作相关邮件',
    risk_flags: [],
  };
  return JSON.stringify({ ...base, ...overrides });
}

// 安全默认元组的全 8 字段断言（多处复用）。
function assertSafeDefault(result: Classification): void {
  assert.equal(result.priority, 'P1');
  assert.equal(result.category, 'unknown');
  assert.equal(result.should_notify_now, false);
  assert.equal(result.should_mark_read, false);
  assert.equal(result.should_include_digest, true);
  assert.equal(result.confidence, 0);
  assert.equal(result.reason, 'AI 分类失败，降级 P1');
  assert.deepEqual(result.risk_flags, []);
}

// ——————————————————————————————————————————————————————————
// classifyEmail：状态机与安全默认
// ——————————————————————————————————————————————————————————

// 验收① 合法 JSON → 返回校验过的 Classification。
test('合法 JSON → 返回校验过的 Classification（调用 1 次）', async () => {
  const chat = makeChatSpy([
    { return: validClassificationJson({ priority: 'P0', category: 'security', confidence: 0.95 }) },
  ]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  // 断言针对返回值（不是喂进去的假响应）：每个字段都被 zod 校验过并采用。
  assert.equal(result.priority, 'P0');
  assert.equal(result.category, 'security');
  assert.equal(result.confidence, 0.95);
  assert.equal(result.should_include_digest, true);
  assert.deepEqual(result.risk_flags, []);
  // 第 1 次必须以 json_schema + 主模型请求。
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.calls[0]?.responseFormat, 'json_schema');
  assert.equal(chat.calls[0]?.model, config.OPENROUTER_MODEL);
});

// 验收② 首次内容失败（非法 JSON）、二次合法 → 成功，且 chatSpy 恰好被调用 2 次。
test('首次内容失败、二次合法 → 成功且恰好调用 2 次（同主模型 + json_object）', async () => {
  const chat = makeChatSpy([
    { return: '这不是合法 JSON {{{' },
    { return: validClassificationJson({ priority: 'P3', category: 'marketing' }) },
  ]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assert.equal(result.priority, 'P3');
  assert.equal(result.category, 'marketing');
  // 必须断言调用次数，否则「恰好一次重试」无法证伪。
  assert.equal(chat.calls.length, 2);
  // 第 1 次：主模型 + json_schema；第 2 次：同主模型降级 json_object。
  assert.equal(chat.calls[0]?.responseFormat, 'json_schema');
  assert.equal(chat.calls[0]?.model, config.OPENROUTER_MODEL);
  assert.equal(chat.calls[1]?.responseFormat, 'json_object');
  assert.equal(chat.calls[1]?.model, config.OPENROUTER_MODEL);
});

// 验收② 变体：首次 200 但未过 zod（priority 越界）、二次合法 → 成功且恰好 2 次。
test('首次过 JSON 但未过 zod、二次合法 → 成功且恰好调用 2 次', async () => {
  const chat = makeChatSpy([
    { return: JSON.stringify({ priority: 'P9', category: 'work', should_notify_now: false, should_mark_read: false, should_include_digest: true, confidence: 0.5, reason: 'x', risk_flags: [] }) },
    { return: validClassificationJson({ priority: 'P1' }) },
  ]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assert.equal(result.priority, 'P1');
  assert.equal(chat.calls.length, 2);
  assert.equal(chat.calls[1]?.responseFormat, 'json_object');
  assert.equal(chat.calls[1]?.model, config.OPENROUTER_MODEL);
});

// 验收③ 恒非法（两次都非法 JSON）→ 完整 8 字段安全默认、不抛、调用 ≤ 2 次。
test('恒非法 → 完整 8 字段安全默认、不抛异常、调用 ≤ 2 次', async () => {
  const chat = makeChatSpy([
    { return: 'garbage-1 {{' },
    { return: 'garbage-2 }}' },
  ]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assertSafeDefault(result);
  assert.ok(chat.calls.length <= 2, `chatSpy 调用应 ≤ 2，实际 ${chat.calls.length}`);
  assert.equal(chat.calls.length, 2); // 内容失败路径恰好两次
});

// 验收③ 变体：恒 throw（两次都 5xx 传输失败）→ 完整 8 字段安全默认、不抛、调用 ≤ 2 次。
test('恒 throw（5xx）→ 完整 8 字段安全默认、不抛异常、调用 ≤ 2 次', async () => {
  const chat = makeChatSpy([
    { throw: httpError(500) },
    { throw: httpError(503) },
  ]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assertSafeDefault(result);
  assert.ok(chat.calls.length <= 2, `chatSpy 调用应 ≤ 2，实际 ${chat.calls.length}`);
  assert.equal(chat.calls.length, 2); // transport 失败触发 1 次重试
});

// 第 1 次 throw（传输失败，无 status）、fallback 合法 → 成功且第 2 次用 OPENROUTER_FALLBACK_MODEL。
test('传输失败（无 status）→ 第 2 次用 fallback 模型 + json_object，成功', async () => {
  const transportErr = new Error('socket hang up'); // 无 .status → transport
  const chat = makeChatSpy([
    { throw: transportErr },
    { return: validClassificationJson({ priority: 'P2', category: 'newsletter' }) },
  ]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assert.equal(result.priority, 'P2');
  assert.equal(result.category, 'newsletter');
  assert.equal(chat.calls.length, 2);
  // 第 1 次主模型 json_schema；第 2 次必须 fallback 模型 + json_object。
  assert.equal(chat.calls[0]?.model, config.OPENROUTER_MODEL);
  assert.equal(chat.calls[1]?.model, config.OPENROUTER_FALLBACK_MODEL);
  assert.equal(chat.calls[1]?.responseFormat, 'json_object');
  // 主模型与 fallback 必须确实不同，否则该断言无意义。
  assert.notEqual(config.OPENROUTER_MODEL, config.OPENROUTER_FALLBACK_MODEL);
});

// 第 1 次 401 → 不发起第 2 次调用（调用 1 次）→ 安全默认。
test('鉴权失败 401 → 不重试（调用 1 次）→ 安全默认', async () => {
  const chat = makeChatSpy([{ throw: httpError(401) }]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assertSafeDefault(result);
  assert.equal(chat.calls.length, 1);
});

// 第 1 次 403 → 同样不重试 → 安全默认（auth 类的另一个状态码）。
test('鉴权失败 403 → 不重试（调用 1 次）→ 安全默认', async () => {
  const chat = makeChatSpy([{ throw: httpError(403) }]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assertSafeDefault(result);
  assert.equal(chat.calls.length, 1);
});

// 第 1 次 429（限流，catch-all）→ 不发起第 2 次调用 → 安全默认。
test('429 限流 → 不重试（调用 1 次）→ 安全默认', async () => {
  const chat = makeChatSpy([{ throw: httpError(429) }]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assertSafeDefault(result);
  assert.equal(chat.calls.length, 1);
});

// 第 1 次 404（模型不存在，catch-all）→ 不发起第 2 次调用 → 安全默认。
test('404 模型不存在 → 不重试（调用 1 次）→ 安全默认', async () => {
  const chat = makeChatSpy([{ throw: httpError(404) }]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: 'sk-test' });

  assertSafeDefault(result);
  assert.equal(chat.calls.length, 1);
});

// 缺 OPENROUTER_API_KEY（apiKey:undefined 注入）→ 不调用 chat、不抛 → 安全默认。
test('缺 API key → 不调用 chat、不抛异常 → 安全默认', async () => {
  const chat = makeChatSpy([{ return: validClassificationJson() }]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: undefined });

  assertSafeDefault(result);
  assert.equal(chat.calls.length, 0); // 绝不发起任何网络调用
});

// 空字符串 key 同样视为缺 key（短路）。
test('空字符串 API key → 不调用 chat → 安全默认', async () => {
  const chat = makeChatSpy([{ return: validClassificationJson() }]);

  const result = await classifyEmail(sampleEmail(), { chat, apiKey: '' });

  assertSafeDefault(result);
  assert.equal(chat.calls.length, 0);
});

// ——————————————————————————————————————————————————————————
// normalizeEmail：结构化不变量 + 必填字段默认与归一
// ——————————————————————————————————————————————————————————

test('normalizeEmail：缺 accountId → throw', () => {
  const raw: RawEmail = { provider: 'gmail', providerMessageId: 'm1' };
  assert.throws(() => normalizeEmail(raw), /accountId/);
});

test('normalizeEmail：缺 provider → throw', () => {
  const raw: RawEmail = { accountId: 'a1', providerMessageId: 'm1' };
  assert.throws(() => normalizeEmail(raw), /provider/);
});

test('normalizeEmail：provider 非法值 → throw', () => {
  const raw: RawEmail = { accountId: 'a1', provider: 'outlook', providerMessageId: 'm1' };
  assert.throws(() => normalizeEmail(raw), /provider/);
});

test('normalizeEmail：缺 providerMessageId → throw', () => {
  const raw: RawEmail = { accountId: 'a1', provider: 'imap' };
  assert.throws(() => normalizeEmail(raw), /providerMessageId/);
});

test('normalizeEmail：缺所有必填可选字段 → 补默认且无 undefined 必填', () => {
  const raw: RawEmail = { accountId: 'a1', provider: 'gmail', providerMessageId: 'm1' };
  const out = normalizeEmail(raw);

  assert.equal(out.subject, '(无主题)');
  assert.equal(out.fromEmail, '');
  assert.deepEqual(out.to, []);
  assert.equal(out.hasAttachments, false);
  assert.deepEqual(out.headers, {});
  // date 补摄入时刻 ISO：必须是合法 ISO 字符串、非 undefined。
  assert.equal(typeof out.date, 'string');
  assert.ok(!Number.isNaN(new Date(out.date).getTime()), 'date 必须是可解析的 ISO');

  // 断言无任一必填字段为 undefined。
  for (const key of ['accountId', 'provider', 'providerMessageId', 'subject', 'fromEmail', 'to', 'date', 'hasAttachments', 'headers'] as const) {
    assert.notEqual(out[key], undefined, `必填字段 ${key} 不应为 undefined`);
  }
});

test('normalizeEmail：header key 小写归一 + last-non-empty-wins（From 非空、from 空）', () => {
  const raw: RawEmail = {
    accountId: 'a1',
    provider: 'gmail',
    providerMessageId: 'm1',
    headers: { From: 'a@b.com', from: '' }, // 后写的 from 为空，禁止覆盖已有非空 From
  };
  const out = normalizeEmail(raw);

  // key 归一为小写，只剩一个 from。
  assert.deepEqual(Object.keys(out.headers), ['from']);
  // 空值不覆盖非空 → 保留 a@b.com。
  assert.equal(out.headers.from, 'a@b.com');
});

test('normalizeEmail：last-non-empty-wins（from 空在前、From 非空在后 → 非空覆盖）', () => {
  const raw: RawEmail = {
    accountId: 'a1',
    provider: 'gmail',
    providerMessageId: 'm1',
    headers: { from: '', From: 'later@b.com' }, // 后写非空，覆盖前面的空。
  };
  const out = normalizeEmail(raw);

  assert.deepEqual(Object.keys(out.headers), ['from']);
  assert.equal(out.headers.from, 'later@b.com');
});

test('normalizeEmail：数组形态 headers（[key,value] 对）→ 小写归一、非数字键', () => {
  const out = normalizeEmail({
    accountId: 'a1',
    provider: 'gmail',
    providerMessageId: 'm1',
    headers: [
      ['Authentication-Results', 'spf=pass'],
      ['Reply-To', 'r@b.com'],
    ],
  });

  // 走 Array.isArray 分支：小写归一，不产出数字键。
  assert.equal(out.headers['authentication-results'], 'spf=pass');
  assert.equal(out.headers['reply-to'], 'r@b.com');
  assert.ok(!('0' in out.headers), '不应出现数字索引键');
  assert.ok(!('1' in out.headers), '不应出现数字索引键');
});

test('buildClassifierInput：数组形态 headers 的安全 header 全链路存活', () => {
  const normalized = normalizeEmail({
    accountId: 'a1',
    provider: 'gmail',
    providerMessageId: 'm1',
    headers: [
      ['Authentication-Results', 'spf=pass'],
      ['Reply-To', 'r@b.com'],
    ],
  });
  const input = buildClassifierInput(normalized);

  assert.equal(input.headers['authentication-results'], 'spf=pass');
  assert.equal(input.headers['reply-to'], 'r@b.com');
});

// ——————————————————————————————————————————————————————————
// buildClassifierInput：最小化送模型输入、不外泄正文
// ——————————————————————————————————————————————————————————

test('buildClassifierInput：超长 textBody 被截断到 ~6000 字符', () => {
  const longBody = 'x'.repeat(10_000);
  const input = buildClassifierInput(sampleEmail({ textBody: longBody }));

  assert.ok(input.textBody !== undefined);
  assert.ok(input.textBody.length <= 6000, `textBody 应被截断到 ≤6000，实际 ${input.textBody.length}`);
  assert.equal(input.textBody.length, 6000);
});

test('buildClassifierInput：htmlBody 绝不出现在投影中', () => {
  const input = buildClassifierInput(
    sampleEmail({ htmlBody: '<html>secret body</html>', textBody: 'plain' }),
  );

  // 投影对象不含 htmlBody 键。
  assert.ok(!('htmlBody' in input), '投影禁止包含 htmlBody');
  // 序列化后也不含 htmlBody 内容（防止经其他字段泄漏）。
  assert.ok(!JSON.stringify(input).includes('secret body'));
});

test('buildClassifierInput：header 集合 ⊆ 闭集白名单，白名单外的被剔除', () => {
  const input = buildClassifierInput(
    sampleEmail({
      headers: {
        'reply-to': 'r@b.com',
        'return-path': 'rp@b.com',
        'list-unsubscribe': '<mailto:u@b.com>',
        'authentication-results': 'spf=pass',
        // 白名单外，必须被剔除：
        received: 'from mx.example',
        'x-mailer': 'Outlook',
        from: 'sender@b.com',
        subject: 'should-not-be-here',
      },
    }),
  );

  const allowed = new Set(['reply-to', 'return-path', 'list-unsubscribe', 'authentication-results']);
  // 正向断言：产出 header 集合是闭集的子集。
  for (const key of Object.keys(input.headers)) {
    assert.ok(allowed.has(key), `header ${key} 不应出现（不在闭集白名单内）`);
  }
  // 白名单内的应保留。
  assert.equal(input.headers['reply-to'], 'r@b.com');
  assert.equal(input.headers['authentication-results'], 'spf=pass');
  // 白名单外的确实被剔除。
  assert.ok(!('received' in input.headers), 'received 必须被剔除');
  assert.ok(!('x-mailer' in input.headers), 'x-mailer 必须被剔除');
  assert.ok(!('from' in input.headers), 'from 不应进入 header 投影');
  assert.ok(!('subject' in input.headers), 'subject 不应进入 header 投影');
});

test('buildClassifierInput：经 normalizeEmail 的真实路径也只产出白名单 header', () => {
  // 用 normalizeEmail 收敛一个混杂大小写 + 白名单外 header 的原始邮件，
  // 再投影，验证全链路只送白名单。
  const normalized = normalizeEmail({
    accountId: 'a1',
    provider: 'imap',
    providerMessageId: 'm1',
    subject: 's',
    fromEmail: 'x@y.com',
    headers: {
      'Reply-To': 'r@b.com',
      'Authentication-Results': 'dkim=pass',
      Received: 'from somewhere',
      'X-Spam-Score': '0.1',
    },
  });
  const input = buildClassifierInput(normalized);

  const allowed = new Set(['reply-to', 'return-path', 'list-unsubscribe', 'authentication-results']);
  for (const key of Object.keys(input.headers)) {
    assert.ok(allowed.has(key), `header ${key} 不应出现`);
  }
  assert.equal(input.headers['reply-to'], 'r@b.com');
  assert.equal(input.headers['authentication-results'], 'dkim=pass');
  assert.ok(!('received' in input.headers));
  assert.ok(!('x-spam-score' in input.headers));
});
