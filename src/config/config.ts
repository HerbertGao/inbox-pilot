import 'dotenv/config';

// 有副作用的配置入口（migration §1.6 / design D8）：顶层 `import 'dotenv/config'`（填充 process.env，幂等）。
//
// **模块顶层禁 process.exit / throw**（D8：脊柱 daemon 经 import() in-process 加载 pilot，模块顶层
// 自杀会在加载即杀死整个 daemon、绕过 D7 fence/reaper）。故：
//   - `config` 改为**惰性 Proxy**——首次属性读时 memoize 一次 `safeParse(process.env)`；**校验失败不
//     exit/不 throw**，读到任一字段返回 `undefined`（模块顶层构造如 defaultNotifier 读到 undefined → 优雅
//     降级，不崩）。既有 `config.X` 读法不变。
//   - `loadConfig()`：**由 `run(ctx)` 开头显式调用**，校验失败 **throw**（→ `run.failed`，受 choke-point +
//     reaper 覆盖）而非 exit。standalone CLI 入口亦可显式调它 fail-fast。
//
// 纯 schema / 校验器（configSchema / isValidGmailRedirectUri / isGmailOnboardingAvailable / Config）
// 仍住无副作用的 ./configSchema.js；此处 re-export 使既有 importer 不变。

import {
  configSchema,
  isGmailOnboardingAvailable,
  isValidGmailRedirectUri,
  type Config,
} from './configSchema.js';
import type { z } from 'zod';

export {
  configSchema,
  isGmailOnboardingAvailable,
  isValidGmailRedirectUri,
  type Config,
};

type ParseState =
  | { ok: true; config: Config }
  | { ok: false; error: z.ZodError };

let memo: ParseState | undefined;

/** memoize 一次 safeParse（不 exit/不 throw）。首次属性读或 loadConfig() 触发。 */
function parseOnce(): ParseState {
  if (memo === undefined) {
    const parsed = configSchema.safeParse(process.env);
    memo = parsed.success
      ? { ok: true, config: Object.freeze(parsed.data) }
      : { ok: false, error: parsed.error };
  }
  return memo;
}

/** 仅供测试：清空 memo（否则跨用例读到首个进程 env 的缓存结果）。 */
export function _resetConfigCacheForTest(): void {
  memo = undefined;
}

/**
 * 校验 config 并返回冻结结果；**失败 throw**（含字段级 issue、不含密钥值）——由 `run(ctx)` 开头调用
 * （→ `run.failed`），或 standalone CLI 入口显式 fail-fast。**绝不 process.exit**（D8）。
 */
export function loadConfig(): Config {
  const state = parseOnce();
  if (!state.ok) {
    const details = state.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`环境配置校验失败：${details}`);
  }
  return state.config;
}

/**
 * 惰性 config：属性读经 memoize 的 safeParse。**校验有效** → 返回真值；**校验无效** → 返回 `undefined`
 * （不 throw/不 exit，保 D8：模块顶层读不杀 daemon；真正的 fail-loud 由 run() 调 loadConfig()）。
 */
export const config: Config = new Proxy({} as Config, {
  get(_target, prop: string | symbol): unknown {
    const state = parseOnce();
    if (!state.ok || typeof prop === 'symbol') {
      return undefined;
    }
    return (state.config as Record<string, unknown>)[prop];
  },
  has(_target, prop: string | symbol): boolean {
    const state = parseOnce();
    return state.ok && typeof prop === 'string' && prop in state.config;
  },
});
