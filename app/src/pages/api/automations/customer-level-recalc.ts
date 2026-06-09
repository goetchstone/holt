// /app/src/pages/api/automations/customer-level-recalc.ts
//
// Weekly customer-level recalc job. Wraps recalculateCustomerLevels() with
// Bearer-token auth so the Synology cron can call it, while also still
// accepting an authenticated ADMIN/MANAGER session for manual triggers.
// Logs each run to MailchimpSyncLog (kind = "customer-level-recalc") so
// the admin automations dashboard can surface freshness.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import { logError, logger } from "@/lib/logger";
import { recalculateCustomerLevels } from "@/lib/customerLeveling";

function isAuthorized(
  req: NextApiRequest,
  session: { user?: { email?: string | null; role?: string | null } } | null,
): boolean {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey && req.headers.authorization === `Bearer ${apiKey}`) return true;
  const role = session?.user?.role;
  if (role === "ADMIN" || role === "SUPER_ADMIN" || role === "MANAGER") return true;
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

  const runId = randomUUID();
  const startedAt = new Date();
  const errors: string[] = [];
  let customersUpdated = 0;

  try {
    const result = await recalculateCustomerLevels();
    customersUpdated = result.customersUpdated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`recalculate: ${msg}`);
    logError("customer-level-recalc failed", err);
  }

  const finishedAt = new Date();
  const status = errors.length === 0 ? "SUCCESS" : "FAILED";

  const log = await prisma.mailchimpSyncLog.create({
    data: {
      runId,
      kind: "customer-level-recalc",
      status,
      errors,
      startedAt,
      finishedAt,
    },
  });

  logger.info("customer-level-recalc complete", {
    runId,
    status,
    customersUpdated,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
  });

  return res.status(status === "FAILED" ? 500 : 200).json({
    runId,
    status,
    customersUpdated,
    errors,
    logId: log.id,
  });
}
