// /app/src/lib/cacheGeneration.ts
//
// Server-only. How an in-process cache learns that ANOTHER process changed what
// it holds.
//
// Holt can run as several identical app processes behind nginx (docs/HOSTING.md).
// Each one keeps a few small caches in memory: the role grant table, the
// settings row, the sign-in providers, the store name maps, the import's
// fallback ids. Dropping a cache after a write (invalidateRoleGrantCache() and
// the rest) only ever reaches the process that made the write. Every other
// process kept serving its copy until a TTL ran out -- 30s for a revoked
// permission, 60s for a settings change -- or, for the caches with no TTL, until
// it restarted. A database restore left every process holding ids from the old
// database.
//
// So each cache has a row in CacheGeneration. A write bumps the row in the same
// transaction as the write itself (bumpCacheGenerations(keys, tx)), and a cache
// keeps its copy only while the generation it was loaded under is still the
// current one (cacheGeneration(key)).
//
// THE BOUND. Reading the generations costs one query, so a process reads them
// at most once every CACHE_GENERATION_CHECK_MS (2 seconds) and answers from that
// snapshot in between. A change committed at time T is therefore seen by every
// process no later than T + 2s plus one query's latency. A revoked permission
// stops working everywhere within that bound (tested in
// __tests__/integration/multiProcessCaches.integration.test.ts).
//
// ORDER MATTERS, in two places:
//   - A cache reads the generation BEFORE it loads, so what it loads is at least
//     as new as the generation it files it under. Loading first could file old
//     data under a new generation and keep it.
//   - A write bumps in the same transaction as the write (or after it commits).
//     Bumping first would let a reader see the new generation, load the old
//     rows, and keep them.
//
// WHEN THE TABLE CAN'T BE READ (a database outage, or a restored dump older
// than this table) the snapshot holds UNREADABLE for the interval. A cache
// filed under a real generation then reloads, which is the safe direction; two
// unreadable checks in a row compare equal, so a cache then behaves as the plain
// TTL cache it was before.

import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/**
 * Every cache that follows a generation. One home (rule 37): a key outside this
 * list does not type-check, and bumpAllCacheGenerations() bumps exactly these.
 */
export const CACHE_GENERATION_KEYS = [
  /** The role grant table (lib/auth/permissionResolver.ts). */
  "roles",
  /** The settings row (lib/appSettings.ts). */
  "settings",
  /** The sign-in providers built from stored keys (lib/auth/authProviders.ts). */
  "authProviders",
  /** Store name maps (lib/trafficStoreMap.ts, lib/storeLocationResolver.ts). */
  "stores",
  /** Ids the POS import keeps for its whole life: the fallback vendor and
   *  taxonomy, the import user, the vendor number prefixes. */
  "imports",
] as const;

export type CacheGenerationKey = (typeof CACHE_GENERATION_KEYS)[number];

/** The longest a process answers from one snapshot of the generations. */
export const CACHE_GENERATION_CHECK_MS = 2_000;

/** What a key reads while the table can't be read. See the header. */
export const UNREADABLE = "unreadable";

/** What a key reads before it has ever been bumped. */
const NEVER_BUMPED = "0";

type Snapshot = { values: ReadonlyMap<string, string> | null; readAt: number };

let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;
let lastReadFailed = false;

async function readSnapshot(): Promise<Snapshot> {
  // Stamped with the time the read STARTED: anything committed before then is in
  // it, so the bound holds from the start of the read, not its end.
  const readAt = Date.now();
  try {
    const rows = await prisma.cacheGeneration.findMany({
      select: { key: true, generation: true },
    });
    lastReadFailed = false;
    return { values: new Map(rows.map((r) => [r.key, r.generation.toString()])), readAt };
  } catch (err) {
    // Warn once per outage, not once per request. logger, not logError: the
    // error recorder writes to the database this just failed to read.
    if (!lastReadFailed) {
      logger.warn("Cache generations unreadable; caches reload instead of trusting a copy", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    lastReadFailed = true;
    return { values: null, readAt };
  }
}

/**
 * The current generation of `key`, as of a read no older than
 * CACHE_GENERATION_CHECK_MS. A cache compares it with the generation it loaded
 * under and reloads when they differ. Never throws.
 */
export async function cacheGeneration(key: CacheGenerationKey): Promise<string> {
  if (!snapshot || Date.now() - snapshot.readAt >= CACHE_GENERATION_CHECK_MS) {
    // One read at a time per process; concurrent callers share it.
    inflight ??= readSnapshot().finally(() => {
      inflight = null;
    });
    snapshot = await inflight;
  }
  if (!snapshot.values) return UNREADABLE;
  return snapshot.values.get(key) ?? NEVER_BUMPED;
}

/**
 * Make this process read the generations afresh on its next check. Called by
 * the local invalidate functions, so the process that made a change does not
 * spend up to two seconds comparing against a snapshot from before it.
 */
export function forgetCacheGenerations(): void {
  snapshot = null;
  inflight = null;
}

type Db = Pick<PrismaClient, "$executeRaw"> | Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Tell every process that what these caches hold has changed. Pass the write's
 * transaction so the bump commits with the write and not before it.
 *
 * The new value is the larger of one more than before and the database clock
 * in microseconds, so it only ever moves forward, even past a row a restored
 * dump brought back from the past.
 */
export async function bumpCacheGenerations(
  keys: readonly CacheGenerationKey[],
  db: Db = prisma,
): Promise<void> {
  if (keys.length === 0) return;
  const unique = [...new Set(keys)];
  await db.$executeRaw`
    INSERT INTO "CacheGeneration" ("key", "generation", "updated")
    SELECT k, (extract(epoch from clock_timestamp()) * 1000000)::bigint, now()
    FROM unnest(${unique}::text[]) AS k
    ON CONFLICT ("key") DO UPDATE SET
      "generation" = GREATEST("CacheGeneration"."generation" + 1, EXCLUDED."generation"),
      "updated" = now()`;
  forgetCacheGenerations();
}

/**
 * Every cache, in every process, reloads. For when the whole database was
 * replaced underneath the running processes: a restore from a backup, or a
 * practice copy going back to its starting point. Ids a process held from the
 * old database mean nothing in the new one.
 */
export async function bumpAllCacheGenerations(db: Db = prisma): Promise<void> {
  await bumpCacheGenerations(CACHE_GENERATION_KEYS, db);
}

/**
 * The generation straight from the database, skipping the snapshot. For a
 * screen that must not act on a copy up to two seconds old: the settings page
 * uses the "settings" generation as its version (pages/api/admin/settings).
 *
 * `lock: true`, inside a transaction, holds the row until the transaction ends,
 * so two writers that both read the same version cannot both go on to write.
 * The row is created first when missing, since a lock on no row locks nothing.
 */
export async function readCacheGenerationNow(
  key: CacheGenerationKey,
  db: DbRead = prisma,
  opts: { lock?: boolean } = {},
): Promise<string> {
  if (opts.lock) {
    await db.$executeRaw`
      INSERT INTO "CacheGeneration" ("key", "generation") VALUES (${key}, 0)
      ON CONFLICT ("key") DO NOTHING`;
  }
  const rows = opts.lock
    ? await db.$queryRaw<{ generation: bigint }[]>`
        SELECT "generation" FROM "CacheGeneration" WHERE "key" = ${key} FOR UPDATE`
    : await db.$queryRaw<{ generation: bigint }[]>`
        SELECT "generation" FROM "CacheGeneration" WHERE "key" = ${key}`;
  return rows[0]?.generation.toString() ?? NEVER_BUMPED;
}

type DbRead =
  | Pick<PrismaClient, "$queryRaw" | "$executeRaw">
  | Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;
