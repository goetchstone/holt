// /app/src/pages/api/sales/orders/[id]/line-items.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Order ID is required." });
  }

  const orderId = Number.parseInt(id);
  const changedBy = session.user?.email || null;

  // POST: Add a new line item to the order
  if (req.method === "POST") {
    try {
      const {
        productName,
        partNo,
        quantity,
        unitPrice,
        cost: explicitCost,
        taxRate,
        source,
        fulfillment,
        productId,
      } = req.body;

      if (!productName || !quantity || unitPrice === undefined) {
        return res
          .status(400)
          .json({ error: "productName, quantity, and unitPrice are required." });
      }

      const order = await prisma.salesOrder.findUnique({
        where: { id: orderId },
        include: { lineItems: { orderBy: { lineNumber: "desc" }, take: 1 } },
      });

      if (!order) return res.status(404).json({ error: "Order not found." });
      if (order.status === "CANCELLED" || order.status === "FULFILLED") {
        return res.status(400).json({ error: `Cannot add items to a ${order.status} order.` });
      }

      // Resolve wholesale cost: use explicit value, or look up product baseCost
      let itemCost = Number(explicitCost || 0);
      if (itemCost === 0 && productId) {
        const product = await prisma.product.findUnique({
          where: { id: productId },
          select: { baseCost: true },
        });
        if (product?.baseCost) itemCost = Number(product.baseCost);
      }

      const nextLineNumber = (order.lineItems[0]?.lineNumber || 0) + 1;
      const netPrice = Number(quantity) * Number(unitPrice);
      const vatAmount = taxRate ? Math.round(netPrice * Number(taxRate) * 100) / 100 : 0;

      const result = await prisma.$transaction(async (tx) => {
        const lineItem = await tx.orderLineItem.create({
          data: {
            salesOrderId: orderId,
            lineNumber: nextLineNumber,
            productName,
            partNo: partNo || null,
            orderedQuantity: quantity,
            netPrice,
            cost: itemCost,
            barcode: "",
            vatRate: taxRate || 0,
            vatAmount,
            source: source || null,
            fulfillment: fulfillment || null,
            productId: productId || null,
          },
        });

        await tx.orderChangeLog.create({
          data: {
            salesOrderId: orderId,
            lineItemId: lineItem.id,
            changeType: "LINE_ADDED",
            newValue: `${productName} (qty: ${quantity}, price: ${unitPrice})`,
            changedBy,
          },
        });

        await tx.salesOrder.update({
          where: { id: orderId },
          data: { updatedBy: changedBy },
        });

        return lineItem;
      });

      return res.status(201).json({
        id: result.id,
        lineNumber: result.lineNumber,
        productName: result.productName,
        partNo: result.partNo,
        orderedQuantity: Number(result.orderedQuantity),
        netPrice: Number(result.netPrice),
        vatAmount: Number(result.vatAmount),
        lineItemStatus: result.lineItemStatus,
      });
    } catch (error) {
      logError("Error adding line item", error);
      return res.status(500).json({ error: "Failed to add line item." });
    }
  }

  res.setHeader("Allow", ["POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
