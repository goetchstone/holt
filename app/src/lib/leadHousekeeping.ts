// /app/src/lib/leadHousekeeping.ts
//
// Aging-rule logic for the Leads board. Runs nightly:
//   - Active: touched in last 14 days — shows normally.
//   - Going stale: 14–29 days untouched — flag on the card, not archived.
//   - Auto-archive: 30+ days untouched, status still NEW or ASSIGNED →
//     moves to LOST with archivedBy="auto". Hidden from the board.
//
// Exemptions from auto-archive:
//   - status in CONTACTED / QUALIFIED / CONVERTED (someone's on it)
//   - pinned = true (explicit manager override)
//   - lead's linked customer has an active QUOTE (conversion in progress)
//
// All three thresholds are pure constants so tests can cover the boundaries.

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export const STALE_AFTER_DAYS = 14;
export const ARCHIVE_AFTER_DAYS = 30;

type Tx = Pick<PrismaClient, "lead" | "salesOrder">;

export interface HousekeepingResult {
  leadsArchived: number;
  archivedIds: number[];
}

/**
 * Find and auto-archive leads that have been silent for ARCHIVE_AFTER_DAYS
 * (30) days. Exempts pinned leads, leads with live quotes on their customer,
 * and anything past the NEW / ASSIGNED stage.
 */
export async function autoArchiveStaleLeads(
  now: Date = new Date(),
  client: Tx = defaultPrisma,
): Promise<HousekeepingResult> {
  const cutoff = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 86400000);

  // Step 1: find candidates — NEW/ASSIGNED, not pinned, lastActionAt older
  // than the cutoff (or null, which means never touched since create).
  const candidates = await client.lead.findMany({
    where: {
      status: { in: ["NEW", "ASSIGNED"] },
      pinned: false,
      OR: [{ lastActionAt: null }, { lastActionAt: { lt: cutoff } }],
    },
    select: { id: true, customerId: true, email: true, created: true },
  });

  if (candidates.length === 0) {
    return { leadsArchived: 0, archivedIds: [] };
  }

  // Step 2: exempt leads whose linked customer has an active QUOTE.
  // Single query over all candidate customerIds; filter in memory.
  const customerIds = Array.from(
    new Set(candidates.map((l) => l.customerId).filter((id): id is number => id !== null)),
  );
  let customersWithActiveQuote = new Set<number>();
  if (customerIds.length > 0) {
    const activeQuotes = await client.salesOrder.findMany({
      where: {
        customerId: { in: customerIds },
        status: "QUOTE",
        pipelineArchivedAt: null,
      },
      select: { customerId: true },
    });
    customersWithActiveQuote = new Set(
      activeQuotes.map((q) => q.customerId).filter((id): id is number => id !== null),
    );
  }

  const toArchive = candidates.filter(
    (l) => !l.customerId || !customersWithActiveQuote.has(l.customerId),
  );

  if (toArchive.length === 0) {
    return { leadsArchived: 0, archivedIds: [] };
  }

  // Step 3: archive in one query.
  const archiveIds = toArchive.map((l) => l.id);
  await client.lead.updateMany({
    where: { id: { in: archiveIds } },
    data: {
      status: "LOST",
      archivedBy: "auto",
      notes: undefined, // don't wipe notes; append would need per-row loop
      updatedBy: "auto:housekeeping",
    },
  });

  // Append the auto-archive note per row (non-critical; don't block on it).
  for (const lead of toArchive) {
    try {
      await client.lead.update({
        where: { id: lead.id },
        data: {
          notes: {
            set: `[auto] no action in ${ARCHIVE_AFTER_DAYS} days; archived on ${now
              .toISOString()
              .slice(0, 10)}`,
          },
        },
      });
    } catch {
      // ignore — the bulk archive succeeded
    }
  }

  logger.info("autoArchiveStaleLeads complete", {
    candidates: candidates.length,
    exemptedForActiveQuote: candidates.length - toArchive.length,
    archived: toArchive.length,
  });

  return { leadsArchived: toArchive.length, archivedIds: archiveIds };
}

// ─── Helpers for UI / API ───────────────────────────────────────────────────

/** Days since the lead was last touched. Null lastActionAt → very high. */
export function daysSinceLastAction(
  lastActionAt: Date | string | null | undefined,
  now: Date = new Date(),
): number {
  if (!lastActionAt) return Number.MAX_SAFE_INTEGER;
  const d = typeof lastActionAt === "string" ? new Date(lastActionAt) : lastActionAt;
  return Math.floor((now.getTime() - d.getTime()) / 86400000);
}

export type LeadTemperature = "active" | "going_stale" | "expired";

export function leadTemperature(
  lastActionAt: Date | string | null | undefined,
  now: Date = new Date(),
): LeadTemperature {
  const days = daysSinceLastAction(lastActionAt, now);
  if (days < STALE_AFTER_DAYS) return "active";
  if (days < ARCHIVE_AFTER_DAYS) return "going_stale";
  return "expired";
}

export interface NeedsAttentionCounts {
  newToAssign: number;
  goingStale: number;
  hotNoContact: number;
}

/**
 * Three counts for the "Needs Attention" strip at the top of /leads.
 * Pure-ish — just three count queries.
 */
export async function computeNeedsAttention(
  client: Tx = defaultPrisma,
  now: Date = new Date(),
): Promise<NeedsAttentionCounts> {
  const staleCutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 86400000);
  const archiveCutoff = new Date(now.getTime() - ARCHIVE_AFTER_DAYS * 86400000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const [newToAssign, goingStale, hotNoContact] = await Promise.all([
    client.lead.count({
      where: { status: "NEW", assignedToId: null },
    }),
    client.lead.count({
      where: {
        status: { in: ["NEW", "ASSIGNED"] },
        pinned: false,
        lastActionAt: { gte: archiveCutoff, lt: staleCutoff },
      },
    }),
    // HOT + no contact in 7d proxy: ASSIGNED with lastActionAt older than 7d
    // (full HOT/WARM/COOL tier computation happens per-row in the API).
    client.lead.count({
      where: {
        status: "ASSIGNED",
        lastActionAt: { lt: sevenDaysAgo },
      },
    }),
  ]);

  return { newToAssign, goingStale, hotNoContact };
}
