// rules-config 加载器（design 决策 2/3/4、spec rules-config）。
//
// 职责：读 rules/rules.yaml（路径可经 env RULES_FILE 覆盖）→ yaml 解析 → zod 校验为
// 五类可配置名单 → 整集并集（security）/逐项回落 → 同步访问器 getActiveRules() 暴露快照 ref。
// 热重载（mtime 轮询）在后台两阶段原子发布。
//
// 不可违反的约束（逐条对应 spec）：
//   - 验证码关键词 VERIFICATION_KEYWORDS / 敏感类别集 SENSITIVE_CATEGORIES **不在 schema**、
//     保持代码内置、绝不经 YAML 覆盖（守 §12.1 与类别轴硬约束）。
//   - security_keywords 有效集 = **整个内置 SECURITY_PAYMENT_KEYWORDS ∪ YAML**（只增不减、非子集）；
//     operator 配空/缺词/标量时全部内置词仍生效。
//   - 同步初始化：模块加载时 security_keywords 同步默认 = 整个内置 SECURITY_PAYMENT_KEYWORDS
//     （即「内置整集 ∪ 空」，禁止初始化为空待异步并集——否则首次异步加载前 security 守卫失效）。
//   - 两阶段原子发布：先逐项校验+替换装配完整候选快照、再一次性原子替换 ref（构建未完成不切 ref）。
//   - 绝不崩 + 绝不泄露：读取/解析抛任意 fs 错误（ENOENT/EACCES/EISDIR…）/某项非法 → 逐项回落 +
//     脱敏日志（只 kind+项名+zod issue.path；禁 issue.message/received/解析节点/文件内容/任何解析值）；
//     非 strict、未知键（含凭据形态键）静默丢弃；禁止枚举被丢弃键名（键本身可能是密钥）、至多记数量。

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { logger } from '../logger.js';
import { SECURITY_PAYMENT_KEYWORDS } from './lists.js';

// 本模块所有日志经此最小 sink（只用到 .warn）。默认转发给共享 logger（生产行为不变）；
// 测试经 setRulesConfigLoggerForTest 注入捕获型 sink 断言「凭据/解析值/丢弃键名绝不入日志」——
// 共享 pino logger 直写 fd1（绕过 process.stdout.write），无法在测试中可靠拦截，故引入此注入 seam。
type WarnSink = { warn: (obj: Record<string, unknown>, msg: string) => void };
let logSink: WarnSink = { warn: (obj, msg) => logger.warn(obj, msg) };

/** 五类可配置名单的有效快照（getActiveRules 返回此形状的 ref；属性 + 数组皆 readonly 并 Object.freeze，
 *  防消费者经重赋值/强转改动这个全局安全策略快照——见 assembleActive 的冻结）。 */
export type ActiveRules = {
  /** 有效集 = 整个内置 SECURITY_PAYMENT_KEYWORDS ∪ YAML（只增不减）。 */
  readonly securityKeywords: readonly string[];
  /** 可选、非决定性域名轴；内置默认空（项目不维护域名白名单）。 */
  readonly neverMarkReadDomains: readonly string[];
  readonly vipSenders: readonly string[];
  readonly importantDomains: readonly string[];
  readonly marketingKeywords: readonly string[];
};

// rules.yaml 默认路径（仓库根 rules/rules.yaml），可经 env RULES_FILE 覆盖。
// 本文件位于 <repo>/src/rules/rulesConfig.ts → 默认指向 <repo>/rules/rules.yaml。
const DEFAULT_RULES_PATH = fileURLToPath(new URL('../../rules/rules.yaml', import.meta.url));

// ponytail: 256KB cap on operator-local rules.yaml — bounds sync parse cost; over-limit → carry-forward; raise or stream-parse if operators need huge lists
const MAX_RULES_FILE_BYTES = 256 * 1024;

function resolveRulesPath(): string {
  const fromEnv = process.env.RULES_FILE;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_RULES_PATH;
}

// —— zod schema（每项独立校验，使「某项非法仅该项回落、其余生效」成立）——
// 关键：**不**做整对象 safeParse——否则某项非法会使整对象校验失败、连累合法项一起回落，
// 违背「仅该项回落」语义。改为：顶层只确认是 object（按名只读五类已知键、未知键不读 = 丢弃），
// 每个已知键各自独立 z.array(z.string()).safeParse（见 validateField）。
// 「不含 verification/sensitive_categories」由「只按这五个键名读取」天然落地——其余键名永不被读。
const stringArray = z.array(z.string());

// 五类可配置名单的键名（只读这些键；未知键含凭据形态键一律不读 = 静默丢弃）。
const KNOWN_KEYS = [
  'vip_senders',
  'important_domains',
  'marketing_keywords',
  'security_keywords',
  'never_mark_read_domains',
] as const;

/**
 * zod issue.path 脱敏 helper（沿用 classifyEmail.ts 的 zodIssuePaths 纪律）。
 * 只取连接后的路径字符串（root 记为 '(root)'）——绝不取 issue.message / received /
 * 被解析节点 / 任何解析出的值（防凭据/PII 经错误对象入日志）。
 * classifyEmail.ts 未导出该 helper，故在此本地复刻这个小函数（不编辑 classifyEmail.ts）。
 */
function zodIssuePaths(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.join('.') || '(root)');
}

// —— 上一次有效值（carry-forward 用）——
// security 的「上一次有效值」定义为 **operator 原始 YAML 列表**（发布时与内置整集重新求并集）；
// 故内置词永不丢、operator 已加词在坏重载中存活。首次无上一次值 → 内置默认（security 用空列表叠加内置整集）。
type LastValid = {
  securityYaml: readonly string[]; // operator 原始 YAML security 列表（不含内置）；默认空。
  neverMarkReadDomains: readonly string[];
  vipSenders: readonly string[];
  importantDomains: readonly string[];
  marketingKeywords: readonly string[];
};

function builtinLastValid(): LastValid {
  return {
    securityYaml: [],
    neverMarkReadDomains: [],
    vipSenders: [],
    importantDomains: [],
    marketingKeywords: [],
  };
}

/** 由 LastValid 装配出对外的 ActiveRules（security 与内置整集求并集）。 */
function assembleActive(last: LastValid): ActiveRules {
  // 深冻结：消费者拿到的快照（及每个数组）不可变——防经重赋值/强转污染这个驱动「不标已读」裁定的全局策略。
  // 单一工厂处冻结即覆盖全部赋值点（同步初始化 / publish / resetForTest）。数组皆复制后冻结，不动 LastValid 的 carry-forward 内部数组。
  return Object.freeze({
    securityKeywords: Object.freeze(unionSecurity(last.securityYaml)),
    neverMarkReadDomains: Object.freeze([...last.neverMarkReadDomains]),
    vipSenders: Object.freeze([...last.vipSenders]),
    importantDomains: Object.freeze([...last.importantDomains]),
    marketingKeywords: Object.freeze([...last.marketingKeywords]),
  });
}

/** security 整集并集：整个内置常量 ∪ YAML（去重、保持确定顺序：内置在前、YAML 新增在后）。 */
function unionSecurity(yamlWords: readonly string[]): readonly string[] {
  const seen = new Set<string>(SECURITY_PAYMENT_KEYWORDS);
  const out: string[] = [...SECURITY_PAYMENT_KEYWORDS];
  for (const w of yamlWords) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

// —— 模块内可变状态（单一权威 ref + carry-forward 源）——
// 同步初始化：security = 内置整集（经 assembleActive 由空 securityYaml 并集得到）、其余空。
let lastValid: LastValid = builtinLastValid();
let activeRules: ActiveRules = assembleActive(lastValid);

/** 同步访问器：返回当前内存有效快照 ref（applySafetyRules 同步读此）。 */
export function getActiveRules(): ActiveRules {
  return activeRules;
}

// —— 单字段校验（逐项 safeParse，使「某项非法仅该项回落」成立）——
// 对每项独立做 z.array(z.string()).safeParse：合法→取值；非法/缺失→由调用方 carry-forward。
type FieldResult =
  | { ok: true; value: string[] }
  | { ok: false; paths: string[] };

function validateField(raw: unknown): FieldResult {
  const parsed = stringArray.safeParse(raw);
  if (parsed.success) {
    // 归一每个 YAML 列表项：trim + toLowerCase + 丢空（引擎只小写 email 侧，故需在 ingest 把列表项也归一，
    // 否则 operator 写大小写/含空白的项会静默不匹配——security_keywords 即 safety false-green）。
    return { ok: true, value: parsed.data.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0) };
  }
  return { ok: false, paths: zodIssuePaths(parsed.error) };
}

// 文件读取/解析的结果：要么拿到一个 object（逐项再校验），要么整体失败（全 carry-forward）。
type LoadOutcome =
  | { ok: true; obj: Record<string, unknown> }
  | { ok: false; kind: 'fs-error' | 'parse-error' | 'shape-error' | 'too-large' };

/**
 * 读文件 + yaml 解析 + 顶层 shape 校验（非 strict：未知键丢弃、绝不读取）。
 * 任意 fs 错误（ENOENT/EACCES/EISDIR…）/解析失败/顶层非 object → 整体失败（调用方全 carry-forward）。
 * 绝不抛、绝不泄露：catch 不取 err 的任何字段（message/path 可能含路径/凭据）。
 */
function loadFile(path: string): LoadOutcome {
  // 大小上限：statSync 取字节数与上限比较；超限 → carry-forward（不读不解析，避免同步 parse 阻塞 event loop）。
  // statSync 抛错（如文件不存在）落回既有 'fs-error' carry-forward。
  try {
    if (statSync(path).size > MAX_RULES_FILE_BYTES) {
      return { ok: false, kind: 'too-large' };
    }
  } catch {
    return { ok: false, kind: 'fs-error' };
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // ENOENT/EACCES/EISDIR 等全 catch；不取 err 任何字段（绝不泄露路径/凭据）。
    return { ok: false, kind: 'fs-error' };
  }

  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return { ok: false, kind: 'parse-error' };
  }

  // 顶层必须是 plain object（非数组、非 null/标量）。空文件/纯注释 → null/undefined → shape-error
  // → 退化为「全字段缺失/全 carry-forward」（不丢 operator 守卫）。
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, kind: 'shape-error' };
  }

  // 非 strict：**只按名读取**五类已知键、未知键（含凭据形态键）绝不读取 = 静默丢弃。
  // 逐项独立校验在 resolveField 内（某项非法仅该项回落）。
  const src = doc as Record<string, unknown>;
  const obj: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    if (key in src) {
      obj[key] = src[key];
    }
  }
  return { ok: true, obj };
}

/**
 * 两阶段构建 + 原子发布（design 决策 2、spec「构建后原子发布」）。
 * 阶段一：逐项校验+替换装配出完整候选 LastValid（某项非法/缺失 → carry-forward 该字段上一次有效值）。
 * 阶段二：一次性原子替换 lastValid + activeRules ref（构建未完成绝不切 ref）。
 *
 * 返回是否发生发布（用于测试/日志），但发布本身已落在 module 状态。
 * 绝不抛：所有错误已在 loadFile / validateField 内被收敛为「该项回落 + 脱敏日志」。
 */
function buildAndPublish(path: string): void {
  const prev = lastValid;
  const outcome = loadFile(path);

  if (!outcome.ok) {
    // 整文件读取/解析/shape 失败 → 全字段 carry-forward（退化情形，不回落空/builtin 丢 operator 守卫）。
    // 记脱敏日志：只 kind；绝不记路径/文件内容/err 字段。
    logSink.warn({ kind: 'rules-config-load-failed', cause: outcome.kind }, 'rules.yaml 加载失败，全字段 carry-forward');
    // 候选 = prev（全 carry-forward）；与当前一致时 ref 切换是无害的等价替换。
    publish(prev);
    return;
  }

  const obj = outcome.obj;
  // 逐项构建（缺失键 raw 为 undefined → safeParse 失败 → carry-forward）。
  const candidate: LastValid = {
    securityYaml: resolveField('security_keywords', obj.security_keywords, prev.securityYaml),
    neverMarkReadDomains: resolveField('never_mark_read_domains', obj.never_mark_read_domains, prev.neverMarkReadDomains),
    vipSenders: resolveField('vip_senders', obj.vip_senders, prev.vipSenders),
    importantDomains: resolveField('important_domains', obj.important_domains, prev.importantDomains),
    marketingKeywords: resolveField('marketing_keywords', obj.marketing_keywords, prev.marketingKeywords),
  };

  publish(candidate);
}

/** 单字段：合法→取 YAML 值；缺失/非法→carry-forward 上一次有效值 + 脱敏日志（只 kind+项名+issue.path）。 */
function resolveField(name: string, raw: unknown, carryForward: readonly string[]): readonly string[] {
  if (raw === undefined) {
    // 缺失（含整文件无此键）→ carry-forward，无需记日志（缺失是合法的「未配置」常态）。
    return carryForward;
  }
  const res = validateField(raw);
  if (res.ok) {
    return res.value;
  }
  // 非法（如标量/数组含非字符串）→ carry-forward + 脱敏日志：只 kind+项名+issue.path。
  logSink.warn(
    { kind: 'rules-config-field-invalid', field: name, issuePaths: res.paths },
    'rules.yaml 某项非法，回落上一次有效值',
  );
  return carryForward;
}

/** 阶段二：一次性原子替换 lastValid + activeRules ref。 */
function publish(candidate: LastValid): void {
  lastValid = candidate;
  activeRules = assembleActive(candidate);
}

// —— 初次同步加载（模块加载时即跑一次，使 getActiveRules 反映 rules.yaml）——
// 注意：同步初始化 activeRules 已在上面赋为「内置整集 ∪ 空」；此处再同步跑一次实际加载，
// 使首次 getActiveRules 即反映文件内容。失败已被 buildAndPublish 收敛（不崩、carry-forward）。
buildAndPublish(resolveRulesPath());

// ====================================================================
// 热重载（mtime 轮询、两阶段原子发布、poll tick 自愈）——task 2.x
// ====================================================================

/** 可注入 seam（便于单测直调重载、不依赖真 timing）。 */
export type ReloadDeps = {
  /** rules.yaml 路径，默认 resolveRulesPath()。 */
  path?: string;
  /** 取文件 mtimeMs；默认 statSync。注入便于测试不依赖真 fs timing。 */
  statMtimeMs?: (path: string) => number;
  /** 定时器注入（默认 setInterval/clearInterval）；注入假时钟便于单测。 */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
};

/** startRulesConfigReload 返回的可停止句柄。 */
export type RulesReloadHandle = {
  /** 停止轮询（优雅关闭时调用）。 */
  stop: () => void;
  /** 直接触发一次重载 tick（测试 seam：不依赖真 timing 即可驱动重载）。 */
  reloadNow: () => void;
};

/**
 * 启动 rules.yaml 热重载（mtime 轮询 → 检测变更 → 两阶段原子发布）。
 * - carry-forward：某字段缺失/非法 → carry-forward 上一次有效值；整文件坏/删 = 全 carry-forward；
 *   security 上一次有效值 = operator 原始 YAML 列表，发布时与内置整集重新求并集（内置词永不丢）。
 * - poll tick 自愈：每次 tick 自捕获其错误（含 fs.stat 失败）、记脱敏日志、保持轮询存活——
 *   一次 tick 出错绝不使后续重载永久失效。
 *
 * // ponytail: mtime 秒级——同秒两连改可能漏第二次、下次任意变更追上
 */
export function startRulesConfigReload(deps: ReloadDeps = {}): RulesReloadHandle {
  const path = deps.path ?? resolveRulesPath();
  const statMtimeMs = deps.statMtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  const setIntervalFn = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  // 记初次加载时的 mtime（取不到——如文件不存在——记 undefined，下次出现即触发重载）。
  let lastMtimeMs: number | undefined = safeStatMtime(statMtimeMs, path);

  const tick = (): void => {
    // poll tick 自愈：整 tick 包在 try/catch，任何错误（含 stat 失败）只记日志、不抛、轮询存活。
    try {
      const mtime = statMtimeMs(path);
      if (lastMtimeMs === undefined || mtime !== lastMtimeMs) {
        lastMtimeMs = mtime;
        buildAndPublish(path);
      }
    } catch {
      // fs.stat 失败（如文件被删）：记脱敏日志（只 kind），保持轮询；
      // 同时触发一次 buildAndPublish 使「文件被删」走全 carry-forward（不丢 operator 守卫）。
      // lastMtimeMs 置 undefined：文件重新出现时（任意 mtime）即被视为变更、重载。
      if (lastMtimeMs !== undefined) {
        lastMtimeMs = undefined;
        logSink.warn({ kind: 'rules-config-stat-failed' }, 'rules.yaml stat 失败，全字段 carry-forward，轮询继续');
        safeBuildAndPublish(path);
      }
    }
  };

  // ponytail: 固定 1000ms 轮询；测试经 setIntervalFn 注入假时钟、不依赖此值
  const handle = setIntervalFn(tick, 1000);
  // unref 使该定时器不阻止进程退出（与 scheduler 句柄一致的优雅关闭语义）。
  if (handle !== null && typeof handle === 'object' && 'unref' in handle && typeof (handle as { unref?: unknown }).unref === 'function') {
    (handle as { unref: () => void }).unref();
  }

  return {
    stop: () => clearIntervalFn(handle),
    reloadNow: () => tick(),
  };
}

/** stat 取 mtime，失败返回 undefined（不抛）——用于初次记基线。 */
function safeStatMtime(statMtimeMs: (path: string) => number, path: string): number | undefined {
  try {
    return statMtimeMs(path);
  } catch {
    return undefined;
  }
}

/** buildAndPublish 的自捕获包装（buildAndPublish 已不抛，此为额外防线）。 */
function safeBuildAndPublish(path: string): void {
  try {
    buildAndPublish(path);
  } catch {
    // buildAndPublish 设计上不抛；此处兜底使 poll tick 永不因此死亡。
  }
}

/**
 * 测试 seam：直接以指定路径触发一次两阶段构建+发布（不经轮询/timing）。
 * 供单测断言「改 YAML 后 getActiveRules 反映新值」「坏重载 carry-forward」。
 */
export function reloadRulesConfigForTest(path: string): void {
  buildAndPublish(path);
}

/**
 * 测试 seam：把内存状态重置为同步初始化态（内置整集 ∪ 空、其余空）。
 * 供单测隔离（避免前一用例的 carry-forward 残留泄漏到下一用例）。
 */
export function resetRulesConfigForTest(): void {
  lastValid = builtinLastValid();
  activeRules = assembleActive(lastValid);
}

/**
 * 测试 seam：注入捕获型 warn sink，断言「凭据/解析值/丢弃键名绝不入日志」。
 * 传 null 还原为默认（转发共享 logger）。
 */
export function setRulesConfigLoggerForTest(sink: WarnSink | null): void {
  logSink = sink ?? { warn: (obj, msg) => logger.warn(obj, msg) };
}
