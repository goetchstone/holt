// /app/src/pages/api/admin/reports/pay-period-confirmations/reopen.ts
//
// Reopen a designer's pay-period confirmation so a correction can be
// made. MANAGER / ADMIN / SUPER_ADMIN only. `reason` is required —
// the reopen is auditable (reopenedBy + reopenReason on the row).
// After reopen the attribution lock for that designer+period lifts;
// re-confirming re-locks.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { reopenPayPeriod } from "@/lib/payPeriodConfirmationService";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN"], // tabled 2026-05-29 — owner-only until management adopts it
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const confirmationId = Number(req.body?.confirmationId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!Number.isFinite(confirmationId)) {
      return res.status(400).json({ error: "confirmationId is required" });
    }
    if (!reason) {
      return res.status(400).json({ error: "A reason is required to reopen a confirmed period" });
    }

    try {
      await reopenPayPeriod({
        confirmationId,
        reopenedBy: session.user?.email ?? "unknown",
        reason,
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      logError("POST /api/admin/reports/pay-period-confirmations/reopen failed", err);
      return res.status(500).json({ error: "Failed to reopen confirmation" });
    }
  },
);
