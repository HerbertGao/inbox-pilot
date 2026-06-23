// durable-retry 的长程退避值表与常量（durable-retry 决策 2/3/6、tasks 2.2）。
//
// 独立文件（非塞进 executeActions.ts）：executeActions.ts（首次入队）与 retryQueue.ts（drain
// 推进/死信/staleness）都 import 此处，彼此不互改、常量集中一处可调。轮内 ≤~1s 的发送态退避
// （BACKOFF_BASE_MS 等）仍留在 executeActions.ts，与本处长程退避**不同维度**、不合并。

/**
 * 长程退避**精确值表**（毫秒，非约值）：索引 `n∈0..5` 对应 1min/5min/30min/2h/6h/24h（指数 + 24h 封顶）。
 *   - 初次入队（executeActions 瞬时耗尽）用 `durableBackoffMs(0)` = 60s。
 *   - drain 失败推进：`retryCount += 1` → **先判 `retryCount ≥ MAX_DURABLE_ATTEMPTS` → 死信（不索引 backoff）**；
 *     否则 `nextRetryAt = now + durableBackoffMs(retryCount)`（此时 `retryCount∈1..5`，合法索引）。
 * 与 design 决策 2 / durable-retry §需求3 / tasks 2.2 统一：恰好 6 次 drain 重试用尽 6 个退避槽 backoff(0..5)。
 */
const DURABLE_BACKOFF_MS: readonly number[] = [
  60_000, //  n=0 → 1min（初次入队）
  300_000, //  n=1 → 5min
  1_800_000, //  n=2 → 30min
  7_200_000, //  n=3 → 2h
  21_600_000, //  n=4 → 6h
  86_400_000, //  n=5 → 24h（封顶）
] as const;

/**
 * 长程退避 `durableBackoffMs(n)`：返回索引 `n∈0..5` 的退避毫秒。
 * 调用契约保证 `n` 在 `0..MAX_DURABLE_ATTEMPTS-1`（drain 推进顺序先判 `≥MAX` 死信、再索引），
 * 故越界不应发生；防御性地对越界 `n` 回落到 24h 封顶（绝不返回 undefined）。
 */
export function durableBackoffMs(n: number): number {
  if (n < 0) {
    return DURABLE_BACKOFF_MS[0];
  }
  return DURABLE_BACKOFF_MS[n] ?? DURABLE_BACKOFF_MS[DURABLE_BACKOFF_MS.length - 1];
}

/**
 * durable 重试上限（决策 2，统一表述 `retryCount ≥ MAX`、非 `+1≥`）：初次入队 retryCount=0、
 * drain 失败依次 1..6，**达 6 即死信** = 恰好 6 次 drain 重试、用尽 6 个退避槽 backoff(0..5)。
 */
export const MAX_DURABLE_ATTEMPTS = 6;

/**
 * notify staleness 上界（毫秒，默认 24h）：基于 `mail_messages.receivedAt`——超界的 `retrying` notify
 * 直接 `dead_letter`、不补发（数天前的 P0 补发无意义）。markRead/reflectPriority **无** staleness 上界。
 */
export const NOTIFY_STALENESS_MS = 24 * 60 * 60 * 1000;

/** 单账号每 poll 至多 drain 的到期重试条数（决策 6，按 nextRetryAt 升序取前 N）。 */
export const DRAIN_BATCH_CAP = 50;

/**
 * drain 软 elapsed-budget/deadline（毫秒，决策 6）：单账号每轮 drain 的保守时间分额，
 * 取自 `DEFAULT_POLL_TIMEOUT_MS`(5min) 的一个保守占比——超预算即提前停止本轮 drain（剩余下轮续），
 * 避免 50 次 live 网络重试把整轮拖到 5min 墙（scheduler 超时只释放名额、不中断在途 poll）。
 */
export const DRAIN_TIME_BUDGET_MS = 60_000;
