import { pino } from 'pino';

// 结构化（JSON）日志。配置 redact 使敏感字段不以明文出现。
//
// 安全约定（基于 key 的 redact 无法清洗字符串内嵌的口令，必须人工遵守）：
//   1. 禁止打印原始 config 对象（例如 logger.info(config)）——它含 DATABASE_URL。
//   2. 禁止把原始数据库连接串或未脱敏的 Prisma 错误对象（可能内嵌口令）写入日志；
//      记录 DB 错误时只记 message/code 等脱敏字段，禁止直接 log 原始 error 对象。
export const logger = pino({
  redact: {
    paths: [
      'DATABASE_URL',
      '*.DATABASE_URL',
      'password',
      '*.password',
      // *_API_KEY（如 OPENROUTER_API_KEY）——pino redact 不支持 key 后缀通配，
      // 故枚举顶层与一层嵌套的已知密钥键。
      'OPENROUTER_API_KEY',
      '*.OPENROUTER_API_KEY',
      'GMAIL_CLIENT_SECRET',
      '*.GMAIL_CLIENT_SECRET',
      'TELEGRAM_BOT_TOKEN',
      '*.TELEGRAM_BOT_TOKEN',
    ],
    censor: '[REDACTED]',
  },
});
