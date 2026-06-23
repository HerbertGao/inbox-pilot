import 'dotenv/config';

// 有副作用的配置入口：顶层 `import 'dotenv/config'`（填充 process.env，幂等）+
// 导入期 `export const config = loadConfig()`——后者对非法配置在 import 时即 process.exit(1)。
// 纯 schema 定义 + 纯校验器（configSchema / isValidGmailRedirectUri /
// isGmailOnboardingAvailable / Config）已抽到无副作用模块 ./configSchema.js，
// 供需要 schema 的纯路径（doctor 预检）import 而不触发 loadConfig()。
// 此处 re-export 这些符号，使既有 importer（如 src/cli/account.ts、config.test.ts）
// 继续从 ./config.js import 不变。
import {
  configSchema,
  isGmailOnboardingAvailable,
  isValidGmailRedirectUri,
  type Config,
} from './configSchema.js';

export {
  configSchema,
  isGmailOnboardingAvailable,
  isValidGmailRedirectUri,
  type Config,
};

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
