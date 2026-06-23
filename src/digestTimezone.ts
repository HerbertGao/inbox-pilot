// 摘要调度器时区解析（deploy-operability 决策 4）。
// 抽成独立模块以便单测直接 import（main.ts 在 import 时即 app.listen，不可被测试 import）。

// 摘要调度器时区的文档化默认值（与 .env.example 推荐值一致）。
export const DEFAULT_DIGEST_TIMEZONE = 'Asia/Shanghai';

/**
 * 解析摘要调度器时区。`TZ` 默认值归属应用：未设置 / 为空字符串 / 纯空白时（先 trim）
 * 回退到文档化默认，并发一次性 `tz-fallback-default` 告警使该回退可观测
 *（deploy-operability 决策 4）。compose 不再注入 `TZ` 默认，故未设置 / 为空 / 纯空白的
 * `TZ` 能抵达此回退分支、告警端到端可达；带首尾空白的合法时区（如 ` UTC `）trim 后原样采用。
 * 不校验时区合法性：非空非空白的非法 `TZ` 的处置由运维负责（见 spec）。
 */
export function resolveDigestTimezone(
  env: { TZ?: string | undefined },
  log: { warn: (obj: object, msg: string) => void },
): string {
  const trimmed = env.TZ?.trim();
  const tz = trimmed || DEFAULT_DIGEST_TIMEZONE;
  if (!trimmed) {
    // TZ 未设置 / 为空串 / 纯空白 → 回退；发一次性告警使「未设置」变响亮、可观测。
    log.warn(
      { kind: 'tz-fallback-default', timezone: DEFAULT_DIGEST_TIMEZONE },
      'TZ unset or empty; falling back to documented default timezone',
    );
  }
  return tz;
}
