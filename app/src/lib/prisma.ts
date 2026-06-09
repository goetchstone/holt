// /app/src/lib/prisma.ts
//
// Prisma 7 uses a native TypeScript query engine with the pg driver adapter.
// Connection pool is managed by pg via the DATABASE_URL connection string.
//
// PrismaPg passes its config to `pg.Pool`, which reads `max` (not the
// `?connection_limit` URL param). To override pool size, set
// PG_POOL_MAX in the environment. Default leaves it to pg.Pool's
// internal default (currently 10). Integration tests set
// PG_POOL_MAX=1 to force serial query execution — without it,
// sequential awaits across two queries can land on different
// connections and the second sometimes doesn't see the first's just-
// written row, surfacing as spurious FK violations.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const poolMax = process.env.PG_POOL_MAX ? Number.parseInt(process.env.PG_POOL_MAX, 10) : undefined;
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
  ...(poolMax !== undefined && Number.isFinite(poolMax) ? { max: poolMax } : {}),
});

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "production" ? ["error"] : ["query"],
    transactionOptions: {
      maxWait: 10000,
      timeout: 30000,
    },
  });

// Timeout presets for $transaction calls. Use LONG for bulk imports, SHORT for
// quick multi-table writes. The client default (above) is 30s for everything else.
export const TX_TIMEOUT = {
  SHORT: { maxWait: 5000, timeout: 10000 },
  LONG: { maxWait: 30000, timeout: 300000 },
} as const;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
