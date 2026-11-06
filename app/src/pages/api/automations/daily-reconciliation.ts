// /app/src/pages/api/automations/daily-reconciliation.ts
//
// Phase 0 C1 — daily-reconciliation cron endpoint. Called by an external
// scheduler (via curl + AUTO_IMPORT_API_KEY Bearer) at end-of-day,
// or manually from the admin UI (via NextAuth session).
//
// Wraps `computeDailyReconciliation` from lib/dailyReconciliation.ts.
// One run can reconcile one day (default: yesterday in the deployment's business timezone)
// or a date range. Each reconciled day produces exactly one
// DailyReconciliationLog row — re-runs append, don't overwrite, so the
// operator has full history.
//
// Dual auth model: Bearer (AUTO_IMPORT_API_KEY) for unattended cron runs,
// NextAuth session for the admin UI. No role gating beyond authentication
// itself — reading reconciliation results is non-destructive.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { parseReconciliationRange, runDailyReconciliation } from "@/lib/dailyReconciliationRun";
import { logError } from "@/lib/logger";

async function run(req: NextApiRequest, res: NextApiResponse, session: Session | null) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const summary = await runDailyReconciliation({
      range: parseReconciliationRange(req.body),
      createdBy: session?.user?.email || "auto-import",
    });
    return res.status(200).json(summary);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("Daily reconciliation orchestrator failed", err);
    return res.status(500).json({ error: "Daily reconciliation failed", details: msg });
  }
}

export default guardAutomation(run);
