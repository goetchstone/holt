// /app/src/pages/api/automations/mailchimp-customer-sync.ts
//
// Pushes new ERP customers (created on/after AUDIENCE_BACKFILL_CUTOFF, no
// prior sync, has email) into the configured Mailchimp audience as PENDING
// (double-opt-in). Idempotent.
//
// Triggered by:
//   - scripts/auto-mailchimp-customer-sync.sh (Synology cron, daily)
//   - "Sync new customers" button on /admin/automations/mailchimp-sync
//
// Auth: Bearer AUTO_IMPORT_API_KEY (cron) or authenticated session (UI).

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError, logger } from "@/lib/logger";
import { runCustomerAudienceSync } from "@/lib/mailchimpAudienceSync";

function isAuthorized(
  req: NextApiRequest,
  session: { user?: { email?: string | null } } | null,
): boolean {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey && req.headers.authorization === `Bearer ${apiKey}`) return true;
  if (session?.user?.email) return true;
  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!isAuthorized(req, session)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Optional knobs from the body. Default cap of 200/run keeps a single
  // cron tick well under Mailchimp rate limits + bounds the worst-case
  // duration. Operators can pass a smaller limit for a probe run, or
  // ?dryRun=true to validate without writing.
  const limit = Number.parseInt((req.query.limit as string) || "", 10);
  const dryRun = req.query.dryRun === "true";

  try {
    const result = await runCustomerAudienceSync({
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      dryRun,
    });

    logger.info(
      `Mailchimp customer sync: scanned=${result.scanned} pushed=${result.pushed} ` +
        `skippedNoEmail=${result.skippedNoEmail} skippedInvalidEmail=${result.skippedInvalidEmail} ` +
        `errors=${result.errors.length} dryRun=${dryRun}`,
    );

    return res.status(200).json(result);
  } catch (err: unknown) {
    logError("Mailchimp customer sync failed", err);
    const message = err instanceof Error ? err.message : "unknown error";
    return res.status(500).json({ error: message });
  }
}
