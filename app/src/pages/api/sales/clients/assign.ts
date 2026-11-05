// /app/src/pages/api/sales/clients/assign.ts
//
// POST: a manager assigns clients no one owns to a salesperson, one by id or everyone
// matching the list on screen. See lib/clientAssign.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { assignClients, assignMatchingClients } from "@/lib/clientAssign";
import { parseAssignClientsBody } from "@/lib/clientOwnership";
import { logError, logger } from "@/lib/logger";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  const parsed = parseAssignClientsBody(req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });

  try {
    const actorEmail = session.user?.email ?? null;
    const result =
      parsed.kind === "one"
        ? await assignClients([parsed.customerId], parsed.toStaffId, actorEmail)
        : await assignMatchingClients(
            parsed.options,
            parsed.expectedCount,
            parsed.toStaffId,
            actorEmail,
            new Date(),
          );
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    logger.info("clients_assigned", {
      toStaffId: parsed.toStaffId,
      clientCount: result.clientCount,
      openQuotes: result.openQuotes,
      workedWith: parsed.kind === "all-matching" ? parsed.options.workedWith : null,
      by: actorEmail,
    });
    return res.status(200).json(result);
  } catch (err) {
    logError("Failed to assign clients", err);
    return res.status(500).json({ error: "Failed to assign clients" });
  }
}

export default requirePermission("sales.clients.manage", handler);
