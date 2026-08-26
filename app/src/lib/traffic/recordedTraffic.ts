// /app/src/lib/traffic/recordedTraffic.ts
//
// Door-counter traffic, read back from what we already recorded.
//
// The live path (lib/axperClient.ts) returns [] whenever the counter is
// unreachable OR unconfigured -- no API key, bad credentials, vendor outage,
// all the same empty array. The dashboard then renders "0 ENTRIES TODAY",
// which is a lie of a specific and damaging kind: it does not say "we cannot
// see the counter", it says "nobody came in".
//
// `TrafficSnapshot` already holds every interval the import has ever pulled,
// so the honest fallback is to answer from it. A deployment whose counter died
// this morning still sees yesterday, last week and the same day last year --
// and one that has no counter at all (or a demo, which cannot call a third
// party) sees its recorded history instead of a wall of zeros.

import { prisma } from "@/lib/prisma";
import type { AxperTrafficRow } from "@/lib/axperClient";

/**
 * Recorded intervals for a date range, in the shape the live client returns so
 * callers cannot tell the two apart by accident.
 *
 * `dateFrom` / `dateTo` are inclusive YYYY-MM-DD, matching the live client.
 */
export async function readRecordedTraffic(
  dateFrom: string,
  dateTo: string,
): Promise<AxperTrafficRow[]> {
  const gte = new Date(`${dateFrom}T00:00:00.000Z`);
  // Inclusive of the whole end day.
  const lt = new Date(`${dateTo}T00:00:00.000Z`);
  lt.setUTCDate(lt.getUTCDate() + 1);

  const rows = await prisma.trafficSnapshot.findMany({
    where: { intervalStart: { gte, lt } },
    select: {
      intervalStart: true,
      sourceStoreName: true,
      visitors: true,
      exits: true,
    },
    orderBy: { intervalStart: "asc" },
  });

  return rows.map((r) => ({
    // The counter's own store number is not persisted -- the mapping is by name
    // (StoreLocation.trafficSourceNames), which is what resolves both paths
    // downstream. An empty string is honest here; inventing one is not.
    store_number: "",
    store_name: r.sourceStoreName,
    local_time: r.intervalStart.toISOString().replace("Z", ""),
    entries: r.visitors,
    exits: r.exits ?? 0,
  }));
}
