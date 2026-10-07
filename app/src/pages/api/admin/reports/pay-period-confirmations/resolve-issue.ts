// /app/src/pages/api/admin/reports/pay-period-confirmations/resolve-issue.ts
//
// Resolve a pay-period issue a designer flagged (manager / ADMIN /
// SUPER_ADMIN). Resolving clears the flag from the review grid; the
// designer can then confirm. Resolution does NOT itself lock the
// period — confirming does. `resolutionNote` is optional.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { resolvePayPeriodIssue } from "@/lib/payPeriodConfirmationService";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN"], // tabled 2026-05-29 — owner-only until management adopts it
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const issueId = Number(req.body?.issueId);
    const resolutionNote =
      typeof req.body?.resolutionNote === "string" ? req.body.resolutionNote.trim() : undefined;

    if (!Number.isFinite(issueId)) {
      return res.status(400).json({ error: "issueId is required" });
    }

    try {
      await resolvePayPeriodIssue({
        issueId,
        resolvedBy: session.user?.email ?? "unknown",
        resolutionNote,
      });
      return res.status(200).json({ ok: true });
    } catch (err) {
      logError("POST /api/admin/reports/pay-period-confirmations/resolve-issue failed", err);
      return res.status(500).json({ error: "Failed to resolve issue" });
    }
  },
);
