// /app/src/pages/api/sales/orders/[id]/line-items.ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { returnOrderEditProblem } from "@/lib/returns/bookReturn";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import {
  DiscountApprovalError,
  NO_EXTRA_ACCESS,
  authorizeDiscount,
  catalogListUnits,
  logDiscountApproval,
} from "@/lib/sales/discountApproval";
import { lineDiscountPercent } from "@/lib/sales/discountPolicyShared";
import { productCost } from "@/lib/purchasing/landedCostShared";
import {
  resolveTaxDistrict,
  rateForLineAmount,
  lineTaxGroupOf,
  LINE_TAX_GROUP_SELECT,
} from "@/lib/tax/resolveTaxRate";

/** Exported for integration tests -- same pattern as create-from-cart.ts:
 *  calls the real Prisma client with a fake req/res + session, bypassing
 *  requireAuthWithRole (which needs real cookies). Role enforcement is
 *  covered by the apiRouteAuthorization tripwire. */
export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess = NO_EXTRA_ACCESS,
) {
  const { id } = req.query;
  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Order ID is required." });
  }

  const orderId = Number.parseInt(id);
  const changedBy = session.user?.email || null;

  if (req.method !== "GET" && !Number.isNaN(orderId)) {
    const locked = await returnOrderEditProblem(prisma, orderId);
    if (locked) return res.status(409).json({ error: locked });
  }

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

      // The product's cost (when none was sent) and the tax group it sells under.
      const product = productId
        ? await prisma.product.findUnique({
            where: { id: productId },
            select: { baseCost: true, landedCost: true, ...LINE_TAX_GROUP_SELECT },
          })
        : null;
      // The cost sent, else what the product cost Holt: its landed cost, else
      // its catalog cost (productCost, GAP-02).
      let itemCost = Number(explicitCost || 0);
      if (itemCost === 0 && product) itemCost = productCost(product) ?? 0;

      const nextLineNumber = (order.lineItems[0]?.lineNumber || 0) + 1;
      const netPrice = Number(quantity) * Number(unitPrice);

      // A product added below its retail price is a discount, and follows the
      // store's policy (lib/sales/discountApproval.ts). Checked before the
      // transaction, so a wrong manager PIN still counts.
      const [listUnit] = await catalogListUnits(prisma, [
        { productId: productId || null, unitPrice: Number(unitPrice) },
      ]);
      const percent = lineDiscountPercent({ listUnit, quantity: Number(quantity), netPrice });
      const approver = await authorizeDiscount(prisma, {
        percent,
        access,
        approval: req.body.discountApproval,
      });

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
        const lineRate = rateForLineAmount(
          taxDistrict.rules,
          netPrice,
          lineTaxGroupOf(product),
        ).rate;
        const vatAmount = Math.round(netPrice * lineRate * 100) / 100;

        const lineItem = await tx.orderLineItem.create({
          data: {
            salesOrderId: orderId,
            lineNumber: nextLineNumber,
            productName,
            partNo: partNo || null,
            orderedQuantity: quantity,
            netPrice,
            listPrice: listUnit,
            // itemCost is per-unit (the cost sent, or the product's cost);
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
        if (approver) {
          await logDiscountApproval(tx, {
            orderId,
            lineItemId: lineItem.id,
            approver,
            percent,
            changedBy,
          });
        }

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
      if (error instanceof DiscountApprovalError) {
        return res.status(error.status).json(error.body);
      }
      logError("Error adding line item", error);
      return res.status(500).json({ error: "Failed to add line item." });
    }
  }

  res.setHeader("Allow", ["POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requirePermission("sales.write", handler, { also: ["sales.discount"] });
