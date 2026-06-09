// /app/src/pages/api/tills/[id]/reconcile.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const role = (session as any)?.role;
  if (role !== "MANAGER" && role !== "ADMIN") {
    return res.status(403).json({ error: "Manager role required" });
  }

  const tillId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(tillId)) return res.status(400).json({ error: "Invalid till ID" });

  try {
    const till = await prisma.till.findUnique({ where: { id: tillId } });
    if (!till) return res.status(404).json({ error: "Till not found" });
    if (till.status !== "CLOSED") {
      return res.status(400).json({ error: "Till must be CLOSED before reconciliation" });
    }

    const { notes } = req.body;

    const updated = await prisma.till.update({
      where: { id: tillId },
      data: {
        status: "RECONCILED",
        notes: notes ? `${till.notes || ""}\n${notes}`.trim() : till.notes,
        updatedBy: session.user?.email || null,
      },
    });

    return res.status(200).json({
      ...updated,
      openingCash: Number(updated.openingCash),
      expectedCash: updated.expectedCash ? Number(updated.expectedCash) : null,
      actualCash: updated.actualCash ? Number(updated.actualCash) : null,
      variance: updated.variance ? Number(updated.variance) : null,
    });
  } catch (err) {
    logError("POST /tills/[id]/reconcile error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
