// /app/src/pages/api/axper/traffic/index.ts
//
// On-demand traffic fetch from Axper. Backs the live dashboard (HomeView),
// which needs fresh data for the current day before the daily cron has run.
//
// Gated on "View store traffic" (reporting.traffic, SEC-13 2026-09-24), a
// switch the owner sets per role in Admin > Setup > Roles. Every built-in role
// holds it by default, because these figures were open to all staff before.
//
// The persisted-history path lives in `TrafficSnapshot` + the
// `runTrafficImport` orchestrator + the daily cron. Reports that
// query date ranges should read from the table, NOT this endpoint.

import type { NextApiRequest, NextApiResponse } from "next";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { requirePermission } from "@/lib/auth/requireAuth";
import { fetchAxperTraffic } from "@/lib/axperClient";
import { readRecordedTraffic } from "@/lib/traffic/recordedTraffic";
import { getTrafficStoreMap } from "@/lib/trafficStoreMap";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written as YYYY-MM-DD (so 2026-02-30 is refused). */
function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const day = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  if (!(await isModuleEnabled("storeTraffic"))) {
    return res.status(404).json({ error: "Module not enabled" });
  }

  // Checked before anything reaches Axper, the logs or the database: a value
  // that is not a real day used to go into an error log verbatim, and made the
  // recorded-traffic fallback throw.
  const { dateFrom, dateTo } = req.query;
  if (!isCalendarDay(dateFrom) || !isCalendarDay(dateTo)) {
    return res.status(400).json({ error: "dateFrom and dateTo must be days written YYYY-MM-DD" });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ error: "dateFrom must not be after dateTo" });
  }

  // Live first, recorded second. fetchAxperTraffic returns [] for every kind
  // of not-working -- no API key, bad credentials, vendor outage -- so an empty
  // result is never evidence that nobody came in. Falling back to what we have
  // already recorded turns "0 visitors" back into the truth.
  const live = await fetchAxperTraffic({ dateFrom, dateTo });
  const rows = live.length > 0 ? live : await readRecordedTraffic(dateFrom, dateTo);

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

export default requirePermission("reporting.traffic", handler);
