// /app/src/pages/api/reports/traffic/export.ts
//
// CSV export for the Traffic report. Returns one row per
// (calendar day, axperStoreName) with visitors + exits, suitable
// for pasting into Excel / Sheets. Filters mirror the JSON endpoint
// (dateFrom, dateTo, optional stores).
//
// MANAGER+ same as the JSON endpoint.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { fetchAxperTraffic } from "@/lib/axperClient";
import { rollupByDayAndStore, type TrafficRowForSummary } from "@/lib/trafficSummary";
import { getStoreDisplayName } from "@/lib/storeColors";
import { logError } from "@/lib/logger";

function parseDateInput(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const local = new Date(y, mo - 1, d);
  if (Number.isNaN(local.getTime())) return null;
  if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d)
    return null;
  return local;
}

function fmtYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfTodayLocal(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

/** CSV-safe quoting: wrap in double quotes if the value contains a comma, quote, or newline. */
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN", "SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const dateFrom = parseDateInput(req.query.dateFrom);
    const dateTo = parseDateInput(req.query.dateTo);
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ error: "dateFrom and dateTo required as YYYY-MM-DD" });
    }
    if (dateFrom.getTime() > dateTo.getTime()) {
      return res.status(400).json({ error: "dateFrom must be on or before dateTo" });
    }
    const storesParam = typeof req.query.stores === "string" ? req.query.stores.trim() : "";
    const storeFilter = storesParam.length > 0 ? storesParam.split(",").map((s) => s.trim()) : null;

    try {
      const todayStart = startOfTodayLocal();
      const persistedUpperBound =
        dateTo.getTime() < todayStart.getTime() ? endOfDay(dateTo) : todayStart;

      const snapshots = await prisma.trafficSnapshot.findMany({
        where: {
          intervalStart: { gte: dateFrom, lt: persistedUpperBound },
          ...(storeFilter ? { axperStoreName: { in: storeFilter } } : {}),
        },
        select: {
          intervalStart: true,
          axperStoreName: true,
          storeLocationId: true,
          visitors: true,
          exits: true,
        },
      });

      const persistedRows: TrafficRowForSummary[] = snapshots.map((s) => ({
        intervalStart: s.intervalStart,
        axperStoreName: s.axperStoreName,
        storeLocationId: s.storeLocationId,
        visitors: s.visitors,
        exits: s.exits,
      }));

      let liveRows: TrafficRowForSummary[] = [];
      if (dateTo.getTime() >= todayStart.getTime()) {
        const todayYmd = fmtYmd(todayStart);
        const live = await fetchAxperTraffic({ dateFrom: todayYmd, dateTo: todayYmd });
        liveRows = live
          .filter((r) => !storeFilter || storeFilter.includes(r.store_name))
          .map((r) => {
            const parsed = new Date(
              r.local_time.endsWith("Z") ? r.local_time.slice(0, -1) : r.local_time,
            );
            return {
              intervalStart: parsed,
              axperStoreName: r.store_name,
              storeLocationId: null,
              visitors: r.entries ?? 0,
              exits: r.exits ?? null,
            };
          })
          .filter((r) => !Number.isNaN(r.intervalStart.getTime()));
      }

      const allRows = [...persistedRows, ...liveRows];
      const byDayAndStore = rollupByDayAndStore(allRows);

      const header = ["Date", "Store (Axper)", "Store (Display)", "Visitors", "Exits"];
      const body = byDayAndStore.map((r) => [
        r.date,
        r.axperStoreName,
        getStoreDisplayName(r.axperStoreName),
        r.visitors,
        r.exits ?? "",
      ]);

      const lines = [header, ...body].map((row) => row.map(csvCell).join(","));
      const filename = `traffic-${fmtYmd(dateFrom)}_to_${fmtYmd(dateTo)}.csv`;

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.status(200).send(lines.join("\n"));
    } catch (err) {
      logError("/api/reports/traffic/export failed", err);
      return res.status(500).json({ error: "Traffic export failed" });
    }
  },
);
