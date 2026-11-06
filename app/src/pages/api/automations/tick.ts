// /app/src/pages/api/automations/tick.ts
//
// The one thing a host's scheduler calls, every 5 minutes (scripts/auto-automations.sh).
// Holt decides what's due from the store's settings (lib/automations/runner.ts). It
// answers 200 even when a job failed: that's reported on Admin > Automations and to ops
// alerts, and a retry from cron would only run the job again.

import type { NextApiRequest, NextApiResponse } from "next";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import { runDueAutomations } from "@/lib/automations/runner";
import { logError } from "@/lib/logger";

async function run(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    return res.status(200).json({ results: await runDueAutomations() });
  } catch (err: unknown) {
    logError("Automations could not run", err);
    return res.status(500).json({ error: "Automations could not run" });
  }
}

export default guardAutomation(run);
