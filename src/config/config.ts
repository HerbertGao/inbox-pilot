import 'dotenv/config';
import { z } from 'zod';

// P0 配置校验：必需集仅 DATABASE_URL（无默认、缺失即 fail-fast）。
// NODE_ENV / HOST / PORT 带默认值。后续阶段变量（OPENROUTER_* / GMAIL_* /
// TELEGRAM_* / BARK_* / POLL_* / DIGEST_*）一律不纳入校验：用非 strict 的
// z.object（默认 .parse 会忽略未知键），容忍 .env / .env.example 里留空的
// 后续阶段键，避免 shipped .env.example 因多余键 fail-fast。
//
// 密钥（含内嵌口令的 DATABASE_URL）只从环境变量读取，禁止写死在代码中。
// 空串归一为 undefined，使 zod 的 .default() 对 `KEY=`（空串）也生效——
// .default() 只替换 undefined，不替换 ''；不预处理则 OPENROUTER_BASE_URL=''
// 会落成 ''，new OpenAI({ baseURL: '' }) 回退到 api.openai.com，携 OpenRouter
// key 直连 OpenAI（违反「禁止直连其他模型商」并泄露 key）。
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

// 拒绝显式指向 openai.com 的 baseURL——硬约束「AI 仅经 OpenRouter，禁止直连其他模型商」。
// 空串→默认已堵住 SDK 静默回退 api.openai.com 的路径；此处再堵「operator 显式设成
// api.openai.com」的路径，使「禁止出现指向 api.openai.com 的可能」字面成立。
// 仅拒 openai.com host，不强绑 openrouter.ai——保留 OpenRouter 兼容代理 / 自建网关的合法用法。
const isOpenAiHost = (v: string): boolean => {
  try {
    return new URL(v).host.toLowerCase().endsWith('openai.com');
  } catch {
    return false;
  }
};

export const configSchema = z.object({
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
  // P1 OpenRouter（§4.1）：5 个带默认值，使 baseURL/模型/头恒有值——状态机两次
  // 调用始终有模型可用；仅 OPENROUTER_API_KEY 无默认（裸 .optional()，缺失即走
  // 安全默认，禁止发起任何网络调用）。带默认的 optional 仍是「可选」，落在 P0
  // 「后续阶段变量可选」允许范围内，不破坏「仅给 DATABASE_URL 即可启动」。
  // 5 个带默认值的变量均经 emptyToUndefined 预处理，使空串也回落到默认值；
  // BASE_URL 额外 .url() 校验，杜绝非法 baseURL 导致的直连回退。
  OPENROUTER_BASE_URL: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .url()
      .refine((v) => !isOpenAiHost(v), {
        message: 'OPENROUTER_BASE_URL 不得指向 openai.com（硬约束：AI 仅经 OpenRouter）',
      })
      .default('https://openrouter.ai/api/v1'),
  ),
  OPENROUTER_MODEL: z.preprocess(emptyToUndefined, z.string().default('google/gemini-2.5-flash-lite')),
  OPENROUTER_FALLBACK_MODEL: z.preprocess(emptyToUndefined, z.string().default('openai/gpt-4o-mini')),
  OPENROUTER_SITE_URL: z.preprocess(emptyToUndefined, z.string().default('http://localhost:3000')),
  OPENROUTER_APP_NAME: z.preprocess(emptyToUndefined, z.string().default('inbox-pilot')),
  OPENROUTER_API_KEY: z.string().optional(),
  // P2 通知渠道（telegram）：两者都裸 .optional()（无默认），落在 P0「后续阶段
  // 变量可选」范围内，不破坏「仅 DATABASE_URL 必需」。两者全齐 → notifier 选
  // telegram；缺则降级记日志（不崩）。凭据只从此处读、禁写死、不入日志
  // （TELEGRAM_BOT_TOKEN 已在 logger redact 名单，见 src/logger.ts）。
  // bark 作为后续可选渠道，本期不引入 BARK_*。
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
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
