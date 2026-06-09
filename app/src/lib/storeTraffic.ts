// /app/src/lib/storeTraffic.ts
//
// Shared foot-traffic rollup. Groups the raw door-counter store names
// into the canonical StoreLocation names via getStoreLocationName —
// multiple counter names can map to one physical store (co-located
// buildings) so the keys line up with SalesOrder.storeLocation.
// Locations with no door counter simply won't appear (they read 0
// visitors on a row).
//
// Reads only persisted TrafficSnapshot — no live Axper pull. Used by
// the Comparative Sales report and the Weekly Summary week-over-week
// view, so the two reports can't diverge on how traffic is bucketed.

import { prisma } from "@/lib/prisma";
import { getStoreLocationName } from "@/lib/storeColors";

/**
 * Total visitors per canonical StoreLocation name for the window
 * `[from, to)` (to is exclusive).
 */
export async function visitorsByStoreLocation(
  from: Date,
  to: Date,
): Promise<Record<string, number>> {
  const snaps = await prisma.trafficSnapshot.findMany({
    where: { intervalStart: { gte: from, lt: to } },
    select: { axperStoreName: true, visitors: true },
  });
  const result: Record<string, number> = {};
  for (const s of snaps) {
    const loc = getStoreLocationName(s.axperStoreName);
    result[loc] = (result[loc] ?? 0) + s.visitors;
  }
  return result;
}
