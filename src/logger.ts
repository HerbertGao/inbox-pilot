import { pino } from 'pino';

// 结构化（JSON）日志。配置 redact 使敏感字段不以明文出现。
//
// 安全约定（**代码纪律**——基于 key 的 redact 无法清洗字符串内嵌的密钥/口令，
// 故下列「禁打印」必须人工遵守；pino redact 仅作 defense-in-depth）：
//   1. 禁止打印原始 config 对象（例如 logger.info(config)）——它含 DATABASE_URL。
//   2. 禁止把原始数据库连接串或未脱敏的 Prisma 错误对象（可能内嵌口令）写入日志；
//      记录 DB 错误时只记 message/code 等脱敏字段，禁止直接 log 原始 error 对象。
//   3. 禁止整体打印：账号 / 注册表对象（含 authJson）、运行期 OAuth2 client 对象、
//      token 响应、原始 Prisma/OAuth/IMAP 错误对象——**含其 `cause` 链与
//      `AggregateError.errors`**（它们可重新内嵌原始错误/凭据子串，key-redact 清不掉）。
//      错误路径只取 `code` + 固定 kind + 脱敏 message；绝不把原始 error / 其
//      cause / `.response` / `.config` 传给 logger。
//   4. 禁止整体打印 NormalizedEmail 对象（其 to/cc 是第三方收件人 PII）——
//      错误/动作路径只记 accountId + providerMessageId + 脱敏 message。
//   5. OAuth loopback 回调：绝不记回调 URL/query（含单次性授权 code 与 state）——
//      只记 { kind, state-result, path }。
//
// redact 路径（与 account-registry spec「凭据不入日志」声称覆盖的键一一对应）：
//   - 主控 = **整体 redact `authJson` 对象**：pino redact 按 key-path、不支持任意深度/
//     key 后缀通配，父键 redact 会 censor 整棵子树，故 `authJson`/`*.authJson` 对子树内
//     凭据无视深度/casing 全覆盖，是稳健做法。
//   - 辅以叶子凭据键（顶层 + 一层嵌套；pino 不支持 key 后缀通配，逐键枚举）。
//   - 运行期 OAuth2 client 凭据不在 authJson 内，单独枚举其真实键路径（google-auth-library）。
/**
 * redact key-paths（单一真相源）。导出供测试构造同配置的捕获型 pino 断言凭据不入日志，
 * 使断言与生产 logger 的 redact 行为一致（path 与 account-registry spec「凭据不入日志」声称覆盖
 * 的键一一对应）。
 */
export const REDACT_PATHS: string[] = [
      // ── env 密钥（顶层 + 一层嵌套）──
      'DATABASE_URL',
      '*.DATABASE_URL',
      'OPENROUTER_API_KEY',
      '*.OPENROUTER_API_KEY',
      'GMAIL_CLIENT_SECRET',
      '*.GMAIL_CLIENT_SECRET',
      'TELEGRAM_BOT_TOKEN',
      '*.TELEGRAM_BOT_TOKEN',
      // TG_BOT_INBOX 是当前生效的 bot token 来源（resolver 从 env 读取此变量）。
      'TG_BOT_INBOX',
      '*.TG_BOT_INBOX',
      // botToken 是 hangar-notify resolver 返回密钥的对象键（{ botToken, chatId }）——
      // env 名 redact 挡不住「调用方日志记录了 Destination 对象」这条路（CodeRabbit review）。
      'botToken',
      '*.botToken',
      // CHAT_ID 非密钥（泄露无法冒充 bot），但 notifications spec 把 TELEGRAM_* 并列为凭据、
      // 要求失败日志禁含；当前 chat_id 结构上不入任何日志，此处为与 spec 措辞一致的兜底。
      'TELEGRAM_CHAT_ID',
      '*.TELEGRAM_CHAT_ID',
      // ── 主控：整体 redact authJson 子树（imap/gmail 账号凭据统一存此）──
      'authJson',
      '*.authJson',
      // ── 叶子凭据键（账号对象口令字段统一命名 password；OAuth token 字段）──
      'password',
      '*.password',
      'refreshToken',
      '*.refreshToken',
      'accessToken',
      '*.accessToken',
      // snake_case：google-auth-library / OAuth token 端点用 snake_case。
      'refresh_token',
      '*.refresh_token',
      'access_token',
      '*.access_token',
      'client_secret',
      '*.client_secret',
      // ── 运行期 OAuth2 client 凭据（不在 authJson 内，枚举真实键路径）──
      // google-auth-library 把 access/refresh token 放 credentials / tokens——整体 redact 子树。
      'credentials',
      '*.credentials',
      'tokens',
      '*.tokens',
      // google-auth-library 内部字段 _clientSecret（clientSecret 驼峰多为 no-op、无害保留）。
      '_clientSecret',
      '*._clientSecret',
      'clientSecret',
      '*.clientSecret',
      // PKCE：被记则旁路 PKCE 保护。
      'codeVerifier',
      '*.codeVerifier',
      'code_verifier',
      '*.code_verifier',
      // authorization：防 headers 对象直接入日志泄露 bearer（主防仍是「不记原始 error」）。
      // fast-redact **大小写敏感**——HTTP 标准头是大写 'Authorization'，故大小写两种都显式枚举。
      'authorization',
      '*.authorization',
      'Authorization',
      '*.Authorization',
      // ── 数组路径：覆盖凭据落在数组元素里的形态（pino 用 `[*]` 表数组任意下标）──
      '*[*].password',
      '*[*].authJson',
      '*[*].refreshToken',
      '*[*].accessToken',
      '*[*].refresh_token',
      '*[*].access_token',
      '*[*].client_secret',
      '*[*].credentials',
      '*[*].tokens',
      '*[*].code_verifier',
];

export const logger = pino({
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
});
