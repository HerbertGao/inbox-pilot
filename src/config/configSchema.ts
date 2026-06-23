import { z } from 'zod';

// 无副作用的纯 schema 模块：仅含 zod schema 定义 + 纯校验器（无 `import 'dotenv/config'`、
// 无 loadConfig()、无 process.exit、无 `export const config`）。需要 schema 的纯路径
// （如 doctor 预检）可只 import 本模块，不被 config.ts 的导入期 `export const config =
// loadConfig()` 牵连——后者对非法配置在 import 时即 process.exit(1)。
// loadConfig() 与 `export const config` 仍住在有副作用的 config.ts 里。

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

// GMAIL_REDIRECT_URI（P4 app 凭据）：仅约定 host/path，端口运行时绑定空闲端口后填入，
// 故此处忽略 env 值里写的任何端口。Desktop-app loopback 客户端无需在 GCP 预注册端口，
// 但授权 URL 与 getToken 两处必须用同一含端口精确串（运行期填）。
//   - host 必须为 IPv4 字面量 127.0.0.1：监听绑 IPv4，`[::1]`(IPv6) 到不了 IPv4 监听、
//     `localhost` 解析有歧义（可能解析到 ::1）——均致授权静默失败，故都拒绝。
//   - path 必须恰为 /oauth2/callback。
// 校验失败不让整个服务崩——遵循「缺键只禁用一个功能」既有模式：返回 false 仅使 Gmail
// onboarding 显式不可用，其余服务照常启动（消费方据此 fail onboarding）。
export const isValidGmailRedirectUri = (v: string): boolean => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  // hostname 已剥去端口；URL 把 IPv6 写成方括号形式，`[::1]` 的 hostname 为 '[::1]'。
  // 仅接受 IPv4 字面量 127.0.0.1（拒 localhost / [::1] / 其它 loopback 写法）。
  if (u.hostname !== '127.0.0.1') return false;
  if (u.pathname !== '/oauth2/callback') return false;
  return true;
};

// 不变式（schema message 不内插被解析的值）：本 schema 内所有自定义 `message` 串
// 必须是**静态串**、绝不内插被解析的值（如 `` `bad value: ${v}` ``）。doctor 预检对
// `safeParse` 失败的 `issue.message` 做直通（只取 path + message、绝不取 issue.input），
// 该直通按构造 leak-safe 全靠此处每个 message 不承载密钥字段值——一个未来内插密钥的
// message 会令该直通悄然开始泄露。新增 / 修改 message 时必须保持静态。
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
  // P4 Gmail app 凭据（§1.2）：app 凭据（非账号凭据，账号凭据存 DB authJson），仍从 env、
  // 全部可选、空串归一。缺 GMAIL_* → Gmail onboarding 不可用，但服务正常启动
  // （消费方据「三者齐全且 redirect_uri 合法」判定 onboarding 是否可用）。
  // GMAIL_CLIENT_SECRET 已在 logger redact 名单（见 src/logger.ts）。
  GMAIL_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  GMAIL_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  // GMAIL_REDIRECT_URI：约定 host/path（端口运行时绑定），校验 host==127.0.0.1 且
  // path==/oauth2/callback、剥离/忽略 env 中任何端口、禁 localhost/[::1]。非法值不让
  // 服务崩——仅使 Gmail onboarding 显式失败（沿用「缺键禁用功能」模式）：解析阶段只把
  // 空串归一、保留原值，合法性交由 isValidGmailRedirectUri 供消费方判定。
  GMAIL_REDIRECT_URI: z.preprocess(emptyToUndefined, z.string().optional()),
  // P2 通知渠道（telegram）：两者都裸 .optional()（无默认），落在 P0「后续阶段
  // 变量可选」范围内，不破坏「仅 DATABASE_URL 必需」。两者全齐 → notifier 选
  // telegram；缺则降级记日志（不崩）。凭据只从此处读、禁写死、不入日志
  // （TELEGRAM_BOT_TOKEN 已在 logger redact 名单，见 src/logger.ts）。
  // bark 作为后续可选渠道，本期不引入 BARK_*。
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // IMAP 账号凭据不走 env——统一存 DB MailAccount.authJson，经 `account add --imap` 写入
  // （P3 的 IMAP_* env 键 + 一次性迁移脚本已退役）。轮询间隔仍是进程级 env 配置。
  POLL_INTERVAL_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().default(180)),
  // DIGEST_TIMES（每日摘要触发时刻列表，如 `12:30,21:30`）：**有意**不走 emptyToUndefined、
  // 不用 zod .default()——这是本文件 optional 键惯例的**例外**，切勿"修"回去。
  // 必须区分 undefined（env 缺省 → 由 digestScheduler 层兜底成默认 `12:30,21:30`）
  // 与 ''（显式空串 → 空列表 → 不调度任何摘要）。若包 emptyToUndefined，''→undefined→默认
  // 排程复活，"显式空 → 不调度"语义被毁；故此处用裸 z.string().optional() 原样透传。
  DIGEST_TIMES: z.string().optional(),
});

export type Config = Readonly<z.infer<typeof configSchema>>;

// Gmail onboarding 是否可用：需 client id/secret 齐全且 redirect_uri 合法
// （host==127.0.0.1 且 path==/oauth2/callback、忽略端口、禁 localhost/[::1]）。
// 任一缺失/非法 → Gmail onboarding 不可用（onboarding 入口据此显式失败），
// 但其余服务照常启动。redirect_uri 非法属「显式失败」：与「缺键禁用功能」同等对待。
export const isGmailOnboardingAvailable = (c: Pick<
  Config,
  'GMAIL_CLIENT_ID' | 'GMAIL_CLIENT_SECRET' | 'GMAIL_REDIRECT_URI'
>): boolean =>
  Boolean(c.GMAIL_CLIENT_ID) &&
  Boolean(c.GMAIL_CLIENT_SECRET) &&
  typeof c.GMAIL_REDIRECT_URI === 'string' &&
  isValidGmailRedirectUri(c.GMAIL_REDIRECT_URI);
