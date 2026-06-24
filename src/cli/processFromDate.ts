// 共享 `--process-from` / `set-process-from` 日期 parse+validate helper（onboarding-watermark 3.1）。
//
// 两命令同一脚枪、同一守卫：把 ISO date-string 解析为 **UTC 零点**，并拒绝非法 / 未来日期。
//
// 严格解析（**禁止** `new Date(str)` 宽松解析——会放过 `…T14:00` / `2026-13-99` 这类被强转的串、
// 破坏「UTC 零点」保证）：
//   - 只接受 `^\d{4}-\d{2}-\d{2}$`；
//   - 经 `Date.UTC(y, m-1, d)` 落 UTC 零点；
//   - 经 round-trip 核对（拒绝 `2026-02-30` 这类被 JS 进位归一的非真日期）；
//   - 不匹配 / `Invalid Date` → `invalid`（调用方映射 EXIT_USAGE / 退出码 2）。
// 未来判定按 `parsedUtcMidnight > now`（**非** date-to-date），使**今天**（UTC 零点 ≤ now，含东于 UTC
// 的时区）不被误拒；严格未来（`> now`）→ `future`（否则静默排除该日前所有邮件含合法新邮件）。
//
// 返回 discriminated result（纯函数、可 import 单测——组 E 6.7）。

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 日期解析结果（discriminated union）：成功携 UTC 零点 `Date`，失败携 kind 供命令层映射 EXIT_USAGE。 */
export type ProcessFromDateResult =
  | { ok: true; date: Date }
  | { ok: false; kind: 'invalid' | 'future' };

/**
 * 严格解析 ISO date-string（`YYYY-MM-DD`）为 **UTC 零点** `Date`，并拒绝非法 / 未来日期。
 *
 * @param s   原始 date-string（来自 `--process-from <date>` / `set-process-from <id> <date>`）。
 * @param now 「现在」基准（默认 `new Date()`；可注入使单测确定性）。
 * @returns   `{ ok:true, date }`（UTC 零点）/ `{ ok:false, kind:'invalid'|'future' }`。
 */
export function parseProcessFromDate(s: string, now: Date = new Date()): ProcessFromDateResult {
  if (!ISO_DATE_RE.test(s)) {
    // 不匹配严格形式（含带时间分量 `…T14:00` / 越界 `2026-13-99` / 空串）→ 用法错误。
    return { ok: false, kind: 'invalid' };
  }
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(5, 7));
  const day = Number(s.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  const parsed = new Date(ms);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, kind: 'invalid' };
  }
  // round-trip 核对：`Date.UTC` 对 `2026-02-30` 等会进位归一（→ 3 月 2 日），与原串字段不符 → 拒绝。
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return { ok: false, kind: 'invalid' };
  }
  // 严格未来：`parsedUtcMidnight > now`（非 date-to-date），今天（UTC 零点 ≤ now）放行。
  if (parsed.getTime() > now.getTime()) {
    return { ok: false, kind: 'future' };
  }
  return { ok: true, date: parsed };
}
