// /app/src/pages/api/inventory/undo-reconciliation.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
