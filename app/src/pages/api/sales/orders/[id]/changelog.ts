// /app/src/pages/api/sales/orders/[id]/changelog.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Order ID is required." });
  }

  try {
    const logs = await prisma.orderChangeLog.findMany({
      where: { salesOrderId: Number.parseInt(id) },
      orderBy: { created: "desc" },
    });

    return res.status(200).json(
      logs.map((log) => ({
        id: log.id,
        changeType: log.changeType,
        lineItemId: log.lineItemId,
        previousValue: log.previousValue,
        newValue: log.newValue,
        reason: log.reason,
        changedBy: log.changedBy,
        created: log.created,
      })),
    );
  } catch (error) {
    logError("Error fetching changelog", error);
    return res.status(500).json({ error: "Failed to fetch changelog." });
  }
}
