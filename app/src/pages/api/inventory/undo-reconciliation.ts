// /app/src/pages/api/inventory/undo-reconciliation.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") return res.status(405).end();

  const { reconciliationId } = req.body;
  if (!reconciliationId) {
    return res.status(400).json({ error: "Reconciliation ID is required." });
  }

  try {
    const undone = await prisma.reconciliation.delete({
      where: { id: Number(reconciliationId) },
    });
    await auditLog("RECONCILIATION_UNDONE", auditActor(session), {
      summary: `Reconciliation at ${undone.location} undone`,
      details: { reconciliationId: undone.id, location: undone.location },
    });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to undo reconciliation." });
  }
}

export default requirePermission("inventory.count", handler);
