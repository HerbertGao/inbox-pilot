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
import { isValidAccountId } from './accountId.js';
import { parseProcessFromDate } from './processFromDate.js';
import {
  resolveImapPassword,
  PASSWORD_STDIN_USAGE_HINT,
} from './passwordSource.js';

/** CLI 退出码语义（0 成功 / 1 业务失败 / 2 参数错误）。 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/**
 * `--label` 展示别名硬上限（UTF-16 码元）。固定常量、规范层钉死（notification-mailbox-clarity 决策 4）。
 */
const LABEL_MAX_CODE_UNITS = 64;

/**
 * label denylist（notification-mailbox-clarity 决策 4 规范层钉死）：拒 `\p{Cc}`（C0/C1 控制,含
 * `\n`/`\r`/`\t`/NUL/DEL/U+0085）+ `\p{Cf}`（格式,含零宽 U+200B / BOM U+FEFF / bidi 嵌入·覆盖
 * U+202A–U+202E）+ 行分隔 U+2028/U+2029（属 `\p{Zl}/\p{Zp}`、**不**在 `\p{Cf}` 内,必须显式补）+
 * bidi 隔离符 U+2066–U+2069（本属 `\p{Cf}`、显式列仅为清晰）。理由:仅拒 `\n`/`\r` 会放过
 * RTL-override（U+202E）等 → 在 Telegram 客户端**视觉重排/伪装来源邮箱**,击穿「可辨来源」目标。
 * 用 `new RegExp` + `\u` 转义构造（**禁**在正则字面量内写 U+2028/U+2029 字面字符——会断行 source）。
 */
const LABEL_DENYLIST = new RegExp('[\\p{Cc}\\p{Cf}\\u2028\\u2029\\u2066-\\u2069]', 'u');

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
  /**
   * 交互式选择提示（无 provider 标志的 `account add` 用）：给标签 + 候选项 → 返回所选项。
   * 默认真身经 readline 提示；测试注入桩使交互菜单离线可测。
   */
  promptChoice?: (label: string, choices: string[]) => Promise<string>;
  /**
   * 可注入 stdin 包装（--password-stdin 用）：isTTY 用于 TTY 守卫，read 读取管道全部内容。
   * 默认从 process.stdin 构造（见 defaultDeps）。
   */
  stdin?: { isTTY: boolean; read: () => Promise<string> };
};

/** 解析后的 flag 集合（值型 flag + 布尔 flag + 裸位置参数）。 */
type ParsedFlags = {
  values: Map<string, string>;
  bools: Set<string>;
  /** 非 `--` 开头的裸 token（位置参数）；本 CLI 不接受，调用方据此拒绝（防误把机密当位置参数落 argv/history）。 */
  positionals: string[];
};

/** 短别名 → 长名映射（-e/--email、-H/--host、-p/--port）。 */
const FLAG_ALIASES: Record<string, string> = { e: 'email', H: 'host', p: 'port' };

/**
 * 极简 flag 解析：支持 `--key value`（值型）、`--key=value`（等号内联值型）、`--flag`（布尔，
 * 下一 token 以 `-` 开头或缺失时）与短别名 `-e`/`-H`/`-p`（规范化到长名）。`--key=value` 按**首个**
 * `=` 拆 key/value，使 `--password=x` 解析出 key `password`（否则整 token 成 key、绕过机密 flag 检查）。
 * **不解析任何口令/机密 flag**——口令只经 promptHidden（见文件头硬约束）；机密 flag 由调用方在写前拒绝。
 */
function parseFlags(args: string[]): ParsedFlags {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (!tok.startsWith('-')) {
      // 裸 token：收集供调用方拒绝（不静默忽略——防误把机密当位置参数传入而落 argv/shell 历史）。
      positionals.push(tok);
      continue;
    }
    // 短别名 `-e`/`-H`/`-p`：规范化到长名 body（仅识别已知别名；未知短选项不展开、作长名处理）。
    let body: string;
    if (tok.startsWith('--')) {
      body = tok.slice(2);
    } else {
      const short = tok.slice(1);
      body = FLAG_ALIASES[short] ?? short;
    }
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
    // 下一 token 以 `-` 开头（含短别名 / `--` 长名）或缺失 → 布尔；否则取值。
    if (next === undefined || next.startsWith('-')) {
      bools.add(key);
    } else {
      values.set(key, next);
      i += 1;
    }
  }
  return { values, bools, positionals };
}

/**
 * 口令/机密的 flag 词根集（出现在 argv 即拒绝；口令只经 prompt/stdin）。
 * 按**分段**匹配：flag 名按 `-`/`_` 与 camelCase 边界拆段、逐段小写比对——使
 * `--password`/`--imap-password`/`--imapPassword`/`--db-password`/`--access-token`/
 * `--refreshToken`/`--client-secret` 等复合/分隔符/大小写变体都被命中、无法借别名（含**复合**名）
 * 把机密塞进 argv；而 `--password-stdin`/`--password-file`（白名单豁免）仍被放行。
 */
const FORBIDDEN_SECRET_STEMS = new Set([
  'password',
  'pass',
  'pw',
  'secret',
  'token',
  'refreshtoken',
  'accesstoken',
  'clientsecret',
]);

/**
 * 无边界「粘连」机密名（如 --mypassword / --apikey / --oauthtoken）：对归一全名做子串匹配的长词根集。
 * 仅收**长且无歧义**的词根（均已核验不是任一合法 flag 归一名的子串），避免过度拒绝。
 * ponytail: 子串带按当前 flag 集调参；真正的「机密绝不进 argv」由**结构**保证（无任何 argv flag 值
 * 会落到口令字段，口令只经 resolveImapPassword 读取），此处仅扩宽提示。残留：超短粘连形（--pwd）仍漏，
 * 未来若新增含某词根子串的合法 flag，需把它加进白名单。
 */
const FORBIDDEN_SECRET_SUBSTRINGS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'apikey', 'credential',
  'oauthtoken', 'accesstoken', 'refreshtoken', 'clientsecret', 'privatekey',
  'sessionkey', 'bearer',
]);

/**
 * 机密词根的白名单豁免（按归一全名比对）：`--password-stdin` / `--password-file` 虽含
 * `password` 段，但它们是口令**来源**选择 flag（值非口令本身），故放行。
 */
const SECRET_FLAG_ALLOWLIST = new Set(['passwordstdin', 'passwordfile']);

/** flag 名归一：小写 + 去 `-`/`_` 分隔符（用于白名单全名比对）。 */
const normalize = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');

/**
 * flag 名拆段：在 `-`/`_` 边界与 lowercase→uppercase 过渡（camelCase）处切分，逐段小写。
 * 例：`imap-password`→`[imap, password]`、`imapPassword`→`[imap, password]`、`PW`→`[pw]`。
 */
function splitFlagSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // camelCase 边界插入分隔符
    .split(/[-_]+/)
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.toLowerCase());
}

/**
 * 拒绝经 argv 传入的口令/机密 flag（落 shell 历史 / ps / proc args）。
 * **分段感知**：flag 名任一分段命中机密词根集 → 拒绝（除非归一全名在白名单内）。
 * 命中 → 返回**原始** flag 名（调用方据此报参数错误退出）；否则返回 null。
 */
function findForbiddenSecretFlag(flags: ParsedFlags): string | null {
  for (const name of [...flags.values.keys(), ...flags.bools]) {
    const norm = normalize(name);
    if (SECRET_FLAG_ALLOWLIST.has(norm)) {
      continue;
    }
    // 分段命中（分隔符 / camelCase 复合名：--imap-password / --access-token / --client-secret）。
    if (splitFlagSegments(name).some((seg) => FORBIDDEN_SECRET_STEMS.has(seg))) {
      return name;
    }
    // 无边界粘连名：对归一全名做长词根子串匹配（--mypassword / --apikey / --oauthtoken）。
    if ([...FORBIDDEN_SECRET_SUBSTRINGS].some((s) => norm.includes(s))) {
      return name;
    }
  }
  return null;
}

const USAGE = [
  '用法: account <command> [--json]',
  '',
  '  add --imap -e|--email <addr> -H|--host <h> [-p|--port <n>] [--tls <true|false>] [--no-tls] [--account-id <id>] [--update] [--process-from <YYYY-MM-DD>] [--label <名>]',
  '      口令默认经交互 prompt 读取（echo off）——禁经 argv 传入。',
  '      非交互口令来源（互斥）: --password-stdin（从管道读）| --password-file <path>（读文件）。',
  `      ${PASSWORD_STDIN_USAGE_HINT}`,
  '      同派生 id 已存在默认拒绝；--update 显式确认更新凭据。',
  '      --process-from <YYYY-MM-DD>: 起算日期水位线（容器时区零点）；仅新建账号生效，既有账号请用 set-process-from。',
  '      --label <名>: 通知展示别名（允许中文/可见 Unicode，≤64 码元）；仅新建账号生效，既有账号通知回落 email。',
  '  add --gmail [--process-from <YYYY-MM-DD>] [--label <名>]',
  '      跑 loopback OAuth 授权；同 id 已存在则 upsert 新 refresh token 并启用（re-auth/恢复）。',
  '      --process-from 仅首次接入生效；re-auth 不改既有水位线。',
  '      --label 仅首次接入生效；re-auth 不改既有别名。',
  '  add（不带 --imap/--gmail）',
  '      打开交互式 provider 选择菜单。',
  '  list [--json]',
  '      列出账号 id/provider/email/enabled（不显示任何凭据）；--json 输出 JSON 数组。',
  '  disable <id>',
  '      置 enabled=false（未重启不生效；撤销已泄露账号后应立即重启）。',
  '  set-process-from <id> <YYYY-MM-DD>',
  '      把既有账号的起算日期水位线无条件设为给定容器时区零点日期（可双向移动；改既有账号唯一入口）。',
].join('\n');

/**
 * CLI 入口（可注入 IO/OAuth/repo 离线可测）。返回退出码（0/1/2），不调用 process.exit
 * （调用方/真身 main 据返回值退出，使测试可断言）。
 */
export async function runAccountCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    // 硬约束（**所有**子命令）：口令/机密绝不经 argv（落 shell 历史 / ps）。在路由前对 rest 统一
    // 拒绝任何机密 flag——使 `list --password X` / `disable id --token X` 等也无法把机密塞进 argv。
    const forbidden = findForbiddenSecretFlag(parseFlags(rest));
    if (forbidden !== null) {
      deps.errln(
        `拒绝: 口令/机密禁经命令行参数（--${forbidden}）传入（会落 shell 历史 / ps）；请在交互提示中输入。`,
      );
      return EXIT_USAGE;
    }
    switch (command) {
      case 'add':
        return await cmdAdd(rest, deps);
      case 'list':
        return await cmdList(rest, deps);
      case 'disable':
        return await cmdDisable(rest, deps);
      case 'set-process-from':
        return await cmdSetProcessFrom(rest, deps);
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
  } catch {
    // 顶层脱敏边界：写路径 / repo 可能抛（DB/网络/运行期）——**绝不**把原始 error 打到 stderr
    // （Prisma 错误可内嵌 DATABASE_URL/凭据子串）。只输出固定文案 + EXIT_FAILURE（详情走结构化日志）。
    deps.errln('命令执行失败（已脱敏；详见服务日志）。');
    return EXIT_FAILURE;
  }
}

/** `account add --imap | --gmail`。 */
async function cmdAdd(args: string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(args);

  // 拒绝裸位置参数（只接受显式 flag）：防误把机密当位置参数传入而落 argv/shell 历史/ps。
  if (flags.positionals.length > 0) {
    deps.errln('add 不接受位置参数（只用显式 --flag）；口令/机密只经交互提示输入，绝不经命令行。');
    return EXIT_USAGE;
  }

  // 注：机密 flag 已在 runAccountCli 路由前对**所有**子命令统一拒绝（此处不再重复）。

  let isImap = flags.bools.has('imap');
  let isGmail = flags.bools.has('gmail');
  if (isImap && isGmail) {
    // 两个 provider 同给 → 歧义，仍报参数错误（互斥）。
    deps.errln('add 必须指定且仅指定一个 provider: --imap 或 --gmail');
    deps.errln(USAGE);
    return EXIT_USAGE;
  }
  if (!isImap && !isGmail) {
    // 无 provider 标志 →「无参运行 = 交互菜单」：提示运营者选 provider（仅此处触发，不改变裸命令路径）。
    const prompt = deps.promptChoice ?? defaultPromptChoice;
    const choice = await prompt('选择 provider', ['imap', 'gmail']);
    if (choice === 'imap') {
      isImap = true;
    } else if (choice === 'gmail') {
      isGmail = true;
    } else {
      deps.errln(`未知 provider 选择: ${JSON.stringify(choice)}（需 imap 或 gmail）。`);
      return EXIT_USAGE;
    }
  }
  return isImap ? cmdAddImap(flags, deps) : cmdAddGmail(flags, deps);
}

/**
 * --tls / --no-tls 冲突解析（不依赖解析桶、消除静默忽略）。
 *
 * `tls` token 可落 `values`（`--tls true|false`）或 `bools`（值缺位的 `--tls`，如 `--tls --no-tls`）——
 * 两桶都要查。规则：`--no-tls` 与**任意** `tls` token 共存 → `--no-tls` 优先置 tls=false；**仅**真实
 * 值分歧（`--tls true` + `--no-tls`）→ 冲突；一致对（`--tls false` + `--no-tls`）被接受；值缺位的
 * `--tls --no-tls` 由 `--no-tls` 胜出（tls=false）、不被静默忽略。
 * 返回 { ok:true, tls } / { ok:false }（值分歧 → 调用方映射 EXIT_USAGE）。
 */
function resolveTls(flags: ParsedFlags): { ok: true; tls: boolean } | { ok: false } {
  const noTls = flags.bools.has('no-tls');
  const tlsValue = flags.values.get('tls'); // `--tls true|false`（值形式）
  const tlsBool = flags.bools.has('tls'); // 值缺位的 `--tls`（如 `--tls --no-tls`）
  if (noTls) {
    if (tlsValue !== undefined && tlsValue.toLowerCase() === 'true') {
      // 真实值分歧：`--tls true` + `--no-tls`。
      return { ok: false };
    }
    // 一致对（`--tls false` + `--no-tls`）、值缺位的 `--tls --no-tls`、或 `--no-tls` 单独 → tls=false。
    return { ok: true, tls: false };
  }
  if (tlsBool && tlsValue === undefined) {
    // 值缺位的 `--tls`（无 `--no-tls`）：保守按启用（默认 true），不静默禁用。
    return { ok: true, tls: true };
  }
  // 既有语义：默认 true；仅显式 'false'（大小写不敏感）→ false。
  return { ok: true, tls: tlsValue?.toLowerCase() !== 'false' };
}

/**
 * 解析 `--process-from <ISO date>`（add 路径，可选）：经 3.1 共享 helper（容器时区零点 / 严格未来拒绝）。
 * 未给该 flag → `{ ok:true, processFrom: undefined }`（默认 seed 归 repo 行创建分支、CLI 不抹零点）；
 * 给了非法 / 未来 → `{ ok:false }`，由调用方报参数错误（EXIT_USAGE）。错误信息经 errln（不回显原始值之外）。
 */
function resolveProcessFromFlag(
  flags: ParsedFlags,
  deps: CliDeps,
): { ok: true; processFrom: Date | undefined } | { ok: false } {
  // 值缺位的 `--process-from`（落 bools、非 values）：flag 在场但无日期 → 不静默回落默认 seed，
  // 显式报参数错误（usage 要求 `<YYYY-MM-DD>`）。
  if (flags.bools.has('process-from')) {
    deps.errln('--process-from 需要日期参数 <YYYY-MM-DD>');
    return { ok: false };
  }
  const raw = flags.values.get('process-from');
  if (raw === undefined) {
    return { ok: true, processFrom: undefined };
  }
  const parsed = parseProcessFromDate(raw);
  if (!parsed.ok) {
    deps.errln(
      parsed.kind === 'future'
        ? `--process-from 不能是未来日期: ${JSON.stringify(raw)}（会静默排除该日前所有邮件）。`
        : `--process-from 非法: ${JSON.stringify(raw)}（需 YYYY-MM-DD 形式、解析为容器时区零点）。`,
    );
    return { ok: false };
  }
  return { ok: true, processFrom: parsed.date };
}

/**
 * 解析并校验可选 `--label <名>`（add 路径，IMAP 与 Gmail 两子命令共用；notification-mailbox-clarity
 * 决策 4）。规则（规范层钉死）:
 * ① **值缺位守卫**:`--label` 后续 token 以 `-` 开头（落 `bools`、同 `--process-from` 坑）→ 报
 *    `--label 需要值参数 <名>` + 用法错误（**禁**静默落 NULL）；
 * ② `.trim()` 后非空（纯空白 → 拒，否则存空白、渲染回落 email、`list` 显示空）；
 * ③ 拒 denylist（`\p{Cc}`/`\p{Cf}`/U+2028/U+2029/U+2066–U+2069；见 `LABEL_DENYLIST`）；
 * ④ ≤ 64 码元（`.length` = UTF-16 code units）。
 * 未给该 flag → `{ ok:true, label: undefined }`（repo 写 `label=NULL`、渲染回落 email）。
 * 校验**对 trim 后的值**判定（denylist/限长），合法返回 trim 后的值经 `AccountWriteInput.label` 透传
 * （仅 create 生效）。失败 → `{ ok:false }`，调用方报 EXIT_USAGE、**不**触达 repo 写。
 * 注:`label` **不**进任何结构化日志字段；CLI 回显由调用方经 `JSON.stringify` 转义（双层防注入）。
 */
function validateLabel(
  flags: ParsedFlags,
  deps: CliDeps,
): { ok: true; label: string | undefined } | { ok: false } {
  // 值缺位的 `--label`（落 bools、非 values）：flag 在场但无值 → 不静默回落 NULL，显式报参数错误。
  if (flags.bools.has('label')) {
    deps.errln('--label 需要值参数 <名>');
    return { ok: false };
  }
  const raw = flags.values.get('label');
  if (raw === undefined) {
    return { ok: true, label: undefined };
  }
  // denylist 跑在 **raw**（trim 之前）:`\t`/`\n`/`\r`/U+2028/U+2029/U+FEFF 等既是 denylist 字符、又是
  // `String.trim()` 的 whitespace/line-terminator——若先 trim 再查,前导/后缀的此类字符会被剥掉、denylist 看不到、
  // 被静默接受为 trim 后的值（Codex review）。故先在**原始值**上拒控制 / 格式 / 行分隔 / bidi 隔离符
  //（防 RTL-override 等伪装来源邮箱）;普通空格不在 denylist、仍由下方 trim 清理。
  // 违规值经 JSON.stringify 转义渲染——绝不原样回显（防嵌入控制字符经错误信息再注入 stderr/日志）。
  if (LABEL_DENYLIST.test(raw)) {
    deps.errln(
      `--label 含非法字符（控制 / 格式 / 行分隔 / bidi）: ${JSON.stringify(raw)}`,
    );
    return { ok: false };
  }
  const trimmed = raw.trim();
  // trim 后判空（纯空白）→ 拒。
  if (trimmed.length === 0) {
    deps.errln(`--label 不能为空白: ${JSON.stringify(raw)}`);
    return { ok: false };
  }
  // 限长 ≤ 64 码元（UTF-16 code units = `.length`）。
  if (trimmed.length > LABEL_MAX_CODE_UNITS) {
    deps.errln(
      `--label 超长（${trimmed.length} 码元 > ${LABEL_MAX_CODE_UNITS}）: ${JSON.stringify(raw)}`,
    );
    return { ok: false };
  }
  return { ok: true, label: trimmed };
}

/** `account add --imap`：口令经互斥来源（stdin/file/交互提示）读 → createAccount（同 id 默认拒绝）。 */
async function cmdAddImap(flags: ParsedFlags, deps: CliDeps): Promise<number> {
  const json = flags.bools.has('json');
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
  const tlsRes = resolveTls(flags);
  if (!tlsRes.ok) {
    deps.errln('--tls 与 --no-tls 值分歧（--tls true + --no-tls）：请只用其一。');
    return EXIT_USAGE;
  }
  const tls = tlsRes.tls;

  // id：--account-id（对齐既有/自定义 id）优先，否则确定性 `imap:<user>@<host>`。
  const id = deriveAccountId(flags.values.get('account-id'), user, host);
  // 校验**最终** id（显式或派生），防非法字符 / 控制字符注入 accountId 日志字段 / 污染主键命名空间。
  // 错误信息用 JSON.stringify 转义渲染违规值——绝不原样回显（防原始控制字符经错误信息再注入 stderr/日志）。
  if (!isValidAccountId(id)) {
    deps.errln(
      `account-id 含非法字符或超长（需匹配 ^[A-Za-z0-9:._@+=][A-Za-z0-9:._@+=-]{0,254}$）: ${JSON.stringify(id)}`,
    );
    return EXIT_USAGE;
  }

  // 值缺位的 `--password-file`（落 bools、非 values）会绕过来源互斥 → 静默回落 stdin/提示；显式拒绝。
  if (flags.bools.has('password-file')) {
    deps.errln('--password-file 需要一个路径参数');
    return EXIT_USAGE;
  }
  // `--password-stdin` 是裸布尔；若带值（落 values）则是误用 → 拒绝（防误把口令拼到 --password-stdin=...）。
  if (flags.values.has('password-stdin')) {
    deps.errln('--password-stdin 不接受值参数');
    return EXIT_USAGE;
  }

  // `--process-from`（可选）先于口令 prompt 校验：日期 typo/未来在交互输入口令**之前**即 EXIT_USAGE
  // （fail-fast，避免先敲口令再报日期错；与 Gmail 路径先校验再跑 OAuth 一致）。CLI **不**区分首次/re-auth：
  // 对既有账号走 update 分支会被 repo 忽略（决策 7），改既有水位线只能 set-process-from；未给则 undefined、
  // 默认 seed 归 repo 行创建分支（精确瞬时、不抹零点）。
  const pfRes = resolveProcessFromFlag(flags, deps);
  if (!pfRes.ok) {
    return EXIT_USAGE;
  }
  const processFrom = pfRes.processFrom;

  // `--label`（可选）先于口令 prompt 校验（fail-fast、同 --process-from）：值缺位 / 非法 / 超长 →
  // EXIT_USAGE、**不**触达 repo 写。合法值经 AccountWriteInput.label 透传（仅 create 生效，决策 5）。
  const labelRes = validateLabel(flags, deps);
  if (!labelRes.ok) {
    return EXIT_USAGE;
  }
  const label = labelRes.label;

  // **口令绝不从 argv** → 互斥来源 --password-stdin / --password-file / 交互隐藏提示（默认）。
  const pwResult = await resolveImapPassword(
    {
      passwordStdin: flags.bools.has('password-stdin'),
      passwordFile: flags.values.get('password-file'),
    },
    {
      promptHidden: () => deps.promptHidden('IMAP 口令: '),
      stdin: deps.stdin ?? defaultStdin(),
    },
  );
  if (!pwResult.ok) {
    deps.errln(pwResult.message);
    return EXIT_USAGE;
  }
  const password = pwResult.password;
  if (password.length === 0) {
    deps.errln('口令为空，已中止（未写入任何账号）。');
    return EXIT_FAILURE;
  }

  const authJson = { host, port, user, password, tls };
  const wantUpdate = flags.bools.has('update');

  if (wantUpdate) {
    // 显式确认 → upsert（同 id 更新凭据，不分裂；同邮箱重加自然命中同一行）。
    // `label` 作播种载体:仅 create 分支生效（决策 5）；既有行走 update 被 repo 忽略（保留既有 label）。
    await deps.repo.upsertAccount({ id, provider: 'imap', email, authJson, enabled: true, processFrom, label });
    // 回显成功行（label 经 JSON.stringify 转义，双层防注入，同 id；label 不进结构化日志字段）。
    emitAccountAddOutcome(deps, json, { id, provider: 'imap', email, enabled: true }, `已更新 IMAP 账号: ${id}（email=${email}${label === undefined ? '' : `, label=${JSON.stringify(label)}`}）。重启后生效。`);
    return EXIT_OK;
  }

  try {
    // 默认 reject-on-exists（createAccount 命中已存 id 即抛）——不静默覆盖。
    await deps.repo.createAccount({ id, provider: 'imap', email, authJson, enabled: true, processFrom, label });
  } catch {
    // 区分「id 已存在」与「存储/网络/运行期写失败」——一律报「已存在」会给错指引。
    // getAccountById 自身也可能抛（DB 不可达）→ 再包一层、抛则按通用写失败处理（凭据纪律：不记原始 error）。
    let exists = false;
    try {
      exists = (await deps.repo.getAccountById(id)) !== null;
    } catch {
      exists = false;
    }
    if (exists) {
      deps.errln(
        `拒绝: 账号已存在 (${id})。如需更新凭据请加 --update 显式确认（不会静默覆盖）。`,
      );
    } else {
      deps.errln(`新增失败: 无法写入账号 ${id}（存储/网络错误）。请重试或检查连接。`);
    }
    return EXIT_FAILURE;
  }
  // 回显成功行（label 经 JSON.stringify 转义，双层防注入，同 id；label 不进结构化日志字段）。
  emitAccountAddOutcome(deps, json, { id, provider: 'imap', email, enabled: true }, `已新增 IMAP 账号: ${id}（email=${email}${label === undefined ? '' : `, label=${JSON.stringify(label)}`}）。重启后生效。`);
  return EXIT_OK;
}

/**
 * 账号新增结果输出：`--json` → stdout 发字段**白名单** { id, provider, email, enabled }（显式禁
 * authJson / 口令 / token）；否则人类成功行经 errln（数据走 stdout、人类/日志行走 stderr，使 --json
 * 时 stdout 保持可解析）。
 */
function emitAccountAddOutcome(
  deps: CliDeps,
  json: boolean,
  row: { id: string; provider: string; email: string; enabled: boolean },
  humanLine: string,
): void {
  if (json) {
    deps.println(JSON.stringify(row));
  } else {
    deps.errln(humanLine);
  }
}

/** `account add --gmail`：跑 loopback OAuth → upsert（re-auth/恢复路径，不拒绝）。 */
async function cmdAddGmail(flags: ParsedFlags, deps: CliDeps): Promise<number> {
  const json = flags.bools.has('json');
  // `--process-from`（可选）先校验：非法/未来在跑 OAuth 前即 EXIT_USAGE，避免授权后才报参数错误。
  const pfRes = resolveProcessFromFlag(flags, deps);
  if (!pfRes.ok) {
    return EXIT_USAGE;
  }
  const processFrom = pfRes.processFrom;
  // `--label`（可选）同样在跑 OAuth 前校验（fail-fast）：值缺位 / 非法 / 超长 → EXIT_USAGE、不跑 OAuth、
  // 不触达 repo 写。合法值经 AccountWriteInput.label 透传（Gmail 恒走 upsert，仅首次 create 分支生效，决策 5）。
  const labelRes = validateLabel(flags, deps);
  if (!labelRes.ok) {
    return EXIT_USAGE;
  }
  const label = labelRes.label;
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
  // `processFrom` 作播种载体：仅 create 分支生效（首次接入种值）；既有行走 update 被 repo 忽略（决策 7）。
  await deps.repo.upsertAccount({
    id,
    provider: 'gmail',
    email: result.email,
    authJson: { refreshToken: result.refreshToken, scopes: result.scopes },
    enabled: true,
    processFrom,
    label,
  });
  if (reEnabled) {
    // 「正在重新启用」提示（人类/日志行）：--json 时走 stderr 以保 stdout 纯 JSON，否则走 stdout（既有契约）。
    const hint = '正在重新启用该账号（此前被禁用 / 需重授权）。';
    if (json) {
      deps.errln(hint);
    } else {
      deps.println(hint);
    }
  }
  // 回显成功行（label 经 JSON.stringify 转义，双层防注入，同 id；label 不进结构化日志字段）。
  const gmailLabelSuffix = label === undefined ? '' : `（label=${JSON.stringify(label)}）`;
  emitAccountAddOutcome(deps, json, { id, provider: 'gmail', email: result.email, enabled: true }, `已接入 Gmail 账号: ${id}${gmailLabelSuffix}。重启后生效。`);
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
async function cmdList(args: string[], deps: CliDeps): Promise<number> {
  const json = parseFlags(args).bools.has('json');
  // listAccounts（不按 enabled 过滤）：使运营者能看到 enabled=false 的账号并据此重授权/重启。
  const rows = await deps.repo.listAccounts();
  if (json) {
    // 字段白名单 { id, provider, email, enabled }——绝不含 authJson / 任何凭据。数据走 stdout。
    deps.println(
      JSON.stringify(
        rows.map((r) => ({ id: r.id, provider: r.provider, email: r.email, enabled: r.enabled })),
      ),
    );
    return EXIT_OK;
  }
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
  const flags = parseFlags(args);
  // disable 不接受任何 flag：`disable --json <id>` 会把 <id> 当作 --json 的值吞掉 → 误报缺 id。
  // disable 无任何合法 flag，未知 flag 一律拒绝并给精确报错（区别于下面的位置参数数量错误）。
  if (flags.values.size > 0 || flags.bools.size > 0) {
    deps.errln('disable 不接受任何 flag，仅需一个 id 位置参数');
    deps.errln('用法: account disable <id>');
    return EXIT_USAGE;
  }
  // 恰好一个位置参数 id（防 `disable id1 id2` 静默丢弃多余 id、只禁用 id1）。
  if (flags.positionals.length !== 1) {
    deps.errln('disable 需要且仅需要一个 id 参数');
    deps.errln('用法: account disable <id>');
    return EXIT_USAGE;
  }
  const id = flags.positionals[0]!;
  // 刻意**不**对 id 跑 isValidAccountId：校验是 add/派生路径的规则（id 在那里进主键命名空间）；
  // disable 读取**既有行**，必须能命中任意 id 形态（含历史/直接入库的非常规 id）以履行「撤销已泄露账号」
  // 职责——把它绑到当前 ACCOUNT_ID_RE 反而会锁死非常规 id（与 accountId.ts 首字符禁 `-` 同类的锁定）。
  // 无注入面：id 在下面成功/失败两处回显均经 JSON.stringify 转义，setAccountEnabled 走 Prisma 参数化、不裸 log。
  try {
    await deps.repo.setAccountEnabled(id, false);
  } catch {
    // id 经 JSON.stringify 转义渲染——绝不原样回显（防嵌入 id 的控制字符伪造 stderr/日志行）。
    deps.errln(`禁用失败: 未找到账号 ${JSON.stringify(id)}（或写入失败）。`);
    return EXIT_FAILURE;
  }
  // id 经 JSON.stringify 转义渲染（同上）。
  deps.println(`已禁用账号: ${JSON.stringify(id)}。`);
  deps.println(
    '注意: 未重启不生效（该账号仍会被轮询到下次重启）。撤销/禁用一个凭据已泄露的账号后，应立即重启以停止轮询。',
  );
  return EXIT_OK;
}

/**
 * `account set-process-from <id> <YYYY-MM-DD>`：把既有账号的起算日期水位线**无条件**设为给定容器时区零点
 * 日期（可双向移动、无单调守卫——见 spec「set-process-from 是无条件覆盖」）。`<date>` 经 3.1 共享 helper
 * 解析（容器时区零点 / 非法 → EXIT_USAGE / 严格未来 → EXIT_USAGE）。`<id>` 经 `JSON.stringify` 转义回显
 * （防嵌入 id 的控制字符伪造 stderr/日志行，同 cmdDisable）。改既有行**唯一**入口（add 走 update 被忽略）。
 */
async function cmdSetProcessFrom(args: string[], deps: CliDeps): Promise<number> {
  const flags = parseFlags(args);
  // set-process-from 不接受任何 flag：只需两个位置参数 <id> <date>（防 flag 吞掉位置参数）。
  if (flags.values.size > 0 || flags.bools.size > 0) {
    deps.errln('set-process-from 不接受任何 flag，仅需 <id> <YYYY-MM-DD> 两个位置参数');
    deps.errln('用法: account set-process-from <id> <YYYY-MM-DD>');
    return EXIT_USAGE;
  }
  // 恰好两个位置参数（防 `set-process-from id` 缺日期 / `set-process-from id d1 d2` 静默丢弃多余）。
  if (flags.positionals.length !== 2) {
    deps.errln('set-process-from 需要且仅需要 <id> 与 <YYYY-MM-DD> 两个参数');
    deps.errln('用法: account set-process-from <id> <YYYY-MM-DD>');
    return EXIT_USAGE;
  }
  const id = flags.positionals[0]!;
  const dateRaw = flags.positionals[1]!;
  // <date> 经 3.1 共享 helper：严格 YYYY-MM-DD → 容器时区零点；非法 / 严格未来 → EXIT_USAGE（同 add）。
  const parsed = parseProcessFromDate(dateRaw);
  if (!parsed.ok) {
    // 非法值经 JSON.stringify 转义渲染（绝不原样回显）。未来 / 解析失败分别给精确提示。
    deps.errln(
      parsed.kind === 'future'
        ? `<date> 不能是未来日期: ${JSON.stringify(dateRaw)}（会静默排除该日前所有邮件）。`
        : `<date> 非法: ${JSON.stringify(dateRaw)}（需 YYYY-MM-DD 形式、解析为容器时区零点）。`,
    );
    return EXIT_USAGE;
  }
  try {
    // 无条件覆盖（可双向移动水位线）；id 不校验形态——读既有行、须能命中任意历史 id（同 cmdDisable）。
    await deps.repo.setProcessFrom(id, parsed.date);
  } catch {
    // id 经 JSON.stringify 转义渲染——绝不原样回显（防嵌入 id 的控制字符伪造 stderr/日志行）。
    deps.errln(`设置失败: 未找到账号 ${JSON.stringify(id)}（或写入失败）。`);
    return EXIT_FAILURE;
  }
  // id 经 JSON.stringify 转义渲染（同上）。
  deps.println(
    `已设置账号 ${JSON.stringify(id)} 的起算日期水位线为 ${dateRaw}（容器时区零点，存储瞬时 ${parsed.date.toISOString()}）。`,
  );
  deps.println('注意: 未重启不生效（摄入下界在轮询路径上，重启后才按新水位线过滤）。');
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

/** 真身交互式 provider 选择菜单：readline 提示，反复读到合法候选项（提示走 stderr，保 stdout 干净）。 */
function defaultPromptChoice(label: string, choices: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${label} (${choices.join('/')}): `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** 真身 stdin 包装（--password-stdin 用）：isTTY + 读管道全部内容为字符串。 */
function defaultStdin(): { isTTY: boolean; read: () => Promise<string> } {
  return {
    isTTY: process.stdin.isTTY ?? false,
    read: () =>
      new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', (c: Buffer) => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
      }),
  };
}

/** 真身 deps：PrismaMailRepo + 真 OAuth + config app 凭据。 */
function defaultDeps(): CliDeps {
  return {
    repo: new PrismaMailRepo(),
    println: defaultPrintln,
    errln: defaultErrln,
    promptHidden: defaultPromptHidden,
    promptChoice: defaultPromptChoice,
    stdin: defaultStdin(),
    runOAuth: (app) => authorizeGmailAccount(app),
    gmailApp: () => ({
      available: isGmailOnboardingAvailable(config),
      clientId: config.GMAIL_CLIENT_ID,
      clientSecret: config.GMAIL_CLIENT_SECRET,
    }),
  };
}

/**
 * 公开生产入口（§1.3）：构造生产 deps 并跑 CLI，**返回**退出码——**绝不**内部 process.exit
 * （由分发器 / 主模块守卫在自身退出，避免退出码重复触发）。inbox-pilot 分发器与 `pnpm account`
 * 自跑路径共用此入口、不重复构造 deps。
 */
export async function runAccountCliMain(argv: string[]): Promise<number> {
  return runAccountCli(argv, defaultDeps());
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
  runAccountCliMain(process.argv.slice(2)).then((code) => process.exit(code));
}
