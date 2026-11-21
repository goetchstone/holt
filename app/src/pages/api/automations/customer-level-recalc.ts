// /app/src/pages/api/automations/customer-level-recalc.ts
//
// Weekly customer-level recalc job, behind guardAutomation like every other
// automation trigger: the external scheduler (cron) presents
// AUTO_IMPORT_API_KEY as a Bearer token, and a person running it by hand needs
// "Run scheduled jobs" (admin.automations). Managers recalculate levels from
// the Customers list instead (/api/customers/recalculate-levels).
// Logs each run to MailchimpSyncLog (kind = "customer-level-recalc") so
// the admin automations dashboard can surface freshness.

import type { NextApiRequest, NextApiResponse } from "next";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { runCustomerLevelRecalc } from "@/lib/automations/loggedRuns";

async function run(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const result = await runCustomerLevelRecalc();
  return res.status(result.status === "FAILED" ? 500 : 200).json(result);
}

export default guardAutomation(run);
