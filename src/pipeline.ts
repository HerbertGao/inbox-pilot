// inbox pilot 入口 —— hangar host 经 `<appDir>/dist/pipeline.js` in-process 加载并调 `run(ctx)`
// （migration §1.1、design D2/D8/R10）。run() 在 run() 内直接编排自动动作（不经 gateway/propose），
// 审计经 ctx.emit 写域事件进 RunEvent.payload_json。
//
// 逐封闭环：list(is:unread) 穷尽翻页 → DB 预去重（记 isRevisit + 既存行）→ 最旧优先(≤get-budget) → 逐封
//   **死信门（重跑封,get 前）** → get → map → normalize → saveEmail → 分类（re-poll 复用/否则 LLM）→
//   executeActions(reflect→notify→mark_read) → emit → markProcessed（除非 notify 耗尽）。
//
// 关键鲁棒性（design D3/D5/D7）：
//   - **两级读错误（§3.1）**：429/配额 → 结束本轮；401/scope-403/invalid_grant → 结束本轮 + 持久 suspend；
//     瞬时 403 → 结束本轮不 suspend；良性 get/map/normalize → 逐封 skip。读侧终态 run 仍 completed。
//   - **成本上界（§3.2）**：processFrom 水位 `after:<epoch>` 下界 + get-budget ≤200。
//   - **notify 耗尽 → coarse re-poll + 死信终态（§2.2/2.3）**：耗尽跳 markProcessed、留 unread、下轮重跑
//     复用分类（getClassification 跳 LLM+跳 saveClassification）；重跑入口评估门 `计数≥K 或超 staleness`
//     → markProcessed + email.dead_letter，封顶所有已落库成因。
//   - **每 email 超时 + 每 run 兜底 + best-effort 取消 + fence（§4.4）**：per-email 超时放弃单封（best-effort
//     AbortController 取消底层 gmail 调用）、per-run 墙钟结束本轮兜底；被弃诺吞拒绝（防 unhandledRejection
//     杀 daemon）、超时后 per-email fence 掉后续 emit/markProcessed（晚到 resolve/reject 皆挡）。
//
// app 事件 kind（notify.*/reflect.*/mark_read.*/account.suspended/email.dead_letter）刻意选不撞脊柱
// STATE_BY_KIND（events.ts）——否则 appendEvent 遇生命周期 kind 会误移状态。外部 pilot 不 import
// @hangar/core，此约束由命名纪律 + 本注释守（待解问题 R3 CR-n1）。

import { renameSync, writeFileSync } from 'node:fs';

import type { Logger } from 'pino';

import { loadConfig } from './config/config.js';
import { PrismaMailRepo, NOISE_TOPN_WINDOW_DAYS, type MailRepo } from './repo/mailRepo.js';
import { readNoiseOverlay, resolveNoiseOverlayPath } from './rules/rulesConfig.js';
import { loadEnabledAccounts } from './accounts/accountRegistry.js';
import type { Account } from './providers/provider.js';
import { ProviderReauthRequired } from './providers/provider.js';
import {
  createGmailClient,
  isInvalidGrant,
  isReauth403,
  readErrorCode,
  readHttpStatus,
  throwReauth,
  type GmailApi,
} from './providers/gmail/gmailClient.js';
import { createGmailProvider } from './providers/gmail/gmailActions.js';
import type { ProviderActions } from './actions/providerActions.js';
import { toRawEmail } from './providers/gmail/gmailMap.js';
import { normalizeEmail, type NormalizedEmail } from './normalizer/normalizeEmail.js';
import { classifyEmail } from './classifier/classifyEmail.js';
import type { Classification } from './classifier/schema.js';
import { applySafetyRules } from './rules/applySafetyRules.js';
import { executeActions } from './actions/executeActions.js';
import { defaultNotifier, type Notifier } from './notify/notifier.js';
import { runDigestOnce } from './digest/digestScheduler.js';
import { NOISE_TOPN } from './digest/buildDigest.js';

/**
 * **本地结构化 RunContext**（R10/M6）：外部 pilot 不 import @hangar/core 的类型——用本地结构 type，
 * ctx 是**运行时鸭子契约**。`tsc` 绿只证本地自洽、**不**证与脊柱运行时传入的 ctx 版本兼容；脊柱
 * RunContext 改动后须**重编译**本 pilot。缓解 = run() 开头 fail-loud 断言（见下）。
 */
type Action = { tool: string; args: object };
type RunContext = {
  input: unknown;
  config: Record<string, unknown>;
  logger: Logger;
  emit(kind: string, payload?: object): void;
  propose(action: Action): Promise<unknown>;
  /**
   * 可选触发身份（脊柱零域、多触发路由，design D1/D2）：脊柱把触发的**不透明 name**（app.yaml
   * trigger.name）塞进此字段；`run()` 据此 `switch` 分派（`'digest'`→摘要、`'poll'`/undefined→poll）。
   * 老脊柱不传 → undefined → 向后兼容走 poll。**运行时鸭子契约新增字段**，pilot 防御性读、fail-loud 断言**不**含它。
   */
  trigger?: string;
};

/** 每轮 get 预算（design D5 成本上界 §3.2；否则大量 unread 积压下每 tick 穷尽 get/classify 爆发）。 */
const GET_BUDGET = 200;

/**
 * per-email 主超时（design D7 §4.4）：**单封实际工作**量级（1×get + ≤2×classify + reflect + ≤3×notify +
 * mark_read，各含退避），非旧 `DEFAULT_POLL_TIMEOUT_MS`=5min 的**每轮**预算——防最旧邮件 head-of-line
 * 饿死更新邮件、防 200×5min≈16h 单 run 占 active-lock。
 */
const PER_EMAIL_TIMEOUT_MS = 45_000;

/**
 * per-run 结束本轮墙钟兜底（design D7 §4.4）：剩余邮件 → re-poll（受死信门封顶）。因 per-email 已封单封，
 * 兜底**不**重引入 head-of-line，只封住病态累积（大量慢封逐个耗时的总和）。
 */
const PER_RUN_TIMEOUT_MS = 10 * 60_000;

/**
 * 死信门阈值（design D3 §2.3；参照旧 durable drain 的 MAX_DURABLE_ATTEMPTS=6 / NOTIFY_STALENESS_MS=24h）：
 * 重跑一封已存-未处理封时 `re-poll 计数≥K 或 receivedAt 超 staleness` → markProcessed + email.dead_letter。
 * 真实阈值待 §6.1 按实测 notify 失败率定；此为占位默认。
 */
const DEAD_LETTER_MAX_REPOLLS = 6;
const DEAD_LETTER_STALENESS_MS = 24 * 60 * 60 * 1000;

/** per-email 作用域的中止标志（每封新建）：超时后 fence 掉后续 emit/markProcessed（design D7）。 */
type Fence = { aborted: boolean };

/**
 * 读侧「结束本轮」信号（design D5 §3.1）：get 遇 429/配额/瞬时 403 → 结束本账号本轮（不逐封 skip 继续
 * 翻页加剧限流）。区别于 `ProviderReauthRequired`（结束本轮 + 持久 suspend）与良性错误（逐封 skip）。
 * 逃出 per-email 超时/try 层，由 pollGmailAccount 捕获后结束本账号邮件循环、run 仍 completed。
 */
class ReadRoundEnd extends Error {
  constructor() {
    super('read-round-end');
    this.name = 'ReadRoundEnd';
  }
}

/**
 * 良性单封失败标记（design D2 M-B / spec §2.1 作用域纪律）：**只**包裹 classify 崩 / get-map-normalize
 * 失败——per-email catch 只吞它 → skip 该封 continue。终态 DB I/O（saveEmail/gate/markProcessed 抛）与意外
 * 错误**不**被包裹 → 逃出该 catch → 账号级处理（结束本账号本轮），**禁止**被当作「skip 一封」。
 * 只留**标量** code/name（绝不整体保留原始 GaxiosError，防其 .config/.response bearer 入日志）。
 */
class BenignEmailError extends Error {
  readonly code: string | number | undefined;
  readonly errorName: string;
  constructor(cause: unknown) {
    super('benign-email-skip');
    this.name = 'BenignEmailError';
    this.code = readErrorCode(cause);
    this.errorName = cause instanceof Error ? cause.name : 'unknown';
  }
}

type GmailAccount = Extract<Account, { provider: 'gmail' }>;

/** classify seam：默认真实 classifyEmail；测试注入 spy 计调用数（re-poll 复用分类断言，tasks 2.4a）。 */
type ClassifyFn = (email: NormalizedEmail) => Promise<Classification>;

/**
 * run() 的可注入覆盖（仅测试用；hangar 调 `run(ctx)` 无第二参，走全默认生产路径）。
 * 让 self-check 驱动真实 run() 全链路（fetch→classify→rules→save→executeActions→markProcessed）而
 * 注入 fake gmail / fake notifier / in-memory repo / classify spy，**不 stub** executeActions/emit（tasks 2.4）。
 */
export type RunOverrides = {
  repo?: MailRepo;
  notifier?: Notifier;
  classify?: ClassifyFn;
  /** provider 工厂（reflect/mark_read）；默认 createGmailProvider(accountId, gmail)。 */
  makeProvider?: (accountId: string, gmail: GmailApi) => ProviderActions;
  /** gmail client 工厂；默认 createGmailClient(...)。测试注入假 GmailApi（含读错误脚本）。 */
  makeGmail?: (account: GmailAccount) => GmailApi;
  /** gmail app 凭据覆盖（默认 loadConfig()）。makeGmail 注入时无关紧要。 */
  config?: { readonly GMAIL_CLIENT_ID?: string; readonly GMAIL_CLIENT_SECRET?: string };
  /** 单调时钟（ms），默认 Date.now；staleness 门 + per-run 兜底用。 */
  now?: () => number;
  perEmailTimeoutMs?: number;
  perRunTimeoutMs?: number;
  deadLetterMaxRepolls?: number;
  deadLetterStalenessMs?: number;
  /** 退避睡眠 seam（透传给 executeActions）；默认真实 setTimeout，测试注入假时钟零真实等待。 */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 读侧错误分层（design D5 §3.1，list/get 共用）：
 *   - `reauth`   ：401 / scope-403(insufficientPermissions) / invalid_grant(400) → 结束本轮 + 持久 suspend。
 *   - `end-round`：429 / 瞬时 403(rate/quota) → 结束本轮、**不** suspend（例行限流不污染 trace/不猛打 token）。
 *   - `benign`   ：其余（坏响应 / 瞬时网络） → get 逐封 skip；list 无逐封语义故当结束本轮（不继续翻页）。
 */
type ReadErrorClass = 'reauth' | 'end-round' | 'benign';

function classifyReadError(err: unknown): ReadErrorClass {
  if (isInvalidGrant(err)) {
    return 'reauth'; // token 端点 400 invalid_grant（撤销/过期，不自愈）。
  }
  const status = readHttpStatus(err);
  if (status === 401) {
    return 'reauth';
  }
  if (status === 403) {
    return isReauth403(err) ? 'reauth' : 'end-round'; // scope 失配 → reauth；rate/quota → 结束本轮不 suspend。
  }
  if (status === 429) {
    return 'end-round'; // 限流/配额：结束本轮（不继续翻页加剧限流）。
  }
  // 5xx（Gmail 侧故障）刻意归 benign（get 逐封 skip、**不** end-round）：单封 message-specific 500 若 end-round，
  // 在 oldest-first 下会每 tick 结束整轮、饿死更新邮件（且该封 get 前失败未落库 → 永不 revisit → 死信门封不住 →
  // 无限静默饿死，含 P0 码，RC r2）。Gmail-wide 5xx 外呀的逐封 skip 代价（≤GET_BUDGET get/tick）有界且罕见，
  // 是较小恶（原设计的「坏响应→benign」行为，记 §5.2 降级）。list-5xx 仍 end-round（fetchListPage 非 reauth 皆 end-round）。
  return 'benign';
}

/** 竞速结果（Promise.race work vs 超时，design D7）。 */
type Raced<T> = { kind: 'ok'; value: T } | { kind: 'err'; error: unknown } | { kind: 'timeout' };

/**
 * work 与 per-email/list 超时竞速（design D7 anti-wedge 机制核心）：
 *   - 超时 → 返回 `{kind:'timeout'}` + `controller.abort()`（best-effort 取消底层 gmail 调用）。
 *   - **被弃诺吞拒绝**：`work` 稍后 reject 由 `mapped` 的 onRejected 收编为 resolved `{kind:'err'}`——恒有
 *     handler，绝不 `unhandledRejection`（否则 Node 默认杀 daemon、楔死借另一门重现）。
 * 调用方据 kind 分流；超时后须用 fence 挡住 work 晚到 resolve 的副作用（本函数不管 fence）。
 */
async function raceTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<Raced<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const mapped: Promise<Raced<T>> = work.then(
    (value): Raced<T> => ({ kind: 'ok', value }),
    (error): Raced<T> => ({ kind: 'err', error }),
  );
  try {
    const raced = await Promise.race([mapped, timeout]);
    if (raced.kind === 'timeout') {
      controller.abort(); // best-effort：googleapis AbortSignal 不保证毁 socket；真兜底靠 fence（见调用方）。
    }
    return raced;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** run() 内共享的处理依赖（穿透到 per-account / per-email）。 */
type RunDeps = {
  repo: MailRepo;
  notifier: Notifier;
  classify: ClassifyFn;
  ctx: RunContext;
  log: Logger;
  now: () => number;
  makeGmail: (account: GmailAccount) => GmailApi;
  makeProvider: (accountId: string, gmail: GmailApi) => ProviderActions;
  /** per-run 墙钟兜底截止（ms，绝对时刻 = 起始 now() + perRunTimeoutMs）。 */
  runDeadline: number;
  perEmailTimeoutMs: number;
  deadLetterMaxRepolls: number;
  deadLetterStalenessMs: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 一轮 inbox run。cron 到点由 hangar 起，处理完当轮 gmail 未读、无 pending approval → run `completed`。
 * 读侧终态（429/硬 reauth/瞬时）由 run() 捕获、按账号结束本轮后 run 仍 `completed`（design D5 RC-F6）——
 * `run.failed` 只留给真故障；否则例行 429 会把每 run 标 failed、污染 trace。
 */
export async function run(ctx: RunContext, overrides?: RunOverrides): Promise<void> {
  // —— fail-loud 契约断言（M6/R10）：本地 RunContext 是运行时鸭子契约，脊柱传入不兼容的 ctx 时**立刻**
  //    抛明确错误，而非晚点 `undefined is not a function`。断言 run() **实际用到的** emit/config/input/logger
  //    （logger 立即 deref，缺则须早抛而非晚崩）；`propose` **不**断言——run() 从不用它（Phase 2 approval
  //    动作 gmail.send 才用），断言它会把只缺 propose 的合法 ctx 误拒。——
  if (
    ctx === null ||
    typeof ctx !== 'object' ||
    typeof ctx.emit !== 'function' ||
    typeof ctx.config !== 'object' ||
    ctx.config === null ||
    !('input' in ctx) ||
    typeof ctx.logger !== 'object' ||
    ctx.logger === null
  ) {
    throw new Error(
      'inbox pipeline: incompatible RunContext (expected emit/config/input/logger) — rebuild pilot against current @hangar/core',
    );
  }

  // —— 多触发路由（design D1/D2 + spec「每日摘要作为 digest 触发器」/「未知 trigger 响亮失败」）：脊柱把触发的
  //    不透明 name 塞进 ctx.trigger，app 内**显式 case + loud default**分派——`'digest'`→摘要、`'poll'`/undefined→poll、
  //    其余未知非空 name → **throw**（拼错/漏配触发器时响亮失败，不静默走 poll 致 digest 时刻双 poll）。undefined
  //    向后兼容（老脊柱不传）。名→行为绑定是约定（脊柱零域、无法内省 app 的 switch），故 app 侧自守 loud default。——
  if (ctx.trigger === 'digest') {
    await runDigest(ctx, overrides);
    return;
  }
  if (ctx.trigger === 'poll' || ctx.trigger === undefined) {
    await runPoll(ctx, overrides);
    return;
  }
  // noise-feedback 反馈闭环（跨 repo 契约 add-view-command-path）：interpret 干跑解析（无写）、apply 幂等落 overlay。
  if (ctx.trigger === 'interpret-feedback') {
    await runInterpretFeedback(ctx, overrides);
    return;
  }
  if (ctx.trigger === 'apply-feedback') {
    await runApplyFeedback(ctx, overrides);
    return;
  }
  throw new Error(
    `inbox pipeline: unknown trigger '${String(ctx.trigger)}' — expected 'poll'/'digest'/'interpret-feedback'/'apply-feedback' (check app.yaml trigger name)`,
  );
}

/**
 * digest 触发（design「inbox 落地」/ spec「每日摘要作为 digest 触发器」）：**包裹**一轮编排 `runDigestOnce`，
 * 把审计经 `ctx.emit`（digest.sent/digest.empty/digest.failed，非 PII）而非模块 logger，并组装与 poll 同的
 * 依赖（PrismaMailRepo / defaultNotifier；now 由 overrides 注入假时钟）。build 为 null → digest.empty 不推。
 * 一轮编排的**逐段提交语义**（成功即 markDigested、遇非 sent 停）由 runDigestOnce 保证。
 */
async function runDigest(ctx: RunContext, overrides?: RunOverrides): Promise<void> {
  const repo: MailRepo = overrides?.repo ?? new PrismaMailRepo();
  const notifier: Notifier = overrides?.notifier ?? defaultNotifier;
  const now: () => number = overrides?.now ?? (() => Date.now());
  await runDigestOnce({
    repo,
    notifier,
    now: () => new Date(now()),
    emit: (kind, payload) => ctx.emit(kind, payload),
  });
}

/**
 * interpret-feedback 触发（noise-feedback 契约）：**干跑解析、无任何写、不 throw**。
 * 取最近高频发件人候选（复用 buildDigest 同源的 `repo.countRecentSenders`，窗口 = now - NOISE_TOPN_WINDOW_DAYS，
 * **并同 digest 只取计数降序 TOP-N**），对用户自然语言 text 做**确定性子串匹配**（无 LLM）→ 命中候选地址原文 add，emit interpretation.proposed。
 * 输出恒为候选集子集（零幻觉）；误命中由后续 apply 前的**人工确认**兜住（interpret 只提议、不落地）。
 */
async function runInterpretFeedback(ctx: RunContext, overrides?: RunOverrides): Promise<void> {
  const repo: MailRepo = overrides?.repo ?? new PrismaMailRepo();
  const now: () => number = overrides?.now ?? (() => Date.now());
  const text = readFeedbackText(ctx.input);
  const since = new Date(now() - NOISE_TOPN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await repo.countRecentSenders(since); // 只读（无写副作用）。
  // 只对 digest 展示的 TOP-N 匹配（同 renderNoiseTopN 的 slice(0, NOISE_TOPN)），使 interpret 命中集 == 用户在 digest 看到的那几个。
  const add = matchNoiseCandidates(text, candidates.slice(0, NOISE_TOPN).map((c) => c.fromEmail));
  ctx.emit('interpretation.proposed', { add });
}

/** 从 ctx.input 读反馈自然语言（`{ text: string }`）；非对象/缺 text/非串 → 空串（当空处理）。 */
function readFeedbackText(input: unknown): string {
  if (input !== null && typeof input === 'object' && 'text' in input) {
    const t = (input as { text: unknown }).text;
    if (typeof t === 'string') {
      return t;
    }
  }
  return '';
}

/**
 * 确定性候选匹配（无 LLM）：text 按非字母数字切 token、小写、只留长度≥3；对每个候选地址（小写），
 * 任一 token 是其子串 → 命中（域名是完整地址的连续子串，故整地址 `includes` 已覆盖「匹配地址或其域名」）。
 * 返回去重命中的**候选地址原文**（保候选顺序）。中文虚词经 `[^a-z0-9]+` 切分被剔除，故不匹配。
 * // ponytail: 通用短 token（如 "com"）可过匹配——设计上由 apply 前人工确认兜住，非本层职责
 */
function matchNoiseCandidates(text: string, candidates: readonly string[]): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const addr of candidates) {
    const lower = addr.toLowerCase();
    if (!seen.has(addr) && tokens.some((tok) => lower.includes(tok))) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

/**
 * apply-feedback 触发（noise-feedback 契约）：把确认后的 add **幂等**并入 overlay 机器文件、**只写 overlay**。
 * add 过滤为字符串（非串丢弃）+ trim+lower+丢空归一（同 loader ingest，使并集去重成立）；读现有 overlay
 * （缺失/读错误→空，overlay 机器可再生）；`added` = 不在现有集的、`already_present` = 已在的（set-union 幂等）；
 * 原子写 tmp+rename（**绝不碰 rules.yaml**）；emit feedback.applied。重发安全：同一 add 再 apply → added=[]。
 */
async function runApplyFeedback(ctx: RunContext, _overrides?: RunOverrides): Promise<void> {
  const add = normalizeFeedbackAdd(ctx.input);
  const overlayPath = resolveNoiseOverlayPath();
  const existing = new Set<string>(readNoiseOverlay(overlayPath));
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const seenInput = new Set<string>();
  for (const s of add) {
    if (seenInput.has(s)) {
      continue; // 同一 add 内去重（避免同一地址重复计入 added/already_present）。
    }
    seenInput.add(s);
    if (existing.has(s)) {
      alreadyPresent.push(s);
    } else {
      existing.add(s);
      added.push(s);
    }
  }
  writeNoiseOverlayAtomic(overlayPath, existing);
  ctx.emit('feedback.applied', { added, already_present: alreadyPresent });
}

/** 从 ctx.input 读确认后的 add（`{ add: string[] }`）：非数组→空；过滤非串；trim+lower+丢空归一。 */
function normalizeFeedbackAdd(input: unknown): string[] {
  const raw =
    input !== null && typeof input === 'object' && 'add' in input
      ? (input as { add: unknown }).add
      : undefined;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * 原子写 overlay（同盘 tmp+rename 原子发布）：写 `<overlay>.tmp` 再 renameSync 覆盖 overlay。
 * 一行一个发件人（无注释纯机器文件）；空集 → 空文件。**绝不碰 rules.yaml**。
 */
function writeNoiseOverlayAtomic(overlayPath: string, entries: Iterable<string>): void {
  const list = [...entries];
  const body = list.length > 0 ? list.join('\n') + '\n' : '';
  const tmp = overlayPath + '.tmp';
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, overlayPath);
}

/**
 * poll 触发（现有 fetch→classify→executeActions→markProcessed 每轮循环，design D2/D5/D7）：
 * 从 run() 主体原样抽出——多触发路由前的**唯一**行为，`ctx.trigger` 为 `'poll'`/undefined 时走此路径。
 */
async function runPoll(ctx: RunContext, overrides?: RunOverrides): Promise<void> {
  const log = ctx.logger;

  // —— config fail-loud（D8）：run() 开头校验并 throw（→ run.failed，受 choke-point+reaper 覆盖）；
  //    **绝不**在模块顶层 process.exit（否则 import 即杀 daemon）。测试可注入 overrides.config 绕过。——
  const config: { GMAIL_CLIENT_ID?: string; GMAIL_CLIENT_SECRET?: string } =
    overrides?.config ?? loadConfig();

  const repo: MailRepo = overrides?.repo ?? new PrismaMailRepo();
  const notifier: Notifier = overrides?.notifier ?? defaultNotifier;
  const classify: ClassifyFn = overrides?.classify ?? ((email) => classifyEmail(email));
  const now: () => number = overrides?.now ?? (() => Date.now());
  const makeProvider =
    overrides?.makeProvider ?? ((accountId: string, gmail: GmailApi) => createGmailProvider(accountId, gmail));

  // §1 scope：Gmail 单账号。加载 enabled 账号、留 gmail。
  const accounts = await loadEnabledAccounts(repo);
  const gmailAccounts = accounts.filter((a): a is GmailAccount => a.provider === 'gmail');
  if (gmailAccounts.length === 0) {
    log.info({ kind: 'inbox-no-gmail-accounts' }, '无 enabled gmail 账号：本轮无邮件可处理');
    return;
  }

  const clientId = config.GMAIL_CLIENT_ID;
  const clientSecret = config.GMAIL_CLIENT_SECRET;
  // gmail client 工厂：默认用 app 凭据 + 账号 refresh token 构造自动 refresh client；测试注入假 GmailApi。
  const makeGmail: (account: GmailAccount) => GmailApi =
    overrides?.makeGmail ??
    ((account: GmailAccount): GmailApi =>
      createGmailClient(account.accountId, {
        clientId: clientId!,
        clientSecret: clientSecret!,
        refreshToken: account.refreshToken,
        // 轮换后的 refreshToken best-effort 回写 DB（不触碰 enabled，见 mailRepo.updateGmailTokens）。
        persistRefreshToken: async (id, refreshToken) => {
          await repo.updateGmailTokens(id, { refreshToken, scopes: account.scopes });
        },
      }));
  if (overrides?.makeGmail === undefined && (clientId === undefined || clientSecret === undefined)) {
    // 缺 gmail app 凭据 → 无法构造 client。非单 run 故障：记日志、run 仍 completed（沿旧「缺键跳过」模式）。
    log.warn(
      { kind: 'inbox-gmail-app-credentials-missing' },
      'GMAIL_CLIENT_ID/SECRET 缺失：跳过 gmail 轮询（run 仍 completed）',
    );
    return;
  }

  const deps: RunDeps = {
    repo,
    notifier,
    classify,
    ctx,
    log,
    now,
    makeGmail,
    makeProvider,
    runDeadline: now() + (overrides?.perRunTimeoutMs ?? PER_RUN_TIMEOUT_MS),
    perEmailTimeoutMs: overrides?.perEmailTimeoutMs ?? PER_EMAIL_TIMEOUT_MS,
    deadLetterMaxRepolls: overrides?.deadLetterMaxRepolls ?? DEAD_LETTER_MAX_REPOLLS,
    deadLetterStalenessMs: overrides?.deadLetterStalenessMs ?? DEAD_LETTER_STALENESS_MS,
    sleep: overrides?.sleep,
  };

  // per-run 内存 suspend set（design D5/§3.3）：本 run 内 break 该账号剩余处理；持久 disable 落 DB（下 run 不再加载）。
  const suspended = new Set<string>();

  for (const account of gmailAccounts) {
    if (suspended.has(account.accountId)) {
      continue; // 本 run 已 suspend（重复账号条目防御）。
    }
    if (now() >= deps.runDeadline) {
      log.warn({ kind: 'inbox-run-deadline' }, 'per-run 墙钟兜底：结束本轮剩余账号（剩余邮件下轮 re-poll）');
      break;
    }
    try {
      await pollGmailAccount(account, deps);
    } catch (err) {
      if (err instanceof ProviderReauthRequired) {
        // 硬 reauth（invalid_grant / scope-403）：**持久** setAccountEnabled(false)（不自愈、防每 tick 猛打
        // token 端点；clear-path = 既有重授权流 updateGmailTokens + setAccountEnabled(true) → listEnabledAccounts
        // 自动重纳入）。本 run 内存 suspend set 只做本 run 内跳过该账号剩余邮件（§3.3）。不重试（executeActions/
        // 读侧遇 reauth 单次命中即抛，绝不 3× 猛打）。
        suspended.add(account.accountId);
        // 持久 disable 落库失败（DB down）**不得**逃逸（否则 run.failed + 账号未 suspend）：本 run 仍靠内存
        // suspend set 跳过该账号 + emit account.suspended，run 照常 completed，下 tick 重试持久化（m5）。
        try {
          await repo.setAccountEnabled(account.accountId, false);
        } catch (persistErr) {
          log.warn(
            { kind: 'inbox-reauth-persist-failed', accountId: account.accountId, code: readErrorCode(persistErr) },
            'reauth 持久 disable 落库失败（DB down）：本 run 仍 suspend + emit account.suspended，下 tick 重试持久化',
          );
        }
        // accountId(=`gmail:<email>`)是**受认可的低敏运营标识**（见 accountRegistry「低敏运营标识,可入日志」）——
        // 运维需知哪个账号要重授权。R8「不含地址」治的是邮件**内容**（sender/subject/body），非运营 accountId。
        ctx.emit('account.suspended', { accountId: account.accountId, reason: 'reauth-required' });
        log.warn(
          { kind: 'inbox-account-suspended', accountId: account.accountId },
          'gmail 账号需重授权：持久 disable（enabled=false）、本 run 跳过、下 run 不再加载（待重授权）',
        );
        continue;
      }
      // 终态 DB I/O / 意外错误（非读侧结束本轮——那在 pollGmailAccount 内已正常返回）：逃出 per-email catch 到此
      // → 本 run suspend 该账号 + emit account.suspended(reason:'terminal-error' 审计——否则 DB 挂掉的 run 在 trace
      // 里与「没邮件可做」的 run 无从区分)、**不** persist setAccountEnabled(false)（瞬时故障不该永久禁用账号；
      // persist 只给硬 reauth，spec §2.1/design §2.3）；继续下账号。read-side terminal → run 仍 completed
      // （design D5：run.failed 只留给真故障，不污染 trace）。
      suspended.add(account.accountId);
      // accountId 是受认可的低敏运营标识（同上 reauth 分支）——供运维定位账号，非邮件内容 PII（R8）。
      ctx.emit('account.suspended', { accountId: account.accountId, reason: 'terminal-error' });
      log.warn(
        { kind: 'inbox-account-round-failed', accountId: account.accountId, code: readErrorCode(err) },
        'gmail 账号本轮意外结束（终态 DB I/O/意外）：本 run suspend、下轮 cron 重试（非持久 disable）',
      );
      continue;
    }
  }
}

/**
 * 一账号一轮：穷尽 is:unread 翻页 → DB 预去重（记 isRevisit）→ 最旧优先(≤get-budget) → 逐封处理。
 * 读侧结束本轮（ReadRoundEnd / list 读错误）→ 正常返回（run 仍 completed）；硬 reauth 上抛给 run() 持久 suspend。
 */
async function pollGmailAccount(account: GmailAccount, deps: RunDeps): Promise<void> {
  const { repo, log } = deps;
  const accountId = account.accountId;
  const gmail = deps.makeGmail(account);
  const provider = deps.makeProvider(accountId, gmail);

  // —— 穷尽翻页 list(q)（纯 id、轻；每页带超时 + best-effort abort + 两级读错误，§3.1/§4.4）——
  const q = buildUnreadQuery(account.processFrom ?? undefined);
  const allIds: string[] = [];
  let pageToken: string | undefined;
  do {
    if (deps.now() >= deps.runDeadline) {
      log.warn({ kind: 'inbox-run-deadline-list', accountId }, 'per-run 墙钟兜底：结束本账号翻页（剩余下轮 re-poll）');
      return;
    }
    const page = await fetchListPage(gmail, q, pageToken, deps.perEmailTimeoutMs, accountId, log);
    if (page === 'end-round') {
      return; // 429/配额/瞬时/超时 → 结束本账号本轮（run 仍 completed）；硬 reauth 已在 fetchListPage 内上抛。
    }
    allIds.push(...page.ids);
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined && pageToken !== '');

  // —— DB 预去重：命中已处理 → 跳过（不 get）；未命中/未处理 → 收集，记 isRevisit（已存-未处理 = 重跑封）。——
  const unprocessed: EmailItem[] = [];
  for (const id of allIds) {
    // per-run 墙钟兜底（M1）：dedup 扫描本身每 id 一次 findByDedupKey；大积压下须能在 runDeadline 处提前退出
    // （已收集的照常处理，剩余下轮 re-poll），否则纯扫描就能跑过 PER_RUN_TIMEOUT_MS 占死 active-lock。
    if (deps.now() >= deps.runDeadline) {
      log.warn(
        { kind: 'inbox-run-deadline-dedup', accountId },
        'per-run 墙钟兜底：结束本账号 dedup 扫描（已收集照常处理，剩余下轮 re-poll）',
      );
      break;
    }
    const existing = await repo.findByDedupKey(accountId, id);
    if (existing !== null && existing.processedAt !== null) {
      continue;
    }
    // existing !== null（且 processedAt === null）= 已存-未处理封（上轮 notify 耗尽/超时/classify 崩留下）= 重跑封。
    // 携带既存行（id + receivedAt）供入口死信门在 get 前评估（M2）。
    unprocessed.push({
      providerMessageId: id,
      isRevisit: existing !== null,
      ...(existing !== null ? { existing: { id: existing.id, receivedAt: existing.receivedAt } } : {}),
    });
  }
  // 最旧优先（list 最新优先故逆序），取至 get 预算。
  const toProcess = unprocessed.reverse().slice(0, GET_BUDGET);

  const emailDeps: EmailDeps = {
    gmail,
    provider,
    accountId,
    accountLabel: account.accountLabel,
    repo,
    notifier: deps.notifier,
    classify: deps.classify,
    ctx: deps.ctx,
    log,
    now: deps.now,
    perEmailTimeoutMs: deps.perEmailTimeoutMs,
    deadLetterMaxRepolls: deps.deadLetterMaxRepolls,
    deadLetterStalenessMs: deps.deadLetterStalenessMs,
    sleep: deps.sleep,
  };
  for (const item of toProcess) {
    if (deps.now() >= deps.runDeadline) {
      log.warn(
        { kind: 'inbox-run-deadline-email', accountId },
        'per-run 墙钟兜底：结束本账号剩余邮件（剩余下轮 re-poll、受死信门封顶）',
      );
      return;
    }
    try {
      await processOneWithTimeout(item, emailDeps);
    } catch (err) {
      if (err instanceof ReadRoundEnd) {
        log.warn(
          { kind: 'inbox-read-round-end', accountId },
          '读侧 get 429/配额/瞬时：结束本账号本轮（不逐封 skip 继续加剧限流）',
        );
        return; // 结束本轮（run 仍 completed）。
      }
      throw err; // ProviderReauthRequired → 上抛给 run() 持久 suspend。
    }
  }
}

/**
 * 取一页 list（带超时 + best-effort abort + 两级读错误分层，§3.1/§4.4）：
 *   - 超时 → 结束本轮（'end-round'）。
 *   - reauth（401/scope-403/invalid_grant）→ throwReauth（上抛给 run() 持久 suspend）。
 *   - 其余读错误（429/配额/瞬时/坏响应）→ 结束本轮（不继续翻页加剧限流）。
 *   - 成功 → 返回本页 ids + nextPageToken。
 */
async function fetchListPage(
  gmail: GmailApi,
  q: string,
  pageToken: string | undefined,
  timeoutMs: number,
  accountId: string,
  log: Logger,
): Promise<{ ids: string[]; nextPageToken: string | undefined } | 'end-round'> {
  const controller = new AbortController();
  const call = gmail.users.messages.list({ userId: 'me', q, pageToken, signal: controller.signal });
  const raced = await raceTimeout(call, timeoutMs, controller);
  if (raced.kind === 'timeout') {
    log.warn({ kind: 'inbox-list-timeout', accountId }, 'list 页超时：结束本账号本轮（best-effort abort）');
    return 'end-round';
  }
  if (raced.kind === 'err') {
    const cls = classifyReadError(raced.error);
    if (cls === 'reauth') {
      throwReauth(accountId, raced.error); // → ProviderReauthRequired（上抛给 run() 持久 suspend）。
    }
    log.warn(
      {
        kind: 'inbox-list-read-error',
        accountId,
        code: readErrorCode(raced.error),
        status: readHttpStatus(raced.error),
      },
      '读侧 list 429/配额/瞬时/坏响应：结束本账号本轮（不继续翻页加剧限流）',
    );
    return 'end-round';
  }
  const ids: string[] = [];
  for (const m of raced.value.data.messages ?? []) {
    if (typeof m.id === 'string' && m.id.length > 0) {
      ids.push(m.id);
    }
  }
  return { ids, nextPageToken: raced.value.data.nextPageToken ?? undefined };
}

type EmailDeps = {
  gmail: GmailApi;
  provider: ProviderActions;
  accountId: string;
  accountLabel?: string;
  repo: MailRepo;
  notifier: Notifier;
  classify: ClassifyFn;
  ctx: RunContext;
  log: Logger;
  now: () => number;
  perEmailTimeoutMs: number;
  deadLetterMaxRepolls: number;
  deadLetterStalenessMs: number;
  sleep?: (ms: number) => Promise<void>;
};

type EmailItem = {
  providerMessageId: string;
  isRevisit: boolean;
  /**
   * 重跑封（isRevisit=true）携带的既存行（id + receivedAt）：供**死信门在 get 前**评估
   * （计数≥K ∨ receivedAt 超 staleness），使 get/map/normalize 反复良性失败的重跑封仍能推进计数、终态死信
   * （design D3 §2.3；否则门在 get 之后，get 抛则永不 dead-letter）。首访封为 undefined。
   */
  existing?: { id: string; receivedAt: Date };
};

/**
 * 单封处理 + per-email 超时（design D7 §4.4）：
 *   - 正常完成 → 返回。
 *   - 超时 → 设 fence.aborted（work 若仍在途、其后续 emit/markProcessed 被 fence 挡住）+ best-effort abort
 *     底层 gmail 调用 + 吞被弃诺（raceTimeout 内已吞）→ skip 该封、下轮 re-poll（受死信门封顶）。
 *   - `ProviderReauthRequired`（账号级）/ `ReadRoundEnd`（读侧结束本轮）→ 逃出（pollGmailAccount/run() 处理）。
 *   - 良性（get/map/normalize/classify 失败）→ skip 该封 continue。
 */
async function processOneWithTimeout(item: EmailItem, deps: EmailDeps): Promise<void> {
  const fence: Fence = { aborted: false };
  const controller = new AbortController();
  const work = processOneEmail(item, fence, controller.signal, deps);
  const raced = await raceTimeout(work, deps.perEmailTimeoutMs, controller);
  if (raced.kind === 'timeout') {
    // fence：超时后释放锁前禁止 work 晚到 resolve/reject 再对该封 emit/markProcessed/发副作用（design D7）。
    fence.aborted = true;
    deps.log.warn(
      { kind: 'inbox-email-timeout', providerMessageId: item.providerMessageId },
      'per-email 超时：放弃本封、下轮 re-poll（best-effort 已 abort；fence 挡晚到副作用）',
    );
    return;
  }
  if (raced.kind === 'err') {
    const err = raced.error;
    if (err instanceof ProviderReauthRequired || err instanceof ReadRoundEnd) {
      throw err; // 逃出到账号级 / 读侧结束本轮。
    }
    if (err instanceof BenignEmailError) {
      // 良性失败（get/map/normalize/classify 崩）→ skip 该封 continue（下轮 re-poll、DB 去重兜底）。
      deps.log.warn(
        {
          kind: 'inbox-email-failed',
          providerMessageId: item.providerMessageId,
          code: err.code,
          errorName: err.errorName,
        },
        '单封 get/map/normalize/classify 失败：跳过该封（下轮 re-poll、DB 去重兜底）',
      );
      return;
    }
    // 终态 DB I/O / 意外错误（saveEmail/gate/markProcessed 抛等）：逃出该 catch → 账号级处理（结束本账号本轮），
    // **禁止**当作「skip 一封」（design D2 M-B / spec §2.1 作用域纪律）。
    throw err;
  }
  // kind === 'ok'：正常完成。
}

/**
 * 单封：重跑封入口死信门（get 前）→ get → 分类（复用/LLM）→ executeActions → emit → markProcessed
 * （design D2/D3/D4）。良性错误上抛给 processOneWithTimeout skip；reauth / 读侧结束本轮上抛逃逸。fence 在每个
 * 副作用前 fence（D7）。
 */
async function processOneEmail(
  item: EmailItem,
  fence: Fence,
  signal: AbortSignal,
  deps: EmailDeps,
): Promise<void> {
  const { providerMessageId, isRevisit, existing } = item;
  const { gmail, provider, accountId, accountLabel, repo, notifier, classify, ctx, now } = deps;

  // —— 死信终态门在**重跑封入口**（get 之前）评估（design D3 §2.3）：仅对已存-未处理封（isRevisit）用**既存行**
  //    的 repollCount + receivedAt 判 `计数≥K ∨ 超 staleness`——门在最开头 ⇒ 封顶所有已落库成因（notify 耗尽 /
  //    saveEmail 后 timeout / classify 崩），且 get/map/normalize 反复良性失败的重跑封也能推进计数、终态死信
  //    （门若在 get 之后、get 抛则永不 dead-letter）。命中 → dead_letter（前）+ markProcessed（后）、**不 get**；
  //    未命中 → 计数 +1 再 get。首访封（isRevisit=false）不评估、不计数。——
  if (isRevisit && existing !== undefined) {
    const rowId = existing.id;
    // stale 纯内存判（用既存行 receivedAt），**先于且短路** getRepollCount：持续 hang/err 的 getRepollCount
    // （即便 statement_timeout 每 tick 报错）不得让 staleness 终态永不触发（RC r2）。Number.isFinite 守坏
    // receivedAt（仅 InMemory 测试可达；Prisma NOT NULL 列写时拒非法 Date）→ 不误判 stale。
    const receivedMs = existing.receivedAt.getTime();
    const stale = Number.isFinite(receivedMs) && now() - receivedMs > deps.deadLetterStalenessMs;
    const repollCount = stale ? 0 : await repo.getRepollCount(rowId);
    if (stale || repollCount >= deps.deadLetterMaxRepolls) {
      if (fence.aborted) {
        return;
      }
      // 门命中：emit email.dead_letter（SQLite 审计）**在前** → markProcessed（Postgres）最后写（R7：崩在二者
      // 之间的最坏情形是下轮 re-poll 门再命中、多一条冗余审计行，**非**缺终态）。stale 优先（短路未读 count）。
      const reason = stale ? 'stale' : 'max-attempts';
      ctx.emit('email.dead_letter', { messageRowId: rowId, providerMessageId, reason });
      if (fence.aborted) {
        return;
      }
      await repo.markProcessed(rowId);
      return; // 门命中：不 get。
    }
    if (fence.aborted) {
      return; // m4：incrementRepollCount 前 fence（对齐其它副作用；防超时后晚到重跑封双计 → 早死信）。
    }
    await repo.incrementRepollCount(rowId); // 未命中 → +1 再跑。
  }

  // —— get → map → normalize（带 best-effort abort signal；两级读错误分层，§3.1）——
  let email: NormalizedEmail;
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id: providerMessageId, format: 'full', signal });
    email = normalizeEmail(toRawEmail(res.data, accountId, accountLabel));
  } catch (err) {
    const cls = classifyReadError(err);
    if (cls === 'reauth') {
      throwReauth(accountId, err); // → ProviderReauthRequired（逃出到账号级持久 suspend）。
    }
    if (cls === 'end-round') {
      throw new ReadRoundEnd(); // 429/配额/瞬时 403 → 结束本账号本轮。
    }
    throw new BenignEmailError(err); // 良性（坏 MIME/normalize 抛 / 缺 From / 瞬时坏响应 / 5xx message-specific 500）→ 调用方 skip 该封。
  }

  // fence（get 若曾 hung、超时后晚到 resolve）：释放锁前禁止落库/后续副作用。
  if (fence.aborted) {
    return;
  }

  // 落库拿 rowId（幂等 upsert：重跑封复用未处理行〔= existing.id〕；落库前失败无行——每 tick 重取 skip）。
  const stored = await repo.saveEmail(email);
  const messageRowId = stored.id;

  // —— 分类：re-poll 命中已存分类 → 跳 LLM **且跳 saveClassification**（append-only，否则每 tick 追加重复行，
  //    design D4）；无分类（首访 / classify 崩过）→ 重 LLM + saveClassification。——
  let decision = await repo.getClassification(messageRowId);
  if (decision === null) {
    let classification: Classification;
    try {
      classification = await classify(email);
    } catch (err) {
      throw new BenignEmailError(err); // classify 崩 → 良性 skip 该封（下轮 re-poll、DB 去重兜底）。
    }
    if (fence.aborted) {
      return; // fence（classify 若曾 hung、超时后晚到 resolve）：禁止 saveClassification/执行动作。
    }
    decision = applySafetyRules(email, classification);
    await repo.saveClassification(messageRowId, classification, decision);
  }

  // fence：禁止执行动作（notify 是发副作用；超时后晚到不得多发一次 notify，design D7）。
  if (fence.aborted) {
    return;
  }

  // —— 自动动作（design D2）：reflect_priority → notify → mark_read，结果回传供 emit + 分支 markProcessed。——
  const result = await executeActions(email, decision, { notifier, provider, signal, sleep: deps.sleep });

  // fence：禁止 emit（晚到写已完成的 run，design D7）。emit payload 只带**非 PII** 标识（messageRowId/providerMessageId）。
  if (fence.aborted) {
    return;
  }
  // reflect（best-effort 审计；§2.1 耗尽不阻 notify）。
  if (result.reflect === 'ok') {
    ctx.emit('reflect.ok', { messageRowId, providerMessageId });
  } else if (result.reflect === 'failed') {
    ctx.emit('reflect.failed', { messageRowId, providerMessageId });
  }
  // notify（在重试之外——每封至多一条非幂等 notify 审计，R8 SA-m1）。
  if (result.notify === 'sent') {
    ctx.emit('notify.sent', { messageRowId, providerMessageId });
  } else if (result.notify === 'skipped') {
    ctx.emit('notify.skipped', { messageRowId, providerMessageId });
  } else if (result.notify === 'failed') {
    ctx.emit('notify.failed', { messageRowId, providerMessageId });
  }
  // mark_read（best-effort 审计）。
  if (result.markRead === 'ok') {
    ctx.emit('mark_read.ok', { messageRowId, providerMessageId });
  } else if (result.markRead === 'failed') {
    ctx.emit('mark_read.failed', { messageRowId, providerMessageId });
  }

  // fence：禁止 markProcessed（晚到写已完成的 run，design D7）。
  if (fence.aborted) {
    return;
  }
  // markProcessed 除非 notify 耗尽（design D3：留 unread → 下轮 cron re-poll 重发，受死信门封顶 §2.3）。
  if (!result.notifyExhausted) {
    await repo.markProcessed(messageRowId);
  }
}

/**
 * Gmail list 查询：`is:unread`；processFrom 非空合取 `after:<floor(epoch 秒)>`（成本下界，design D5 §3.2）。
 * NULL/缺省 → 全量 `is:unread`（dedup 兜底重复）。
 */
function buildUnreadQuery(processFrom: Date | undefined): string {
  if (processFrom === undefined) {
    return 'is:unread';
  }
  return `is:unread after:${Math.floor(processFrom.getTime() / 1000)}`;
}
