// /app/src/pages/api/automations/email-queue.ts
//
// POST -- drain the email queue (send due PENDING rows, retry failures). Used by
// the admin "Process now" button (session auth) and a cron (Bearer
// AUTO_IMPORT_API_KEY), mirroring the other /api/automations/* endpoints.
//
// First it queues the customer messages that are due (GAP-13,
// lib/messages/due.ts), so they go in the same run. A failure there is logged
// and the drain still runs: an email already queued is not held up by one
// that couldn't be. Texts drain here too (GAP-12): one cron for what's waiting
// to reach a customer.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { processEmailQueue } from "@/lib/email/queue";
import { queueDueMessages, type DueSummary } from "@/lib/messages/due";
import { processSmsQueue } from "@/lib/sms/queue";
import { logError } from "@/lib/logger";

function authorizedByApiKey(req: NextApiRequest): boolean {
  const key = process.env.AUTO_IMPORT_API_KEY;
  if (!key) return false;
  return req.headers.authorization === `Bearer ${key}`;
}

async function drain(_req: NextApiRequest, res: NextApiResponse) {
  let messages: DueSummary | null = null;
  try {
    messages = await queueDueMessages();
  } catch (err: unknown) {
    logError("Customer messages could not be queued", err);
  }
  try {
    const summary = await processEmailQueue();
    const texts = await processSmsQueue();
    return res.status(200).json({ summary, texts, messages });
  } catch (err: unknown) {
    logError("Email queue drain failed", err);
    return res.status(500).json({ error: "Could not process email queue" });
  }
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (authorizedByApiKey(req)) return drain(req, res);
  return requirePermission("admin.integrations", drain)(req, res);
}
