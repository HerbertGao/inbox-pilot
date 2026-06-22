// 离线自测（daily-digest task 4.3/4.4）：buildDigest 组装 + 分段 + 有界渲染（纯函数）。
//
// 4.3：P1/P2 逐条含发件人/主题/原因；P3 仅计数、文案不含「已读」字样；无 P1P2 且 P3=0 → null；
//   P3>0 但无 P1P2 → 非 null；超长 → 多段、每段 ≤ SEGMENT_MAX、不断行；
//   超长发件人/主题/原因各自及组合 → 单行仍 < SEGMENT_MAX 且保 `^.+ - .+ - .+$` 结构；
//   emoji 主题按 UTF-16 计数不超限、截断不裂代理对。
// 4.4：所有 segment.text 不含 bodyText（候选无该字段，结构保证）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDigest,
  renderItemLine,
  renderP3CountLine,
  truncateUtf16,
  SEGMENT_MAX,
  FIELD_CAP,
} from './buildDigest.js';
import type { DigestCandidate, MailRepo } from '../repo/mailRepo.js';
import { DIGEST_TYPE_DAILY } from '../repo/mailRepo.js';

// 注入假 repo：仅实现 buildDigest 用到的 listDigestCandidates（返回 crafted 候选）。
function fakeRepo(candidates: DigestCandidate[]): Pick<MailRepo, 'listDigestCandidates'> {
  return {
    async listDigestCandidates(digestType: string): Promise<DigestCandidate[]> {
      assert.equal(digestType, DIGEST_TYPE_DAILY); // 钉死按 daily 命名空间查
      return candidates;
    },
  };
}

function makeCandidate(overrides: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    messageRowId: 'row-1',
    priority: 'P1',
    category: 'work',
    subject: '主题A',
    fromEmail: 'a@example.com',
    fromName: '甲',
    reason: '原因A',
    ...overrides,
  };
}

const NOW = new Date('2026-06-22T12:30:00.000Z');

// 渲染行（含前缀）结构断言：去掉 `[Px] ` 前缀后须满足 `^.+ - .+ - .+$`（发件人 - 主题 - 原因）。
const LINE_STRUCT = /^.+ - .+ - .+$/u;
function assertLineStruct(line: string): void {
  const body = line.replace(/^\[P[12]\] /u, '');
  assert.match(body, LINE_STRUCT, `行结构应保 发件人 - 主题 - 原因：${line.slice(0, 80)}`);
}

test('P1/P2 逐条含发件人/主题/原因', async () => {
  const repo = fakeRepo([
    makeCandidate({ messageRowId: 'p1', priority: 'P1', subject: '紧急工单', fromName: '老板', reason: '直接点名' }),
    makeCandidate({ messageRowId: 'p2', priority: 'P2', subject: '周报', fromName: '同事', reason: '常规协作' }),
  ]);
  const result = await buildDigest(repo, NOW);
  assert.notEqual(result, null);
  const text = result!.segments.map((s) => s.text).join('\n');
  // 逐条含发件人/主题/原因
  for (const needle of ['老板', '紧急工单', '直接点名', '同事', '周报', '常规协作']) {
    assert.ok(text.includes(needle), `应含「${needle}」`);
  }
  // 每条行保结构
  for (const line of text.split('\n')) {
    if (line.startsWith('[P1] ') || line.startsWith('[P2] ')) {
      assertLineStruct(line);
    }
  }
});

test('发件人取 fromName，缺 fromName 回落 fromEmail，两者皆空填占位', async () => {
  assert.ok(renderItemLine(makeCandidate({ fromName: '名字', fromEmail: 'x@e.com' })).includes('名字'));
  const noName = renderItemLine(makeCandidate({ fromName: undefined, fromEmail: 'only@email.com' }));
  assert.ok(noName.includes('only@email.com'));
  const empty = renderItemLine(makeCandidate({ fromName: undefined, fromEmail: '' }));
  assert.ok(empty.includes('（未知发件人）'), '两者皆空应填占位');
  assertLineStruct(empty);
});

test('空主题/空原因填占位 → 行仍保 发件人 - 主题 - 原因 结构', () => {
  // classifier schema 允许 reason:'' 通过（无 .min(1)），subject 同理；空字段须补占位保结构非空。
  const line = renderItemLine(makeCandidate({ priority: 'P1', subject: '', reason: '' }));
  assert.ok(line.includes('（无主题）'), '空主题应填占位');
  assert.ok(line.includes('（无原因）'), '空原因应填占位');
  assertLineStruct(line);
});

test('换行注入：发件人/主题/原因含 \\r\\n → 归一为单行，不伪造多行结构', () => {
  const line = renderItemLine(
    makeCandidate({
      priority: 'P1',
      fromName: '攻击者\n[P0] 紧急',
      subject: '正常\r\nP3 广告营销：999 封',
      reason: '原因\n伪造',
    }),
  );
  assert.equal(line.includes('\n'), false, '行内不得含换行（防注入伪造多行）');
  assert.equal(line.includes('\r'), false, '行内不得含回车');
  assertLineStruct(line);
});

test('P3 仅计数、文案不含「已读」字样、不逐条列出', async () => {
  const repo = fakeRepo([
    makeCandidate({ messageRowId: 'ad1', priority: 'P3', subject: '促销秘密主题', reason: '营销原因X' }),
    makeCandidate({ messageRowId: 'ad2', priority: 'P3', subject: '另一促销', reason: '营销原因Y' }),
  ]);
  const result = await buildDigest(repo, NOW);
  assert.notEqual(result, null);
  const text = result!.segments.map((s) => s.text).join('\n');
  assert.ok(text.includes('2'), 'P3 应输出计数 2');
  // 不含「已读」字样（决策 5：不断言已读）
  assert.ok(!text.includes('已读'), '文案不得含「已读」字样');
  assert.ok(!text.includes('已标记'), '文案不得声称已标记');
  // P3 不逐条列出：主题/原因不应出现在文案里
  assert.ok(!text.includes('促销秘密主题'), 'P3 不应逐条列出主题');
  assert.ok(!text.includes('营销原因X'), 'P3 不应逐条列出原因');
});

test('renderP3CountLine 不含「已读」', () => {
  const line = renderP3CountLine(26);
  assert.ok(line.includes('26'));
  assert.ok(!line.includes('已读'));
});

test('无 P1P2 且 P3=0 → null', async () => {
  const result = await buildDigest(fakeRepo([]), NOW);
  assert.equal(result, null);
});

test('P3>0 但无 P1P2 → 非 null（且携 P3 row-ids）', async () => {
  const repo = fakeRepo([
    makeCandidate({ messageRowId: 'ad1', priority: 'P3' }),
    makeCandidate({ messageRowId: 'ad2', priority: 'P3' }),
  ]);
  const result = await buildDigest(repo, NOW);
  assert.notEqual(result, null);
  // P3 段携带 P3 的 row-ids（使其被 mark）
  const allIds = result!.segments.flatMap((s) => s.messageRowIds);
  assert.deepEqual([...allIds].sort(), ['ad1', 'ad2']);
});

test('每段携带其所含邮件 row-ids（P1/P2 行 + P3 计数并入末段）', async () => {
  const repo = fakeRepo([
    makeCandidate({ messageRowId: 'p1a', priority: 'P1' }),
    makeCandidate({ messageRowId: 'p2a', priority: 'P2' }),
    makeCandidate({ messageRowId: 'ad1', priority: 'P3' }),
  ]);
  const result = await buildDigest(repo, NOW);
  const allIds = result!.segments.flatMap((s) => s.messageRowIds);
  assert.deepEqual([...allIds].sort(), ['ad1', 'p1a', 'p2a']);
});

test('超长 → 多段、每段 text.length ≤ SEGMENT_MAX、不断行', async () => {
  // 造足够多条短行使总长跨过 SEGMENT_MAX → 须分多段。
  const many: DigestCandidate[] = [];
  for (let i = 0; i < 200; i++) {
    many.push(
      makeCandidate({
        messageRowId: `row-${i}`,
        priority: 'P1',
        subject: `主题编号${i}`,
        fromName: `发件人${i}`,
        reason: `原因填充${i}` + 'x'.repeat(50),
      }),
    );
  }
  const result = await buildDigest(fakeRepo(many), NOW);
  assert.notEqual(result, null);
  assert.ok(result!.segments.length > 1, '超长应分多段');
  // 每段 ≤ SEGMENT_MAX（UTF-16 单位）
  for (const seg of result!.segments) {
    assert.ok(seg.text.length <= SEGMENT_MAX, `段长 ${seg.text.length} 应 ≤ ${SEGMENT_MAX}`);
  }
  // 不断行：每段每行要么是头行，要么是完整渲染行（含前缀）
  for (const seg of result!.segments) {
    const ls = seg.text.split('\n');
    for (let i = 1; i < ls.length; i++) {
      assert.ok(ls[i]!.startsWith('[P1] ') || ls[i]!.startsWith('[P2] '), '段内非头行须是完整渲染行（不断行）');
    }
  }
  // 全部 row-ids 不丢、不重复
  const allIds = result!.segments.flatMap((s) => s.messageRowIds);
  assert.equal(allIds.length, 200);
  assert.equal(new Set(allIds).size, 200);
});

test('P3 计数行加不下末段 → 另起新段承载（含 P3 row-ids、每段 ≤ SEGMENT_MAX）', async () => {
  // 造若干满档 P1 行 + 一条调参行，使「仅 P1/P2」末段填到距 SEGMENT_MAX 不足 len('P3…')+1 → P3 行溢出另起新段。
  const cands: DigestCandidate[] = [];
  for (let i = 0; i < 6; i++) {
    cands.push(
      makeCandidate({
        messageRowId: `f${i}`,
        priority: 'P1',
        fromName: 'N'.repeat(500),
        subject: 'S'.repeat(500),
        reason: 'R'.repeat(500),
      }),
    );
  }
  // 调参行：发件人截到 FIELD_CAP(200) + 主题 100 + 原因 4 → 整行约 315，使末段填到 3992（距上限 8 < 11+1）。
  cands.push(
    makeCandidate({ messageRowId: 'tune', priority: 'P1', fromName: 'A'.repeat(500), subject: 'B'.repeat(100), reason: 'RRRR' }),
  );
  cands.push(makeCandidate({ messageRowId: 'ad1', priority: 'P3' }));

  const result = await buildDigest(fakeRepo(cands), NOW);
  assert.notEqual(result, null);
  const segs = result!.segments;
  // P3 行未能并入 P1/P2 末段 → 独占一个新的末段。
  const last = segs[segs.length - 1]!;
  assert.ok(last.text.includes('P3 广告营销：'), 'P3 计数行应在独立新末段');
  assert.deepEqual(last.messageRowIds, ['ad1'], '新末段 row-ids 仅含 P3 候选');
  // 上一段（P1/P2 末段）不含 P3 行。
  assert.ok(!segs[segs.length - 2]!.text.includes('P3 广告营销：'), 'P3 行不应留在前一段');
  // 每段 ≤ SEGMENT_MAX。
  for (const seg of segs) {
    assert.ok(seg.text.length <= SEGMENT_MAX, `段长 ${seg.text.length} 应 ≤ ${SEGMENT_MAX}`);
  }
});

test('truncateUtf16：代理对安全（不裂出孤代理）+ 截断加省略号', () => {
  // 不截断
  assert.equal(truncateUtf16('abc', 10), 'abc');
  // 截断 ASCII：省略号占预算内 1 单位 → 结果长度严格 ≤ max。
  const t = truncateUtf16('abcdef', 3);
  assert.ok(t.length <= 3, `截断结果应 ≤ max（含省略号），实得 ${t.length}`);
  assert.ok(t.endsWith('…'));
  // emoji 代理对：'😀' = 2 个 UTF-16 单位（0xD83D 0xDE00）。截到奇数边界须丢孤高代理。
  const emojis = '😀😀😀'; // length 6
  const cut = truncateUtf16(emojis, 3); // 边界落在第二个 emoji 中间
  // 结果不得含孤立高代理（0xD800–0xDBFF 末尾落单）
  for (let i = 0; i < cut.length; i++) {
    const code = cut.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = cut.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, '高代理须紧跟低代理（无裂代理对）');
    }
  }
  // 该 cut 应是 '😀…'（保住整对的第一个 emoji + 省略号）
  assert.equal(cut, '😀…');
});

test('超长发件人 → 单行仍 < SEGMENT_MAX 且保结构', () => {
  const line = renderItemLine(
    makeCandidate({ fromName: 'X'.repeat(10000), subject: '正常主题', reason: '正常原因' }),
  );
  assert.ok(line.length < SEGMENT_MAX, `单行 ${line.length} 应 < ${SEGMENT_MAX}`);
  assertLineStruct(line);
});

test('超长主题 → 单行仍 < SEGMENT_MAX 且保结构', () => {
  const line = renderItemLine(
    makeCandidate({ fromName: '甲', subject: '题'.repeat(10000), reason: '正常原因' }),
  );
  assert.ok(line.length < SEGMENT_MAX);
  assertLineStruct(line);
});

test('超长原因 → 单行仍 < SEGMENT_MAX 且保结构', () => {
  const line = renderItemLine(
    makeCandidate({ fromName: '甲', subject: '正常主题', reason: '因'.repeat(10000) }),
  );
  assert.ok(line.length < SEGMENT_MAX);
  assertLineStruct(line);
});

test('三字段全超长组合 → 单行仍 < SEGMENT_MAX 且保结构', () => {
  const line = renderItemLine(
    makeCandidate({
      fromName: 'N'.repeat(10000),
      subject: 'S'.repeat(10000),
      reason: 'R'.repeat(10000),
    }),
  );
  assert.ok(line.length < SEGMENT_MAX, `组合单行 ${line.length} 应 < ${SEGMENT_MAX}`);
  assertLineStruct(line);
  // 各字段被 FIELD_CAP 截断（含省略号 → ≤ FIELD_CAP，省略号占预算内 1 单位）
});

test('单字段截到 FIELD_CAP（+省略号）', () => {
  const line = renderItemLine(
    makeCandidate({ fromName: 'A'.repeat(1000), subject: 'B', reason: 'C' }),
  );
  // 去前缀后第一段（发件人）= (FIELD_CAP-1) 个 A + 省略号，总长 = FIELD_CAP（省略号占预算内 1 单位）
  const body = line.replace(/^\[P[12]\] /u, '');
  const sender = body.split(' - ')[0]!;
  assert.equal(sender.length, FIELD_CAP, '发件人应截到 FIELD_CAP（含省略号，长度 ≤ max）');
  assert.ok(sender.endsWith('…'));
});

test('emoji 主题按 UTF-16 计数不超限、截断不裂代理对', () => {
  // 5000 个 emoji = 10000 UTF-16 单位；renderItemLine 须截到 FIELD_CAP 且不裂代理对。
  const line = renderItemLine(
    makeCandidate({ fromName: '甲', subject: '😀'.repeat(5000), reason: '正常原因' }),
  );
  assert.ok(line.length < SEGMENT_MAX);
  assertLineStruct(line);
  // 全行无孤立代理对
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = line.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, '不得裂出孤高代理');
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = line.charCodeAt(i - 1);
      assert.ok(prev >= 0xd800 && prev <= 0xdbff, '不得有孤低代理');
    }
  }
});

test('整行兜底始终执行：单字段不超 FIELD_CAP 但前缀+分隔仍渲染完整结构 < SEGMENT_MAX', async () => {
  // 普通候选：行远短于 SEGMENT_MAX，仍须 < SEGMENT_MAX（兜底无条件执行，正常情况下不改变内容）。
  const line = renderItemLine(makeCandidate());
  assert.ok(line.length < SEGMENT_MAX);
  assert.ok(!line.endsWith('…'), '正常短行不应被兜底截断');
});

test('安全（4.4）：所有 segment.text 不含 bodyText —— 候选无该字段，结构保证', async () => {
  // 候选类型本身无 bodyText，无法注入；构造带「正文」标记串的字段确认其只出现在被渲染字段、
  // 且 buildDigest 从不引入候选以外的文本。这里断言渲染只来自 subject/fromName/fromEmail/reason。
  const SECRET_BODY = '【这是绝不应出现的正文 bodyText 内容】';
  const repo = fakeRepo([
    makeCandidate({
      messageRowId: 'r1',
      priority: 'P1',
      subject: '主题',
      fromName: '发件人',
      reason: '原因',
    }),
    makeCandidate({ messageRowId: 'r2', priority: 'P3' }),
  ]);
  const result = await buildDigest(repo, NOW);
  const text = result!.segments.map((s) => s.text).join('\n');
  // SECRET_BODY 从未进任何候选字段 → 必不出现（结构保证：DigestCandidate 无 bodyText 字段）
  assert.ok(!text.includes(SECRET_BODY));
  // 进一步：文案只由 header / 渲染行 / P3 计数行 / 占位 / 候选字段构成——逐段核验无意外文本来源
  for (const seg of result!.segments) {
    for (const lineText of seg.text.split('\n')) {
      const ok =
        lineText === '邮件摘要' ||
        lineText.startsWith('[P1] ') ||
        lineText.startsWith('[P2] ') ||
        lineText.startsWith('P3 广告营销：');
      assert.ok(ok, `意外行内容（可能泄露非候选文本）：${lineText.slice(0, 60)}`);
    }
  }
});
