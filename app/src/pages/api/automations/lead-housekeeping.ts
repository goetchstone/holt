// /app/src/pages/api/automations/lead-housekeeping.ts
//
// Nightly lead-aging job. Auto-archives leads that have been silent for
// 30 days (ARCHIVE_AFTER_DAYS). Exempts pinned leads and leads whose
// customer has an active QUOTE. Safe to run repeatedly — idempotent.

import type { NextApiRequest, NextApiResponse } from "next";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { runLeadHousekeeping } from "@/lib/automations/loggedRuns";

async function run(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const result = await runLeadHousekeeping();
  return res.status(result.status === "FAILED" ? 500 : 200).json(result);
}

export default guardAutomation(run);
