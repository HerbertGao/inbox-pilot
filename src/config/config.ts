import 'dotenv/config';
import { z } from 'zod';

// P0 配置校验：必需集仅 DATABASE_URL（无默认、缺失即 fail-fast）。
// NODE_ENV / HOST / PORT 带默认值。后续阶段变量（OPENROUTER_* / GMAIL_* /
// TELEGRAM_* / BARK_* / POLL_* / DIGEST_*）一律不纳入校验：用非 strict 的
// z.object（默认 .parse 会忽略未知键），容忍 .env / .env.example 里留空的
// 后续阶段键，避免 shipped .env.example 因多余键 fail-fast。
//
// 密钥（含内嵌口令的 DATABASE_URL）只从环境变量读取，禁止写死在代码中。
const configSchema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z
    .string()
    .url('DATABASE_URL 必须是合法的 URL')
    .refine(
      (value) =>
        value.startsWith('postgresql://') || value.startsWith('postgres://'),
      { message: 'DATABASE_URL 的 scheme 必须为 postgresql:// 或 postgres://' },
    ),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

function loadConfig(): Config {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    // fail-fast：打印清晰的校验错误并以非零退出码终止，禁止静默启动。
    // 注意：只打印 zod 的字段级 issue（不含密钥值），不打印原始连接串或 process.env。
    console.error('环境配置校验失败：');
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '(root)';
      console.error(`  - ${path}: ${issue.message}`);
    }
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const config: Config = loadConfig();
