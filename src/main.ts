// 启动最早处：import config 即触发 zod 校验（失败时 config 模块内部
// console.error + process.exit(1)），满足"启动最早处校验"。必须放在最前。
import { config } from './config/config.js';
import { logger } from './logger.js';
import { prisma } from './db/prisma.js';
import Fastify from 'fastify';

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

// 优雅关闭：best-effort 关闭 fastify 与 prisma，再退出。包 try/catch，失败也退出。
// entrypoint 用 exec 使 SIGTERM/SIGINT 直达 node。P0 无在途业务，不强求 drain。
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ msg: 'shutting down', signal });
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
