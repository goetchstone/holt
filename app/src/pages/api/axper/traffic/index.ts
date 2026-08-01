// /app/src/pages/api/axper/traffic/index.ts
//
// On-demand traffic fetch from Axper. Backs the live dashboard (HomeView),
// which needs fresh data for the current day before the daily cron has run.
//
// The persisted-history path lives in `TrafficSnapshot` + the
// `runTrafficImport` orchestrator + the daily cron. Reports that
// query date ranges should read from the table, NOT this endpoint.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { fetchAxperTraffic } from "@/lib/axperClient";
import { getTrafficStoreMap } from "@/lib/trafficStoreMap";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { dateFrom, dateTo } = req.query;
  if (typeof dateFrom !== "string" || typeof dateTo !== "string") {
    return res.status(400).json({ error: "Missing dateFrom or dateTo parameter" });
  }

  const rows = await fetchAxperTraffic({ dateFrom, dateTo });

  // Enrich with the DB-backed mapping so callers (HomeView) don't each
  // need their own server round-trip to resolve a friendly name / the
  // StoreLocation join key -- this is the only place raw Axper rows cross
  // the client/server boundary live (the persisted path resolves at
  // import time instead; see runTrafficImport.ts).
  const storeMap = await getTrafficStoreMap();
  const enriched = rows.map((row) => ({
    ...row,
    displayName: storeMap.resolveDisplayName(row.store_name),
    storeLocationName: storeMap.resolveStoreLocation(row.store_name)?.name ?? row.store_name,
  }));
  return res.status(200).json(enriched);
}
