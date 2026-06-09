// /app/src/pages/api/admin/reports/commission-payouts/drift.ts
//
// SUPER_ADMIN-only. Returns drift between live YTD sales and the
// frozen ytdSalesAtEnd on every locked CommissionPayout. Powers the
// "Drift" surface on the Locked Payouts tab so the operator can see
// which locks were undermined by late-landing returns / rewrites /
// cancellations / reassignments and decide whether to claw back.
//
// Query params:
//   - staffMemberId  : narrow to one designer
//   - includeClean   : when "true", include rows with |drift| ≤ $0.01
//                      (default false — only non-zero drift)
//
// Origin: PR #333 follow-up, post-v1 audit 2026-05-27.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { computeLockedPayoutDrift } from "@/lib/commissionDrift";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "GET") {
      res.setHeader("Allow", ["GET"]);
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      const staffMemberId = req.query.staffMemberId
        ? Number.parseInt(req.query.staffMemberId as string, 10)
        : undefined;
      const includeClean = req.query.includeClean === "true";
      const rows = await computeLockedPayoutDrift({
        staffMemberId: Number.isFinite(staffMemberId) ? staffMemberId : undefined,
        includeClean,
      });
      return res.status(200).json({ rows });
    } catch (err) {
      logError("commission-payouts/drift GET failed", err);
      return res.status(500).json({ error: "Failed to compute payout drift" });
    }
  },
);
