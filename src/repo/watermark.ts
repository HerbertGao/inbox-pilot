// 摘要层水位线下界的共享纯谓词（design 决策 9）。两 repo（Prisma / InMemory）都调它，作单一真源，
// 防漂移、离线可测（组 E 的纯函数单测 import 它）。
//
// `processFrom == null` 同时覆盖 `null`（账号未设下界）**与** `undefined`（`map.get(accountId)` 对 map 中
// 缺失账号返回 undefined）——两者都视为「不设下界、放行」。接受 `undefined` 是为挡「缺失 accountId →
// `undefined.getTime()` 抛/NaN → 静默丢候选」（决策 9）。边界**含界**（`receivedAt >= processFrom` 纳入）。

/**
 * 摘要候选是否通过该账号的 `processFrom` 水位线下界。
 * @param receivedAt 候选邮件的 `receivedAt`（来自 `Date:` 头，缺失/不可解析回落摄入时刻）。
 * @param processFrom 账号水位线；`null`（未设）或 `undefined`（map 缺失该账号）⇒ 不设下界、放行。
 * @returns `true` 纳入；`false` 排除（`receivedAt < processFrom`）。
 */
export function passesWatermark(
  receivedAt: Date,
  processFrom: Date | null | undefined,
): boolean {
  return processFrom == null || receivedAt.getTime() >= processFrom.getTime();
}
