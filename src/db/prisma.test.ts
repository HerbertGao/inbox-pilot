// prisma.withStatementTimeout self-check（M1a）：给连接串附 DB 侧 statement_timeout 的 URL 拼接分支
// （无查询串 / 有查询串 / 幂等）——空格/等号须 percent-encode（避免 URLSearchParams 的 `+` 陷阱）。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withStatementTimeout } from './prisma.js';

test('withStatementTimeout：无查询串 → ?options=-c statement_timeout（percent-encoded 30s）', () => {
  const out = withStatementTimeout('postgresql://u:p@h:5432/db');
  assert.match(out, /\?options=-c%20statement_timeout%3D30000$/);
});

test('withStatementTimeout：有查询串 → & 合并、保留既有参数', () => {
  const out = withStatementTimeout('postgresql://u:p@h:5432/db?schema=public');
  assert.ok(out.includes('schema=public'), '保留既有 schema 参数');
  assert.match(out, /&options=-c%20statement_timeout%3D30000$/);
});

test('withStatementTimeout：已含 statement_timeout → 幂等、不重复附加', () => {
  const url = 'postgresql://u:p@h:5432/db?options=-c%20statement_timeout%3D5000';
  assert.equal(withStatementTimeout(url), url);
});
