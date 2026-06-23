// rules-config 加载器单测（node:test）——逐条兑现 rules-config/spec.md 场景 + tasks §1.6/§2.3。
//
// 覆盖：
//   §1.6 合法 YAML → 用「内置整集 ∪ YAML」；缺文件/EACCES → 回落不崩；security_keywords:[] / 缺内置词 /
//        标量 → 整集仍生效（经 applySafetyRules 对「医院预约」断言 shouldMarkRead=false）；解析失败 →
//        敏感邮件仍不标已读；凭据值/原始错误不入日志；首次异步加载前 getActiveRules().securityKeywords 已是内置整集。
//   §2.3 改 YAML 后 getActiveRules() 反映新值（含「内置整集 ∪ 新词」）；坏重载/删文件 → carry-forward
//        （含 operator 域名/词）+ 内置整集仍并入、护栏不失效、不崩；poll tick 抛错后下一 tick 仍能重载。
//
// 注入 seam：reloadRulesConfigForTest(path) 直调重载、startRulesConfigReload({statMtimeMs,setIntervalFn,...})
// 注入假时钟/poller，均不依赖真 timing。
//
// TODO(组B): 域名轴/security 整集语义首选经 applySafetyRules 的可选 `rules` 参注入快照断言；
// 组 B 改完 applySafetyRules 签名后，组 E 统一把这些断言收口到 applySafetyRules。此前部分断言走 loader 层。

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { applySafetyRules } from './applySafetyRules.js';
import { SECURITY_PAYMENT_KEYWORDS } from './lists.js';
import {
  getActiveRules,
  reloadRulesConfigForTest,
  resetRulesConfigForTest,
  setRulesConfigLoggerForTest,
  startRulesConfigReload,
} from './rulesConfig.js';
import type { Classification } from '../classifier/schema.js';
import type { NormalizedEmail } from '../normalizer/normalizeEmail.js';

// —— 临时 YAML 文件管理 ——
let tmpDir: string;
let yamlPath: string;
let counter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'rules-config-'));
  yamlPath = join(tmpDir, `rules-${counter++}.yaml`);
});

afterEach(() => {
  resetRulesConfigForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误。
  }
});

function writeYaml(content: string): void {
  writeFileSync(yamlPath, content, 'utf8');
}

// —— fixture helpers ——
function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    accountId: 'acct-1',
    provider: 'gmail',
    providerMessageId: 'm-1',
    subject: '普通主题',
    fromEmail: 'someone@neutral-domain.test',
    date: '2026-06-22T00:00:00.000Z',
    to: [],
    hasAttachments: false,
    headers: {},
    ...overrides,
  };
}

function makeClassification(overrides: Partial<Classification> = {}): Classification {
  return {
    priority: 'P2',
    category: 'newsletter',
    should_notify_now: false,
    should_mark_read: true,
    should_include_digest: true,
    confidence: 0.9,
    reason: 'test',
    risk_flags: [],
    ...overrides,
  };
}

// ====================================================================
// §1.6 — 同步初始化 / 整集并集 / 回落 / 不泄露
// ====================================================================

test('首次（异步加载前）getActiveRules().securityKeywords 已是内置整集', () => {
  // resetRulesConfigForTest 模拟同步初始化态（内置整集 ∪ 空）。
  resetRulesConfigForTest();
  const active = getActiveRules();
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw), `内置词 ${kw} 必须在同步初始化的有效集中`);
  }
});

test('合法 YAML → securityKeywords = 内置整集 ∪ YAML 新词，其余轴取 YAML', () => {
  writeYaml(
    [
      'security_keywords:',
      '  - 对账单',
      '  - statement',
      'vip_senders:',
      '  - vip@example.com',
      'important_domains:',
      '  - example.com',
      'marketing_keywords:',
      '  - 促销',
      'never_mark_read_domains:',
      '  - bank.example',
    ].join('\n'),
  );
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();

  // 整集并集：所有内置词仍在 + YAML 新词叠加。
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw), `内置词 ${kw} 必须仍生效`);
  }
  assert.ok(active.securityKeywords.includes('对账单'));
  assert.ok(active.securityKeywords.includes('statement'));

  assert.deepEqual(active.vipSenders, ['vip@example.com']);
  assert.deepEqual(active.importantDomains, ['example.com']);
  assert.deepEqual(active.marketingKeywords, ['促销']);
  assert.deepEqual(active.neverMarkReadDomains, ['bank.example']);
});

test('security_keywords:[] → 内置整集仍生效；经 applySafetyRules 对「医院预约」断言不标已读', () => {
  writeYaml('security_keywords: []\n');
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw), `配空后内置词 ${kw} 必须仍生效`);
  }
  // 经 applySafetyRules：含内置词「医院」的 P2 邮件 → shouldMarkRead=false（内置整集守住）。
  // applySafetyRules 当前直接用内置 SECURITY_PAYMENT_KEYWORDS，故此处坐实「内置整集守住」语义。
  const decision = applySafetyRules(
    makeEmail({ subject: '医院预约提醒' }),
    makeClassification({ priority: 'P2', category: 'newsletter' }),
  );
  assert.equal(decision.shouldMarkRead, false);
});

test('security_keywords 缺某些内置词（只列自定义词）→ 内置整集不被删', () => {
  writeYaml('security_keywords:\n  - 自定义安全词\n');
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw), `内置词 ${kw} 不可被 YAML 删除`);
  }
  assert.ok(active.securityKeywords.includes('自定义安全词'));
});

test('security_keywords 配成标量（非数组）→ 该项回落、内置整集仍生效', () => {
  writeYaml('security_keywords: 不是数组\n');
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw), `标量回落后内置词 ${kw} 必须仍生效`);
  }
});

test('缺文件 → 全 carry-forward（首次=内置默认）、不崩', () => {
  // 指向不存在路径。
  reloadRulesConfigForTest(join(tmpDir, 'does-not-exist.yaml'));
  const active = getActiveRules();
  // security 仍是内置整集；其余空。
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw));
  }
  assert.deepEqual(active.vipSenders, []);
  assert.deepEqual(active.neverMarkReadDomains, []);
});

test('某项非法（vip 标量）但 security 合法 → 仅 vip 回落、security 生效、不崩', () => {
  writeYaml(['security_keywords:', '  - 对账单', 'vip_senders: 不是数组'].join('\n'));
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  assert.ok(active.securityKeywords.includes('对账单'));
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw));
  }
  // vip 回落（首次=空）。
  assert.deepEqual(active.vipSenders, []);
});

test('解析失败（坏 YAML）→ 敏感邮件仍不标已读（内置整集 + 类别轴守住）', () => {
  // 先放一个合法文件建立基线，再放坏文件触发解析失败 → 全 carry-forward。
  writeYaml('vip_senders:\n  - vip@example.com\n');
  reloadRulesConfigForTest(yamlPath);
  // 坏 YAML（未闭合）。
  writeYaml('security_keywords: [\n  - "unterminated');
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  // 内置整集仍在。
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw));
  }
  // carry-forward 保住上一次有效 vip。
  assert.deepEqual(active.vipSenders, ['vip@example.com']);
  // 经 applySafetyRules：敏感类别 P2 → 不标已读。
  const decision = applySafetyRules(
    makeEmail(),
    makeClassification({ priority: 'P2', category: 'finance' }),
  );
  assert.equal(decision.shouldMarkRead, false);
});

test('凭据形态键/verification/sensitive_categories → 静默丢弃、不消费、不入日志', () => {
  writeYaml(
    [
      'OPENROUTER_API_KEY: sk-secret-value-do-not-log',
      'password: hunter2',
      'verification:',
      '  - 不该被读',
      'sensitive_categories:',
      '  - 不该被读',
      'security_keywords:',
      '  - 对账单',
    ].join('\n'),
  );

  // 捕获 logger 输出：断言绝不含凭据值/被丢弃键名。
  const logs = captureLogs(() => reloadRulesConfigForTest(yamlPath));

  const active = getActiveRules();
  // 已知键正常消费。
  assert.ok(active.securityKeywords.includes('对账单'));
  // 未知键/verification/sensitive_categories 绝不出现在快照（schema 不含、被丢弃）。
  const serialized = JSON.stringify(active);
  assert.ok(!serialized.includes('不该被读'), 'verification/sensitive_categories 内容不得进入快照');
  // 日志绝不含凭据值/被丢弃键名。
  for (const line of logs) {
    assert.ok(!line.includes('sk-secret-value-do-not-log'), '凭据值绝不入日志');
    assert.ok(!line.includes('hunter2'), '凭据值绝不入日志');
    assert.ok(!line.includes('OPENROUTER_API_KEY'), '被丢弃键名绝不入日志');
    assert.ok(!line.includes('password'), '被丢弃键名绝不入日志');
  }
});

test('某项非法日志只含 kind+项名+issuePaths，不含 issue.message/received/解析值', () => {
  writeYaml('vip_senders: 机密值-secret-xyz\n');
  const logs = captureLogs(() => reloadRulesConfigForTest(yamlPath));
  // 必有一条 field-invalid 日志。
  const invalidLog = logs.find((l) => l.includes('rules-config-field-invalid'));
  assert.ok(invalidLog, '某项非法应记 field-invalid 日志');
  // 不含解析值。
  for (const line of logs) {
    assert.ok(!line.includes('机密值-secret-xyz'), '解析值绝不入日志');
    // zod issue.message（中文/英文）形态——确认没把 message 整段写进去（received 等）。
    assert.ok(!line.includes('"received"'), 'issue.received 绝不入日志');
    assert.ok(!line.includes('"message"'), 'issue.message 绝不入日志');
  }
  // 但含项名与 issuePaths 字段。
  assert.ok(invalidLog!.includes('vip_senders'));
});

test('YAML 列表项归一：大小写/空白/空项 → trim+lower+丢空；大写 security 词强制不标已读', () => {
  writeYaml('security_keywords:\n  - "WIRE TRANSFER"\n  - "  "\n  - "Statement"\n');
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  assert.ok(active.securityKeywords.includes('wire transfer'), '大写 security 词应被小写归一');
  assert.ok(active.securityKeywords.includes('statement'), '混合大小写 security 词应被小写归一');
  assert.ok(!active.securityKeywords.includes(''), '空白项归一后应被丢弃');
  // 经 applySafetyRules：subject "Wire Transfer Confirmation" 的 P2 → shouldMarkRead=false（安全方向）。
  const decision = applySafetyRules(
    makeEmail({ subject: 'Wire Transfer Confirmation' }),
    makeClassification({ priority: 'P2', category: 'newsletter' }),
    active,
  );
  assert.equal(decision.shouldMarkRead, false);
});

test('rules.yaml >256KB → carry-forward（内置整集仍在、不崩、cause=too-large）', () => {
  // 先放合法基线，再写一个 >256KB 的合法文件。
  writeYaml('security_keywords:\n  - 对账单\n');
  reloadRulesConfigForTest(yamlPath);
  const huge = 'security_keywords:\n' + '  - x\n'.repeat(60_000); // 远超 256KB
  writeYaml(huge);
  const logs = captureLogs(() => reloadRulesConfigForTest(yamlPath));
  const active = getActiveRules();
  // 内置整集仍在（护栏不失效）。
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw));
  }
  // carry-forward 保住上一次有效值。
  assert.ok(active.securityKeywords.includes('对账单'), '超限 → carry-forward 上一次有效值');
  // 记 load-failed 日志、cause=too-large。
  const failLog = logs.find((l) => l.includes('rules-config-load-failed'));
  assert.ok(failLog, '超限应记 load-failed 日志');
  assert.ok(failLog!.includes('too-large'), 'cause 应为 too-large');
});

// ====================================================================
// §2.3 — 热重载 / carry-forward / poll tick 自愈
// ====================================================================

test('改 YAML 后 reloadNow → getActiveRules 反映新值（含内置整集 ∪ 新词）', () => {
  // 假时钟 poller + 注入 mtime。
  writeYaml('security_keywords:\n  - 初始词\n');
  let mtime = 1;
  const handle = startRulesConfigReload({
    path: yamlPath,
    statMtimeMs: () => mtime,
    setIntervalFn: () => ({ unref: () => {} }),
    clearIntervalFn: () => {},
  });
  // startRulesConfigReload 记基线 mtime，但未发布；reloadNow 首 tick 时 mtime 未变 → 不重载。
  // 改文件 + 变 mtime → reloadNow 触发重载。
  writeYaml('security_keywords:\n  - 新词\n');
  mtime = 2;
  handle.reloadNow();
  const active = getActiveRules();
  assert.ok(active.securityKeywords.includes('新词'), '改 YAML 后应反映新词');
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw), '内置整集仍并入');
  }
  handle.stop();
});

test('坏重载 carry-forward 不丢 operator 域名/词 + 内置整集仍并入', () => {
  // 先放合法文件建立 operator 守卫（域名 + security 词）。
  writeYaml(
    [
      'security_keywords:', '  - operator安全词',
      'never_mark_read_domains:', '  - operator-domain.test',
    ].join('\n'),
  );
  reloadRulesConfigForTest(yamlPath);
  let active = getActiveRules();
  assert.ok(active.securityKeywords.includes('operator安全词'));
  assert.deepEqual(active.neverMarkReadDomains, ['operator-domain.test']);

  // 把整文件改坏（解析失败）→ 全 carry-forward。
  writeYaml('security_keywords: [unterminated\n');
  reloadRulesConfigForTest(yamlPath);
  active = getActiveRules();
  // operator 守卫存活。
  assert.ok(active.securityKeywords.includes('operator安全词'), 'operator security 词在坏重载中存活');
  assert.deepEqual(active.neverMarkReadDomains, ['operator-domain.test'], 'operator 域名在坏重载中存活');
  // 内置整集仍并入。
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw));
  }
});

test('删文件 → 全 carry-forward（不回落空丢 operator 守卫）+ 不崩', () => {
  writeYaml('never_mark_read_domains:\n  - operator-domain.test\n');
  reloadRulesConfigForTest(yamlPath);
  // 删文件。
  rmSync(yamlPath, { force: true });
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  assert.deepEqual(active.neverMarkReadDomains, ['operator-domain.test'], '删文件后 operator 域名 carry-forward');
});

test('poll tick stat 抛错 → 自捕获、轮询存活、下一 tick 仍能重载', () => {
  writeYaml('security_keywords:\n  - 初始词\n');
  let statShouldThrow = false;
  let mtime = 1;
  const statMtimeMs = (): number => {
    if (statShouldThrow) {
      throw new Error('stat failed');
    }
    return mtime;
  };
  const handle = startRulesConfigReload({
    path: yamlPath,
    statMtimeMs,
    setIntervalFn: () => ({ unref: () => {} }),
    clearIntervalFn: () => {},
  });
  // 第一 tick：stat 抛错 → 自捕获、全 carry-forward、不崩。
  statShouldThrow = true;
  assert.doesNotThrow(() => handle.reloadNow(), 'stat 抛错的 tick 不得抛出');
  // 内置整集仍在（护栏不失效）。
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(getActiveRules().securityKeywords.includes(kw));
  }
  // 下一 tick：stat 恢复、改文件、变 mtime → 仍能重载。
  statShouldThrow = false;
  writeYaml('security_keywords:\n  - 恢复后新词\n');
  mtime = 2;
  handle.reloadNow();
  assert.ok(getActiveRules().securityKeywords.includes('恢复后新词'), 'stat 错误后的 tick 仍能重载有效文件');
  handle.stop();
});

// —— logger 捕获 helper（断言凭据/解析值/丢弃键名不入日志）——
// 共享 pino logger 直写 fd1（绕过 process.stdout.write）、无法可靠拦截，故经 rulesConfig 的
// setRulesConfigLoggerForTest 注入捕获型 sink，把每条日志整体（obj+msg）序列化为一行断言。
function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  setRulesConfigLoggerForTest({
    warn: (obj, msg) => {
      lines.push(JSON.stringify({ ...obj, msg }));
    },
  });
  try {
    fn();
  } finally {
    setRulesConfigLoggerForTest(null);
  }
  return lines;
}
