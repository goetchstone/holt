-- Holt runs as several app processes: a shared cache generation per in-process
-- cache (lib/cacheGeneration.ts) and rate-limit counters every process shares
-- (lib/rateLimit.ts). Both tables are new and empty; nothing existing changes.

-- CreateTable
CREATE TABLE "CacheGeneration" (
    "key" TEXT NOT NULL,
    "generation" BIGINT NOT NULL,
    "updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CacheGeneration_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "bucket" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitWindow_pkey" PRIMARY KEY ("bucket","clientKey","windowStart")
);

-- CreateIndex
CREATE INDEX "RateLimitWindow_expiresAt_idx" ON "RateLimitWindow"("expiresAt");
