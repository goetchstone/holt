// /app/src/lib/sales/orderToPay.ts
//
// An order as the register needs it to take a payment on it: what it comes
// to, what has been paid, and who it is for.
//
// The register could only take a payment on the order it had just created.
// A balance on an order written earlier (a deposit order collected, a quote
// the customer came back to pay for) could be paid by payment link or store
// credit and no other way: no cash, no check, no card on the reader. The
// order page now sends such an order to the register (/app/sales/pos?order=),
// which opens on its payment screen with what this returns.
//
// The totals are computeBalance's, the one every other balance uses, so the
// register asks for what the order page and a payment link say is owed.

import { prisma } from "@/lib/prisma";
import { computeBalance } from "@/lib/paymentService";
import { isCountedLine } from "@/lib/salesOrderRevenue";

export interface OrderToPay {
  id: number;
  orderno: string;
  /** What the order comes to, tax included. */
  total: number;
  /** What has been paid toward it; a pending or failed payment is not counted. */
  paid: number;
  customer: {
    id: number;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
  } | null;
  /** It sells or reloads a gift card, so it is paid in full before it leaves the register. */
  holdsGiftCard: boolean;
}

/** The order, or why the register can't take a payment on it. */
export type OrderToPayResult = { order: OrderToPay } | { problem: string };

export async function loadOrderToPay(orderId: number): Promise<OrderToPayResult> {
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderno: true,
      status: true,
      customer: {
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      },
      lineItems: {
        select: {
          netPrice: true,
          orderedQuantity: true,
          vatAmount: true,
          lineItemStatus: true,
          giftCardNumber: true,
        },
      },
      payments: {
        select: { paymentAmount: true, status: true, isRefund: true },
      },
    },
  });
  if (!order) return { problem: "That order was not found." };
  if (order.status === "CANCELLED") {
    return { problem: `Order ${order.orderno} is cancelled, so it can't take a payment.` };
  }

  const { totalDue, totalPaid, balanceDue } = computeBalance(order.lineItems, order.payments);
  if (balanceDue <= 0) {
    return { problem: `Order ${order.orderno} has nothing left to pay.` };
  }

  return {
    order: {
      id: order.id,
      orderno: order.orderno,
      total: totalDue,
      paid: totalPaid,
      customer: order.customer && {
        ...order.customer,
        firstName: order.customer.firstName ?? "",
        lastName: order.customer.lastName ?? "",
      },
      holdsGiftCard: order.lineItems.some(
        (line) => line.giftCardNumber != null && isCountedLine(line.lineItemStatus),
      ),
    },
  };
}

/**
 * The order the register was opened to take a payment on (`?order=` on the
 * register's page, from the order page's button), or why it can't be. Null
 * when the register was opened the ordinary way. Taking money is "Take
 * payment", as the routes the payment screen posts to require.
 */
export async function orderToPayFromQuery(
  order: string | string[] | undefined,
  mayTakePayments: boolean,
): Promise<OrderToPayResult | null> {
  if (order === undefined) return null;
  if (!mayTakePayments) return { problem: "Your role can't take payments." };
  if (typeof order !== "string" || !/^\d{1,9}$/.test(order)) {
    return { problem: "That order was not found." };
  }
  return loadOrderToPay(Number.parseInt(order, 10));
}
