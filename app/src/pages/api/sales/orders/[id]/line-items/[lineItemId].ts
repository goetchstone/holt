// /app/src/pages/api/sales/orders/[id]/line-items/[lineItemId].ts

import { dropPoLines, poOutcome, raiseSpecialOrderPos, readLinePos } from "@/lib/sales/salePos";
import { isPoDecision, poLineChangeProblem, poStanding } from "@/lib/sales/salePosShared";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { returnOrderEditProblem } from "@/lib/returns/bookReturn";
import { deliveryFeeLineEditProblem } from "@/lib/delivery/deliveryFee";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import {
  DiscountApprovalError,
  NO_EXTRA_ACCESS,
  authorizeDiscount,
  catalogListUnits,
  existingListUnit,
  logDiscountApproval,
} from "@/lib/sales/discountApproval";
import { lineDiscountPercent } from "@/lib/sales/discountPolicyShared";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { HoldError, quoteHoldContext, setLineHold } from "@/lib/sales/quoteHolds";
import { readLineNote } from "@/lib/sales/lineNotesShared";

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
  const { id, lineItemId } = req.query;
  if (!id || typeof id !== "string" || !lineItemId || typeof lineItemId !== "string") {
    return res.status(400).json({ error: "Order ID and Line Item ID are required." });
  }

  const orderId = Number.parseInt(id);
  const itemId = Number.parseInt(lineItemId);
  const changedBy = session.user?.email || null;

  if (!Number.isNaN(orderId)) {
    const locked = await returnOrderEditProblem(prisma, orderId);
    if (locked) return res.status(409).json({ error: locked });
  }
  if (!Number.isNaN(itemId)) {
    const feeLine = await deliveryFeeLineEditProblem(prisma, itemId);
    if (feeLine) return res.status(409).json({ error: feeLine });
  }

  // PUT: Update line item (cancel, replace, relink, or modify)
  if (req.method === "PUT") {
    try {
      const { action, reason, replacement, quantity, unitPrice, productId, partNo, poDecision } =
        req.body;

      const order = await prisma.salesOrder.findUnique({ where: { id: orderId } });
      if (!order) return res.status(404).json({ error: "Order not found." });

      const lineItem = await prisma.orderLineItem.findFirst({
        where: { id: itemId, salesOrderId: orderId },
      });
      if (!lineItem) return res.status(404).json({ error: "Line item not found." });

      // Nothing on a cancelled sale changes: its money and stock have gone back. A note
      // can still go on, and a relink only fixes how a line reports.
      if (order.status === "CANCELLED" && action !== "note" && action !== "relink") {
        return res
          .status(409)
          .json({ error: "This order is cancelled. To sell it again, copy it." });
      }

      // A line the vendor has acknowledged keeps its product and quantity (DECISIONS 51).
      const linePos = await readLinePos(prisma, itemId);
      const changesWhatIsOrdered =
        action === "replace" ||
        action === "relink" ||
        (action === "update" &&
          quantity !== undefined &&
          Number(quantity) !== Number(lineItem.orderedQuantity));
      if (changesWhatIsOrdered) {
        const stuck = linePos.map(poLineChangeProblem).find(Boolean);
        if (stuck) return res.status(409).json({ error: stuck });
      }

      // Allow "relink" on cancelled items too — a misclassified cancelled line
      // shouldn't block recategorization for reporting purposes.
      if (lineItem.lineItemStatus === "CANCELLED" && action !== "relink") {
        return res.status(400).json({ error: "Cannot modify a cancelled line item." });
      }

      // Hold a quote line's floor stock for the customer through a day, or
      // take the hold off with null (GAP-16, lib/sales/quoteHolds.ts).
      if (action === "hold") {
        const { holdUntil } = req.body as { holdUntil?: unknown };
        if (holdUntil !== null && typeof holdUntil !== "string") {
          return res.status(400).json({ error: "holdUntil must be a date (YYYY-MM-DD) or null." });
        }
        try {
          const ctx = await quoteHoldContext();
          const result = await prisma.$transaction((tx) =>
            setLineHold(tx, { orderId, lineItemId: itemId, holdUntil, actor: changedBy }, ctx),
          );
          return res.status(200).json({ id: itemId, holdUntil: result.holdUntil });
        } catch (error) {
          if (error instanceof HoldError) {
            return res.status(error.status).json({ error: error.message });
          }
          throw error;
        }
      }

      // Staff's note on the line (GAP-07, lib/sales/lineNotesShared.ts):
      // printed under it on the invoice and found by the orders search. null
      // clears it. A note changes no money, so a delivered order's lines take
      // one too.
      if (action === "note") {
        const read = readLineNote((req.body as { notes?: unknown }).notes);
        if ("problem" in read) return res.status(400).json({ error: read.problem });
        if (read.note !== lineItem.notes) {
          await prisma.$transaction([
            prisma.orderLineItem.update({ where: { id: itemId }, data: { notes: read.note } }),
            prisma.orderChangeLog.create({
              data: {
                salesOrderId: orderId,
                lineItemId: itemId,
                changeType: "LINE_NOTE",
                previousValue: lineItem.notes,
                newValue: read.note,
                changedBy,
              },
            }),
          ]);
        }
        return res.status(200).json({ id: itemId, notes: read.note });
      }

      // Relink: change the productId so the line item joins the right
      // department/category on reports. Optionally also update partNo so
      // future imports / auto-relink pick up the new mapping.
      if (action === "relink") {
        if (productId !== null && typeof productId !== "number") {
          return res.status(400).json({ error: "productId must be a number or null" });
        }

        if (productId !== null) {
          const product = await prisma.product.findUnique({
            where: { id: productId },
            select: { id: true, productNumber: true },
          });
          if (!product) return res.status(400).json({ error: "Product not found" });
        }

        const updates: Record<string, unknown> = { productId };
        if (typeof partNo === "string" && partNo.trim() !== lineItem.partNo) {
          updates.partNo = partNo.trim();
        }

        const result = await prisma.$transaction(async (tx) => {
          const updated = await tx.orderLineItem.update({
            where: { id: itemId },
            data: updates,
          });

          await tx.orderChangeLog.create({
            data: {
              salesOrderId: orderId,
              lineItemId: itemId,
              changeType: "PRODUCT_RELINKED",
              previousValue: `productId: ${lineItem.productId ?? "null"}, partNo: ${lineItem.partNo ?? ""}`,
              newValue: `productId: ${productId ?? "null"}${updates.partNo ? `, partNo: ${updates.partNo}` : ""}`,
              reason: reason || null,
              changedBy,
            },
          });

          await tx.salesOrder.update({
            where: { id: orderId },
            data: { updatedBy: changedBy },
          });

          // Relinking can change which product this line commits stock
          // against -- full resync rather than delta math.
          await resyncOrderAllocation(orderId, order.storeLocation, tx);

          return updated;
        });

        return res.status(200).json({
          id: result.id,
          productId: result.productId,
          partNo: result.partNo,
        });
      }

      // Cancel a line item
      if (action === "cancel") {
        if (!reason) {
          return res.status(400).json({ error: "Cancel reason is required." });
        }

        // An acknowledged PO needs a decision, from someone who may make it. A line that's
        // kept leaves its PO alone: its goods arrive free now the line is cancelled.
        const acknowledged = linePos.filter((po) => poStanding(po.status) === "ACKNOWLEDGED");
        const poCalled = linePos.some((po) => poStanding(po.status) !== "OPEN");
        if (poCalled && !access.holds["sales.cancel-acknowledged"]) {
          return res.status(403).json({
            error:
              "A vendor has acknowledged this line's PO, and your role can't make that call. Ask a manager.",
          });
        }
        if (acknowledged.length > 0 && !isPoDecision(poDecision)) {
          return res.status(400).json({
            error: `${acknowledged[0].poNumber} is acknowledged by ${acknowledged[0].vendor}. Say whether they agreed to cancel it, or the store keeps the piece.`,
          });
        }

        const result = await prisma.$transaction(async (tx) => {
          const updated = await tx.orderLineItem.update({
            where: { id: itemId },
            data: { lineItemStatus: "CANCELLED", cancelReason: reason },
          });

          for (const po of linePos) {
            const outcome = poOutcome(po, isPoDecision(poDecision) ? poDecision : undefined);
            if (outcome === "NONE") continue;
            if (outcome === "DROP") await dropPoLines(tx, po, changedBy);
            await tx.orderChangeLog.create({
              data: {
                salesOrderId: orderId,
                lineItemId: itemId,
                changeType: outcome === "DROP" ? "PO_CANCELLED" : "PO_KEPT",
                newValue: po.poNumber,
                reason:
                  outcome === "KEEP"
                    ? `${po.vendor} acknowledged it, and the store keeps the piece to sell off the floor`
                    : null,
                changedBy,
              },
            });
          }

          await tx.orderChangeLog.create({
            data: {
              salesOrderId: orderId,
              lineItemId: itemId,
              changeType: "LINE_CANCELLED",
              previousValue: lineItem.lineItemStatus,
              newValue: "CANCELLED",
              reason,
              changedBy,
            },
          });

          await tx.salesOrder.update({
            where: { id: orderId },
            data: { updatedBy: changedBy },
          });

          // Cancelling a line changes what the order has committed --
          // full resync rather than delta math.
          await resyncOrderAllocation(orderId, order.storeLocation, tx);

          return updated;
        });

        return res.status(200).json({
          id: result.id,
          lineItemStatus: result.lineItemStatus,
          cancelReason: result.cancelReason,
        });
      }

      // Replace a line item (e.g., fabric out of stock, customer re-selects)
      if (action === "replace") {
        if (!replacement || !replacement.productName) {
          return res
            .status(400)
            .json({ error: "Replacement item details are required (productName)." });
        }

        // Get next line number
        const maxLine = await prisma.orderLineItem.findFirst({
          where: { salesOrderId: orderId },
          orderBy: { lineNumber: "desc" },
        });
        const nextLineNumber = (maxLine?.lineNumber || 0) + 1;

        // netPrice is the LINE total, so the original's unit price is
        // netPrice / orderedQuantity. The order screen's Replace dialog sends
        // neither quantity nor price, so the new line carries the original's
        // unit price at the original quantity. `??`, not `||`: a zero unit
        // price is a price.
        const replQuantity = Number(replacement.quantity ?? lineItem.orderedQuantity);
        if (!Number.isFinite(replQuantity) || replQuantity <= 0) {
          return res.status(400).json({ error: "Quantity must be positive." });
        }
        const originalUnitPrice = Number(lineItem.netPrice) / Number(lineItem.orderedQuantity || 1);
        const replUnitPrice = Number(replacement.unitPrice ?? originalUnitPrice);
        if (!Number.isFinite(replUnitPrice) || replUnitPrice < 0) {
          return res.status(400).json({ error: "Unit price must be zero or more." });
        }
        const replNetPrice = Math.round(replQuantity * replUnitPrice * 100) / 100;
        const replTaxRate = Number(lineItem.vatRate || 0);
        const replVatAmount = Math.round(replNetPrice * replTaxRate * 100) / 100;
        // The replacement keeps the original's list price, or takes its own
        // product's retail; selling it below that is a discount (GAP-06).
        const [replListUnit] = await catalogListUnits(prisma, [
          { productId: replacement.productId || null, unitPrice: existingListUnit(lineItem) },
        ]);
        const replPercent = lineDiscountPercent({
          listUnit: replListUnit,
          quantity: replQuantity,
          netPrice: replNetPrice,
        });
        const replApprover = await authorizeDiscount(prisma, {
          percent: replPercent,
          access,
          approval: req.body.discountApproval,
        });

        const result = await prisma.$transaction(async (tx) => {
          // Create the replacement line item
          const newItem = await tx.orderLineItem.create({
            data: {
              salesOrderId: orderId,
              lineNumber: nextLineNumber,
              productName: replacement.productName,
              partNo: replacement.partNo || lineItem.partNo,
              orderedQuantity: replQuantity,
              netPrice: replNetPrice,
              listPrice: replListUnit,
              cost: 0,
              barcode: "",
              vatRate: lineItem.vatRate || 0,
              vatAmount: replVatAmount,
              source: replacement.source || lineItem.source,
              fulfillment: replacement.fulfillment || lineItem.fulfillment,
              productId: replacement.productId || null,
              selectedGrade: replacement.selectedGrade || null,
            },
          });

          // Mark the original as replaced and link to the new one
          await tx.orderLineItem.update({
            where: { id: itemId },
            data: {
              lineItemStatus: "REPLACED",
              cancelReason: reason || "Replaced",
              replacedByLineItemId: newItem.id,
            },
          });

          await tx.orderChangeLog.create({
            data: {
              salesOrderId: orderId,
              lineItemId: itemId,
              changeType: "LINE_REPLACED",
              previousValue: `${lineItem.productName} (${lineItem.partNo})`,
              newValue: `${replacement.productName} (${replacement.partNo || lineItem.partNo})`,
              reason: reason || "Item replaced",
              changedBy,
            },
          });
          if (replApprover) {
            await logDiscountApproval(tx, {
              orderId,
              lineItemId: newItem.id,
              approver: replApprover,
              percent: replPercent,
              changedBy,
            });
          }

          await tx.salesOrder.update({
            where: { id: orderId },
            data: { updatedBy: changedBy },
          });

          // The original line is now REPLACED (inactive) and the new line
          // is ACTIVE -- full resync rather than delta math.
          await resyncOrderAllocation(orderId, order.storeLocation, tx);

          for (const po of linePos) await dropPoLines(tx, po, changedBy);

          return newItem;
        });

        if (order.status === "ORDER") await raiseSpecialOrderPos(orderId);

        return res.status(200).json({
          originalId: itemId,
          replacementId: result.id,
          lineNumber: result.lineNumber,
          productName: result.productName,
        });
      }

      // Update quantity or price on an existing line item
      if (action === "update") {
        const updates: Record<string, unknown> = {};
        const changes: string[] = [];

        if (quantity !== undefined) {
          const newQty = Number(quantity);
          if (newQty <= 0) return res.status(400).json({ error: "Quantity must be positive." });
          changes.push(`qty: ${Number(lineItem.orderedQuantity)} → ${newQty}`);
          updates.orderedQuantity = newQty;
        }

        if (unitPrice !== undefined) {
          const newPrice = Number(unitPrice);
          changes.push(`price: ${Number(lineItem.netPrice)} → ${newPrice}`);
          updates.netPrice = newPrice;
        }

        if (updates.orderedQuantity || updates.netPrice) {
          const finalQty = Number(updates.orderedQuantity || lineItem.orderedQuantity);
          const finalPrice = Number(updates.netPrice || lineItem.netPrice);
          // Recalculate if both or either changed — netPrice is total, not unit
          if (unitPrice !== undefined) {
            updates.netPrice = finalQty * Number(unitPrice);
            updates.vatAmount =
              Math.round(Number(updates.netPrice) * Number(lineItem.vatRate || 0) * 100) / 100;
          } else if (quantity !== undefined) {
            // Qty changed but not price — recalculate based on original unit price
            const originalUnitPrice =
              Number(lineItem.netPrice) / Number(lineItem.orderedQuantity || 1);
            updates.netPrice = finalQty * originalUnitPrice;
            updates.vatAmount =
              Math.round(Number(updates.netPrice) * Number(lineItem.vatRate || 0) * 100) / 100;
          }
          // cost is a LINE total (same invariant as netPrice) — scale it with
          // the quantity so COGS postings and margin reports stay correct.
          if (quantity !== undefined) {
            const originalUnitCost =
              Number(lineItem.cost || 0) / Number(lineItem.orderedQuantity || 1);
            updates.cost = Math.round(finalQty * originalUnitCost * 100) / 100;
          }
        }

        if (changes.length === 0) {
          return res.status(400).json({ error: "No changes specified." });
        }

        // A price below the line's list price is a discount (GAP-06). Only a
        // price change can make one: a quantity change keeps the unit price.
        const pricePercent =
          unitPrice === undefined
            ? 0
            : lineDiscountPercent({
                listUnit: existingListUnit(lineItem),
                quantity: Number(updates.orderedQuantity ?? lineItem.orderedQuantity),
                netPrice: Number(updates.netPrice),
              });
        const priceApprover = await authorizeDiscount(prisma, {
          percent: pricePercent,
          access,
          approval: req.body.discountApproval,
        });

        const result = await prisma.$transaction(async (tx) => {
          if (priceApprover) {
            await logDiscountApproval(tx, {
              orderId,
              lineItemId: itemId,
              approver: priceApprover,
              percent: pricePercent,
              changedBy,
            });
          }
          const updated = await tx.orderLineItem.update({
            where: { id: itemId },
            data: updates,
          });

          await tx.orderChangeLog.create({
            data: {
              salesOrderId: orderId,
              lineItemId: itemId,
              changeType: "PRICE_CHANGE",
              previousValue: `qty: ${Number(lineItem.orderedQuantity)}, net: ${Number(lineItem.netPrice)}`,
              newValue: changes.join(", "),
              reason: reason || null,
              changedBy,
            },
          });

          await tx.salesOrder.update({
            where: { id: orderId },
            data: { updatedBy: changedBy },
          });

          // A quantity change moves what the order has committed -- full
          // resync rather than delta math.
          await resyncOrderAllocation(orderId, order.storeLocation, tx);

          if (changesWhatIsOrdered) {
            for (const po of linePos) {
              for (const line of po.lines) {
                await tx.purchaseOrderItem.update({
                  where: { id: line.id },
                  data: { orderedQuantity: quantity },
                });
              }
            }
          }

          return updated;
        });

        return res.status(200).json({
          id: result.id,
          orderedQuantity: Number(result.orderedQuantity),
          netPrice: Number(result.netPrice),
          vatAmount: Number(result.vatAmount),
        });
      }

      return res
        .status(400)
        .json({ error: "Invalid action. Use 'cancel', 'replace', or 'update'." });
    } catch (error) {
      if (error instanceof DiscountApprovalError) {
        return res.status(error.status).json(error.body);
      }
      logError("Error updating line item", error);
      return res.status(500).json({ error: "Failed to update line item." });
    }
  }

  // DELETE: Remove a line item (only for QUOTE status orders)
  if (req.method === "DELETE") {
    try {
      const order = await prisma.salesOrder.findUnique({ where: { id: orderId } });
      if (!order) return res.status(404).json({ error: "Order not found." });

      if (order.status !== "QUOTE") {
        return res
          .status(400)
          .json({ error: "Line items can only be removed from quotes. Cancel the item instead." });
      }

      const lineItem = await prisma.orderLineItem.findFirst({
        where: { id: itemId, salesOrderId: orderId },
      });
      if (!lineItem) return res.status(404).json({ error: "Line item not found." });

      await prisma.$transaction(async (tx) => {
        await tx.orderLineItem.delete({ where: { id: itemId } });

        await tx.orderChangeLog.create({
          data: {
            salesOrderId: orderId,
            lineItemId: itemId,
            changeType: "LINE_REMOVED",
            previousValue: `${lineItem.productName} (qty: ${Number(lineItem.orderedQuantity)})`,
            changedBy,
          },
        });

        await tx.salesOrder.update({
          where: { id: orderId },
          data: { updatedBy: changedBy },
        });

        // Removing a line changes what the order has committed -- full
        // resync rather than delta math.
        await resyncOrderAllocation(orderId, order.storeLocation, tx);
      });

      return res.status(204).end();
    } catch (error) {
      logError("Error removing line item", error);
      return res.status(500).json({ error: "Failed to remove line item." });
    }
  }

  res.setHeader("Allow", ["PUT", "DELETE"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}

export default requirePermission("sales.write", handler, {
  also: ["sales.discount", "sales.cancel-acknowledged"],
});
