// /app/src/pages/api/sales/orders/[id]/return-link.ts
//
// POST -- staff mint a customer's return link for an order: an INITIATED Return
// with a portalToken, opened at /portal/return/[token]. A line named for the
// return must be one it may be for (returnLineProblem): the same check the
// customer's own request makes, so the link and the request cannot disagree.

import crypto from "node:crypto";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { generateReturnNumber } from "@/lib/returnService";
import { isLineItemId, LINE_ITEM_ID_ERROR, returnLineProblem } from "@/lib/returns/returnLine";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const salesOrderId = Number(req.query.id);
  if (Number.isNaN(salesOrderId)) {
    return res.status(400).json({ error: "Invalid order ID" });
  }

  const lineItemId: unknown = req.body?.lineItemId ?? null;
  if (lineItemId !== null && !isLineItemId(lineItemId)) {
    return res.status(400).json({ error: LINE_ITEM_ID_ERROR });
  }

  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: { id: true, customerId: true },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (lineItemId !== null) {
      const problem = await returnLineProblem(prisma, order.id, lineItemId);
      if (problem) return res.status(400).json({ error: problem });
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
          lineItemId,
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

export default requirePermission("sales.write", handler);
