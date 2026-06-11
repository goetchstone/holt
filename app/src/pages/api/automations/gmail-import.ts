// /app/src/pages/api/automations/gmail-import.ts
//
// POST -- run the legacy-POS auto-import (Gmail -> CSV -> import runners).
// Called by the daily cron (Bearer AUTO_IMPORT_API_KEY via
// scripts/auto-import.sh) or manually from the admin automations page
// (role-gated session). Imports MUTATE sales/PO/payment data, so the session
// path requires ADMIN — not just any signed-in user. Gated behind the
// `legacyPosImport` feature flag (404 when the edition doesn't use it).
// ?dryRun=true parses + routes without writing.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { runGmailImport } from "@/lib/adapters/ordorite/orchestrator";
import { reportOpsAlert } from "@/lib/opsAlert";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

function authorizedByApiKey(req: NextApiRequest): boolean {
  const key = process.env.AUTO_IMPORT_API_KEY;
  if (!key) return false;
  return req.headers.authorization === `Bearer ${key}`;
}

async function run(req: NextApiRequest, res: NextApiResponse) {
  const dryRun = req.query.dryRun === "true";
  const session = await getServerSession(req, res, authOptions);
  const createdBy = session?.user?.email || "auto-import";

  try {
    const summary = await runGmailImport({ dryRun, createdBy });
    return res.status(200).json(summary);
  } catch (err: unknown) {
    logError("Legacy-POS import orchestrator failed", err);
    // The cron wrapper alerts on non-2xx too, but a manual run from the admin
    // page should page ops the same way — a silently-broken daily import means
    // every report goes stale.
    await reportOpsAlert({
      title: "Legacy-POS auto-import failed",
      detail:
        "The Gmail import orchestrator threw before completing. Reports are stale until it succeeds; failed emails stay queued and retry next run.",
      context: { error: getErrorMessage(err, "unknown") },
    });
    return res.status(500).json({ error: getErrorMessage(err, "Import failed") });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "legacyPosImport")) {
    return res.status(404).json({ error: "Not found" });
  }
  if (authorizedByApiKey(req)) return run(req, res);
  return requireAuthWithRole(["SUPER_ADMIN", "ADMIN"], run)(req, res);
}
