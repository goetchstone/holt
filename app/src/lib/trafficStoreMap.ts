// /app/src/lib/trafficStoreMap.ts
//
// Server-only, database-backed replacement for the hardcoded
// STORE_DISPLAY_NAMES / AXPER_TO_STORE_LOCATION literals that used to live in
// lib/storeColors.ts. A traffic counter (Axper and friends) reports its own
// label for each door; that label rarely matches StoreLocation.name (the
// canonical name used everywhere else -- POS, sales, up-board). One
// StoreLocation can own several counter labels (two co-located buildings
// counted separately still roll up to one store), which is why the mapping
// is keyed by StoreLocation.trafficSourceNames (a String[]) rather than a
// 1:1 column.
//
// This module is intentionally NOT imported by storeColors.ts (which stays
// client-safe for getStoreColor) -- it touches Prisma, so it is server-only
// by construction. Import it directly from server code (API routes, report
// builders, the import runner); never from a "use client" component.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export interface ResolvedStoreLocation {
  id: number;
  name: string;
}

export interface TrafficStoreMap {
  /** The owning StoreLocation's name, or the raw sourceName unchanged if
   *  nothing maps to it. Never throws, never drops a row -- an unmapped
   *  counter name has to keep showing up somewhere so an operator notices
   *  it exists and adds the mapping. */
  resolveDisplayName(sourceName: string): string;
  /** The owning StoreLocation's {id, name}, or null if nothing maps to it. */
  resolveStoreLocation(sourceName: string): ResolvedStoreLocation | null;
}

/** Shape this module needs from StoreLocation. Kept minimal (rather than
 *  importing a Prisma payload type) so buildTrafficStoreMap can be unit
 *  tested with plain object literals -- no Prisma, no DB. */
export interface TrafficSourceStoreLocation {
  id: number;
  name: string;
  trafficSourceNames: string[];
}

/**
 * Builds a resolver from already-fetched StoreLocation rows. Pure and
 * synchronous -- all the DB access lives in getTrafficStoreMap() below, so
 * this function is the one to unit-test.
 *
 * Matching is case-insensitive and trimmed (counters and humans are
 * inconsistent about trailing whitespace and capitalization), but
 * trafficSourceNames and StoreLocation.name are stored/returned verbatim --
 * only the lookup key is normalized.
 */
export function buildTrafficStoreMap(rows: TrafficSourceStoreLocation[]): TrafficStoreMap {
  const bySourceName = new Map<string, ResolvedStoreLocation>();
  for (const row of rows) {
    for (const sourceName of row.trafficSourceNames) {
      bySourceName.set(sourceName.trim().toLowerCase(), { id: row.id, name: row.name });
    }
  }

  // Warn once per unique unmapped name per resolver build (i.e. at most
  // once per CACHE_TTL_MS window below), not once per row -- a day of
  // 15-minute intervals for an unmapped store would otherwise flood the
  // log with the same warning hundreds of times.
  const warnedUnmapped = new Set<string>();

  function lookup(sourceName: string): ResolvedStoreLocation | null {
    const key = sourceName.trim().toLowerCase();
    const hit = bySourceName.get(key);
    if (hit) return hit;
    if (!warnedUnmapped.has(key)) {
      warnedUnmapped.add(key);
      logger.warn("traffic source name has no StoreLocation mapping", {
        sourceName,
        hint: "add it to the store's Traffic Source Names in Admin > Settings > Configuration",
      });
    }
    return null;
  }

  return {
    resolveStoreLocation(sourceName: string): ResolvedStoreLocation | null {
      return lookup(sourceName);
    },
    resolveDisplayName(sourceName: string): string {
      return lookup(sourceName)?.name ?? sourceName;
    },
  };
}

// 60s: several dashboard charts and reports call getTrafficStoreMap() once
// per request (see storeTraffic.ts, reports/trafficReport.ts, the
// /api/axper/traffic route) -- a per-call query would turn one page load
// into an N+1 against StoreLocation. A bare process-lifetime singleton
// (no TTL) would mean an admin editing a store's Traffic Source Names in
// the GUI wouldn't see it take effect without a server restart. 60s splits
// the difference: cheap enough to avoid the N+1 within a request, short
// enough that a config change is live well within one operator's "did it
// save" refresh. invalidateTrafficStoreMap() below lets the admin write
// path force a rebuild sooner than that.
const CACHE_TTL_MS = 60_000;

let cached: { map: TrafficStoreMap; expiresAt: number } | null = null;

// Bumped by invalidateTrafficStoreMap(). Without this, a load that was
// already in flight when an invalidation happens can resolve AFTER it and
// unconditionally overwrite `cached` with the stale (pre-invalidation) map
// -- re-pinning it for a full fresh TTL and silently undoing the
// invalidation it raced with. A load only gets to install its result if the
// generation it started under is still current when it finishes; otherwise
// something newer has already started (or finished) and its own result
// must win instead.
let generation = 0;

/**
 * Returns the cached resolver, rebuilding it from StoreLocation if the
 * cache is empty or older than CACHE_TTL_MS.
 */
export async function getTrafficStoreMap(): Promise<TrafficStoreMap> {
  const now = Date.now();
  if (cached && now < cached.expiresAt) return cached.map;

  const startedAtGeneration = generation;
  const rows = await prisma.storeLocation.findMany({
    select: { id: true, name: true, trafficSourceNames: true },
  });
  const map = buildTrafficStoreMap(rows);
  // Only pin this result if no invalidation happened while the query was in
  // flight. A stale generation means a fresher load already landed (or is
  // still in flight and will land) -- this result must not clobber it.
  if (generation === startedAtGeneration) {
    cached = { map, expiresAt: Date.now() + CACHE_TTL_MS };
  }
  return map;
}

/**
 * Clears the cached resolver. Call this after a config-preset apply or an
 * admin edit to StoreLocation.trafficSourceNames so the next request sees
 * the change immediately instead of waiting out the TTL.
 */
export function invalidateTrafficStoreMap(): void {
  cached = null;
  generation++;
}
