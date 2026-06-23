#!/usr/bin/env node
// 统一 inbox-pilot 二进制 + 薄分发器（spec inbox-pilot-cli「统一二进制 + 分发器」、
// design「统一二进制 + 分发器」、tasks 1.4/1.5）。
//
// **顶层 dotenv bootstrap（1.4）**：第一行（在任何路由 / 任何 safeParse 之前）做纯副作用的
// `import 'dotenv/config'`——把 `.env` 文件供给的 env 装进 process.env，使 doctor 与 account
// **两路径**都看见 `.env`-文件供给的 DATABASE_URL（doctor 有意避开有副作用的 config.ts，故若
// 分发器不在顶层加载 .env，doctor 会误报 DATABASE_URL 缺失 / 退出 1）。该 import 幂等、不
// loadConfig、不 process.exit，故对 doctor 纯路径安全、且不重新引入急切 loadConfig 崩溃。
import 'dotenv/config';

// **顶层不静态 import account.ts / config.ts（1.4）**：两者都会（直接或传递地）求值
// `config.ts` 的 `export const config = loadConfig()`——它在 import 时即对非法配置
// `process.exit(1)`，会令 `inbox-pilot doctor` 在路由前崩溃。故按子命令惰性 `await import(...)`：
//   - doctor → `await import('./doctor.js')`（纯路径，只触达无副作用 schema 模块、绝不求值 loadConfig）；
//   - account → `await import('./account.js')`（账号命令本就需要 config，惰性加载它无妨）。

/** CLI 退出码（镜像 account.ts：0 成功 / 1 失败 / 2 用法）。 */
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'inbox-pilot <command>',
  '',
  'Commands:',
  '  account <add|list|disable> [...]   账号接入（详见 inbox-pilot account）',
  '  doctor [--json]                    只读预检（就绪健康检查）',
].join('\n');

/**
 * 分发器测试注入点。
 *   - `doctorDeps` 透传给 runDoctor 以离线断言（不连真 DB）。
 *   - `runAccountCliMain` / `runDoctor`（可选）覆盖动态 import 目标，使路由 / setup-throw 断言离线、
 *     纯净、不触发真 config.ts 模块求值或真 DB。生产路径**不传**这些覆盖，走默认动态 import。
 */
export type DispatchDeps = {
  doctorDeps?: import('./doctor.js').DoctorDeps;
  runAccountCliMain?: (argv: string[]) => Promise<number>;
  runDoctor?: (
    opts: { json: boolean },
    doctorDeps?: import('./doctor.js').DoctorDeps,
  ) => Promise<number>;
};

/** 默认 stderr 行输出（人类 / 日志行走 stderr，使 stdout 保持可解析）。 */
function errln(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * 可测分发器（1.4/1.5）：路由子命令并**返回**退出码——**绝不**内部 process.exit
 * （仅在本模块自身的 import.meta.url 主模块守卫下退出，使退出码不被重复触发；被 import 时不自跑）。
 *
 * 顶层脱敏 + 退出码透传 + setup 期抛错（1.5）：把**全部**分发（account + doctor，含 setup 期抛错——
 * 如动态 import 失败、或 account 路径里 `new PrismaMailRepo()` 抛出可内嵌连接串的 Prisma 错误）包进
 * 与 account.ts 顶层 catch 一致的固定文案脱敏 catch；任何被捕获的抛错 → 固定文案 + 固定 EXIT_FAILURE，
 * **绝不**把原始 error / 连接串打到 stderr。唯有 `account` 分支由 `runAccountCliMain` **返回**的退出码
 * 被**原样透传**（该路径已把自身抛错吞成退出码，不二次包裹）。
 *
 * 注（有意、非缺口）：若 `account` 的动态 import 触发 `config.ts` 导入期 fail-fast
 * （`export const config = loadConfig()` 在模块求值期对非法配置 `process.exit`），该退出**不可**被本
 * try/catch 捕获（模块求值期的进程退出不可捕获）——这是有意行为且 leak-safe（config.ts 只打印 path+message）。
 */
export async function runDispatch(argv: string[], deps?: DispatchDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'account': {
        // account 分支：经共用的公开生产入口（内部构造生产 deps），**原样透传**其返回的退出码、不二次包裹。
        const runAccountCliMain =
          deps?.runAccountCliMain ?? (await import('./account.js')).runAccountCliMain;
        return await runAccountCliMain(rest);
      }
      case 'doctor': {
        // doctor 分支：纯路径，只触达无副作用 schema 模块、绝不求值 loadConfig。解析 --json。
        const json = rest.includes('--json');
        const runDoctor = deps?.runDoctor ?? (await import('./doctor.js')).runDoctor;
        return await runDoctor({ json }, deps?.doctorDeps);
      }
      default:
        // 裸 inbox-pilot（argv 空）、裸 inbox-pilot account（→ account 分支自身的 command-undefined
        // USAGE/EXIT_USAGE，不在此特判）、未知子命令：打印 USAGE 到 stderr、退出 2。
        errln(USAGE);
        return EXIT_USAGE;
    }
  } catch {
    // 顶层脱敏边界（镜像 account.ts）：setup 期抛错（动态 import 失败 / Prisma 构造抛出可内嵌连接串的
    // 错误等）一律映射固定文案 + 固定 EXIT_FAILURE——**绝不**把原始 error 打到 stderr。
    errln('命令执行失败（已脱敏；详见服务日志）。');
    return EXIT_FAILURE;
  }
}

// 真身入口：`node dist/cli/inbox-pilot.js <args>`。import.meta 主模块判定（ESM）：仅当本文件被直接
// 运行时跑分发器（被 import 时不自跑，使测试纯净、且不双重 process.exit）。退出**仅**在此守卫下发生。
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  runDispatch(process.argv.slice(2)).then((code) => process.exit(code));
}

// 静态分析友好：导出退出码常量供测试引用（不参与运行期路由）。
export { EXIT_OK, EXIT_FAILURE, EXIT_USAGE };
