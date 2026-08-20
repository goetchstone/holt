// /app/src/pages/api/sales/orders/[id]/line-items.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { resolveTaxDistrict, rateForLineAmount } from "@/lib/tax/resolveTaxRate";

/** Exported for integration tests -- same pattern as create-from-cart.ts:
 *  calls the real Prisma client with a fake req/res + session, bypassing
 *  requireAuthWithRole (which needs real cookies). Role enforcement is
 *  covered by the apiRouteAuthorization tripwire. */
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
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

      const result = await prisma.$transaction(async (tx) => {
        // Tax is resolved SERVER-SIDE from the order's customer and store.
        //
        // It used to be `taxRate` off the request body: the client told the
        // server what tax to charge. Two failures in one. A caller could send
        // any rate, and a caller that simply omitted it got `taxRate || 0` --
        // a line silently added at ZERO tax to an otherwise-taxed order, with
        // nothing anywhere reporting a problem.
        //
        // Resolved per line rather than per order because a TaxRule can band by
        // amount (triggerPrice / startPrice), so a $9,000 line and a $90 line
        // on the same order can legitimately differ.
        const taxDistrict = await resolveTaxDistrict(tx, {
          customerId: order.customerId,
          storeLocationId: order.storeLocationId,
          contextLabel: `order ${order.orderno ?? orderId}`,
        });
        const lineRate = rateForLineAmount(taxDistrict.rules, netPrice).rate;
        const vatAmount = Math.round(netPrice * lineRate * 100) / 100;

        const lineItem = await tx.orderLineItem.create({
          data: {
            salesOrderId: orderId,
            lineNumber: nextLineNumber,
            productName,
            partNo: partNo || null,
            orderedQuantity: quantity,
            netPrice,
            // itemCost is per-unit (explicit value or product baseCost);
            // OrderLineItem.cost stores the LINE total, like netPrice.
            cost: itemCost * Number(quantity),
            barcode: "",
            vatRate: lineRate,
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

        // A new line changes what the order has committed -- full resync
        // (release everything, re-allocate current active lines) rather
        // than per-line delta math. See allocation.ts's release() doc
        // comment for why.
        await resyncOrderAllocation(orderId, order.storeLocation, tx);

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

export default requirePermission("sales.write", handler);
