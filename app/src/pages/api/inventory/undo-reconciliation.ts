// /app/src/pages/api/inventory/undo-reconciliation.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const { reconciliationId } = req.body;
  if (!reconciliationId) {
    return res.status(400).json({ error: "Reconciliation ID is required." });
  }

  try {
    await prisma.reconciliation.delete({
      where: { id: Number(reconciliationId) },
    });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to undo reconciliation." });
  }
}

export default requirePermission("inventory.count", handler);
