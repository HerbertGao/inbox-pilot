// account-id 合法性校验（inbox-pilot-cli §2）。
//
// 校验落在 deriveAccountId(...) 返回的**最终**主键值上（无论显式 --account-id 还是派生
// imap:<user>@<host>）——这是唯一规范性规则（不采用「派生前校验各组成部分」：拼接的
// imap:<email>@<host> 可超 255 字符或以漏检的方式组合）。
//
// 完全锚定、定长模式：纳入 `+`（plus-tagged 邮箱）、`=`（合法派生 id 可含 `=`，如 --email=a=b →
// imap:a=b@h）与既有 id 形态（imap:user@host、gmail:email）；拒控制字符 / 换行 / 空白（未锚定的
// 检查会放过 id="evil\nINJECTED" → accountId 日志字段注入）；拒空串 ""。
// 正则**不带** `i` / `u` 标志（会改变 ASCII 字符类语义）。
// {1,255} 为 CLI 级合理性边界（MailAccount.id DB 列无界、不截断）。
// 首字符排除 `-`（否则 `disable <id>` 会被通用 flag 解析器把以 `-` 开头的 id 当作 flag 吞掉 →
// 0 位置参数 → EXIT_USAGE → 永久无法禁用该账号；在主键校验处从源头堵掉）。

const ACCOUNT_ID_RE = /^[A-Za-z0-9:._@+=][A-Za-z0-9:._@+=-]{0,254}$/;

/** 最终 accountId 主键值合法 ⇔ 匹配锚定定长字符集。 */
export function isValidAccountId(id: string): boolean {
  return ACCOUNT_ID_RE.test(id);
}
