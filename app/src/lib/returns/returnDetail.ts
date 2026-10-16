// /app/src/lib/returns/returnDetail.ts
//
// The return detail as the screen reads it (returnDetailContract.ts): the
// return, where the piece went, and its money -- what it is worth, the fee,
// every refund so far, what can still be refunded and from which payments.
// The same rules the refund route enforces (returnMoney.ts), so the screen
// never offers what the server would refuse.

import type { Prisma, PrismaClient } from "@prisma/client";
import { toQty } from "@/lib/inventory/quantity";
import { computeBalance, computeRefundable, REFUND_RETRY_WINDOW_MS } from "@/lib/paymentService";
import { feeAccountMapped } from "./bookReturn";
import type { ReturnDetail, ReturnMoney, ReturnRefund } from "./returnDetailContract";
import {
  computeReturnRefundable,
  computeReturnValue,
  refundCounts,
  ReturnMoneyError,
  type ReturnValue,
} from "./returnMoney";

type Db = PrismaClient | Prisma.TransactionClient;

const n = (d: Prisma.Decimal | number | null | undefined) => Number(d ?? 0);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const RETURN_DETAIL_INCLUDE = {
  salesOrder: {
    select: {
      id: true,
      orderno: true,
      customerId: true,
      lineItems: {
        select: { netPrice: true, orderedQuantity: true, vatAmount: true, lineItemStatus: true },
      },
      payments: {
        select: {
          id: true,
          paymentType: true,
          paymentAmount: true,
          status: true,
          isRefund: true,
          cardLast4: true,
          refundedPayments: { select: { paymentAmount: true, status: true } },
        },
        orderBy: { paymentDate: "asc" },
      },
    },
  },
  lineItem: { select: { netPrice: true, vatAmount: true, cost: true, orderedQuantity: true } },
  customer: { select: { id: true, firstName: true, lastName: true, creditBalance: true } },
  product: { select: { name: true, productNumber: true } },
  pickupAddress: true,
  inspectedBy: { select: { displayName: true } },
  receivedStockLocation: { select: { name: true } },
  restockedStockLocation: { select: { name: true } },
  returnOrder: {
    select: {
      id: true,
      orderno: true,
      lineItems: { select: { id: true, netPrice: true, vatAmount: true, cost: true } },
    },
  },
  refunds: {
    where: { isRefund: true },
    select: {
      id: true,
      paymentDate: true,
      created: true,
      paymentType: true,
      paymentAmount: true,
      status: true,
      method: true,
      originalPaymentId: true,
      processorType: true,
    },
    orderBy: { paymentDate: "asc" },
  },
  exchangeOrder: { select: { id: true, orderno: true } },
  vendorReturnPOs: { select: { id: true, poNumber: true } },
} satisfies Prisma.ReturnInclude;

type ReturnRow = Prisma.ReturnGetPayload<{ include: typeof RETURN_DETAIL_INCLUDE }>;

/** Booked: read from the return's own order. Not yet: what booking it now would value it at. */
async function valueOf(
  db: Db,
  ret: ReturnRow,
): Promise<{ value: ReturnValue | null; fee: number; blockedReason: string | null }> {
  const quantity = toQty(ret.quantity);
  if (ret.returnOrder) {
    const goods = ret.returnOrder.lineItems.filter((l) => l.id !== ret.restockingFeeLineItemId);
    const feeLine = ret.returnOrder.lineItems.find((l) => l.id === ret.restockingFeeLineItemId);
    return {
      value: {
        quantity,
        net: -goods.reduce((s, l) => s + n(l.netPrice), 0),
        tax: -goods.reduce((s, l) => s + n(l.vatAmount), 0),
        cost: -goods.reduce((s, l) => s + n(l.cost), 0),
      },
      fee: n(feeLine?.netPrice),
      blockedReason: null,
    };
  }
  if (!ret.lineItem || ret.lineItemId == null) {
    return {
      value: null,
      fee: 0,
      blockedReason:
        "This return names no order line, so Holt cannot tell what it is worth. Start the return from the line being returned.",
    };
  }
  const others = await db.return.findMany({
    where: { lineItemId: ret.lineItemId, id: { not: ret.id }, returnOrderId: { not: null } },
    select: {
      quantity: true,
      restockingFeeLineItemId: true,
      returnOrder: {
        select: {
          lineItems: { select: { id: true, netPrice: true, vatAmount: true, cost: true } },
        },
      },
    },
  });
  const booked = { quantity: 0, net: 0, tax: 0, cost: 0 };
  for (const o of others) {
    booked.quantity += toQty(o.quantity);
    for (const l of o.returnOrder?.lineItems ?? []) {
      if (l.id === o.restockingFeeLineItemId) continue;
      booked.net -= n(l.netPrice);
      booked.tax -= n(l.vatAmount);
      booked.cost -= n(l.cost);
    }
  }
  try {
    const value = computeReturnValue(
      {
        netPrice: n(ret.lineItem.netPrice),
        vatAmount: n(ret.lineItem.vatAmount),
        cost: n(ret.lineItem.cost),
        orderedQuantity: n(ret.lineItem.orderedQuantity),
      },
      quantity,
      booked,
    );
    return { value, fee: 0, blockedReason: null };
  } catch (err) {
    if (err instanceof ReturnMoneyError) return { value: null, fee: 0, blockedReason: err.message };
    throw err;
  }
}

function refundsOf(ret: ReturnRow): ReturnRefund[] {
  return ret.refunds.map((r) => ({
    id: r.id,
    date: r.paymentDate.toISOString(),
    destination: r.method === "STORE_CREDIT" ? "STORE_CREDIT" : "ORIGINAL_PAYMENT",
    paymentType: r.paymentType,
    amount: n(r.paymentAmount),
    status: r.status,
    retryable:
      r.status === "PENDING" &&
      r.processorType != null &&
      Date.now() - r.created.getTime() <= REFUND_RETRY_WINDOW_MS,
  }));
}

async function moneyOf(db: Db, ret: ReturnRow): Promise<ReturnMoney> {
  const { value, fee, blockedReason } = await valueOf(db, ret);
  const refunds = refundsOf(ret);
  const { refunded, refundable } = value
    ? computeReturnRefundable({ value, fee, refunds })
    : { refunded: 0, refundable: 0 };
  const cancelled =
    ret.status === "CANCELLED" ? "A cancelled return has no money to pay out." : null;
  // Paid first from the return, but only where there is a customer to hold
  // the credit that pays it (refundReturn.ts payOriginalBalanceFirst).
  const hasCustomer = ret.customerId != null || ret.salesOrder.customerId != null;
  const owes = hasCustomer
    ? Math.max(0, computeBalance(ret.salesOrder.lineItems, ret.salesOrder.payments).balanceDue)
    : 0;
  const originalOwes = Math.min(owes, refundable);
  return {
    valued: value != null,
    blockedReason: blockedReason ?? cancelled,
    returnedNet: value?.net ?? 0,
    returnedTax: value?.tax ?? 0,
    restockingFee: fee,
    feeBooked: ret.returnOrderId != null,
    feeAccountMapped: await feeAccountMapped(db as Prisma.TransactionClient),
    returnOrder: ret.returnOrder
      ? { id: ret.returnOrder.id, orderno: ret.returnOrder.orderno }
      : null,
    refunds,
    refundedTotal: refunded,
    originalOwes,
    refundable: cancelled ? 0 : Math.max(0, Math.round((refundable - originalOwes) * 100) / 100),
    payments: ret.salesOrder.payments
      .filter((p) => !p.isRefund && p.status === "COMPLETED")
      .map((p) => ({
        id: p.id,
        paymentType: p.paymentType,
        cardLast4: p.cardLast4,
        remaining: computeRefundable(
          n(p.paymentAmount),
          p.refundedPayments.filter((r) => refundCounts(r.status)).map((r) => n(r.paymentAmount)),
        ),
      }))
      .filter((p) => p.remaining > 0),
  };
}

function addressOf(a: ReturnRow["pickupAddress"]): string | null {
  if (!a) return null;
  return [a.address1, a.address2, `${a.city}, ${a.state} ${a.zip}`].filter(Boolean).join(", ");
}

export async function loadReturnDetail(db: Db, id: number): Promise<ReturnDetail | null> {
  const ret = await db.return.findUnique({ where: { id }, include: RETURN_DETAIL_INCLUDE });
  if (!ret) return null;
  return {
    id: ret.id,
    returnNumber: ret.returnNumber,
    status: ret.status,
    reason: ret.reason,
    reasonNotes: ret.reasonNotes,
    quantity: toQty(ret.quantity),
    created: ret.created.toISOString(),
    salesOrder: { id: ret.salesOrder.id, orderno: ret.salesOrder.orderno },
    customer: ret.customer
      ? {
          id: ret.customer.id,
          name: `${ret.customer.firstName ?? ""} ${ret.customer.lastName ?? ""}`.trim(),
          creditBalance: n(ret.customer.creditBalance),
        }
      : null,
    product: ret.product
      ? { name: ret.product.name, productNumber: ret.product.productNumber }
      : ret.productName
        ? { name: ret.productName, productNumber: ret.partNo }
        : null,
    pickup: {
      required: ret.pickupRequired,
      address: addressOf(ret.pickupAddress),
      date: iso(ret.pickupDate),
      timeSlot: ret.pickupTimeSlot,
      notes: ret.pickupNotes,
    },
    inspection: {
      condition: ret.inspectionCondition,
      notes: ret.inspectionNotes,
      inspectedBy: ret.inspectedBy?.displayName ?? null,
      inspectedAt: iso(ret.inspectedAt),
    },
    disposition: {
      receivedPlace: ret.receivedStockLocation?.name ?? null,
      restockedAt: iso(ret.restockedAt),
      restockedPlace: ret.restockedStockLocation?.name ?? null,
      writtenOffAt: iso(ret.writtenOffAt),
      writeOffReason: ret.writeOffReason,
    },
    money: await moneyOf(db, ret),
    exchangeOrder: ret.exchangeOrder,
    vendorReturnPOs: ret.vendorReturnPOs,
  };
}
