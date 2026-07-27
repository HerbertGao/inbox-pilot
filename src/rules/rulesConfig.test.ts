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

import assert from 'node:assert/strict';
import {
  mkdirSync,
  chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { applySafetyRules, normalizeFromAddress, normalizeFromDomain } from './applySafetyRules.js';
import { SECURITY_PAYMENT_KEYWORDS } from './lists.js';
import {
  readOverlayFile,
  canonicalizeUserEntry,
  canonicalizeOverlayLine,
  checkEntry,
  isAddableEntry,
  MAX_ENTRY_LEN,
  readNoiseOverlay,
  resolveNoiseOverlayPath,
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
      'noise_senders:',
      '  - nas@home.lan',
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
  assert.deepEqual(active.noiseSenders, ['nas@home.lan']);
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

test('加载并归一 noise_senders：大小写/空白/空项 → trim+lower+丢空（发件人 + 域）', () => {
  writeYaml('noise_senders:\n  - "NAS@home.LAN"\n  - "  "\n  - "hkss.example.com"\n');
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  assert.deepEqual(active.noiseSenders, ['nas@home.lan', 'hkss.example.com']);
  assert.ok(!active.noiseSenders.includes(''), '空白项归一后应被丢弃');
});

test('noise_senders 配成标量（非数组）→ 仅 noise 回落、其余五类生效、不崩', () => {
  writeYaml(
    [
      'security_keywords:', '  - 对账单',
      'vip_senders:', '  - vip@example.com',
      'noise_senders: 不是数组',
    ].join('\n'),
  );
  reloadRulesConfigForTest(yamlPath);
  const active = getActiveRules();
  // noise 回落（首次=空）。
  assert.deepEqual(active.noiseSenders, []);
  // 其余项不被 noise 非法连累。
  assert.ok(active.securityKeywords.includes('对账单'));
  assert.deepEqual(active.vipSenders, ['vip@example.com']);
  for (const kw of SECURITY_PAYMENT_KEYWORDS) {
    assert.ok(active.securityKeywords.includes(kw), `noise 非法不得连累内置整集：${kw}`);
  }
});

test('noise_senders 坏重载 carry-forward 上一次有效值，不连累其余五类', () => {
  writeYaml('noise_senders:\n  - nas@home.lan\n');
  reloadRulesConfigForTest(yamlPath);
  assert.deepEqual(getActiveRules().noiseSenders, ['nas@home.lan']);
  // 改坏（解析失败）→ 全 carry-forward。
  writeYaml('noise_senders: [unterminated\n');
  reloadRulesConfigForTest(yamlPath);
  assert.deepEqual(getActiveRules().noiseSenders, ['nas@home.lan'], 'operator noise 项在坏重载中存活');
});

test('加载 noise overlay 并 set-union 进 noiseSenders（rules.yaml noise_senders ∪ overlay、归一、去重）', () => {
  writeYaml('noise_senders:\n  - nas@home.lan\n');
  // overlay 与 rules.yaml 同目录（resolveNoiseOverlayPath 由 buildAndPublish 传入的 path 派生）。
  writeFileSync(
    join(tmpDir, 'noise_senders.overlay'),
    'nas@home.lan\nPUSH@taobao.com\n  \nnoreply@jd.com\n',
    'utf8',
  );
  reloadRulesConfigForTest(yamlPath);
  // yaml 的 nas 与 overlay 的 nas 去重；overlay 归一 lower+trim+丢空；YAML 在前、overlay 新增在后。
  assert.deepEqual(getActiveRules().noiseSenders, ['nas@home.lan', 'push@taobao.com', 'noreply@jd.com']);
});

test('noise overlay 缺失 → 仅用 rules.yaml noise_senders（不崩、优雅退化）', () => {
  writeYaml('noise_senders:\n  - nas@home.lan\n');
  reloadRulesConfigForTest(yamlPath); // tmpDir 下无 overlay 文件
  assert.deepEqual(getActiveRules().noiseSenders, ['nas@home.lan']);
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
      'noise_senders:',
      '  - nas@home.lan',
    ].join('\n'),
  );

  // 捕获 logger 输出：断言绝不含凭据值/被丢弃键名。
  const logs = captureLogs(() => reloadRulesConfigForTest(yamlPath));

  const active = getActiveRules();
  // 已知键正常消费（含新增第六类 noise_senders，证加 KNOWN_KEYS 后凭据丢弃契约不破）。
  assert.ok(active.securityKeywords.includes('对账单'));
  assert.deepEqual(active.noiseSenders, ['nas@home.lan']);
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

// ─────────────── overlay 格式所有权：L ⊆ W 的性质测试 ───────────────
//
// 「loader 接受的每一行，写路径都必须能删掉」——这条性质此前靠两处手抄的归一维持，三轮 review 里
// 因它破裂产生过三类缺陷（谎报 already_present / 静默激活死行 / 存量条目结构性锁死）。
// 现在 loader 与写路径共用 canonicalizeOverlayLine，故它是构造性事实；本用例是它的回归网。

test('L ⊆ W：readNoiseOverlay 读出的每一行，remove 侧判据必须接受', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-lang-'));
  const file = join(dir, 'noise_senders.overlay');
  try {
    writeFileSync(
      file,
      [
        '<a@b.com>', // 尖括号包裹（旧 writer 可写出）
        '  A@B.COM  ', // 前后空白 + 大写
        'root@nas', // 无点域（不可加入，但必须可移除）
        'admin@10.0.0.5', // 数字 TLD
        'mailto:a@b.com', // 匹配侧永不命中的形态
        'plain.domain.example', // 裸域名
        '', // 空行
        '   ', // 纯空白行
        'dup@x.com',
        'DUP@X.COM', // 归一后重复
        '<<nested@x.com>>', // 嵌套尖括号 —— 曾是唯一的不幂等族
        'a'.repeat(300) + '@x.com', // 超 MAX_ENTRY_LEN 的手改行：loader 认得它，remove 就必须能删掉它
        'a\u0009b@x.com', // 内部控制字符（同上）
      ].join('\r\n') + '\r\n', // CRLF
      'utf8',
    );
    const lines = readNoiseOverlay(file);
    assert.ok(lines.length > 0, '语料应产出条目');
    for (const line of lines) {
      assert.ok(checkEntry(line, 'remove'), `loader 读出的行必须可被 remove 接受：${JSON.stringify(line)}`);
      assert.equal(canonicalizeOverlayLine(line), line, `loader 读出的行必须已是归一形态：${JSON.stringify(line)}`);
    }
    // 长度闸只在 add 侧，故**没有残余**：超长的手改行照样可移除。闸放到共用前缀上时，
    // 这一行会「loader 认得（正在静音邮件）、remove 却删不掉」= 结构性锁死。
    const longLine = 'a'.repeat(300) + '@x.com';
    assert.ok(lines.includes(longLine), '语料里的超长行必须被 loader 读出（否则下一条断言是空转）');
    assert.equal(checkEntry(longLine, 'remove'), true, '超长存量行必须可移除');
    assert.equal(checkEntry(longLine, 'add'), false, '但 add 侧仍受 MAX_ENTRY_LEN 限制');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('可加入判据 == 匹配侧能命中的形态（既不严于它、也不宽于它）', () => {
  // 拒：匹配侧的归一**产不出**这个串，写进去就是一条永不命中的规则（false-green）。
  for (const bad of [
    '<a@x.com>', // 尖括号：normalizeFromAddress 会剥掉，故它本身永远比不中
    'a b@x.com', // local 含空白：出了 [^\s<>@] 的字母表
    'a@x com', // 域含空白：出了 [a-z0-9.-] 的字母表
    'a@x_y.com', // 下划线：同上
    'a@例子.com', // 非 ASCII：匹配侧不转 punycode（IDN 裁决 ④）
    'com', // 裸 TLD：一条静音整个 .com
    'no-dot', // 无 @ 无点：既不是地址也不是域名
    '', // 空
    'mailto:alice@example.com', // mailto: 前缀：匹配侧的 From 永远产不出它；改写它属意图解析，写路径不做
  ]) {
    assert.equal(isAddableEntry(bad), false, `${bad} 在匹配侧永不命中，必须不可加入`);
  }
  // 收：匹配侧**确实命中**这些形态。判据比匹配侧严，就会把真实存在的发件人锁在反馈闭环之外——
  // root@nas / admin@10.0.0.5 这一整类（NAS、路由器、内网 cron）曾因 RFC dot-atom + 纯字母 TLD 判据
  // 被整体挡掉，而 digest 表头正把它们展示为可加入。
  for (const ok of [
    'a@x.com',
    'root@nas', // 无点域：normalizeFromAddress 的 [a-z0-9.-]+ 收它
    'admin@10.0.0.5', // 数字 TLD：同上
    'a@x.c', // 单字母 TLD：同上
    'bounces+1=user.com@sendgrid.net', // VERP
    'srs0=a=b=user@fwd.net', // SRS
    'ops!tag@x.com',
    'first.last@company.com',
    'plain.domain.example', // 域名条目
  ]) {
    assert.equal(isAddableEntry(ok), true, `${ok} 匹配侧命中，必须可加入`);
  }
});

test('性质：isAddableEntry(s) ≡ 匹配侧可达(s) ∧ ¬豁免(s)（双向等价，穷举短串；oracle 用匹配侧真函数）', () => {
  // 这条守的是 RC-F1 那一类缺陷：判据与匹配侧的偏离都必须是**声明过的**，而正反例清单只能抽样、
  // 恰好绕开偏离区就全绿。故按性质穷举，且 oracle 直接 import `applySafetyRules` 的两个归一——
  // 抄一份正则进测试，匹配侧一改这条网就随之失效，等于没有网。
  //
  // 断言是**双向等价**，不是「每条豁免有一个见证」：后者只要求豁免类里有**一个**样本被拒，
  // 判据把同类的其余成员错误地**收下**照样全绿（政策被削掉一半而测试不红）。
  //
  // 码位判定一律走 codePointAt，**绝不把非 ASCII/控制字符写进正则字面量**（它们在编辑器/剪贴板/
  // JSON 往返里会被静默改写，那时这张网会无声地失效）。
  const codePoints = (s: string): number[] => [...s].map((c) => c.codePointAt(0) ?? 0);
  const hasNonAscii = (s: string): boolean => codePoints(s).some((cp) => cp > 0x7f);
  const hasControl = (s: string): boolean => codePoints(s).some((cp) => cp < 0x20 || cp === 0x7f);
  /** `isAddableEntry` doc 里逐条声明的豁免（匹配侧产得出、判据仍拒）。 */
  const exemptions: Array<[string, (s: string) => boolean]> = [
    ['①非 ASCII local part（IDN 裁决）', hasNonAscii],
    ['②控制字符（邮件内容侧的信任边界）', hasControl],
    ['③④无点的域名条目 / 裸 TLD（一条静音整个后缀）', (s) => !s.includes('@') && !s.includes('.')],
    ['⑤超 MAX_ENTRY_LEN（长度闸只在 add 侧，remove 侧必须收得下存量行）', (s) => s.length > MAX_ENTRY_LEN],
    ['⑥mailto: 前缀（改写它属意图解析，写路径只收或拒）', (s) => s.slice(0, 7).toLowerCase() === 'mailto:'],
  ];
  /** 政策的**完整**声明：匹配侧可达 ∧ 不命中任何一条豁免。`isAddableEntry` 必须与它逐串相等。 */
  const reachable = (s: string): boolean => normalizeFromAddress(s) === s || normalizeFromDomain(`x@${s}`) === s;
  const expectedPolicy = (s: string): boolean => reachable(s) && !exemptions.some(([, pred]) => pred(s));
  // `:` 与 `m` 在字母表里，`mailto:` 族的字符才可达（此前完全不可达 = ⑥那条政策没有网）。
  const alphabet = ['a', '1', '.', '-', '@', '<', '>', ' ', '_', '!', '+', '=', ':', 'm', '\u00e9', String.fromCodePoint(1)];
  const mismatches: string[] = []; // 判据与政策声明不符的串（收得太宽 / 拒得太严，两个方向都记这里）
  const hitExemptions = new Set<string>(); // 每条豁免都得真被样本独占命中（否则这条分类是空转的）
  let checked = 0;
  const visit = (s: string): void => {
    checked++;
    if (isAddableEntry(s) !== expectedPolicy(s)) {
      mismatches.push(JSON.stringify(s));
    }
    // 只记**独占**见证（恰好命中一条豁免、且匹配侧确实产得出的样本）：同时命中两条的样本会替其中
    // 一条打掩护；匹配侧本就产不出的样本不构成「豁免」的见证（它根本不在偏离区）。
    const hit = exemptions.filter(([, pred]) => pred(s));
    if (hit.length === 1 && reachable(s)) {
      hitExemptions.add(hit[0][0]);
    }
  };
  const walk = (s: string, depth: number): void => {
    if (depth === 0) {
      visit(s);
      return;
    }
    for (const c of alphabet) {
      walk(s + c, depth - 1);
    }
  };
  for (let d = 1; d <= 4; d++) {
    walk('', d);
  }
  // 两条豁免的最短见证长于 4：⑤要 255+ 字符、⑥要 7 字符的前缀。短串穷举够不着，单独喂。
  visit('a'.repeat(300) + '@x.com');
  for (const s of ['mailto:a@b.com', 'mailto:alice@example.com', 'mailto:x.com', 'mailto:@x.com', 'mailto:a@b']) {
    visit(s);
  }
  assert.ok(checked > 20000, `穷举规模应足够（实际 ${checked}）`);
  assert.deepEqual(
    mismatches.slice(0, 10),
    [],
    'isAddableEntry 必须与「匹配侧可达 − 具名豁免集」逐串相等：宽于它 = 写进永不命中的死条目；' +
      '严于它 = 把真实发件人锁在闭环之外',
  );
  for (const [name] of exemptions) {
    assert.ok(hitExemptions.has(name), `豁免「${name}」无独占见证样本，这条分类是空转的`);
  }
});
test('不动点性质：canonicalizeOverlayLine 的输出恒为自身的不动点（穷举短串，不依赖语料选得好不好）', () => {
  // 这条是 L = W 的真正的网。上一轮只有「语料 → 逐行断言」，而语料恰好绕开了唯一的不幂等族
  // （嵌套尖括号），于是 474 个用例全绿而性质是破的。**性质要被断言，不能被论证。**
  const alphabet = ['<', '>', ' ', 'a', 'A', '	', '@', '.'];
  let checked = 0;
  const walk = (prefix: string, depth: number): void => {
    if (depth === 0) {
      const once = canonicalizeOverlayLine(prefix);
      if (once !== null) {
        assert.equal(canonicalizeOverlayLine(once), once, `非不动点：${JSON.stringify(prefix)} → ${JSON.stringify(once)}`);
        assert.ok(checkEntry(once, 'remove'), `行归一的输出必须可被 remove 接受：${JSON.stringify(once)}`);
      }
      checked++;
      return;
    }
    for (const c of alphabet) {
      walk(prefix + c, depth - 1);
    }
  };
  for (let len = 0; len <= 4; len++) {
    walk('', len);
  }
  assert.ok(checked > 4000, `穷举规模应足够（实际 ${checked}）`);
});

test('不动点性质：canonicalizeUserEntry 的输出恒为行归一的不动点（剥到底，不是只剥一层）', () => {
  for (const raw of ['<<a@b.com>>', '<<<a@b.com>>>', '< <a@b.com> >', '  <A@B.COM>  ', '<>', '<a', 'a>']) {
    const out = canonicalizeUserEntry(raw);
    if (out === null) continue;
    assert.equal(canonicalizeOverlayLine(out), out, `用户输入归一的输出必须是行的不动点：${JSON.stringify(raw)} → ${JSON.stringify(out)}`);
  }
  assert.equal(canonicalizeUserEntry('<<a@b.com>>'), 'a@b.com', '剥到不动点，而非只剥一层');
  // 写路径**只收或拒、绝不改写**：`mailto:` 前缀原样留着（归一只做 trim/剥 <>/小写），由 isAddableEntry 拒掉。
  // 剥它就是替用户解析意图——local part 真叫 `mailto` 的发件人会被改写成另一个地址、静音错的人。
  for (const raw of ['mailto:Alice@Example.com', '<mailto:alice@example.com>', ' MAILTO:alice@example.com ']) {
    assert.equal(canonicalizeUserEntry(raw), 'mailto:alice@example.com', `mailto: 前缀不得被剥掉：${raw}`);
    assert.equal(isAddableEntry('mailto:alice@example.com'), false, `带 mailto: 前缀的条目必须被拒：${raw}`);
  }
});

test('readOverlayFile：statSync 本身抛错（父目录不可搜索）时不得逃逸 —— fail-open 降级、fail-closed 抛受控错误', () => {
  // 这条守的是 import 期崩溃：readOverlayFile 在模块顶层 buildAndPublish 的调用链上，
  // 而 `throwIfNoEntry:false` **只**压制 ENOENT/ENOTDIR，EACCES/ELOOP 照抛。不捕获即整个模块 import 失败。
  // 注意必须让 **stat 本身**失败（chmod 父目录），chmod 文件只会让 readFileSync 失败，测不到这条路径。
  const dir = mkdtempSync(join(tmpdir(), 'overlay-stat-'));
  const sub = join(dir, 'locked');
  mkdirSync(sub);
  const file = join(sub, 'noise_senders.overlay');
  writeFileSync(file, 'keep@a.com\n', 'utf8');
  chmodSync(sub, 0o000);
  try {
    if (readOverlayFile(file, 'fail-open').length !== 0) {
      return; // root 或该平台不强制目录搜索权限 → 构造不成立，跳过
    }
    assert.deepEqual(readOverlayFile(file, 'fail-open'), [], 'loader 侧降级为空集，绝不崩');
    assert.throws(
      () => readOverlayFile(file, 'fail-closed'),
      /overlay 读取失败/,
      '写路径抛受控错误（只回 kind），而非让原生 fs 错误带着绝对路径逃逸',
    );
  } finally {
    chmodSync(sub, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readOverlayFile：非法路径(ENOTDIR)与非普通文件不得被当作空文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-kind-'));
  const file = join(dir, 'plain');
  writeFileSync(file, 'a@b.com\n', 'utf8');
  const throughFile = join(file, 'nested.overlay'); // 把普通文件当目录用 → ENOTDIR
  try {
    // ENOTDIR 曾被 throwIfNoEntry:false 折成 undefined → fail-closed 的 remove 会成功回执「本就不在」。
    assert.deepEqual(readOverlayFile(throughFile, 'fail-open'), [], 'loader 侧降级为空集');
    assert.throws(() => readOverlayFile(throughFile, 'fail-closed'), /overlay 读取失败/, '写路径必须抛错');
    // 目录不是普通文件：size 不可信、同步读语义不定。
    assert.deepEqual(readOverlayFile(dir, 'fail-open'), []);
    assert.throws(() => readOverlayFile(dir, 'fail-closed'), /overlay 读取失败/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay 路径恒由 rules 路径派生（同目录 noise_senders.overlay），无第二个旋钮', () => {
  // 「这两条路径是不是同一个文件」那一整类别名闸随可配置旋钮一起消失：只有 RULES_FILE 决定两者位置，
  // 故它们不可能被指到对方身上——除非 rules 文件自己就叫 noise_senders.overlay（撞名，由 apply 腿拒）。
  const dir = mkdtempSync(join(tmpdir(), 'overlay-derive-'));
  try {
    assert.equal(resolveNoiseOverlayPath(join(dir, 'rules.yaml')), join(dir, 'noise_senders.overlay'));
    assert.equal(resolveNoiseOverlayPath(join(dir, 'sub', 'r.yaml')), join(dir, 'sub', 'noise_senders.overlay'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
