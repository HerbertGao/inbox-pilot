// doctor 只读部署预检（spec account-cli「需求:doctor 只读部署预检」）。
//
// 只读、零写入的健康预检：在不触发 loadConfig() 的前提下报告服务是否就绪。
//
// **模块隔离（3.1 规范级不变式）**：本模块**只** import 无副作用的纯 schema 模块
// `../config/configSchema.js`（configSchema / isGmailOnboardingAvailable）与 `@prisma/client`
// （仅用于 SELECT 1 可达性探测）。**绝不** import `config.ts` / `account.ts` 或任何传递求值
// `loadConfig()` 的模块——后者 `export const config = loadConfig()` 在 import 时即对非法配置
// `process.exit(1)`，会令 doctor 在出报告前崩溃。凡 runDoctor 可达的 import 都不得求值 loadConfig()。
//
// **脱敏边界（3.3）**：runDoctor 继承 account CLI 的脱敏纪律——**绝不**回显任何捕获的原始错误。
//   - safeParse 失败只取 `issue.path` + `issue.message`（镜像 config.ts 既有 fail-fast），**绝不**取
//     `issue.input`（含口令的非法 DATABASE_URL 等原始值）/ 原始 `error.issues` / `process.env`；
//     禁 `JSON.stringify(parsed.error)` 这类会带出 issue.input 的写法。
//   - DB 可达性失败报固定标签 `unreachable`，绝不打印 Prisma 错误或连接串。
//   - 凭据检查只回 `set`/`missing`/`unreachable`。

import { spawn } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

import { configSchema, isGmailOnboardingAvailable } from '../config/configSchema.js';

/** CLI 退出码（doctor 只用 0/1：关键检查失败 → 1，否则 0）。 */
export const DOCTOR_OK = 0;
export const DOCTOR_FAILURE = 1;

/** DB SELECT 1 探测超时（毫秒）。Promise.race 超时模式：只取消等待、
 *  不真正中断底层查询/连接池取用（doctor 是 liveness-only 只读探测，禁止挂起）。 */
const DB_PROBE_TIMEOUT_MS = 2500;

/** openssl 探测超时（毫秒）。 */
const OPENSSL_PROBE_TIMEOUT_MS = 1500;

/** 单条检查结果。`ok` 仅对关键检查参与退出码；detail 只承载非密钥的固定/脱敏标签。 */
export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

/** --json 输出形状：`ok` 由关键检查决定（非全部检查）。 */
export type DoctorReport = {
  checks: DoctorCheck[];
  ok: boolean;
};

/**
 * 可注入依赖（测试用；prod 用真身默认）。把 DB / openssl 两项外部探测做成可注入，
 * 使测试可离线运行（不连真 DB、不 spawn openssl）。
 */
export type DoctorDeps = {
  /** DB 可达性探测：`ok` 可达 / `unreachable` 不可达（绝不透传底层 Prisma 错误或连接串）。 */
  checkDb?: () => Promise<'ok' | 'unreachable'>;
  /** openssl 是否存在（spawn `openssl version`）。 */
  checkOpenssl?: () => Promise<boolean>;
  /** 数据行输出（默认 process.stdout.write，附换行）。表格 / JSON 走此（stdout）。 */
  println?: (line: string) => void;
};

/** 真身 DB 可达性探测：一次性 PrismaClient + SELECT 1 + 超时 race。绝不把原始 error / 连接串透传。 */
async function defaultCheckDb(): Promise<'ok' | 'unreachable'> {
  // 一次性新建 PrismaClient（doctor 不复用 db/prisma.ts 的进程级单例——避免拖入额外模块图）。
  const client = new PrismaClient();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, rejectTimeout) => {
    timer = setTimeout(
      () => rejectTimeout(new Error('db probe timeout')),
      DB_PROBE_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([client.$queryRaw`SELECT 1`, timeout]);
    return 'ok';
  } catch {
    // 脱敏：绝不回显原始 Prisma 错误（可能内嵌 DATABASE_URL / 口令）——一律映射固定标签。
    return 'unreachable';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // best-effort 断开（不阻塞退出码；失败也吞掉、绝不透传错误）。
    try {
      await client.$disconnect();
    } catch {
      // 忽略：断开失败不影响探测结论，且绝不回显原始错误。
    }
  }
}

/** 真身 openssl 探测：spawn `openssl version`，退出码 0 = 存在。任何 spawn 错误（ENOENT 等）= 不存在。 */
function defaultCheckOpenssl(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (present: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(present);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      // spawn 同步抛（极少见）→ 视为不存在。
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, OPENSSL_PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0);
    });
  });
}

function defaultPrintln(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * doctor 只读部署预检入口（可注入 DB/openssl 探测离线可测）。**返回**退出码（0/1），
 * 绝不调用 process.exit（由分发器在自身主模块守卫下退出，使退出码不被重复触发）。
 *
 * 关键 vs 告警模型（3.2）：configSchema.safeParse 任一失败 + DB 不可达为**关键**（失败 → 退出 1）；
 * 可选凭据缺失（OPENROUTER_API_KEY 缺失 / Gmail onboarding 不可用 / openssl 缺失）为**告警/提示**
 * （报告但不影响退出码）。退出码只反映关键检查。
 */
export async function runDoctor(opts: { json: boolean }, deps: DoctorDeps = {}): Promise<number> {
  const checkDb = deps.checkDb ?? defaultCheckDb;
  const checkOpenssl = deps.checkOpenssl ?? defaultCheckOpenssl;
  const println = deps.println ?? defaultPrintln;

  const checks: DoctorCheck[] = [];
  // 关键检查失败累计；退出码只由此决定。可选凭据缺失不写此处。
  let criticalFailed = false;

  // —— 关键 1：configSchema 整体校验（任一失败均为关键——非法 DATABASE_URL、指向 openai.com 的
  //    OPENROUTER_BASE_URL、任意 required/refine）。先校验再连 DB。 ——
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    criticalFailed = true;
    // 脱敏：只取 issue.path + issue.message（镜像 config.ts），绝不取 issue.input / 原始 issues 对象 /
    // process.env；绝不 JSON.stringify(parsed.error)。message 串按 schema 不变式恒为静态、不内插值。
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    checks.push({ name: 'config', ok: false, detail: summary });
  } else {
    checks.push({ name: 'config', ok: true, detail: 'valid' });
  }

  // —— 关键 2：DB 可达性（SELECT 1）。失败报固定标签 unreachable，绝不打印 Prisma 错误 / 连接串。
  //    仅当 config 校验通过时才探测 DB：config 失败时 DATABASE_URL 可能非法，构造 PrismaClient 可在
  //    构造期抛出（崩 doctor），违背「先校验、后连 DB」「doctor 在坏配置下仍出报告」。config 已关键失败、
  //    退出码已为 1，此处 DB 检查记 skipped、**不**计入 criticalFailed（不改变退出码结论）。 ——
  const dbResult = parsed.success ? await checkDb() : 'skipped';
  if (dbResult === 'ok') {
    checks.push({ name: 'database', ok: true, detail: 'reachable' });
  } else if (dbResult === 'skipped') {
    // config 失败 → 跳过 DB 探测；告警标签、不参与关键退出码（config 已令退出 1）。
    checks.push({ name: 'database', ok: true, detail: 'skipped' });
  } else {
    criticalFailed = true;
    checks.push({ name: 'database', ok: false, detail: 'unreachable' });
  }

  // —— 告警/提示：OPENROUTER_API_KEY 设置与否（缺失 → 安全默认禁用 AI，仅提示、不影响退出码）。
  //    脱敏：只回 set/missing，绝不回显密钥值任何部分（前缀/长度/掩码）。 ——
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openrouterSet = typeof openrouterKey === 'string' && openrouterKey.length > 0;
  checks.push({
    name: 'openrouter_api_key',
    ok: true, // 告警检查：ok 恒 true（不参与关键退出码）；detail 承载 set/missing。
    detail: openrouterSet ? 'set' : 'missing',
  });

  // —— 告警/提示：Gmail onboarding 可用性（经既有纯校验器 isGmailOnboardingAvailable）。
  //    仅在 config 校验通过时有 parsed.data 可传；缺失/非法 → 不可用（仅提示、不影响退出码）。 ——
  const gmailAvailable = parsed.success ? isGmailOnboardingAvailable(parsed.data) : false;
  checks.push({
    name: 'gmail_onboarding',
    ok: true, // 告警检查：不参与关键退出码。
    detail: gmailAvailable ? 'available' : 'unavailable',
  });

  // —— 提示：TZ（不在 configSchema 内，直接读 process.env.TZ；缺省时注明默认 Asia/Shanghai 回退）。 ——
  const tz = process.env.TZ;
  checks.push({
    name: 'tz',
    ok: true,
    // TZ 原始 env 值经 JSON.stringify 转义（人类表格按 detail 原样写、含控制字符的 TZ 否则可伪造表格行）。
    detail:
      typeof tz === 'string' && tz.length > 0
        ? `set (${JSON.stringify(tz)})`
        : 'unset (defaults to Asia/Shanghai)',
  });

  // —— 告警/提示：openssl 存在与否（缺失 → 仅提示、不影响退出码）。 ——
  const opensslPresent = await checkOpenssl();
  checks.push({
    name: 'openssl',
    ok: true,
    detail: opensslPresent ? 'present' : 'missing',
  });

  // ok 由关键检查决定：仅 config + database 失败才令 ok=false / 退出 1。
  const reportOk = !criticalFailed;

  if (opts.json) {
    // --json：发出可解析对象到 stdout（数据走 stdout）。ok = 关键检查结论。
    println(JSON.stringify({ checks, ok: reportOk }));
  } else {
    // 默认：人类可读表格到 stdout。
    println('check\tok\tdetail');
    for (const c of checks) {
      println(`${c.name}\t${c.ok}\t${c.detail}`);
    }
    println(`overall\t${reportOk}\t${reportOk ? 'ready' : 'not-ready (critical check failed)'}`);
  }

  return reportOk ? DOCTOR_OK : DOCTOR_FAILURE;
}
