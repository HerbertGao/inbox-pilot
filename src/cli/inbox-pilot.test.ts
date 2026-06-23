// inbox-pilot 分发器离线单测（1.6，node:test）。
//
// 覆盖：
//   - 路由：`account` → runAccountCliMain 收到 sliced argv；`doctor` → runDoctor 收到解析的 {json}；
//     裸 / 未知子命令 → EXIT_USAGE(2)。
//   - setup-throw（1.5）：被捕获的抛错 → EXIT_FAILURE(1) + 固定脱敏行（不含原始 error）。
//   - dotenv/DATABASE_URL 意图（1.6 核心）：DATABASE_URL 存在于 process.env（如 dotenv 从 .env 装载）时，
//     `doctor` 路由把它报告为存在 / 不因 DATABASE_URL 缺失而假失败（注入 doctorDeps 桩使无真 DB 调用）。
//
// 全离线：路由 / setup-throw 断言用 deps 覆盖（不触发真 config.ts 模块求值 / 真 DB）；1.6 走真
// runDoctor（纯路径）+ 注入 DB 桩。env 用 withEnv 快照 / 恢复，避免污染同套件其它测试。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runDispatch, EXIT_USAGE, EXIT_FAILURE } from './inbox-pilot.js';
import type { DoctorReport } from './doctor.js';

/**
 * 在隔离的 env 快照下运行回调（镜像 doctor.test.ts 的 withEnv）：保存被改键、跑回调、恢复。
 * 分发器顶层 `import 'dotenv/config'` 已在模块加载期跑过；此处只为各用例自管 DATABASE_URL 等键，
 * 避免污染同套件其它读 process.env 的测试。
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
// 路由：account → runAccountCliMain(sliced argv)
// ——————————————————————————————————————————————————————————

test('dispatch：account → runAccountCliMain 收到 sliced argv，并原样透传其退出码', async () => {
  let seen: string[] | undefined;
  const code = await runDispatch(['account', 'list', '--json'], {
    runAccountCliMain: async (argv) => {
      seen = argv;
      return 7; // 透传哨兵：分发器不得二次包裹此值。
    },
  });
  assert.deepEqual(seen, ['list', '--json']);
  assert.equal(code, 7);
});

test('dispatch：裸 account（无子命令）→ 路由到 account 分支、透传其返回码', async () => {
  let seen: string[] | undefined;
  const code = await runDispatch(['account'], {
    runAccountCliMain: async (argv) => {
      seen = argv;
      return EXIT_USAGE; // account 自身的 command-undefined USAGE/EXIT_USAGE。
    },
  });
  assert.deepEqual(seen, []); // 不特判：rest 为空数组传入。
  assert.equal(code, EXIT_USAGE);
});

// ——————————————————————————————————————————————————————————
// 路由：doctor → runDoctor 收到解析的 {json}
// ——————————————————————————————————————————————————————————

test('dispatch：doctor --json → runDoctor 收到 {json:true} + 透传 doctorDeps', async () => {
  let seenOpts: { json: boolean } | undefined;
  let seenDeps: unknown;
  const sentinelDeps = { checkDb: async () => 'ok' as const };
  const code = await runDispatch(['doctor', '--json'], {
    runDoctor: async (opts, doctorDeps) => {
      seenOpts = opts;
      seenDeps = doctorDeps;
      return 0;
    },
    doctorDeps: sentinelDeps,
  });
  assert.deepEqual(seenOpts, { json: true });
  assert.equal(seenDeps, sentinelDeps);
  assert.equal(code, 0);
});

test('dispatch：doctor（无 --json）→ runDoctor 收到 {json:false}', async () => {
  let seenOpts: { json: boolean } | undefined;
  await runDispatch(['doctor'], {
    runDoctor: async (opts) => {
      seenOpts = opts;
      return 0;
    },
  });
  assert.deepEqual(seenOpts, { json: false });
});

// ——————————————————————————————————————————————————————————
// 路由：裸 / 未知子命令 → EXIT_USAGE(2)，USAGE 走 stderr（非 stdout）
// ——————————————————————————————————————————————————————————

test('dispatch：裸 inbox-pilot（argv 空）→ EXIT_USAGE', async () => {
  const code = await runDispatch([]);
  assert.equal(code, EXIT_USAGE);
});

test('dispatch：未知子命令 → EXIT_USAGE', async () => {
  const code = await runDispatch(['nope', '--x']);
  assert.equal(code, EXIT_USAGE);
});

// ——————————————————————————————————————————————————————————
// setup-throw（1.5）：被捕获的抛错 → EXIT_FAILURE + 固定脱敏行（不含原始 error）
// ——————————————————————————————————————————————————————————

test('dispatch：account 分支 setup 期抛错 → EXIT_FAILURE，stderr 为固定脱敏行、不含原始 error', async () => {
  const SECRET = 'postgresql://user:LEAKED_PW@db.invalid/x';
  const captured: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown) = (chunk: unknown): boolean => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const code = await runDispatch(['account', 'add'], {
      // 模拟 setup 期抛错（如 new PrismaMailRepo() 抛出内嵌连接串的 Prisma 错误）。
      runAccountCliMain: async () => {
        throw new Error(`connect failed: ${SECRET}`);
      },
    });
    assert.equal(code, EXIT_FAILURE);
  } finally {
    (process.stderr.write as unknown) = origWrite;
  }
  const stderr = captured.join('');
  // 固定脱敏文案（镜像 account.ts 顶层 catch）。
  assert.match(stderr, /命令执行失败（已脱敏；详见服务日志）。/);
  // 绝不泄露原始 error / 连接串子串。
  assert.ok(!stderr.includes('LEAKED_PW'), 'stderr 不得含原始 error 的密钥子串');
  assert.ok(!stderr.includes(SECRET), 'stderr 不得含原始连接串');
});

test('dispatch：doctor 分支 setup 期抛错（动态 import 失败模拟）→ EXIT_FAILURE', async () => {
  const code = await runDispatch(['doctor'], {
    runDoctor: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(code, EXIT_FAILURE);
});

// ——————————————————————————————————————————————————————————
// 1.6 核心：dotenv/DATABASE_URL 意图——DATABASE_URL 存在（如 dotenv 从 .env 装载）时，
// doctor 路由把 config 报为 valid、不因 DATABASE_URL 缺失而假失败 / 退出 1。
// 走**真** runDoctor（纯路径），注入 doctorDeps 桩使无真 DB 调用（离线）。
// ——————————————————————————————————————————————————————————

test('dispatch：DATABASE_URL 存在于 env（dotenv 装载）时 doctor 路由报 config valid、不假失败', async () => {
  await withEnv(
    {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/inbox_pilot',
      // 其余 schema 字段有默认值；只需保证无关键失败。
      OPENROUTER_BASE_URL: undefined, // 走默认（不指向 openai.com）。
    },
    async () => {
      const out: string[] = [];
      const code = await runDispatch(['doctor', '--json'], {
        // 注入 DB 桩使无真 DB 调用（离线）；DATABASE_URL 经 schema 校验已视为存在。
        doctorDeps: {
          checkDb: async () => 'ok',
          checkOpenssl: async () => true,
          checkHostPort: async () => 'free',
          println: (l) => out.push(l),
        },
      });
      assert.equal(code, 0, 'DATABASE_URL 存在 → 关键检查全过 → 退出 0');
      const report = JSON.parse(out[0]) as DoctorReport;
      const config = report.checks.find((c) => c.name === 'config');
      assert.ok(config, '应含 config 检查项');
      assert.equal(config.ok, true, 'DATABASE_URL 存在 → config 校验应通过（非缺失假失败）');
      assert.equal(report.ok, true, '无关键失败 → 整体 ok');
    },
  );
});
