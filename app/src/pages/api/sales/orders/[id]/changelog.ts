// /app/src/pages/api/sales/orders/[id]/changelog.ts

import { requirePermission } from "@/lib/auth/requireAuth";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
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

export default requirePermission("sales.read", handler);
