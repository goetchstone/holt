// /app/src/pages/api/automations/source-import.ts
//
// POST -- run this deployment's source import.
//
// Replaces /api/automations/gmail-import, which named ONE adapter's transport
// in the URL. Gmail is how Ordorite ships its reports; it is not what an
// import is. That route still works and forwards here (see its header) so the
// deployed cron on Saybrook's NAS keeps running -- renaming a URL a cron calls
// is how a nightly job dies silently.
//
// Auth is unchanged: Bearer AUTO_IMPORT_API_KEY for the cron, or an
// ADMIN/SUPER_ADMIN session. Imports MUTATE sales/PO/payment data, so the
// session path is not "any signed-in user".
//
// The module gate moved onto the adapter. `legacyPosImport` gated this route
// when Ordorite was the only possible answer; now each adapter names the flag
// it needs (or none), and resolution returns the no-op adapter when the flag
// is off. A deployment with no source system gets 200 and "nothing to import"
// instead of 404 -- which is the truth, and keeps a cron from alerting nightly
// on a deployment that is working exactly as configured.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { requirePermission } from "@/lib/auth/requireAuth";
import { getActiveSourceAdapter } from "@/lib/adapters";
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

  let adapter;
  try {
    adapter = await getActiveSourceAdapter();
  } catch (err: unknown) {
    // Resolution throws only for an id this build does not know -- a wrong
    // image or a botched rename. 500 with the reason, because importing
    // nothing and reporting success is how reports go stale unnoticed.
    logError("Source adapter resolution failed", err);
    return res.status(500).json({ error: getErrorMessage(err, "Source adapter is unavailable") });
  }

  // Fail before doing work, with the setting that is missing named. Previously
  // this surfaced as a stack trace from inside a Google auth client on the
  // first run after someone forgot to paste the service-account JSON.
  const readiness = await adapter.checkReadiness();
  if (!readiness.ready) {
    return res.status(409).json({
      error: `${adapter.label} is not ready to import.`,
      reason: readiness.reason,
      sourceAdapterId: adapter.id,
    });
  }

  try {
    const summary = await adapter.runImport({ dryRun, createdBy });
    return res.status(200).json({ ...summary, sourceAdapterId: adapter.id });
  } catch (err: unknown) {
    logError("Source import failed", err, { sourceAdapterId: adapter.id });
    // The cron wrapper alerts on non-2xx too, but a manual run from the admin
    // page should page ops the same way -- a silently-broken daily import
    // means every report goes stale.
    await reportOpsAlert({
      title: `Source import failed (${adapter.label})`,
      detail:
        "The import orchestrator threw before completing. Reports are stale until it succeeds; failed work stays queued and retries next run.",
      context: { error: getErrorMessage(err, "unknown"), sourceAdapterId: adapter.id },
    });
    return res.status(500).json({ error: getErrorMessage(err, "Import failed") });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (authorizedByApiKey(req)) return run(req, res);
  return requirePermission("admin.data", run)(req, res);
}
