// /app/src/lib/reports/trafficReport.ts
//
// Aggregated Axper traffic for the traffic report. Reads TrafficSnapshot for the
// range and applies the pure rollups in lib/trafficSummary.ts. HYBRID source:
// when the range extends into today (cron hasn't run yet), live-pull today from
// Axper and merge. Extracted from the Pages API so the App Router page + tRPC
// procedure share one source of truth. No sales line items → rule 33 N/A.

import type { PrismaClient } from "@prisma/client";
import { fetchAxperTraffic } from "@/lib/axperClient";
import {
  rollupByDay,
  rollupByStore,
  rollupByDayAndStore,
  rollupByHour,
  rollupByDayOfWeek,
  totalVisitors,
  type TrafficRowForSummary,
} from "@/lib/trafficSummary";
import { getStoreDisplayName } from "@/lib/storeColors";

export interface TrafficReportParams {
  dateFrom: string; // YYYY-MM-DD
  dateTo: string; // YYYY-MM-DD
  stores?: string[] | null;
}

export class TrafficReportInputError extends Error {}

function parseDateInput(s: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const local = new Date(y, mo - 1, d);
  if (Number.isNaN(local.getTime())) return null;
  if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) {
    return null; // rejects 2024-02-30 etc
  }
  const min = new Date(2020, 0, 1).getTime();
  const max = Date.now() + 86_400_000;
  if (local.getTime() < min || local.getTime() > max) return null;
  return local;
}

function formatYMDLocal(d: Date): string {
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
  // dateTo is inclusive — upper bound is the first instant of the next day.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

export async function getTrafficReport(prisma: PrismaClient, params: TrafficReportParams) {
  const dateFrom = parseDateInput(params.dateFrom);
  const dateTo = parseDateInput(params.dateTo);
  if (!dateFrom || !dateTo) {
    throw new TrafficReportInputError("dateFrom and dateTo required as YYYY-MM-DD");
  }
  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new TrafficReportInputError("dateFrom must be on or before dateTo");
  }

  const storeFilter =
    params.stores && params.stores.length > 0 ? params.stores.map((s) => s.trim()) : null;

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
  let liveTodayPulled = false;
  if (dateTo.getTime() >= todayStart.getTime()) {
    const todayYmd = formatYMDLocal(todayStart);
    const live = await fetchAxperTraffic({ dateFrom: todayYmd, dateTo: todayYmd });
    liveTodayPulled = true;
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

  const allRows: TrafficRowForSummary[] = [...persistedRows, ...liveRows];

  const byStore = rollupByStore(allRows).map((s) => ({
    ...s,
    displayName: getStoreDisplayName(s.axperStoreName),
  }));
  const byDayAndStore = rollupByDayAndStore(allRows).map((d) => ({
    ...d,
    displayName: getStoreDisplayName(d.axperStoreName),
  }));

  const totals = totalVisitors(allRows);
  const distinctDays = new Set(rollupByDay(allRows).map((d) => d.date)).size;

  return {
    dateFrom: formatYMDLocal(dateFrom),
    dateTo: formatYMDLocal(dateTo),
    stores: storeFilter,
    liveTodayPulled,
    totals: { ...totals, distinctDays, rowCount: allRows.length },
    byDay: rollupByDay(allRows),
    byStore,
    byDayAndStore,
    byHour: rollupByHour(allRows),
    byDayOfWeek: rollupByDayOfWeek(allRows),
  };
}
