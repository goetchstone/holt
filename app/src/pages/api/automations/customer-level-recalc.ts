// /app/src/pages/api/automations/customer-level-recalc.ts
//
// Weekly customer-level recalc job. Wraps recalculateCustomerLevels() with
// Bearer-token auth so an external scheduler (cron) can call it, while also still
// accepting an authenticated ADMIN/MANAGER session for manual triggers.
// Logs each run to MailchimpSyncLog (kind = "customer-level-recalc") so
// the admin automations dashboard can surface freshness.

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { activeStaffRole } from "@/lib/auth/requireAuth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { runCustomerLevelRecalc } from "@/lib/automations/loggedRuns";

async function isAuthorized(
  req: NextApiRequest,
  session: { user?: { id?: string | null; email?: string | null } } | null,
): Promise<boolean> {
  const apiKey = process.env.AUTO_IMPORT_API_KEY;
  if (apiKey && req.headers.authorization === `Bearer ${apiKey}`) return true;
  // Database, not the token. The Bearer path above is for cron; this branch is a
  // human, and a demoted or deactivated one kept access until their JWT expired.
  const role = await activeStaffRole(session);
  if (role === "ADMIN" || role === "SUPER_ADMIN" || role === "MANAGER") return true;
  return false;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!(await isAuthorized(req, session))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const result = await runCustomerLevelRecalc();
  return res.status(result.status === "FAILED" ? 500 : 200).json(result);
}
