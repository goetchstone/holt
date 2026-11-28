// /app/src/pages/api/sales/orders/[id].ts

import { auditActor, auditLog } from "@/lib/audit";
import { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { returnOrderEditProblem } from "@/lib/returns/bookReturn";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { release } from "@/lib/inventory/allocation";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { markHandedOver, handoverMethodFor } from "@/lib/fulfilment/handover";
import { rerateQuoteTax } from "@/lib/tax/rerateQuoteTax";
import {
  planQuoteTrade,
  repriceQuoteTrade,
  type QuoteTradeRepricing,
} from "@/lib/sales/quoteTradePricing";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import {
  DISCOUNT_PERMISSION,
  DiscountApprovalError,
  NO_EXTRA_ACCESS,
  authorizeDiscount,
  type Approver,
} from "@/lib/sales/discountApproval";
import { promoteQuoteToOrder } from "@/lib/sales/quoteHolds";
import { deleteProblem, saleWithoutPaymentProblem } from "@/lib/sales/cancelOrder";
import { readSalePos } from "@/lib/sales/salePos";
import { computeBalance, isProcessorPayment, onSaleWentAhead } from "@/lib/paymentService";
import { getAppSettings } from "@/lib/appSettings";
import { holdDateString, lineHoldProblem } from "@/lib/sales/quoteHoldsShared";
import { STOCKED_SELECT, isStockedProduct } from "@/lib/inventory/stocked";
import { orderFlagsOf } from "@/lib/sales/orderFlags";
import { orderDisclaimersOf } from "@/lib/sales/orderDisclaimers";
import { refundableByPayment } from "@/lib/sales/refundablePayments";
import { handedOverStatusProblem } from "@/lib/fulfilment/undoHandover";
import { isCountedLine } from "@/lib/salesOrderRevenue";

/** What a customer change did to a quote's prices, in a sentence the screen can show. */
function repricingSummary(r: QuoteTradeRepricing): QuoteTradeRepricing & { message: string } {
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (r.repriced > 0) parts.push(`${lines(r.repriced)} re-priced for the new customer`);
  if (r.kept > 0) parts.push(`${lines(r.kept)} with a price someone set kept as it was`);
  return { ...r, message: parts.length > 0 ? `${parts.join("; ")}.` : "No prices changed." };
}

/** Exported for integration tests -- same pattern as create-from-cart.ts:
 *  calls the real Prisma client with a fake req/res + session, bypassing
 *  requirePermission (which needs real cookies). A direct caller passes
 *  `access` for what the gate's `also` answers: DELETE needs sales.cancel. */
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
      const locked = await returnOrderEditProblem(prisma, existing.id);
      if (locked) return res.status(409).json({ error: locked });
      const leaving = handedOverStatusProblem(existing, status);
      if (leaving) return res.status(409).json({ error: leaving });
      if (status && status !== existing.status) {
        const refused = await statusChangeProblem(existing, status);
        if (refused) return res.status(409).json({ error: refused });
      }

      const changedBy = session.user?.email || null;

      // A quote changing hands is priced for its new customer (below). A line
      // someone set a price on keeps it, but its discount was measured from the
      // old customer's trade price: where the new customer's price is higher,
      // what it sells below that is a discount like any other, decided here
      // before the transaction so a wrong manager PIN still counts.
      let newCustomerId = existing.customerId;
      if (customerId !== undefined) {
        newCustomerId = customerId ? Number.parseInt(customerId) : null;
      }
      let tradeApprover: Approver | null = null;
      // Decided by what the order IS, never by the status this request asks for:
      // a quote handed to another customer and made an order in the same request
      // is still priced and judged for its new customer first (CodeQL
      // js/user-controlled-bypass, 2026-11-17).
      const handsOver =
        customerId !== undefined &&
        newCustomerId !== existing.customerId &&
        existing.status === "QUOTE" &&
        (await prisma.payment.count({ where: { salesOrderId: existing.id } })) === 0;
      if (handsOver) {
        const plan = await planQuoteTrade(prisma, existing.id, existing.customerId, newCustomerId);
        tradeApprover = await authorizeDiscount(prisma, {
          percent: plan.percent,
          access,
          approval: req.body.discountApproval,
        });
      }

      const { updated, repricing } = await prisma.$transaction(async (tx) => {
        let repriced: QuoteTradeRepricing | null = null;
        // The customer decides the tax (their exemption, their district) and
        // their trade tier's prices, so a quote that changes hands is priced
        // and re-rated as their sale: its untyped lines take the new
        // customer's tier (lib/sales/quoteTradePricing.ts), then tax follows
        // the new amounts. Only while no money has touched it -- a pending card
        // checkout included: a paid order keeps the prices and tax it was
        // charged (lib/tax/rerateQuoteTax.ts). This runs while it is still a
        // quote, before any promotion this request also asks for, so the
        // order it becomes carries the new customer's prices.
        if (handsOver && (await tx.payment.count({ where: { salesOrderId: existing.id } })) === 0) {
          await tx.salesOrder.update({
            where: { id: existing.id },
            data: { customerId: newCustomerId, updatedBy: changedBy },
          });
          repriced = await repriceQuoteTrade(tx, existing.id, {
            fromCustomerId: existing.customerId,
            changedBy,
            approver: tradeApprover,
          });
          await rerateQuoteTax(tx, existing.id);
        }
        // A quote leaving for an order (or handed over outright) becomes one
        // first, through the one function that does it (lib/sales/quoteHolds.ts),
        // so every line commits stock: as a quote it committed only those it held.
        if (existing.status === "QUOTE" && (status === "ORDER" || status === "FULFILLED")) {
          await promoteQuoteToOrder(tx, existing.id, changedBy);
        }
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
          await applyStatusChange(tx, {
            order: result,
            from: existing.status,
            to: status,
            actor: changedBy,
          });
        }

        const saved = await tx.salesOrder.findUniqueOrThrow({
          where: { id: result.id },
          select: { id: true, status: true },
        });
        return { updated: saved, repricing: repriced };
      });

      // It went ahead with nothing paid: what a first payment would have started.
      if (existing.status === "QUOTE" && updated.status === "ORDER") {
        await onSaleWentAhead(updated.id);
      }

      return res.status(200).json({
        id: updated.id,
        status: updated.status,
        // What changing the customer did to the quote's prices, when it re-priced it.
        ...(repricing ? { repricing: repricingSummary(repricing) } : {}),
      });
    } catch (error) {
      if (error instanceof DiscountApprovalError) {
        return res.status(error.status).json(error.body);
      }
      logError("Error updating order", error);
      return res.status(500).json({ error: "Failed to update order" });
    }
  }

  if (req.method === "DELETE") {
    // Deleting is narrower than the general sales-order gate this file is wrapped
    // in: it needs "Cancel orders" (sales.cancel), answered by the gate's `also`,
    // and only a quote with no money on it may go (lib/sales/cancelOrder.ts).
    // Everything else gets cancelled.
    if (!access.holds["sales.cancel"]) {
      return res
        .status(403)
        .json({ error: "Deleting a quote needs the Cancel orders permission." });
    }

    try {
      const orderId = Number.parseInt(id);
      const order = await prisma.salesOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          orderno: true,
          customerId: true,
          _count: { select: { payments: true, invoices: true } },
        },
      });
      if (!order) return res.status(404).json({ error: "Order not found" });
      const refused = deleteProblem({
        status: order.status,
        paymentCount: order._count.payments,
        invoiceCount: order._count.invoices,
      });
      if (refused) return res.status(409).json({ error: refused });

      await prisma.$transaction(async (tx) => {
        await auditLog(
          "QUOTE_DELETED",
          auditActor(session),
          {
            summary: `Quote ${order.orderno} deleted`,
            details: { orderId, orderno: order.orderno, customerId: order.customerId },
          },
          tx,
        );
        // Nullify references that don't cascade
        await tx.customerInteraction.updateMany({
          where: { salesOrderId: orderId },
          data: { salesOrderId: null },
        });
        // Whatever it held goes back to free stock where it sits.
        await release(orderId, tx);
        // The quote's history goes with it: its foreign key restricts, and the entry
        // above is what's left of it.
        await tx.orderChangeLog.deleteMany({ where: { salesOrderId: orderId } });
        await tx.orderLineItem.deleteMany({ where: { salesOrderId: orderId } });
        await tx.salesOrder.delete({ where: { id: orderId } });
      });
      return res.status(204).end();
    } catch (error) {
      logError("Error deleting order", error);
      return res.status(500).json({ error: "Failed to delete this quote" });
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
        lineItems: {
          omit: { cost: true },
          include: {
            product: {
              select: STOCKED_SELECT,
            },
            purchaseOrderItems: {
              select: {
                purchaseOrder: {
                  select: { poNumber: true, status: true, vendor: { select: { name: true } } },
                },
              },
            },
          },
        },
        invoices: { include: { lineItems: { include: { orderLineItem: true } } } },
        payments: true,
      },
    });

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }
    // The store's flags on it and the disclaimers it prints (GAP-07), and what
    // is left to refund on each payment (the order page's Refund action).
    const [flags, disclaimers, refundable] = await Promise.all([
      orderFlagsOf(prisma, order.id),
      orderDisclaimersOf(prisma, order.id),
      refundableByPayment(prisma, order.payments),
    ]);

    // Cancelled and replaced lines are out of every sum (CLAUDE.md rule 33,
    // COUNTED_LINE_STATUSES); they are still listed below, struck through on the order screen.
    const counted = order.lineItems.filter((item) => isCountedLine(item.lineItemStatus));
    const totalTax = counted.reduce((sum, item) => sum + Number(item.vatAmount || 0), 0);
    const totalSales = counted.reduce((sum, item) => sum + Number(item.netPrice), 0);
    const totalAmount = totalSales + totalTax;
    // What's been paid, by the register's rule. `SalesOrder.totalPaid` is a copy only the
    // import writes, so it never saw a payment taken in Holt.
    const { totalPaid } = computeBalance(order.lineItems, order.payments);

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
      splitPercent: order.splitPercent,
      splitWith: order.splitWith,
      storeLocation: order.storeLocation,
      orderNotes: order.orderNotes,
      deliveryMethod: order.deliveryMethod,
      // When the goods reached the customer; null while still to go (GAP-07:
      // the order screen offers Undo handover on a handed-over order).
      deliveredAt: order.deliveredAt,
      // Which line is the delivery fee: it changes only through
      // orders/[id]/delivery-fee.ts, so the screen leaves it out of line edits.
      deliveryFeeLineItemId: order.deliveryFeeLineItemId,
      flags,
      disclaimers,
      totalTax,
      totalPaid,
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
        purchaseOrders: item.purchaseOrderItems.map(({ purchaseOrder: po }) => ({
          poNumber: po.poNumber,
          status: po.status,
          vendor: po.vendor.name,
        })),
        lineNumber: item.lineNumber,
        productName: item.productName,
        partNo: item.partNo,
        barcode: item.barcode,
        orderedQuantity: Number(item.orderedQuantity),
        netPrice: Number(item.netPrice),
        listPrice: item.listPrice != null ? Number(item.listPrice) : null,
        // The trade tier's percent the line was sold at, when it was (GAP-06 part C).
        tradeDiscountPercent:
          item.tradeDiscountPercent != null ? Number(item.tradeDiscountPercent) : null,
        vatRate: item.vatRate != null ? Number(item.vatRate) : null,
        vatAmount: item.vatAmount != null ? Number(item.vatAmount) : null,
        source: item.source,
        fulfillment: item.fulfillment,
        lineItemStatus: item.lineItemStatus,
        cancelReason: item.cancelReason,
        replacedByLineItemId: item.replacedByLineItemId,
        selectedGrade: item.selectedGrade,
        selectedFinish: item.selectedFinish,
        selectedOptions: item.selectedOptions,
        notes: item.notes,
        productId: item.productId,
        // GAP-16: the day a quote holds this line's stock through, and whether
        // it could hold it (lib/sales/quoteHoldsShared.ts lineHoldProblem).
        holdUntil: item.holdUntil ? holdDateString(item.holdUntil) : null,
        holdable:
          order.status === "QUOTE" &&
          lineHoldProblem({
            lineItemStatus: item.lineItemStatus,
            source: item.source,
            stocked: item.product ? isStockedProduct(item.product) : null,
          }) === null,
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
        // Sent to a register's card reader: the order page words its Void
        // for that (it cancels on the reader, not a link).
        onCardReader: (p.processorData as { cardReader?: unknown } | null)?.cardReader === true,
        // For the Refund action: how it was paid (cash comes back out of a
        // till; a processor's payment goes back through it), and what is
        // left to refund on it, 0 when nothing is.
        method: p.method,
        viaProcessor: isProcessorPayment(p),
        refundable: refundable.get(p.id) ?? 0,
      })),
    });
  } catch (error) {
    logError("Error fetching order details", error);
    return res.status(500).json({ error: "Failed to fetch order details." });
  }
}

export default requirePermission("sales.write", handler, {
  also: [DISCOUNT_PERMISSION, "sales.cancel"],
});

/**
 * What a status change does beyond writing the status: the change-log row, and
 * stock on the TRANSITION into a terminal state, not on every write of this
 * route (the caller only calls it when the status changed). The goods leaving
 * the building (FULFILLED) deletes the committed positions outright; cancelling
 * returns them to free stock. Both are no-ops if nothing is currently committed
 * (e.g. a CANCELLED after FULFILLED already consumed it), which is correct, not
 * a bug -- see allocation.ts's consume()/release() headers.
 */
/**
 * Whether a status button may do this. Cancelling has its own route, because the money
 * has to be settled, and a cancelled sale stays cancelled: its money has gone back, so
 * selling it again is a copy. A quote going ahead without a payment is the store's call.
 */
async function statusChangeProblem(
  existing: { id: number; status: string },
  to: string,
): Promise<string | null> {
  if (to === "CANCELLED") {
    return "Use Cancel order, so what's been paid gets settled.";
  }
  if (existing.status === "CANCELLED") {
    return "This order is cancelled. To sell it again, copy it.";
  }
  if (existing.status === "QUOTE" && (to === "ORDER" || to === "FULFILLED")) {
    const { allowSaleWithoutPayment } = await getAppSettings();
    return saleWithoutPaymentProblem(existing.id, allowSaleWithoutPayment);
  }
  if (existing.status === "ORDER" && to === "QUOTE") {
    const sent = (await readSalePos(prisma, existing.id)).find((po) => po.sentToVendor);
    if (sent)
      return `${sent.poNumber} has gone to ${sent.vendor}, so this can't go back to a quote.`;
  }
  return null;
}

async function applyStatusChange(
  tx: Prisma.TransactionClient,
  args: {
    order: { id: number; deliveryMethod: string | null; storeLocation: string | null };
    from: string;
    to: string;
    actor: string | null;
  },
): Promise<void> {
  const { order, from, to, actor } = args;
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: order.id,
      changeType: "STATUS_CHANGE",
      previousValue: from,
      newValue: to,
      changedBy: actor,
    },
  });

  if (to === "FULFILLED") {
    // Marking an order fulfilled by hand is a real thing a store needs -- a
    // delivery done off-system, or history being corrected -- so it is not
    // refused. But it is the SAME event as a stop completing or a customer
    // collecting, and it goes through the same function rather than flipping a
    // flag and consuming stock on the side.
    //
    // That is what closes the two-FULFILLED-flags gap: this route wrote
    // `status` and never `dispatchStatus`, the dispatch route wrote
    // `dispatchStatus` and never `status`, and an order could sit disagreeing
    // with itself indefinitely with no way to tell which one to believe.
    await markHandedOver(tx, {
      salesOrderId: order.id,
      at: new Date(),
      method: handoverMethodFor(order.deliveryMethod),
      actor,
    });
  } else if (to === "QUOTE" && from === "ORDER") {
    // Back to a quote: only the lines it holds stay committed (GAP-16).
    await resyncOrderAllocation(order.id, order.storeLocation, tx);
  }
}
