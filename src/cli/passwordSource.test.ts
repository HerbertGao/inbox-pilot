// passwordSource 单测（node:test）——兑现 inbox-pilot-cli §6.2–§6.5。
//
// 覆盖：
//   §6.2 互斥：stdin + file 同给 → ok:false。
//   §6.5 TTY 守卫：--password-stdin + isTTY=true → ok:false（不阻塞）。
//   §6.4 stdin 读：注入 read 返回 "  p@ss \n" → 仅剥单尾换行、保留首尾空格。
//   §6.3 文件权限：0600 → ok:true 取内容；0644 → ok:false（指明路径）。
//   §6.4 文件 trim："secret\n" → "secret"。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { resolveImapPassword, type PasswordSourceDeps } from './passwordSource.js';

// —— 临时口令文件管理 ——
let tmpDir: string;
let counter = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'password-source-'));
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 忽略清理错误。
  }
});

function writePwFile(content: string, mode: number): string {
  const path = join(tmpDir, `pw-${counter++}.txt`);
  writeFileSync(path, content, 'utf8');
  chmodSync(path, mode);
  return path;
}

// 默认 deps：promptHidden / stdin 不应被这些用例触达时给出可断言的失败值。
function makeDeps(overrides: Partial<PasswordSourceDeps> = {}): PasswordSourceDeps {
  return {
    promptHidden: async () => {
      throw new Error('promptHidden 不应被调用');
    },
    stdin: {
      isTTY: false,
      read: async () => {
        throw new Error('stdin.read 不应被调用');
      },
    },
    ...overrides,
  };
}

// ====================================================================
// §6.2 — 互斥
// ====================================================================

test('互斥：stdin + file 同给 → ok:false', async () => {
  const result = await resolveImapPassword(
    { passwordStdin: true, passwordFile: '/some/path' },
    makeDeps(),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.message.includes('互斥'));
});

// ====================================================================
// §6.5 — TTY 守卫
// ====================================================================

test('TTY 守卫：--password-stdin + isTTY=true → ok:false（不阻塞）', async () => {
  const result = await resolveImapPassword(
    { passwordStdin: true, passwordFile: undefined },
    makeDeps({ stdin: { isTTY: true, read: async () => 'should-not-read' } }),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.message.includes('TTY'));
});

// ====================================================================
// §6.4 — stdin 读：剥单尾换行、保留首尾空格
// ====================================================================

test('stdin 读：" p@ss \\n" → 仅剥单尾换行、首尾空格逐字保留', async () => {
  const result = await resolveImapPassword(
    { passwordStdin: true, passwordFile: undefined },
    makeDeps({ stdin: { isTTY: false, read: async () => '  p@ss \n' } }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.password, '  p@ss ');
});

// ====================================================================
// §6.3 — 文件权限
// ====================================================================

test('文件权限：0600 文件 → ok:true 取内容', async () => {
  const path = writePwFile('topsecret', 0o600);
  const result = await resolveImapPassword(
    { passwordStdin: false, passwordFile: path },
    makeDeps(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.password, 'topsecret');
});

test('文件权限：0644 文件（group/other 可读）→ ok:false，message 指明路径', async () => {
  const path = writePwFile('topsecret', 0o644);
  const result = await resolveImapPassword(
    { passwordStdin: false, passwordFile: path },
    makeDeps(),
  );
  assert.equal(result.ok, false);
  // 经 JSON.stringify 转义的路径出现在消息里。
  assert.ok(!result.ok && result.message.includes(JSON.stringify(path)));
});

// ====================================================================
// §6.4 — 文件 trim
// ====================================================================

test('文件 trim：0600 文件内容 "secret\\n" → password === "secret"', async () => {
  const path = writePwFile('secret\n', 0o600);
  const result = await resolveImapPassword(
    { passwordStdin: false, passwordFile: path },
    makeDeps(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.password, 'secret');
});

// ====================================================================
// F3/F6 — --password-file 失败一律 { ok:false }（非常规文件 / 打开失败），路径经 JSON.stringify 转义
// ====================================================================

test('F3：--password-file 指向目录（非常规文件）→ ok:false，message 指明路径（不阻塞）', async () => {
  // tmpDir 本身是目录：open('r') 在多数平台可成功，stat().isFile() 为 false → 拒绝。
  const result = await resolveImapPassword(
    { passwordStdin: false, passwordFile: tmpDir },
    makeDeps(),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.message.includes(JSON.stringify(tmpDir)));
});

test('F6：--password-file 指向不存在的文件 → ok:false（映射 EXIT_USAGE，非未映射 throw），路径转义', async () => {
  const missing = join(tmpDir, 'does-not-exist.txt');
  const result = await resolveImapPassword(
    { passwordStdin: false, passwordFile: missing },
    makeDeps(),
  );
  assert.equal(result.ok, false);
  // 固定文案 + 转义路径，绝不外逃成 throw。
  assert.ok(!result.ok && result.message.includes(JSON.stringify(missing)));
});

// ====================================================================
// F-B — --password-file 指向 0600 FIFO（无写者）→ ok:false 且**不阻塞**（非阻塞 open + isFile 拒绝）
// ====================================================================

/** mkfifo 是否可用（Linux/macOS 有；某些受限 env 无 → 优雅跳过）。 */
function mkfifoAvailable(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 测试级超时：回归（阻塞 open）会让本用例超时失败、而非吊死整个套件。
test(
  'F-B：--password-file 指向 0600 FIFO（无写者）→ ok:false 且不阻塞（非阻塞 open + 非常规文件拒绝）',
  { timeout: 5000 },
  async () => {
    if (!mkfifoAvailable()) {
      // 受限环境无 mkfifo：优雅跳过并记录。
      console.log('F-B：mkfifo 不可用，跳过 FIFO 回归用例。');
      return;
    }
    const fifoPath = join(tmpDir, 'pw-fifo');
    execFileSync('mkfifo', [fifoPath]);
    chmodSync(fifoPath, 0o600);
    // 故意不打开任何写者：阻塞式只读 open 会永久等待——非阻塞 open 须立即返回、由 isFile() 拒绝。
    const result = await resolveImapPassword(
      { passwordStdin: false, passwordFile: fifoPath },
      makeDeps(),
    );
    assert.equal(result.ok, false, 'FIFO（非常规文件）→ ok:false');
    assert.ok(
      !result.ok && result.message.includes(JSON.stringify(fifoPath)),
      'message 含转义路径（非常规文件拒绝）',
    );
  },
);
