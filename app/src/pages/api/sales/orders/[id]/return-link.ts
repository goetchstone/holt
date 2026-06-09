// /app/src/pages/api/sales/orders/[id]/return-link.ts

import crypto from "node:crypto";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { generateReturnNumber } from "@/lib/returnService";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const salesOrderId = Number(req.query.id);
  if (Number.isNaN(salesOrderId)) {
    return res.status(400).json({ error: "Invalid order ID" });
  }

  const { lineItemId } = req.body;

  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { id: true, customerId: true },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const portalToken = crypto.randomUUID();
    const returnNumber = await generateReturnNumber();
    const userName = (session.user as { name?: string })?.name || "System";

    const returnRecord = await prisma.$transaction(async (tx) => {
      const created = await tx.return.create({
        data: {
          returnNumber,
          status: "INITIATED",
          reason: "OTHER",
          salesOrderId: order.id,
          customerId: order.customerId,
          lineItemId: lineItemId || null,
          portalToken,
          portalRequestedAt: new Date(),
          createdBy: userName,
        },
      });

      await tx.orderChangeLog.create({
        data: {
          salesOrderId: order.id,
          changeType: "RETURN_INITIATED",
          newValue: returnNumber,
          reason: "Return portal link generated",
          changedBy: userName,
        },
      });

      return created;
    });

    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
    const url = `${baseUrl}/portal/return/${portalToken}`;

    return res.status(200).json({
      url,
      returnNumber: returnRecord.returnNumber,
      portalToken,
    });
  } catch (error) {
    logError("Return link generation error", error);
    return res.status(500).json({ error: "Failed to generate return link" });
  }
}
