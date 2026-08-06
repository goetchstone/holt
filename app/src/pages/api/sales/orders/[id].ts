// /app/src/pages/api/sales/orders/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { consume, release } from "@/lib/inventory/allocation";
import { getActiveOrderLines } from "@/lib/inventory/orderInventorySync";

/** Exported for integration tests -- same pattern as create-from-cart.ts:
 *  calls the real Prisma client with a fake req/res + session, bypassing
 *  requireAuthWithRole (which needs real cookies). Role enforcement is
 *  covered by the apiRouteAuthorization tripwire. */
export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  const { id } = req.query;

  if (!id || typeof id !== "string") {
    return res.status(400).json({ error: "Order ID is required." });
  }

  if (req.method === "PUT") {
    try {
      const { status, orderNotes, deliveryMethod, customerId } = req.body;
      const validStatuses = ["QUOTE", "ORDER", "FULFILLED", "CANCELLED"];
      if (status && !validStatuses.includes(status)) {
        return res
          .status(400)
          .json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      }

      const validDeliveryMethods = ["TAKEN", "PICKUP", "DELIVERY"];
      if (deliveryMethod && !validDeliveryMethods.includes(deliveryMethod)) {
        return res.status(400).json({
          error: `Invalid delivery method. Must be one of: ${validDeliveryMethods.join(", ")}`,
        });
      }

      const existing = await prisma.salesOrder.findUnique({ where: { id: Number.parseInt(id) } });
      if (!existing) return res.status(404).json({ error: "Order not found" });

      const changedBy = session.user?.email || null;

      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.salesOrder.update({
          where: { id: Number.parseInt(id) },
          data: {
            ...(status && { status }),
            ...(orderNotes !== undefined && { orderNotes }),
            ...(deliveryMethod && { deliveryMethod }),
            ...(customerId !== undefined && {
              customerId: customerId ? Number.parseInt(customerId) : null,
            }),
            updatedBy: changedBy,
          },
        });

        if (status && status !== existing.status) {
          await tx.orderChangeLog.create({
            data: {
              salesOrderId: Number.parseInt(id),
              changeType: "STATUS_CHANGE",
              previousValue: existing.status,
              newValue: status,
              changedBy,
            },
          });

          // Consume/release on the TRANSITION into a terminal state, not on
          // every write of this route -- guarded by status !== existing.status
          // above. The goods leaving the building (FULFILLED) deletes the
          // committed positions outright; cancelling returns them to free
          // stock. Both are no-ops if nothing is currently committed (e.g. a
          // CANCELLED after FULFILLED already consumed it), which is correct,
          // not a bug -- see allocation.ts's consume()/release() headers.
          if (status === "FULFILLED") {
            const lines = await getActiveOrderLines(result.id, tx);
            await consume(result.id, lines, tx);
          } else if (status === "CANCELLED") {
            await release(result.id, tx);
          }
        }

        return result;
      });

      return res.status(200).json({ id: updated.id, status: updated.status });
    } catch (error) {
      logError("Error updating order", error);
      return res.status(500).json({ error: "Failed to update order" });
    }
  }

  if (req.method === "DELETE") {
    // Deleting a whole order is narrower than the general sales-order gate
    // this file is wrapped in -- MANAGER/ADMIN only, not DESIGNER/REGISTER.
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Manager role required to delete orders" });
    }

    try {
      const orderId = Number.parseInt(id);
      await prisma.$transaction(async (tx) => {
        // Nullify references that don't cascade
        await tx.customerInteraction.updateMany({
          where: { salesOrderId: orderId },
          data: { salesOrderId: null },
        });
        await tx.customerCreditTransaction.updateMany({
          where: { salesOrderId: orderId },
          data: { salesOrderId: null },
        });
        await tx.inventoryPosition.deleteMany({ where: { salesOrderId: orderId } });
        // Delete child records in dependency order
        await tx.payment.deleteMany({ where: { salesOrderId: orderId } });
        await tx.invoiceLineItem.deleteMany({
          where: { invoice: { salesOrderId: orderId } },
        });
        await tx.invoice.deleteMany({ where: { salesOrderId: orderId } });
        await tx.orderLineItem.deleteMany({ where: { salesOrderId: orderId } });
        await tx.salesOrder.delete({ where: { id: orderId } });
      });
      return res.status(204).end();
    } catch (error) {
      logError("Error deleting order", error);
      return res.status(500).json({ error: "Failed to delete order" });
    }
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const order = await prisma.salesOrder.findUnique({
      where: { id: Number.parseInt(id) },
      include: {
        customer: true,
        salesPerson: { select: { id: true, displayName: true } },
        splitWith: { select: { id: true, displayName: true } },
        lineItems: { include: { product: true } },
        invoices: { include: { lineItems: { include: { orderLineItem: true } } } },
        payments: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    const totalTax = order.lineItems.reduce((sum, item) => sum + Number(item.vatAmount || 0), 0);
    const totalSales = order.lineItems.reduce((sum, item) => sum + Number(item.netPrice), 0);
    const totalAmount = totalSales + totalTax;

    // Convert Prisma Decimal fields to Number for JSON safety
    return res.status(200).json({
      id: order.id,
      orderno: order.orderno,
      orderDate: order.orderDate,
      status: order.status,
      salesperson: order.salesperson,
      salesPersonId: order.salesPersonId,
      salesPerson: order.salesPerson,
      splitWithId: order.splitWithId,
      splitWith: order.splitWith,
      storeLocation: order.storeLocation,
      orderNotes: order.orderNotes,
      deliveryMethod: order.deliveryMethod,
      totalTax,
      totalPaid: Number(order.totalPaid || 0),
      totalAmount,
      customer: order.customer
        ? {
            id: order.customer.id,
            firstName: order.customer.firstName,
            lastName: order.customer.lastName,
          }
        : null,
      lineItems: order.lineItems.map((item) => ({
        id: item.id,
        lineNumber: item.lineNumber,
        productName: item.productName,
        partNo: item.partNo,
        barcode: item.barcode,
        orderedQuantity: Number(item.orderedQuantity),
        netPrice: Number(item.netPrice),
        vatRate: item.vatRate != null ? Number(item.vatRate) : null,
        vatAmount: item.vatAmount != null ? Number(item.vatAmount) : null,
        cost: item.cost != null ? Number(item.cost) : null,
        source: item.source,
        fulfillment: item.fulfillment,
        lineItemStatus: item.lineItemStatus,
        cancelReason: item.cancelReason,
        replacedByLineItemId: item.replacedByLineItemId,
        selectedGrade: item.selectedGrade,
        selectedFinish: item.selectedFinish,
        selectedOptions: item.selectedOptions,
        productId: item.productId,
      })),
      invoices: order.invoices.map((inv) => ({
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate,
        taxAmount: Number(inv.taxAmount),
        lineItems: inv.lineItems.map((li) => ({
          id: li.id,
          deliveredQuantity: Number(li.deliveredQuantity),
          orderLineItem: { partNo: li.orderLineItem?.partNo ?? "" },
        })),
      })),
      payments: order.payments.map((p) => ({
        id: p.id,
        paymentDate: p.paymentDate,
        paymentType: p.paymentType,
        paymentAmount: Number(p.paymentAmount),
        // status/isRefund: needed client-side so OrderDetailView can filter
        // out VOIDED/FAILED/PENDING and sign refunds the same way
        // computeBalance does (see @/lib/paymentBalance) instead of
        // summing every row unfiltered.
        status: p.status,
        isRefund: p.isRefund,
      })),
    });
  } catch (error) {
    logError("Error fetching order details", error);
    return res.status(500).json({ error: "Failed to fetch order details." });
  }
}

export default requireAuthWithRole(["DESIGNER", "REGISTER", "MANAGER", "ADMIN"], handler);
