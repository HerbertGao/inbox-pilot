// 账号 onboarding CLI（spec account-registry「需求:账号 onboarding CLI」、tasks 6.1-6.3）。
//
// 子命令（无 GUI）：
//   - account add --imap   host/port/tls/--email/可选 --account-id 经 flag；**口令经交互 prompt
//     (echo off)/stdin 读取、禁经 argv**（argv 落 shell 历史 / ps / proc args）。经 createAccount
//     写一条 `MailAccount` 行：id = --account-id‖确定性 `imap:<user>@<host>`、email 非空、凭据
//     写 authJson。**同派生 id 已存在 → 默认拒绝**（--update 显式确认才走 upsert 更新凭据）。
//   - account add --gmail  跑 loopback OAuth（offline+prompt=consent+PKCE+state、临时端口、禁 OOB）
//     → getProfile 取邮箱仅小写 → **upsert**（id=`gmail:<email>`、存 refresh token、置 enabled=true）。
//     这是 re-auth/恢复路径：prompt=consent 可能已轮换旧 token，故覆盖；并解除 reauth-suspend。
//   - account list         打印 id/provider/email/enabled——**绝不**含任何 password/token 明文。
//   - account disable <id> 置 enabled=false；提示「未重启不生效，撤销已泄露账号后应重启」。
//
// 凭据纪律（spec「凭据不入日志」/ logger.ts）：凭据**绝不回显/记录明文**；list 绝不显示凭据；
// IMAP 口令**只经交互 prompt(echo off)/stdin、禁 argv**。
//
// IO/OAuth/repo 全可注入（CliDeps）使 6.3 离线可测（不连真 DB、不跑真 OAuth）。

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

import { deriveAccountId } from '../accounts/accountService.js';
import { PrismaMailRepo, type MailRepo } from '../repo/mailRepo.js';
import {
  authorizeGmailAccount,
  type GmailAuthResult,
  type GmailOAuthAppCredentials,
} from '../providers/gmail/oauth.js';
import { config, isGmailOnboardingAvailable } from '../config/config.js';

/** CLI 退出码语义（0 成功 / 1 业务失败 / 2 参数错误）。 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/**
 * 可注入依赖（6.3 离线测试用；prod 用真身默认）。
 * 凭据从不经此处回显：promptHidden 读口令、绝不 println 它。
 */
export type CliDeps = {
  repo: MailRepo;
  /** 行输出（默认 process.stdout.write，附换行）。 */
  println: (line: string) => void;
  /** 错误行输出（默认 process.stderr.write，附换行）。 */
  errln: (line: string) => void;
  /** 关闭回显读一行机密（口令）；prod 用 readline + muted output。 */
  promptHidden: (label: string) => Promise<string>;
  /** 跑 Gmail OAuth（默认真身 authorizeGmailAccount；测试注入桩）。 */
  runOAuth: (app: GmailOAuthAppCredentials) => Promise<GmailAuthResult>;
  /** Gmail app 凭据 + onboarding 是否可用（默认从 config 读）。 */
  gmailApp: () => { available: boolean; clientId?: string; clientSecret?: string };
};

/** 解析后的 flag 集合（值型 flag + 布尔 flag）。 */
type ParsedFlags = {
  values: Map<string, string>;
  bools: Set<string>;
};

/**
 * 极简 flag 解析：支持 `--key value`（值型）、`--key=value`（等号内联值型）与 `--flag`（布尔，
 * 下一 token 以 `--` 开头或缺失时）。`--key=value` 按**首个** `=` 拆 key/value，使 `--password=x`
 * 解析出 key `password`（否则整 token 成 key、绕过机密 flag 检查）。
 * **不解析任何口令/机密 flag**——口令只经 promptHidden（见文件头硬约束）；机密 flag 由调用方在写前拒绝。
 */
function parseFlags(args: string[]): ParsedFlags {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (!tok.startsWith('--')) {
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      // `--key=value`：按首个 `=` 拆分（值可含 `=`）。key 仍参与机密 flag 检查。
      const key = body.slice(0, eq);
      const value = body.slice(eq + 1);
      values.set(key, value);
      continue;
    }
    const key = body;
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      bools.add(key);
    } else {
      values.set(key, next);
      i += 1;
    }
  }
  return { values, bools };
}

/** 口令/机密的 flag 名单——出现在 argv 即拒绝（口令只经 prompt/stdin）。 */
const FORBIDDEN_SECRET_FLAGS = ['password', 'pass', 'pw', 'secret', 'refresh-token', 'token'];

/**
 * 拒绝经 argv 传入的口令/机密 flag（落 shell 历史 / ps / proc args）。
 * 命中任一 → 返回该 flag 名（调用方据此报参数错误退出）；否则返回 null。
 */
function findForbiddenSecretFlag(flags: ParsedFlags): string | null {
  for (const name of FORBIDDEN_SECRET_FLAGS) {
    if (flags.values.has(name) || flags.bools.has(name)) {
      return name;
    }
  }
  return null;
}

const USAGE = [
  '用法: account <command>',
  '',
  '  add --imap --email <addr> --host <h> [--port <n>] [--tls <true|false>] [--account-id <id>] [--update]',
  '      口令经交互 prompt 读取（echo off）——禁经 argv 传入。',
  '      同派生 id 已存在默认拒绝；--update 显式确认更新凭据。',
  '  add --gmail',
  '      跑 loopback OAuth 授权；同 id 已存在则 upsert 新 refresh token 并启用（re-auth/恢复）。',
  '  list',
  '      列出账号 id/provider/email/enabled（不显示任何凭据）。',
  '  disable <id>',
  '      置 enabled=false（未重启不生效；撤销已泄露账号后应立即重启）。',
].join('\n');

/**
 * CLI 入口（可注入 IO/OAuth/repo 离线可测）。返回退出码（0/1/2），不调用 process.exit
 * （调用方/真身 main 据返回值退出，使测试可断言）。
 */
export async function runAccountCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'add':
      return cmdAdd(rest, deps);
    case 'list':
      return cmdList(deps);
    case 'disable':
      return cmdDisable(rest, deps);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      deps.println(USAGE);
      return command === undefined ? EXIT_USAGE : EXIT_OK;
    default:
      deps.errln(`未知命令: ${command}`);
      deps.errln(USAGE);
      return EXIT_USAGE;
  }
}

/** `account add --imap | --gmail`。 */
async function cmdAdd(args: string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(args);

  // 硬约束：口令/机密绝不经 argv（落 shell 历史 / ps）。任何机密 flag 出现即拒。
  const forbidden = findForbiddenSecretFlag(flags);
  if (forbidden !== null) {
    deps.errln(
      `拒绝: 口令/机密禁经命令行参数（--${forbidden}）传入（会落 shell 历史 / ps）；请在交互提示中输入。`,
    );
    return EXIT_USAGE;
  }

  const isImap = flags.bools.has('imap');
  const isGmail = flags.bools.has('gmail');
  if (isImap === isGmail) {
    deps.errln('add 必须指定且仅指定一个 provider: --imap 或 --gmail');
    deps.errln(USAGE);
    return EXIT_USAGE;
  }
  return isImap ? cmdAddImap(flags, deps) : cmdAddGmail(deps);
}

/** `account add --imap`：口令经交互 prompt（禁 argv）→ createAccount（同 id 默认拒绝）。 */
async function cmdAddImap(flags: ParsedFlags, deps: CliDeps): Promise<number> {
  const host = flags.values.get('host');
  if (host === undefined || host.length === 0) {
    deps.errln('--imap 需要 --host <host>');
    return EXIT_USAGE;
  }
  // user 取 --email 的 local/full（用于派生 id `imap:<user>@<host>`）；缺省回落需 --email。
  const email = flags.values.get('email');
  if (email === undefined || email.length === 0) {
    deps.errln('--imap 需要 --email <addr>（作 IMAP 用户名 + 账号 email，缺省回落 user@host）');
    return EXIT_USAGE;
  }
  const user = email;
  const portRaw = flags.values.get('port');
  let port = 993;
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      deps.errln(`--port 非法: ${portRaw}（需 1..65535 整数）`);
      return EXIT_USAGE;
    }
    port = parsed;
  }
  // tls 默认 true；仅显式 'false'（大小写不敏感）→ false（与 config IMAP_TLS 解析一致）。
  const tls = flags.values.get('tls')?.toLowerCase() !== 'false';

  // id：--account-id（对齐 legacy）优先，否则确定性 `imap:<user>@<host>`。
  const id = deriveAccountId(flags.values.get('account-id'), user, host);

  // **口令只经交互 prompt（echo off）**——绝不从 argv、绝不回显。
  const password = await deps.promptHidden('IMAP 口令: ');
  if (password.length === 0) {
    deps.errln('口令为空，已中止（未写入任何账号）。');
    return EXIT_FAILURE;
  }

  const authJson = { host, port, user, password, tls };
  const wantUpdate = flags.bools.has('update');

  if (wantUpdate) {
    // 显式确认 → upsert（同 id 更新凭据，不分裂；同邮箱重加自然命中同一行）。
    await deps.repo.upsertAccount({ id, provider: 'imap', email, authJson, enabled: true });
    deps.println(`已更新 IMAP 账号: ${id}（email=${email}）。重启后生效。`);
    return EXIT_OK;
  }

  try {
    // 默认 reject-on-exists（createAccount 命中已存 id 即抛）——不静默覆盖。
    await deps.repo.createAccount({ id, provider: 'imap', email, authJson, enabled: true });
  } catch {
    // id 已存在：拒绝并提示（凭据纪律：不记原始 error/凭据；只提示 id）。
    deps.errln(
      `拒绝: 账号已存在 (${id})。如需更新凭据请加 --update 显式确认（不会静默覆盖）。`,
    );
    return EXIT_FAILURE;
  }
  deps.println(`已新增 IMAP 账号: ${id}（email=${email}）。重启后生效。`);
  return EXIT_OK;
}

/** `account add --gmail`：跑 loopback OAuth → upsert（re-auth/恢复路径，不拒绝）。 */
async function cmdAddGmail(deps: CliDeps): Promise<number> {
  const app = deps.gmailApp();
  if (!app.available || app.clientId === undefined || app.clientSecret === undefined) {
    // 沿用「缺 app 凭据 / redirect_uri 非法 → onboarding 显式失败」（config.isGmailOnboardingAvailable）。
    deps.errln(
      'Gmail onboarding 不可用: 需配齐 GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET 且 GMAIL_REDIRECT_URI 合法' +
        '（host=127.0.0.1、path=/oauth2/callback）。',
    );
    deps.errln(
      '注: 使用 Desktop-app（已安装应用）OAuth client，端口运行时绑定、无需在 GCP 预注册具体端口；' +
        '授权 URL 与 getToken 两处 redirect_uri 必须含端口精确一致（由 oauth.ts 保证）。',
    );
    return EXIT_FAILURE;
  }

  let result: GmailAuthResult;
  try {
    // loopback OAuth（offline + prompt=consent + PKCE + state、临时端口、禁 OOB；见 oauth.ts）。
    result = await deps.runOAuth({ clientId: app.clientId, clientSecret: app.clientSecret });
  } catch (err) {
    // 凭据纪律：只记固定 kind 串（GmailOAuthError.message 已是零凭据 kind 串）、绝不记原始 error/URL。
    const kind = err instanceof Error ? err.message : 'gmail-oauth-failed';
    deps.errln(`Gmail 授权失败: ${kind}。可 revoke 旧授权后重试。`);
    return EXIT_FAILURE;
  }

  // id = `gmail:<email>`（email 已仅小写，见 oauth.ts getProfile）。
  const id = `gmail:${result.email}`;

  // 同 id 已存在且原 enabled=false → 这是 reauth-suspend 恢复路径，下方 upsert 会置 enabled=true。
  // 先探测是否「正在重新启用」（best-effort，仅用于提示，不改变 upsert 语义）。
  const reEnabled = await willReEnable(deps.repo, id);

  // **upsert**（不拒绝）：覆盖（可能轮换的）refresh token + 置 enabled=true（解除 reauth-suspend）。
  await deps.repo.upsertAccount({
    id,
    provider: 'gmail',
    email: result.email,
    authJson: { refreshToken: result.refreshToken, scopes: result.scopes },
    enabled: true,
  });
  if (reEnabled) {
    deps.println('正在重新启用该账号（此前被禁用 / 需重授权）。');
  }
  deps.println(`已接入 Gmail 账号: ${id}。重启后生效。`);
  return EXIT_OK;
}

/**
 * 判定 upsert 是否会把一个原本 enabled=false 的行重新启用（用于「正在重新启用」提示）。
 * `getAccountById`（MailRepo 现已暴露）取该行：存在且 enabled=false → 即将被本次 re-auth upsert
 * 重新启用（提示）；不存在/已 enabled → 不提示。仅用于提示，不改变 upsert 语义。
 */
async function willReEnable(repo: MailRepo, id: string): Promise<boolean> {
  const row = await repo.getAccountById(id);
  return row !== null && row.enabled === false;
}

/** `account list`：id/provider/email/enabled（**所有**账号，含禁用/reauth-suspend 行）——绝不含凭据。 */
async function cmdList(deps: CliDeps): Promise<number> {
  // listAccounts（不按 enabled 过滤）：使运营者能看到 enabled=false 的账号并据此重授权/重启。
  const rows = await deps.repo.listAccounts();
  if (rows.length === 0) {
    deps.println('（无账号）');
    return EXIT_OK;
  }
  deps.println('id\tprovider\temail\tenabled');
  for (const r of rows) {
    // 仅打印非敏感字段——绝不打印 authJson / 任何凭据。
    deps.println(`${r.id}\t${r.provider}\t${r.email}\t${r.enabled}`);
  }
  return EXIT_OK;
}

/** `account disable <id>`：置 enabled=false + staleness 提示。 */
async function cmdDisable(args: string[], deps: CliDeps): Promise<number> {
  const id = args[0];
  if (id === undefined || id.length === 0 || id.startsWith('--')) {
    deps.errln('用法: account disable <id>');
    return EXIT_USAGE;
  }
  try {
    await deps.repo.setAccountEnabled(id, false);
  } catch {
    deps.errln(`禁用失败: 未找到账号 ${id}（或写入失败）。`);
    return EXIT_FAILURE;
  }
  deps.println(`已禁用账号: ${id}。`);
  deps.println(
    '注意: 未重启不生效（该账号仍会被轮询到下次重启）。撤销/禁用一个凭据已泄露的账号后，应立即重启以停止轮询。',
  );
  return EXIT_OK;
}

/** 真身 promptHidden：readline + muted output（关闭口令回显）。 */
function defaultPromptHidden(label: string): Promise<string> {
  return new Promise<string>((resolve) => {
    // 默认静音：吞掉 readline 对输入的回显，仅放过提示串本身一次（labelPrinted 守卫）。先静音再
    // rl.question——关闭「question 同步写 label 前若有击键被回显」的 TTY 微竞态（M-d）。
    let labelPrinted = false;
    const muteStream = new Writable({
      write(chunk, _enc, cb) {
        // 仅首次写入（label）放过；其余（口令击键回显）一律吞掉。
        if (!labelPrinted) {
          labelPrinted = true;
          process.stdout.write(chunk);
        }
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: muteStream, terminal: true });
    rl.question(label, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/** 真身 stdout/stderr 行输出（附换行）。 */
function defaultPrintln(line: string): void {
  process.stdout.write(`${line}\n`);
}
function defaultErrln(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** 真身 deps：PrismaMailRepo + 真 OAuth + config app 凭据。 */
function defaultDeps(): CliDeps {
  return {
    repo: new PrismaMailRepo(),
    println: defaultPrintln,
    errln: defaultErrln,
    promptHidden: defaultPromptHidden,
    runOAuth: (app) => authorizeGmailAccount(app),
    gmailApp: () => ({
      available: isGmailOnboardingAvailable(config),
      clientId: config.GMAIL_CLIENT_ID,
      clientSecret: config.GMAIL_CLIENT_SECRET,
    }),
  };
}

// 真身入口：`node dist/cli/account.js <args>` / `tsx src/cli/account.ts <args>`。
// import.meta 主模块判定（ESM）：仅当本文件被直接运行时跑 CLI（被 import 时不跑，使测试纯净）。
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isMain) {
  const code = await runAccountCli(process.argv.slice(2), defaultDeps());
  process.exit(code);
}
