// /app/src/pages/api/automations/email-queue.ts
//
// POST -- drain the email queue (send due PENDING rows, retry failures). Used by
// the admin "Process now" button (session auth) and a cron (Bearer
// AUTO_IMPORT_API_KEY), mirroring the other /api/automations/* endpoints.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { processEmailQueue } from "@/lib/email/queue";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

function authorizedByApiKey(req: NextApiRequest): boolean {
  const key = process.env.AUTO_IMPORT_API_KEY;
  if (!key) return false;
  return req.headers.authorization === `Bearer ${key}`;
}

async function drain(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const summary = await processEmailQueue();
    return res.status(200).json({ summary });
  } catch (err: unknown) {
    logError("Email queue drain failed", err);
    return res.status(500).json({ error: getErrorMessage(err, "Could not process email queue") });
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (authorizedByApiKey(req)) return drain(req, res);
  return requireAuthWithRole(["SUPER_ADMIN", "ADMIN"], drain)(req, res);
}
