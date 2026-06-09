// /app/src/pages/api/sales/orders/[id]/line-items/[lineItemId].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const { id, lineItemId } = req.query;
  if (!id || typeof id !== "string" || !lineItemId || typeof lineItemId !== "string") {
    return res.status(400).json({ error: "Order ID and Line Item ID are required." });
  }

  const orderId = Number.parseInt(id);
  const itemId = Number.parseInt(lineItemId);
  const changedBy = session.user?.email || null;

  // PUT: Update line item (cancel, replace, relink, or modify)
  if (req.method === "PUT") {
    try {
      const { action, reason, replacement, quantity, unitPrice, productId, partNo } = req.body;

      const order = await prisma.salesOrder.findUnique({ where: { id: orderId } });
      if (!order) return res.status(404).json({ error: "Order not found." });

      const lineItem = await prisma.orderLineItem.findFirst({
        where: { id: itemId, salesOrderId: orderId },
      });
      if (!lineItem) return res.status(404).json({ error: "Line item not found." });

      // Allow "relink" on cancelled items too — a misclassified cancelled line
      // shouldn't block recategorization for reporting purposes.
      if (lineItem.lineItemStatus === "CANCELLED" && action !== "relink") {
        return res.status(400).json({ error: "Cannot modify a cancelled line item." });
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

        const result = await prisma.$transaction(async (tx) => {
          const updated = await tx.orderLineItem.update({
            where: { id: itemId },
            data: { lineItemStatus: "CANCELLED", cancelReason: reason },
          });

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

        const replNetPrice =
          Number(replacement.quantity || lineItem.orderedQuantity) *
          Number(replacement.unitPrice || lineItem.netPrice);
        const replTaxRate = Number(lineItem.vatRate || 0);
        const replVatAmount = Math.round(replNetPrice * replTaxRate * 100) / 100;

        const result = await prisma.$transaction(async (tx) => {
          // Create the replacement line item
          const newItem = await tx.orderLineItem.create({
            data: {
              salesOrderId: orderId,
              lineNumber: nextLineNumber,
              productName: replacement.productName,
              partNo: replacement.partNo || lineItem.partNo,
              orderedQuantity: replacement.quantity || lineItem.orderedQuantity,
              netPrice: replNetPrice,
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

          await tx.salesOrder.update({
            where: { id: orderId },
            data: { updatedBy: changedBy },
          });

          return newItem;
        });

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
        }

        if (changes.length === 0) {
          return res.status(400).json({ error: "No changes specified." });
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
