// /app/src/pages/api/admin/reports/commission-tiers.ts
//
// Commission tier report (live calculator) — SUPER_ADMIN ONLY.
//
// Marginal-tier model (owner direction 2026-05-19):
//   Caller supplies a date range. For each designer we compute:
//     ytdAtStart = sum of their sales from Jan 1 of startDate.year
//                  through the day BEFORE startDate
//     ytdAtEnd   = sum from Jan 1 of startDate.year through endDate
//                  (inclusive)
//   Commission for the window = marginal slice between ytdAtStart
//   and ytdAtEnd, with each subslice paid at its tier's rate.
//
// Tiers resolve PER DESIGNER through lib/commissionPlans.ts (assigned plan ->
// default plan -> legacy CommissionTier table -> built-in defaults), the same
// resolution the payout generator uses, so the live view and locked payouts
// can never price a designer differently. Each row reports which plan priced
// it; the top-level `tiers` is the default-resolution set (what an unassigned
// designer gets).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import {
  calculateMarginalCommission,
  resolveTier,
  type CommissionTier,
} from "@/lib/commissionTiers";
import { sumDesignerSales } from "@/lib/commissionSales";
import { resolvePlanTiersForStaff, loadLegacyOrDefaultTiers } from "@/lib/commissionPlans";
import { logError } from "@/lib/logger";

interface CommissionRow {
  staffId: number;
  displayName: string;
  planName: string;
  ytdAtStart: number;
  windowSales: number;
  ytdAtEnd: number;
  currentTierLabel: string;
  commission: number;
  breakdown: ReadonlyArray<{
    tierLabel: string;
    rate: number;
    salesInTier: number;
    commission: number;
  }>;
}

interface Response {
  startDate: string;
  endDate: string;
  asOf: string;
  /** Default-resolution tier set (what an unassigned designer gets). */
  tiers: CommissionTier[];
  rows: CommissionRow[];
  totals: {
    totalWindowSales: number;
    totalCommission: number;
  };
}

export default requireAuthWithRole(
  ["SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse<Response | { error: string }>) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      // Default window: year-to-date (Jan 1 of current year through today).
      const today = new Date();
      const defaultStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      const startDate = parseIsoDate(req.query.startDate as string | undefined) ?? defaultStart;
      const endDate = parseIsoDate(req.query.endDate as string | undefined) ?? today;
      if (endDate < startDate) {
        return res.status(400).json({ error: "endDate must be >= startDate" });
      }
      // Year-start anchor (for YTD-at-start lookback).
      const yearStart = new Date(Date.UTC(startDate.getUTCFullYear(), 0, 1));
      // Make the window endpoint inclusive by extending to end-of-day.
      const endExclusive = new Date(endDate);
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

      // Pull designers (incl. aliases for SalesOrder match).
      const staff = await prisma.staffMember.findMany({
        where: { role: { in: ["DESIGNER", "MANAGER"] }, isActive: true },
        select: { id: true, displayName: true, aliases: true },
        orderBy: { displayName: "asc" },
      });

      const [planTiers, defaultResolution] = await Promise.all([
        resolvePlanTiersForStaff(staff.map((s) => s.id)),
        loadLegacyOrDefaultTiers(),
      ]);

      const rows: CommissionRow[] = [];
      for (const s of staff) {
        const resolved = planTiers.get(s.id);
        if (!resolved) continue;
        const matchNames = [s.displayName, ...(s.aliases ?? [])];

        // Two sums: year-start → window-start (= ytdAtStart) and
        // year-start → window-end (= ytdAtEnd). Marginal slice between
        // them is the commissioned window.
        const [ytdAtStart, ytdAtEnd] = await Promise.all([
          sumDesignerSales(s.id, matchNames, yearStart, startDate),
          sumDesignerSales(s.id, matchNames, yearStart, endExclusive),
        ]);

        const windowSales = Math.max(0, ytdAtEnd - ytdAtStart);
        const result = calculateMarginalCommission(ytdAtStart, ytdAtEnd, resolved.tiers);
        const currentTier = resolveTier(ytdAtEnd, resolved.tiers);

        // Skip designers with $0 in the window. Reduces noise on the
        // table without losing info (totals row would be unaffected).
        if (windowSales === 0 && result.commission === 0) continue;

        rows.push({
          staffId: s.id,
          displayName: s.displayName,
          planName: resolved.planName,
          ytdAtStart,
          windowSales,
          ytdAtEnd,
          currentTierLabel: currentTier.label,
          commission: result.commission,
          breakdown: result.breakdown,
        });
      }

      rows.sort((a, b) => b.commission - a.commission);

      const totals = {
        totalWindowSales: rows.reduce((sum, r) => sum + r.windowSales, 0),
        totalCommission: rows.reduce((sum, r) => sum + r.commission, 0),
      };

      return res.status(200).json({
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        asOf: new Date().toISOString(),
        tiers: [...defaultResolution.tiers],
        rows,
        totals,
      });
    } catch (err: unknown) {
      logError("commission-tiers report failed", err);
      return res.status(500).json({ error: "Failed to compute commission tiers" });
    }
  },
);

function parseIsoDate(value: string | undefined): Date | null {
  if (!value) return null;
  // Accept YYYY-MM-DD; Date.UTC interpretation so timezone doesn't shift the day.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

// sumDesignerSales moved to lib/commissionSales.ts so the payout-generation
// flow (api/admin/reports/commission-payouts/*) can call the same function.
