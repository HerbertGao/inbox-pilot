// 启动最早处：import config 即触发 zod 校验（失败时 config 模块内部
// console.error + process.exit(1)），满足"启动最早处校验"。必须放在最前。
import { config } from './config/config.js';
import { logger } from './logger.js';
import { prisma } from './db/prisma.js';
import Fastify from 'fastify';
import type { ScheduledTask } from 'node-cron';
import { loadImapAccount, ImapConfigError } from './accounts/accountService.js';
import { PrismaMailRepo } from './repo/mailRepo.js';
import { pollAccount } from './providers/imap/imapPoller.js';
import { startScheduler } from './jobs/scheduler.js';

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

// IMAP 轮询调度任务（仅在账号存在时被赋值）。优雅关闭时先停止调度，避免在 fastify/prisma
// 关闭后仍有 cron 触发新一轮轮询。
let schedulerTask: ScheduledTask | undefined;

// 优雅关闭：best-effort 停止调度 + 关闭 fastify 与 prisma，再退出。包 try/catch，失败也退出。
// entrypoint 用 exec 使 SIGTERM/SIGINT 直达 node。P0 无在途业务，不强求 drain。
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ msg: 'shutting down', signal });
  // 先停调度：不再触发新一轮轮询（在途的一轮由其自身 finally 释放锁，不阻塞关闭）。
  if (schedulerTask !== undefined) {
    try {
      schedulerTask.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      app.log.warn({ msg: 'scheduler stop failed', error: message });
    }
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

// —— IMAP 接入（6.3，spec「需求:IMAP 账号加载与持久化锚定」）——
// listen 成功后（/health 已可用）再启用 IMAP 轮询：
//   - 账号存在 → ensureAccountAnchor（在 arm 调度前 await 完成，使首轮 saveEmail 已有父行，
//     spec「锚定行先于调度建立」）→ 启动调度器，每 tick 调用 pollAccount（注入真实 IMAP I/O）。
//   - 缺 IMAP_HOST → loadImapAccount 返回 null → 只记一条信息日志、不启用（服务其余正常运行）。
//   - IMAP_HOST 已设而凭据缺 → loadImapAccount 抛 ImapConfigError → fail-fast（非零退出），
//     与 config fail-fast 一致，不静默禁用。
try {
  const account = loadImapAccount(config);
  if (account === null) {
    // 缺 host：IMAP 为可选 provider，禁用而非崩溃（/health 等其余部分正常运行）。
    app.log.info({ msg: 'IMAP disabled (no IMAP_HOST)' });
  } else {
    const repo = new PrismaMailRepo();
    // 锚定 upsert 必须在 arm 调度前 await 完成（首轮任何 saveEmail 都已有父行）。
    await repo.ensureAccountAnchor({ accountId: account.accountId, email: account.user });
    // arm 调度：每 tick 经不重入锁调用 pollAccount（内部每轮新建真实 imapflow 连接、用完即关）。
    schedulerTask = startScheduler(
      () => pollAccount(account, repo),
      config.POLL_INTERVAL_SECONDS,
    );
    app.log.info({
      msg: 'IMAP polling enabled',
      accountId: account.accountId,
      pollIntervalSeconds: config.POLL_INTERVAL_SECONDS,
    });
  }
} catch (error) {
  if (error instanceof ImapConfigError) {
    // host 有而凭据缺：配置错误，fail-fast（非零退出），不静默禁用。
    app.log.error({ msg: 'IMAP misconfigured, refusing to start', error: error.message });
    process.exit(1);
  }
  // 其它启用期错误（如锚定 upsert 的 DB 错误）：无法保证「锚定行先于调度」，同样 fail-fast。
  const message = error instanceof Error ? error.message : 'unknown error';
  app.log.error({ msg: 'failed to enable IMAP polling', error: message });
  process.exit(1);
}
