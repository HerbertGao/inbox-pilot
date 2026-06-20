import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

// Singleton PrismaClient cached on globalThis to avoid leaking connections
// across dev hot-reloads. Lazy connection: no $connect() at module load or
// startup — the connection is established on first query, so service startup
// does not depend on database reachability.
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
