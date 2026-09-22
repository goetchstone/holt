// /app/src/pages/api/automations/customer-ar-drift-check.ts
//
// Phase 0.5.5 (2026-05-12) — daily AR-drift cron endpoint.
//
// Thin wrapper over `runCustomerArDriftCheck` in lib. Authorized via
// NextAuth session OR the `AUTO_IMPORT_API_KEY` Bearer token (same
// pattern as lead-housekeeping + mailchimp-sync).
//
// POST only. Idempotent — running it twice produces the same report
// (assuming no underlying writes between runs).

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { logError, logger } from "@/lib/logger";
import { runCustomerArDriftCheck } from "@/lib/customerArDriftRunner";

async function run(req: NextApiRequest, res: NextApiResponse, session: Session | null) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Phase 0.5.7 — accept either ?lookbackHours=N (default) OR
  // ?customerIds=1,2,3 (hand-pick mode for the cutover validation).
  // The runner enforces "customerIds wins when both are present"; here
  // we just coerce both surfaces from the query.
  const lookbackHoursParam = Number.parseInt(String(req.query.lookbackHours ?? ""), 10);
  const lookbackHours =
    Number.isFinite(lookbackHoursParam) && lookbackHoursParam > 0 ? lookbackHoursParam : undefined;

  const customerIdsParam = req.query.customerIds;
  const customerIds =
    typeof customerIdsParam === "string" && customerIdsParam.trim() !== ""
      ? customerIdsParam
          .split(",")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0)
      : undefined;

  try {
    const report = await runCustomerArDriftCheck({
      lookbackHours,
      customerIds,
    });
    const logCtx = {
      mode: report.mode,
      lookbackHours: report.lookbackHours,
      checked: report.checked,
      drifted: report.drifted.length,
      totalAbsoluteDrift: report.totalAbsoluteDrift,
    };
    if (report.drifted.length > 0) {
      logger.warn("ar-drift-check: drift detected", logCtx);
    } else {
      logger.info("ar-drift-check: no drift", logCtx);
    }
    return res.status(200).json(report);
  } catch (err) {
    logError("ar-drift-check failed", err);
    return res.status(500).json({ error: "AR drift check failed" });
  }
}

export default guardAutomation(run);
