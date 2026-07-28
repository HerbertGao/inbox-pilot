// doctor 只读部署预检离线单测（node:test）。注入 DB/openssl 探测桩 + 捕获 stdout；
// 全离线、不连真 DB、不 spawn openssl。关键覆盖：
//   - 非法 DATABASE_URL → runDoctor 返回 1、不崩、报告标该项失败、输出不含 DATABASE_URL 值任何子串；
//   - 指向 openai.com 的 OPENROUTER_BASE_URL → runDoctor 返回 1（关键 schema 失败），而非 0。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runDoctor, type DoctorDeps, type DoctorReport } from './doctor.js';

/** 捕获 stdout 的 println，并提供合法的离线探测桩（DB ok / openssl present）。 */
function makeDeps(overrides: Partial<DoctorDeps> = {}): { deps: DoctorDeps; out: string[] } {
  const out: string[] = [];
  const deps: DoctorDeps = {
    println: (l) => out.push(l),
    checkDb: async () => 'ok',
    checkOpenssl: async () => true,
    ...overrides,
  };
  return { deps, out };
}

/**
 * 在隔离的 env 快照下运行回调：保存被修改的键、跑回调、恢复。doctor 读 process.env，
 * 故各用例须自管 env，避免污染同套件其它测试（config.test.ts 等读真实 env）。
 */
async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = Object.keys(patch);
  const saved = new Map<string, string | undefined>();
  for (const k of keys) saved.set(k, process.env[k]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const k of keys) {
      const prev = saved.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

// ——————————————————————————————————————————————————————————
// 3.4 非法 DATABASE_URL → 返回 1、不崩、标失败、不泄露该值任何子串
// ——————————————————————————————————————————————————————————

test('doctor：非法 DATABASE_URL → 返回 1、报告标 config 失败、不崩、输出不含该值任何子串', async () => {
  // 含可识别口令子串的非法 DATABASE_URL（scheme 非 postgres → refine 失败 → 关键）。
  const BAD_DB_URL = 'mysql://user:LEAKED_SECRET_PW@db.invalid:3306/x';
  const DISTINCTIVE = 'LEAKED_SECRET_PW';

  await withEnv({ DATABASE_URL: BAD_DB_URL }, async () => {
    const { deps, out } = makeDeps();
    // 注入 DB 桩：即便 schema 失败也不应触达真 DB；此处断言桩不被调用更稳妥。
    let dbCalled = false;
    deps.checkDb = async () => {
      dbCalled = true;
      return 'ok';
    };

    const code = await runDoctor({ json: true }, deps);
    assert.equal(code, 1, '非法 DATABASE_URL → 关键失败 → 退出 1');

    const text = out.join('\n');
    const report = JSON.parse(text) as DoctorReport;
    assert.equal(report.ok, false, 'report.ok=false（关键失败）');
    const configCheck = report.checks.find((c) => c.name === 'config');
    assert.ok(configCheck !== undefined, '有 config 检查项');
    assert.equal(configCheck!.ok, false, 'config 检查标失败');

    // 脱敏：输出（json + detail）绝不含非法 DATABASE_URL 值的任何可识别子串。
    assert.ok(!text.includes(DISTINCTIVE), 'json 输出不含 DATABASE_URL 口令子串');
    assert.ok(!text.includes(BAD_DB_URL), 'json 输出不含完整非法 DATABASE_URL');
    assert.ok(!JSON.stringify(report).includes(DISTINCTIVE), '报告对象不含口令子串');

    // DB 桩仍可能被调用（schema 失败不短路 DB 检查），但绝不是真 DB——离线断言无崩溃即可。
    void dbCalled;
  });
});

test('doctor：非法 DATABASE_URL 下默认人类表格输出同样不泄露该值、返回 1', async () => {
  const BAD_DB_URL = 'mysql://user:TABLE_LEAK_PW@db.invalid/x';
  await withEnv({ DATABASE_URL: BAD_DB_URL }, async () => {
    const { deps, out } = makeDeps();
    const code = await runDoctor({ json: false }, deps);
    assert.equal(code, 1);
    const text = out.join('\n');
    assert.ok(!text.includes('TABLE_LEAK_PW'), '人类表格不含口令子串');
    assert.ok(text.includes('config'), '表格含 config 行');
    assert.ok(text.includes('false'), '表格标失败');
  });
});

// ——————————————————————————————————————————————————————————
// 3.5 指向 openai.com 的 OPENROUTER_BASE_URL → 返回 1（关键 schema 失败），而非 0
// ——————————————————————————————————————————————————————————

test('doctor：OPENROUTER_BASE_URL 指向 openai.com → 返回 1（关键 schema 失败），而非 0', async () => {
  // 合法 DATABASE_URL（隔离单变量），但 OPENROUTER_BASE_URL 触发 openai.com refine。
  await withEnv(
    {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      OPENROUTER_BASE_URL: 'https://api.openai.com/v1',
    },
    async () => {
      const { deps, out } = makeDeps();
      const code = await runDoctor({ json: true }, deps);
      assert.equal(code, 1, 'openai.com refine 失败 → 关键 → 退出 1（非 0）');
      const report = JSON.parse(out.join('\n')) as DoctorReport;
      assert.equal(report.ok, false);
      const configCheck = report.checks.find((c) => c.name === 'config');
      assert.equal(configCheck!.ok, false, 'config 检查因 refine 失败标失败');
    },
  );
});

test('doctor：config/DB 均 ok 时退出 0；可选凭据缺失（openrouter/openssl）不影响退出码', async () => {
  await withEnv(
    {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      OPENROUTER_API_KEY: undefined,
      OPENROUTER_BASE_URL: undefined,
    },
    async () => {
      const { deps, out } = makeDeps({
        checkOpenssl: async () => false, // openssl 缺失 → 仅告警。
      });
      const code = await runDoctor({ json: true }, deps);
      assert.equal(code, 0, '可选凭据/openssl 缺失不影响退出码');
      const report = JSON.parse(out.join('\n')) as DoctorReport;
      assert.equal(report.ok, true);
      const key = report.checks.find((c) => c.name === 'openrouter_api_key');
      assert.equal(key!.detail, 'missing', 'OPENROUTER_API_KEY 缺失报 missing');
      const ssl = report.checks.find((c) => c.name === 'openssl');
      assert.equal(ssl!.detail, 'missing', 'openssl 缺失报 missing');
    },
  );
});

// ——————————————————————————————————————————————————————————
// 成功路径的整体输出脱敏：凭据存在时 detail 只回标签、原始值绝不出现在任何字段
// （幸存的两条整体断言都跑在 config 校验失败路径上；这条补的是 parsed.success === true 那一支）
// ——————————————————————————————————————————————————————————

test('doctor：凭据存在时 detail 只回标签，成功路径整体输出不含凭据值', async () => {
  const OR_SECRET = 'sk-or-LEAKSENTINEL-openrouter';
  const G_SECRET = 'GOCSPX-LEAKSENTINEL-gmail';
  await withEnv(
    {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      OPENROUTER_API_KEY: OR_SECRET,
      GMAIL_CLIENT_ID: 'cid.apps.googleusercontent.com',
      GMAIL_CLIENT_SECRET: G_SECRET,
      GMAIL_REDIRECT_URI: 'http://127.0.0.1/oauth2/callback',
    },
    async () => {
      const { deps, out } = makeDeps();
      const code = await runDoctor({ json: true }, deps);
      assert.equal(code, 0, 'config/DB 均 ok → 退出 0');

      const text = out.join('\n');
      const report = JSON.parse(text) as DoctorReport;
      assert.equal(
        report.checks.find((c) => c.name === 'openrouter_api_key')!.detail,
        'set',
        '凭据存在 → 只回 set 标签',
      );
      assert.equal(
        report.checks.find((c) => c.name === 'gmail_onboarding')!.detail,
        'available',
        'Gmail 三件齐全且 redirect_uri 合法 → available',
      );
      assert.ok(!text.includes(OR_SECRET), '整体输出不含 OPENROUTER_API_KEY 值');
      assert.ok(!text.includes(G_SECRET), '整体输出不含 GMAIL_CLIENT_SECRET 值');
    },
  );
});

test('doctor：DB 不可达 → 关键失败 → 退出 1、detail 为固定标签 unreachable', async () => {
  await withEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' }, async () => {
    const { deps, out } = makeDeps({ checkDb: async () => 'unreachable' });
    const code = await runDoctor({ json: true }, deps);
    assert.equal(code, 1, 'DB 不可达 → 关键 → 退出 1');
    const report = JSON.parse(out.join('\n')) as DoctorReport;
    const db = report.checks.find((c) => c.name === 'database');
    assert.equal(db!.ok, false);
    assert.equal(db!.detail, 'unreachable', 'DB 失败报固定标签 unreachable');
  });
});

// ——————————————————————————————————————————————————————————
// F4：config 校验失败时不探测 DB（避免对非法 DATABASE_URL 构造 PrismaClient 而崩）；DB 记 skipped、不改退出码
// ——————————————————————————————————————————————————————————

test('F4：非法 DATABASE_URL → 不调用 checkDb、database detail=skipped、退出仍为 1', async () => {
  await withEnv({ DATABASE_URL: 'mysql://u:p@db.invalid/x' }, async () => {
    const { deps, out } = makeDeps();
    let dbCalled = false;
    deps.checkDb = async () => {
      dbCalled = true;
      return 'ok';
    };
    const code = await runDoctor({ json: true }, deps);
    assert.equal(code, 1, 'config 关键失败 → 退出 1（不变）');
    assert.equal(dbCalled, false, 'config 失败时绝不探测 DB（避免对非法 DATABASE_URL 构造 PrismaClient 崩溃）');
    const report = JSON.parse(out.join('\n')) as DoctorReport;
    const db = report.checks.find((c) => c.name === 'database');
    assert.equal(db!.detail, 'skipped', 'DB 检查记 skipped');
    assert.equal(db!.ok, true, 'skipped 不参与关键退出码（ok=true）');
  });
});

test('F8：含控制字符的 TZ → 人类表格 detail 经 JSON.stringify 转义（不出现裸换行）', async () => {
  await withEnv(
    { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', TZ: 'Evil\nZONE' },
    async () => {
      const { deps, out } = makeDeps();
      const code = await runDoctor({ json: false }, deps);
      assert.equal(code, 0);
      // tz 行 detail 必为转义形式 "Evil\nZONE"（含字面反斜杠 n），绝不含裸换行伪造表格行。
      const tzLine = out.find((l) => l.startsWith('tz\t'));
      assert.ok(tzLine !== undefined, '有 tz 行');
      assert.ok(tzLine!.includes('\\n'), 'detail 含转义的 \\n（非裸换行）');
      assert.ok(!tzLine!.includes('Evil\nZONE'), 'detail 不含裸控制字符序列');
    },
  );
});
