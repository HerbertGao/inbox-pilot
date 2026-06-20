import OpenAI from 'openai';
import { config } from '../config/config.js';
import { classificationJsonSchema } from './schema.js';

// OpenRouter（OpenAI 兼容 Chat Completions）的唯一入口。
// 本文件只保证三件事：
//   1. 惰性构造 —— 模块加载期不 `new OpenAI()`；首次调用时确认有 key 后才构造并 memoize。
//      （eager 构造会在 classifyEmail 返回安全默认之前抛错，破坏「绝不抛未捕获异常」契约。）
//   2. 显式 baseURL —— 取 `config.OPENROUTER_BASE_URL`（config 层已带 OpenRouter 默认），
//      绝不依赖 OpenAI SDK 默认值（它会指向 api.openai.com，双重违反硬约束）。
//   3. 抛原始错误 —— 不在此处做「缺 key → 安全默认」兜底（那是 classifyEmail 的职责）；
//      让 SDK 的错误（含 `.status`：401/403/429/5xx 等）向上抛，供上游做失败分类。

// 送给 chat 的消息形状（与 OpenAI SDK 的 message 结构兼容）。
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// 每请求超时 ~20s（OpenAI SDK 的 `timeout` 选项）；超时由上游计入 transport 失败。
const REQUEST_TIMEOUT_MS = 20_000;

let client: OpenAI | undefined;

// 惰性构造 + memoize。config 层已为 baseURL/HTTP-Referer/X-Title 提供单一来源默认，
// 故此处直接读 config，不再写 `?? '...'` 兜底（避免双重默认）。
// apiKey 取 `config.OPENROUTER_API_KEY`，密钥只从 config（环境变量）读、禁止写死。
function getClient(): OpenAI {
  if (client === undefined) {
    client = new OpenAI({
      baseURL: config.OPENROUTER_BASE_URL,
      apiKey: config.OPENROUTER_API_KEY,
      defaultHeaders: {
        'HTTP-Referer': config.OPENROUTER_SITE_URL,
        'X-Title': config.OPENROUTER_APP_NAME,
      },
      timeout: REQUEST_TIMEOUT_MS,
    });
  }
  return client;
}

// 真实 OpenRouter 调用。返回模型输出的原始字符串（choices[0].message.content）。
// `responseFormat==='json_schema'` 用派生的 classificationJsonSchema 作 structured-output；
// `'json_object'` 用退化的 JSON mode。模型名由调用方传入（主模型 / fallback 模型）。
export async function openRouterChat(args: {
  messages: ChatMessage[];
  responseFormat: 'json_schema' | 'json_object';
  model: string;
}): Promise<string> {
  const responseFormat =
    args.responseFormat === 'json_schema'
      ? ({
          type: 'json_schema',
          json_schema: {
            name: 'classification',
            schema: classificationJsonSchema as Record<string, unknown>,
          },
        } as const)
      : ({ type: 'json_object' } as const);

  const completion = await getClient().chat.completions.create({
    model: args.model,
    messages: args.messages,
    response_format: responseFormat,
  });

  return completion.choices[0]?.message?.content ?? '';
}
