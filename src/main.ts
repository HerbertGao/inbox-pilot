// 启动最早处：import config 即触发 zod 校验（失败时 config 模块内部
// console.error + process.exit(1)），满足"启动最早处校验"。必须放在最前。
import { config } from './config/config.js';
import { logger } from './logger.js';
import { prisma } from './db/prisma.js';
import Fastify from 'fastify';
import type { ScheduledTask } from 'node-cron';
import { loadEnabledAccounts } from './accounts/accountRegistry.js';
import { PrismaMailRepo } from './repo/mailRepo.js';
import { startAccountSchedulers, type ScheduledAccount } from './jobs/scheduler.js';
import { startDigestSchedulers } from './digest/digestScheduler.js';
import { resolveDigestTimezone } from './digestTimezone.js';
import { defaultNotifier } from './notify/notifier.js';
import type { Account } from './providers/provider.js';
import { pollAccount } from './providers/imap/imapPoller.js';
import { createGmailClient } from './providers/gmail/gmailClient.js';
import { createGmailProvider } from './providers/gmail/gmailActions.js';
import { createGmailPoller } from './providers/gmail/gmailPoller.js';
// import 触发 rulesConfig 模块加载 = rules.yaml 初次同步加载生效（import 副作用）；
// startRulesConfigReload 在 listen 成功后启动 mtime 轮询热重载（改即生效）。
import { startRulesConfigReload } from './rules/rulesConfig.js';

// /health 的 DB 探测超时（毫秒）。Promise.race 只取消等待，不真正中断底层
// 查询/连接池取用——可接受（liveness only，禁止挂起）。
const HEALTH_DB_TIMEOUT_MS = 2500;

const app = Fastify({ loggerInstance: logger });

// GET /health：liveness + DB 连通性。SELECT 1 探测包一层超时，DB 不可达 /
// 查询出错 / 超时一律返 503，禁止挂起。禁止把原始 Prisma 错误对象 / 连接串
// 写日志（可能内嵌口令），只记脱敏字段。
app.get('/health', async (_request, reply) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, rejectTimeout) => {
    timer = setTimeout(
      () => rejectTimeout(new Error('health db probe timeout')),
      HEALTH_DB_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return reply.code(200).send({ status: 'ok' });
  } catch (error) {
    // 只记脱敏字段（message / code），禁止 log 原始 error 对象（可能内嵌连接串）。
    const message = error instanceof Error ? error.message : 'unknown error';
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;
    app.log.warn({ msg: 'health db probe failed', error: message, code });
    return reply.code(503).send({ status: 'unhealthy' });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
});

// per-account 轮询调度任务（每个 enabled 账号一个）。优雅关闭时先停止全部调度，避免在 fastify/prisma
// 关闭后仍有 cron 触发新一轮轮询。
let schedulerTasks: ScheduledTask[] = [];

// rules-config 热重载句柄（mtime 轮询）。与 schedulerTasks 一并由 shutdown() 单一管理停止——
// 否则 $disconnect 后热重载轮询仍可能触发。RulesReloadHandle 与 ScheduledTask 类型不同，
// 但都有 .stop()，故此处只取最小 `{ stop: () => void }` 形状。
let rulesReloadHandle: { stop: () => void } | undefined;

// 优雅关闭：best-effort 停止全部调度 + 关闭 fastify 与 prisma，再退出。包 try/catch，失败也退出。
// entrypoint 用 exec 使 SIGTERM/SIGINT 直达 node。P0 无在途业务，不强求 drain。
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ msg: 'shutting down', signal });
  // 先停全部调度：不再触发新一轮轮询（在途的一轮由其自身 finally 释放锁与信号量名额，不阻塞关闭）。
  for (const task of schedulerTasks) {
    try {
      task.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      app.log.warn({ msg: 'scheduler stop failed', error: message });
    }
  }
  // 一并停止 rules-config 热重载轮询（单一管理）：确保 $disconnect 后轮询不再触发。
  try {
    rulesReloadHandle?.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    app.log.warn({ msg: 'rules reload stop failed', error: message });
  }
  try {
    await app.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    app.log.warn({ msg: 'fastify close failed', error: message });
  }
  try {
    await prisma.$disconnect();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    app.log.warn({ msg: 'prisma disconnect failed', error: message });
  }
  process.exit(0);
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

try {
  // 容器内 HOST=0.0.0.0 以便从宿主访问。Prisma 惰性连接：listen 不依赖 DB 可达。
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  app.log.error({ msg: 'failed to start', error: message });
  process.exit(1);
}

// —— 账号注册表加载 + per-account 调度（spec account-registry「需求:从注册表加载多账号」
//    「需求:per-account 调度与故障隔离」、design 决策 7、tasks 5.3）——
//
// listen 成功后（/health 已可用）从 DB 注册表加载 enabled 账号 → 为每账号按 provider 构造 poller →
// 启动 per-account 调度（共享信号量 + 单轮超时 + reauth-suspend）。无账号 → 只记日志、不轮询。
//
// gmail 账号若 GMAIL_CLIENT_* 不全（onboarding 未配齐）→ 无法构造 client：记日志跳过该账号（沿用
// imap「配置不全则禁用一个账号」模式），其余账号照常调度、服务正常运行。

/**
 * 把一个加载后的 Account 转为「执行一轮该账号轮询」的 poll 闭包；无法构造（gmail 缺 app 凭据）→ null。
 * 凭据纪律：闭包内不整体记录 account/凭据对象；构造失败只记 `{accountId, provider, reason}`。
 */
function buildAccountPoll(account: Account, repo: PrismaMailRepo): (() => Promise<void>) | null {
  if (account.provider === 'imap') {
    // IMAP：每轮新建连接 → pollOnce → logout（连接生命周期归 pollAccount）。
    // durable-retry 5.1：notifier（defaultNotifier）经 pollAccount → pollOnce deps 显式透传进 poll 路径，
    // drain 重试 notify 动作依赖它（账号无关、非 connection-bound）；复用 digest 同一 telegram notifier。
    return () => pollAccount(account, repo, undefined, defaultNotifier);
  }
  // gmail：需 app 凭据（GMAIL_CLIENT_ID/SECRET，从 env）。缺则无法构造 client → 跳过该账号。
  const clientId = config.GMAIL_CLIENT_ID;
  const clientSecret = config.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    app.log.warn({
      msg: 'gmail account skipped: missing app credentials',
      accountId: account.accountId,
      provider: account.provider,
      reason: 'gmail-app-credentials-missing',
    });
    return null;
  }
  // 每轮构造一个按 refresh token 自动 refresh 的 GmailApi（access token 运行期换、不长存）；
  // refresh 后仅轮换的 refreshToken 经 setAccountEnabled 同表的写入路径回写（best-effort 持久化）。
  //
  // **轮换后的 refreshToken 必须在进程内传播到下一轮**：每轮都用 `currentRefreshToken` 构造 client，
  // 并在回写时**先**更新 `currentRefreshToken`、**再**写 DB。否则每轮都用启动时捕获的旧 token；Google
  // 轮换后下一轮仍用陈旧值 → `invalid_grant` → 误把健康账号 suspend 到重启（闭包不共享回写值的缺陷）。
  let currentRefreshToken = account.refreshToken;
  return () => {
    const gmail = createGmailClient(account.accountId, {
      clientId,
      clientSecret,
      refreshToken: currentRefreshToken,
      persistRefreshToken: async (accountId, refreshToken) => {
        // 仅回写轮换后的 refreshToken（绝不写 access_token/expiry 入 authJson）。
        // **先**更新进程内 currentRefreshToken（下一轮 client 即用轮换后的值，不再用陈旧捕获值），
        // **再** await 写 DB（持久化 best-effort）。
        currentRefreshToken = refreshToken;
        // **只更新 authJson token 字段、绝不触碰 enabled**——否则会把 scheduler 刚因 reauth 暂停
        // （enabled=false）的账号重新启用（enabled:true 仅保留给显式 CLI 重授权）。
        // scopes 缺省回落（updateGmailTokens 内回落 [gmail.modify]，绝不写 scopes:undefined）。
        await repo.updateGmailTokens(accountId, { refreshToken, scopes: account.scopes });
      },
    });
    const provider = createGmailProvider(account.accountId, gmail);
    // durable-retry 5.1：notifier 经 GmailPollDeps 显式透传进 poll 路径（drain 重试 notify 动作账号无关、
    // 非 connection-bound）。复用 digest 同一 defaultNotifier（telegram from config，无渠道→skipped 降级）。
    // clock/drainDeadline 用 gmailPoll 内默认 seam（每轮 drain 起点捕获单调 elapsed），无需在此显式注入。
    const poller = createGmailPoller(account.accountId, {
      gmail,
      repo,
      provider,
      notifier: defaultNotifier,
      // 摄入日期下界（design 决策 5/6）：account.processFrom 经 deps 进 gmailPoll 内部决策点
      // （createGmailPoller 当前仅传 id，必须在此补 processFrom，否则水位线静默 no-op）。
      processFrom: account.processFrom,
      // 通知显示名（design 决策 1）：account.accountLabel 经 deps 进 toRawEmail（漏此跳别名静默丢、
      // 同 processFrom 接线坑）。IMAP 侧由 pollAccount 从 account 自取、无需在此显式接线。
      accountLabel: account.accountLabel,
    });
    return poller.poll();
  };
}

try {
  const repo = new PrismaMailRepo();
  const accounts = await loadEnabledAccounts(repo);

  const scheduled: ScheduledAccount[] = [];
  for (const account of accounts) {
    const poll = buildAccountPoll(account, repo);
    if (poll !== null) {
      scheduled.push({ accountId: account.accountId, poll });
    }
  }

  app.log.info({
    msg: 'account registry loaded',
    accountCount: accounts.length,
    scheduledCount: scheduled.length,
    pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
  });

  // 无可调度账号 → startAccountSchedulers 返回 []（不调度）；服务正常运行（/health 可用）。
  const pollingTasks = startAccountSchedulers(scheduled, repo, {
    intervalSeconds: config.POLL_INTERVAL_SECONDS,
  });

  // —— 每日摘要调度（daily-digest 决策 6/7、迁移计划）——
  //
  // 复用同一 PrismaMailRepo（candidate 查询 + markDigested 落库）与默认 notifier（telegram，无渠道→skipped 降级）。
  // timezone 经 resolveDigestTimezone 解析容器 TZ（docker-compose 随 .env 透传）：未设置 / 为空回退
  // Asia/Shanghai 并发一次性 tz-fallback-default 告警——定点触发依赖时区。
  // 构造期错误隔离归 startDigestSchedulers 内的 per-task try/catch（非法 timezone/表达式跳过该任务、不冒泡到此处 setup）。
  const digestTasks = startDigestSchedulers({
    timesString: config.DIGEST_TIMES,
    timezone: resolveDigestTimezone(process.env, logger),
    repo,
    notifier: defaultNotifier,
  });

  // —— rules-config 热重载（yaml-rules-hardening 决策 2/3、tasks 5.1）——
  //
  // rulesConfig 模块加载（上面的 import 副作用）已同步跑过一次初次加载，故 getActiveRules() 此刻已生效；
  // 此处启动 mtime 轮询热重载句柄（改 rules.yaml 即生效），交由 shutdown() 与 schedulerTasks 一并停止。
  rulesReloadHandle = startRulesConfigReload();

  // **单一合并赋值**：轮询 task 与 digest task 合进同一个被 shutdown() 迭代的 schedulerTasks——
  // 否则 digest task 不被 stop()，$disconnect() 后仍触发（决策 / spec「优雅关闭停止摘要调度」）。
  schedulerTasks = [...pollingTasks, ...digestTasks];
} catch (error) {
  // 注册表加载本身失败（DB 错误）：fail-fast，不静默以空账号继续。只记脱敏字段。
  const message = error instanceof Error ? error.message : 'unknown error';
  app.log.error({ msg: 'failed to load account registry', error: message });
  process.exit(1);
}
