// /app/src/pages/api/admin/reports/commission-tiers/tiers.ts
//
// SUPER_ADMIN-only CRUD for `CommissionTier`. Owner edits the tier
// table inline from the commission-tiers report page. PUT replaces
// the entire tier set transactionally — simpler than per-row PATCH
// and the table is small (typically 3-7 rows).

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

interface TierInput {
  label: string;
  minYtdSales: number;
  maxYtdSalesExclusive: number | null;
  rate: number;
  sortOrder: number;
}

interface PutBody {
  tiers: TierInput[];
}

export default requireAuthWithRole(
  ["SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method === "GET") {
      const rows = await prisma.commissionTier.findMany({
        orderBy: { sortOrder: "asc" },
      });
      return res.status(200).json({ tiers: rows });
    }

    if (req.method !== "PUT") {
      res.setHeader("Allow", ["GET", "PUT"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = req.body as Partial<PutBody> | undefined;
    const tiers = Array.isArray(body?.tiers) ? body.tiers : null;
    if (!tiers || tiers.length === 0) {
      return res.status(400).json({ error: "Body must include non-empty `tiers` array" });
    }

    const validation = validateTiers(tiers);
    if (validation) return res.status(400).json({ error: validation });

    try {
      await prisma.$transaction(async (tx) => {
        await tx.commissionTier.deleteMany({});
        for (const [i, t] of tiers.entries()) {
          await tx.commissionTier.create({
            data: {
              label: t.label,
              minYtdSales: t.minYtdSales,
              maxYtdSalesExclusive: t.maxYtdSalesExclusive,
              rate: t.rate,
              sortOrder: t.sortOrder ?? i,
            },
          });
        }
      });
      const refreshed = await prisma.commissionTier.findMany({ orderBy: { sortOrder: "asc" } });
      return res.status(200).json({ tiers: refreshed });
    } catch (err: unknown) {
      logError("commission-tiers PUT failed", err);
      return res.status(500).json({ error: "Failed to update tiers" });
    }
  },
);

/**
 * Lightweight validation: each tier must have a label + non-negative
 * rate; brackets must be contiguous + ascending; only the LAST tier
 * may have `maxYtdSalesExclusive = null`.
 */
function validateTiers(tiers: TierInput[]): string | null {
  for (const [i, t] of tiers.entries()) {
    const fieldError = validateTierFields(t, i);
    if (fieldError) return fieldError;
    const bracketError = validateTierBrackets(t, i, tiers);
    if (bracketError) return bracketError;
  }
  return null;
}

/**
 * Per-tier shape checks: label present, rate in [0,1], minYtdSales >= 0.
 * Independent of neighbouring tiers.
 */
function validateTierFields(t: TierInput, i: number): string | null {
  if (!t.label || typeof t.label !== "string") return `Tier ${i + 1}: missing label`;
  if (typeof t.rate !== "number" || t.rate < 0 || t.rate > 1) {
    return `Tier ${i + 1} (${t.label}): rate must be between 0 and 1`;
  }
  if (typeof t.minYtdSales !== "number" || t.minYtdSales < 0) {
    return `Tier ${i + 1} (${t.label}): minYtdSales must be >= 0`;
  }
  return null;
}

/**
 * Cross-tier bracket checks: non-last tiers must be bounded + contiguous
 * with the next tier; the last tier may be unbounded.
 */
function validateTierBrackets(t: TierInput, i: number, tiers: TierInput[]): string | null {
  const isLast = i === tiers.length - 1;
  if (isLast) {
    if (t.maxYtdSalesExclusive !== null && t.maxYtdSalesExclusive <= t.minYtdSales) {
      return `Tier ${i + 1} (${t.label}): maxYtdSalesExclusive must be > minYtdSales`;
    }
    return null;
  }
  if (t.maxYtdSalesExclusive === null) {
    return `Tier ${i + 1} (${t.label}): only the last tier may be unbounded`;
  }
  if (t.maxYtdSalesExclusive <= t.minYtdSales) {
    return `Tier ${i + 1} (${t.label}): maxYtdSalesExclusive must be > minYtdSales`;
  }
  if (tiers[i + 1].minYtdSales !== t.maxYtdSalesExclusive) {
    return `Tiers ${i + 1} → ${i + 2}: brackets must be contiguous`;
  }
  return null;
}
