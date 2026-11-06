// /app/src/pages/api/automations/mailchimp-sync.ts
//
// Orchestrator endpoint for the automated Mailchimp sync pipeline. Runs
// every 6 hours from an external scheduler (curl + AUTO_IMPORT_API_KEY)
// or on-demand from the admin page (NextAuth session).
//
// Phases, each wrapped in its own try/catch so a later phase failing doesn't
// erase the earlier phase's work:
//
//   1. Campaigns      — cheap, always incremental
//   2. Metrics        — campaigns sent in last 30 days
//   3. Activity       — campaigns sent in last 14 days
//   4. Lead ingestor  — converts newly-synced activity into leads
//
// Writes one MailchimpSyncLog row per run with status SUCCESS / PARTIAL / FAILED.

import type { NextApiRequest, NextApiResponse } from "next";
import { guardAutomation } from "@/lib/automations/guardAutomation";
import {
  MAILCHIMP_SYNC_PHASES,
  runMailchimpSync,
  type MailchimpSyncPhase,
} from "@/lib/mailchimpSyncRun";

async function run(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const phaseParam = (req.query.phase as string) || "all";
  if (!MAILCHIMP_SYNC_PHASES.includes(phaseParam as MailchimpSyncPhase)) {
    return res.status(400).json({
      error: `phase must be one of: ${MAILCHIMP_SYNC_PHASES.join(", ")}`,
    });
  }
  const result = await runMailchimpSync(phaseParam as MailchimpSyncPhase);
  return res.status(result.status === "FAILED" ? 500 : 200).json(result);
}

export default guardAutomation(run);
