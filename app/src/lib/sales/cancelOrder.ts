// /app/src/lib/sales/cancelOrder.ts
//
// Cancelling a sale (DECISIONS 51), and the only way into CANCELLED. Owner, 2026-11-06:
// "if an order has a payment, then we would be cancelling the order and either returning
// the payment or leaving a credit on account." So nothing happens until the checks pass,
// and then, in order:
//
//   1. Money. ORIGINAL_PAYMENT sends each payment back the way it was taken. A card goes
//      through its processor outside any transaction, so a failure leaves the order open,
//      and cancelling again refunds only what's left.
//   2. Everything else, in one transaction: STORE_CREDIT, the lines, the stock, the POs,
//      the schedule, draft transfers, consignment pieces and open stock exceptions.
//
// What this refuses, and why, is in cancelProblem. Revenue and sales tax are booked from
// invoices (lib/journalEntry.ts, lib/reports/taxSummary.ts), so a live invoice has to be
// voided first, and that's what keeps the books right.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { release } from "@/lib/inventory/allocation";
import { handedOverStatusProblem } from "@/lib/fulfilment/undoHandover";
import { returnOrderEditProblem } from "@/lib/returns/bookReturn";
import {
  calculateOrderBalance,
  computeBalance,
  computeRefundable,
  processRefund,
  refundToStoreCreditTx,
  retryProcessorRefund,
  round2,
} from "@/lib/paymentService";
import { refundCounts } from "@/lib/returns/returnMoney";
import { type RefundDestination } from "@/lib/returns/refundReturn";
import { dropPoLines, keepPoAsStock, poOutcome, readSalePos, type SalePo } from "./salePos";
import { type PoDecision } from "./salePosShared";

/** A cancel refused before anything moved; `status` is what the route answers. */
export class CancelOrderError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface RefundablePayment {
  paymentId: number;
  label: string;
  amount: number;
}

export interface CancelPlan {
  /** Taken and not yet gone back: what has to be settled to cancel. */
  held: number;
  /** What would go back to each payment, oldest first, adding up to `held`. */
  payments: RefundablePayment[];
  /** Card refunds that failed last time, to try again: their money isn't in `held`. */
  refundsToRetry: { paymentId: number; amount: number }[];
  /** Credit needs an account to go on. */
  canCredit: boolean;
  /** The POs still in play. An ACKNOWLEDGED one needs a decision. */
  purchaseOrders: SalePo[];
  /** Why this can't be cancelled at all, or null. */
  problem: string | null;
  /** What someone should know, and doesn't stop it. */
  notices: string[];
}

type Db = Prisma.TransactionClient;

export async function readCancelPlan(orderId: number, db: Db = prisma): Promise<CancelPlan> {
  const order = await db.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      deliveredAt: true,
      customerId: true,
      orderDate: true,
      salesPersonId: true,
      splitWithId: true,
      lineItems: { select: { lineItemStatus: true, fulfilledQty: true } },
      invoices: { where: { status: { not: "VOID" } }, select: { invoiceNo: true } },
      payments: {
        orderBy: { paymentDate: "asc" },
        select: {
          id: true,
          paymentType: true,
          paymentAmount: true,
          status: true,
          isRefund: true,
          originalPaymentId: true,
          refundedPayments: { select: { paymentAmount: true, status: true } },
        },
      },
    },
  });
  if (!order) throw new CancelOrderError("Order not found.", 404);

  // A refund to store credit points at no one payment, so it comes off the total.
  const creditedBack = order.payments
    .filter((p) => p.isRefund && p.originalPaymentId === null && refundCounts(p.status))
    .reduce((sum, p) => sum + Math.abs(Number(p.paymentAmount)), 0);

  let left = creditedBack;
  const payments: RefundablePayment[] = [];
  for (const payment of order.payments) {
    if (payment.isRefund || payment.status !== "COMPLETED") continue;
    const refundable = computeRefundable(
      Number(payment.paymentAmount),
      payment.refundedPayments
        .filter((r) => refundCounts(r.status))
        .map((r) => Number(r.paymentAmount)),
    );
    const covered = Math.min(left, refundable);
    left = round2(left - covered);
    const amount = round2(refundable - covered);
    if (amount > 0) {
      payments.push({ paymentId: payment.id, label: payment.paymentType, amount });
    }
  }

  return {
    held: round2(payments.reduce((sum, p) => sum + p.amount, 0)),
    payments,
    refundsToRetry: order.payments
      .filter((p) => p.isRefund && p.status === "PENDING")
      .map((p) => ({ paymentId: p.id, amount: Math.abs(Number(p.paymentAmount)) })),
    canCredit: order.customerId !== null,
    purchaseOrders: await readSalePos(db, orderId),
    problem: await cancelProblem(order, db),
    notices: await cancelNotices(order, db),
  };
}

async function cancelProblem(
  order: {
    id: number;
    status: string;
    deliveredAt: Date | null;
    lineItems: { lineItemStatus: string; fulfilledQty: unknown }[];
    invoices: { invoiceNo: string }[];
    payments: { status: string | null; isRefund: boolean }[];
  },
  db: Db,
): Promise<string | null> {
  if (order.status === "CANCELLED") return "This order is already cancelled.";
  const leaving = handedOverStatusProblem(order, "CANCELLED");
  if (leaving) return leaving;
  const own = await returnOrderEditProblem(db, order.id);
  if (own) return own;
  if (
    order.lineItems.some(
      (line) => line.lineItemStatus === "ACTIVE" && Number(line.fulfilledQty) > 0,
    )
  ) {
    return "Part of this order has already gone to the customer. Cancel the lines that haven't, and do a return for the rest.";
  }
  const money = await moneyProblem(order, db);
  if (money) return money;
  const moving = await db.inventoryTransfer.count({
    where: { salesOrderId: order.id, status: "IN_TRANSIT" },
  });
  if (moving > 0) {
    return "Stock for this order is on its way between stores. Receive the transfer, then cancel.";
  }
  const out = await db.serviceAppointment.findFirst({
    where: {
      salesOrderId: order.id,
      OR: [
        { status: "IN_PROGRESS" },
        { deliveryStop: { status: { in: ["EN_ROUTE", "ARRIVED"] } } },
      ],
    },
    select: { id: true },
  });
  if (out) return "This order is out for delivery or a visit is under way. Finish that first.";
  return null;
}

/**
 * Why the money on a sale can't be settled yet, or null. A whole-sale cancel and a line
 * change that leaves the customer overpaid both ask (rule 42).
 */
async function moneyProblem(
  order: {
    id: number;
    invoices: { invoiceNo: string }[];
    payments: { status: string | null; isRefund: boolean }[];
  },
  db: Db,
): Promise<string | null> {
  if (order.payments.some((p) => p.status === "PENDING" && !p.isRefund)) {
    return "A payment on this order hasn't finished. Wait for it, or void it, then try again.";
  }
  // An imported payment can have no status. It counts toward the balance, but a refund
  // needs a completed payment, so it can't be settled here and mustn't be skipped.
  if (order.payments.some((p) => p.status === null)) {
    return "A payment on this order came from an import with no status, so it can't be settled here.";
  }
  if (order.invoices.length > 0) {
    return `Invoice ${order.invoices[0].invoiceNo} is still live, and revenue and sales tax are booked from it. Void it first.`;
  }
  const ret = await db.return.findFirst({
    where: {
      status: { not: "CANCELLED" },
      OR: [{ salesOrderId: order.id }, { exchangeOrderId: order.id }],
    },
    select: { returnNumber: true },
  });
  if (ret) {
    return `Return ${ret.returnNumber} is tied to this order, so its money can't be settled here.`;
  }
  return null;
}

async function cancelNotices(
  order: {
    id: number;
    orderDate: Date | null;
    salesPersonId: number | null;
    splitWithId: number | null;
  },
  db: Db,
): Promise<string[]> {
  const notices: string[] = [];
  const staffIds = [order.salesPersonId, order.splitWithId].filter((id) => id !== null);
  if (order.orderDate && staffIds.length > 0) {
    const locked = await db.commissionPayout.findFirst({
      where: {
        staffMemberId: { in: staffIds },
        lockedAt: { not: null },
        periodStart: { lte: order.orderDate },
        periodEnd: { gte: order.orderDate },
      },
      select: { id: true },
    });
    if (locked) {
      notices.push(
        "A locked commission payout covers this sale's date. If it counted this sale, the owner has to correct it by hand.",
      );
    }
  }
  const cases = await db.serviceCase.count({
    where: { salesOrderId: order.id, status: { isClosed: false } },
  });
  if (cases > 0) {
    notices.push(`${cases} service case${cases === 1 ? " is" : "s are"} still open on this order.`);
  }
  const picking = await db.pickList.count({
    where: { salesOrderId: order.id, status: { not: "COMPLETED" } },
  });
  if (picking > 0) notices.push("A pick list is open for this order. Tell the warehouse.");
  return notices;
}

export interface CancelInput {
  /** Required when there's money on the order. */
  destination?: RefundDestination;
  /** What was decided about each acknowledged PO, by its id. */
  poDecisions?: Record<number, PoDecision>;
  reason: string;
  actor: string | null;
}

export interface CancelResult {
  refunded: number;
  credited: number;
  /** POs the vendor has a copy of, now cancelled here: someone should tell them. */
  tellVendors: { poNumber: string; vendor: string }[];
}

/** Whether cancelling this takes the store's call on goods it's committed to buying. */
export function needsPoCall(plan: Pick<CancelPlan, "purchaseOrders">): boolean {
  return plan.purchaseOrders.some((po) => po.standing === "ACKNOWLEDGED" || po.standing === "HERE");
}

/**
 * Settles the money, then cancels. Throws CancelOrderError for what the caller got wrong,
 * and lets a processor's refusal through (RefundProcessorError) so the route can say what
 * the processor said. Either way the order stays open.
 */
export async function cancelOrder(orderId: number, input: CancelInput): Promise<CancelResult> {
  const reason = input.reason.trim();
  if (!reason) throw new CancelOrderError("Say why this order is being cancelled.", 400);

  const plan = await readCancelPlan(orderId);
  if (plan.problem) throw new CancelOrderError(plan.problem);
  const undecided = plan.purchaseOrders.find(
    (po) => po.standing === "ACKNOWLEDGED" && !input.poDecisions?.[po.id],
  );
  if (undecided) {
    throw new CancelOrderError(
      `${undecided.poNumber} is acknowledged by ${undecided.vendor}. Say whether they agreed to cancel it, or the store keeps the piece.`,
      400,
    );
  }
  if (plan.held > 0 && !input.destination) {
    throw new CancelOrderError(
      "There's money on this order. Say whether it goes back the way it was paid, or onto the customer's account.",
      400,
    );
  }
  if (plan.held > 0 && input.destination === "STORE_CREDIT" && !plan.canCredit) {
    throw new CancelOrderError(
      "This order has no customer to hold a credit, so the money has to go back the way it was paid.",
      400,
    );
  }

  let refunded = 0;
  const logRefund = async (amount: number) => {
    await prisma.orderChangeLog.create({
      data: {
        salesOrderId: orderId,
        changeType: "REFUND_ISSUED",
        newValue: String(amount),
        reason,
        changedBy: input.actor,
      },
    });
    refunded = round2(refunded + amount);
  };
  // A card refund that failed last time goes first: that money is already spoken for.
  for (const pending of plan.refundsToRetry) {
    await retryProcessorRefund(pending.paymentId);
    await logRefund(pending.amount);
  }
  if (plan.held > 0 && input.destination === "ORIGINAL_PAYMENT") {
    for (const payment of plan.payments) {
      await processRefund(payment.paymentId, {
        amount: payment.amount,
        reason,
        createdBy: input.actor ?? undefined,
      });
      await logRefund(payment.amount);
    }
  }

  const credited = await prisma.$transaction((tx) =>
    closeTheSale(tx, orderId, { ...input, reason }),
  );

  return {
    refunded,
    credited,
    tellVendors: plan.purchaseOrders
      .filter((po) => po.status === "SUBMITTED")
      .map((po) => ({ poNumber: po.poNumber, vendor: po.vendor })),
  };
}

function poChangeReason(
  po: SalePo,
  outcome: "DROP" | "KEEP",
  decision: PoDecision | undefined,
): string | null {
  if (outcome === "KEEP") {
    return `${po.vendor} acknowledged it, and the store keeps the piece to sell off the floor`;
  }
  return decision === "VENDOR_AGREED" ? `${po.vendor} agreed to cancel it` : null;
}

async function closeTheSale(
  tx: Db,
  orderId: number,
  input: CancelInput & { reason: string },
): Promise<number> {
  const { reason, actor } = input;
  const before = await tx.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, customerId: true, storeLocationId: true },
  });
  // First, and only from a state that isn't cancelled: of two cancels at once, the second
  // stops here and can't credit the same money twice.
  const moved = await tx.salesOrder.updateMany({
    where: { id: orderId, status: { not: "CANCELLED" } },
    data: { status: "CANCELLED", dispatchStatus: "CANCELLED", updatedBy: actor },
  });
  if (moved.count === 0) throw new CancelOrderError("This order is already cancelled.");

  await tx.orderChangeLog.create({
    data: {
      salesOrderId: orderId,
      changeType: "STATUS_CHANGE",
      previousValue: before.status,
      newValue: "CANCELLED",
      reason,
      changedBy: actor,
    },
  });

  // The lines go too, so nothing is owed on it and no one can be asked to pay.
  await tx.orderLineItem.updateMany({
    where: { salesOrderId: orderId, lineItemStatus: "ACTIVE" },
    data: { lineItemStatus: "CANCELLED", cancelReason: reason },
  });
  await release(orderId, tx);

  for (const po of await readSalePos(tx, orderId)) {
    const decision = input.poDecisions?.[po.id];
    const outcome = poOutcome(po, decision);
    if (outcome === "NONE") continue;
    if (outcome === "DROP") await dropPoLines(tx, po, actor);
    else await keepPoAsStock(tx, po, before.storeLocationId, actor);
    await tx.orderChangeLog.create({
      data: {
        salesOrderId: orderId,
        changeType: outcome === "DROP" ? "PO_CANCELLED" : "PO_KEPT",
        newValue: po.poNumber,
        reason: poChangeReason(po, outcome, decision),
        changedBy: actor,
      },
    });
  }

  // Nothing is going out for it any more.
  const appointments = await tx.serviceAppointment.findMany({
    where: { salesOrderId: orderId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    select: { id: true },
  });
  const appointmentIds = appointments.map((a) => a.id);
  await tx.deliveryStop.deleteMany({
    where: { serviceAppointmentId: { in: appointmentIds }, status: "PENDING" },
  });
  await tx.serviceAppointment.updateMany({
    where: { id: { in: appointmentIds } },
    data: { status: "CANCELLED" },
  });
  await tx.inventoryTransfer.updateMany({
    where: { salesOrderId: orderId, status: "DRAFT" },
    data: { status: "CANCELLED" },
  });

  // A consignment piece is back on the floor, and if the vendor was paid for it, they owe.
  const backOnFloor = { status: "ON_FLOOR", salesOrderId: null, saleDate: null } as const;
  await tx.consignmentItem.updateMany({
    where: { salesOrderId: orderId, status: "PAID" },
    data: { ...backOnFloor, creditOwed: true, saleTransactionId: null, saleCustomerName: null },
  });
  await tx.consignmentItem.updateMany({
    where: { salesOrderId: orderId, status: "SOLD" },
    data: { ...backOnFloor, saleTransactionId: null, saleCustomerName: null },
  });

  await tx.inventoryException.updateMany({
    where: { salesOrderId: orderId, resolvedAt: null },
    data: { resolvedAt: new Date(), resolvedBy: actor },
  });

  // Read again: more may have been taken since the refunds, in another tab.
  const left = await readCancelPlan(orderId, tx);
  if (left.held <= 0) return 0;
  if (input.destination !== "STORE_CREDIT" || before.customerId === null) {
    throw new CancelOrderError(
      "More money came in on this order while it was being cancelled. Try again.",
    );
  }
  await refundToStoreCreditTx(tx, {
    customerId: before.customerId,
    amount: left.held,
    salesOrderId: orderId,
    reason,
    createdBy: actor ?? undefined,
  });
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: orderId,
      changeType: "CREDIT_ISSUED",
      newValue: String(left.held),
      reason,
      changedBy: actor,
    },
  });
  return left.held;
}

export interface Overpayment {
  /** All that's owed back: `toSettle`, plus any refund that didn't finish. */
  excess: number;
  /** The part the store decides on: back the way it was paid, or credit. */
  toSettle: number;
  /** What `toSettle` takes from each payment if it goes back, newest first. */
  payments: RefundablePayment[];
  /** Tried again whichever way the rest goes: that money is already spoken for. */
  refundsToRetry: CancelPlan["refundsToRetry"];
  /** Credit needs an account to go on. */
  customerId: number | null;
}

/**
 * What lowering one line would leave the customer overpaid, or null. Only what's over: a
 * $300 deposit on a $1,000 order with a $500 line cancelled still owes $200, so nothing
 * goes back. A change that doesn't lower the line asks nothing, even on a sale already
 * overpaid some other way, since this change isn't the reason. Throws CancelOrderError
 * when there's money to settle and it can't be settled yet.
 */
export async function overpaidAfterLineChange(
  orderId: number,
  lineItemId: number,
  newLineTotal: number,
): Promise<Overpayment | null> {
  const plan = await readCancelPlan(orderId);
  const order = await prisma.salesOrder.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      id: true,
      customerId: true,
      invoices: { where: { status: { not: "VOID" } }, select: { invoiceNo: true } },
      payments: { select: { status: true, isRefund: true, paymentAmount: true } },
      lineItems: {
        select: {
          id: true,
          netPrice: true,
          orderedQuantity: true,
          vatAmount: true,
          lineItemStatus: true,
        },
      },
    },
  });
  const line = order.lineItems.filter((l) => l.id === lineItemId);
  if (newLineTotal >= computeBalance(line, []).totalDue) return null;

  const others = order.lineItems.filter((l) => l.id !== lineItemId);
  const owed = round2(computeBalance(others, []).totalDue + newLineTotal);
  // Held leaves out an imported payment with no status, though it counts as paid, so it
  // counts here and moneyProblem refuses it.
  const imported = order.payments
    .filter((p) => p.status === null && !p.isRefund)
    .reduce((sum, p) => sum + Number(p.paymentAmount), 0);
  const toSettle = Math.max(round2(plan.held + imported - owed), 0);
  if (toSettle === 0 && plan.refundsToRetry.length === 0) return null;

  const problem = await moneyProblem(order, prisma);
  if (problem) throw new CancelOrderError(problem);

  let left = toSettle;
  const payments: RefundablePayment[] = [];
  for (const payment of [...plan.payments].reverse()) {
    if (left <= 0) break;
    const amount = Math.min(left, payment.amount);
    payments.push({ ...payment, amount });
    left = round2(left - amount);
  }
  const unfinished = plan.refundsToRetry.reduce((sum, r) => sum + r.amount, 0);
  return {
    excess: round2(toSettle + unfinished),
    toSettle,
    payments,
    refundsToRetry: plan.refundsToRetry,
    customerId: order.customerId,
  };
}

/**
 * Finishes any refund that didn't, then gives the rest back if that's where it goes.
 * Outside a transaction: a card goes through its processor.
 */
export async function refundOverpayment(
  orderId: number,
  lineItemId: number,
  over: Overpayment,
  destination: RefundDestination,
  reason: string,
  actor: string | null,
): Promise<void> {
  const log = (amount: number) =>
    prisma.orderChangeLog.create({
      data: {
        salesOrderId: orderId,
        lineItemId,
        changeType: "REFUND_ISSUED",
        newValue: String(amount),
        reason,
        changedBy: actor,
      },
    });
  for (const pending of over.refundsToRetry) {
    await retryProcessorRefund(pending.paymentId);
    await log(pending.amount);
  }
  if (destination !== "ORIGINAL_PAYMENT") return;
  for (const payment of over.payments) {
    await processRefund(payment.paymentId, {
      amount: payment.amount,
      reason,
      createdBy: actor ?? undefined,
    });
    await log(payment.amount);
  }
}

/** Onto the customer's account, in the transaction that changes the line. */
export async function creditOverpayment(
  tx: Db,
  orderId: number,
  lineItemId: number,
  credit: { customerId: number; amount: number },
  reason: string,
  actor: string | null,
): Promise<void> {
  await refundToStoreCreditTx(tx, {
    customerId: credit.customerId,
    amount: credit.amount,
    salesOrderId: orderId,
    reason,
    createdBy: actor ?? undefined,
  });
  await tx.orderChangeLog.create({
    data: {
      salesOrderId: orderId,
      lineItemId,
      changeType: "CREDIT_ISSUED",
      newValue: String(credit.amount),
      reason,
      changedBy: actor,
    },
  });
}

/**
 * Why a sale can't be deleted, or null. Owner, 2026-11-06: "the only thing that might be
 * deletable is a quote", and one with money on it gets cancelled like any other.
 */
export function deleteProblem(order: {
  status: string;
  paymentCount: number;
  invoiceCount: number;
}): string | null {
  if (order.status !== "QUOTE") {
    return "Only a quote can be deleted. Cancel this order instead.";
  }
  if (order.paymentCount > 0) {
    return "This quote has a payment on it. Cancel it instead, and say where the money goes.";
  }
  if (order.invoiceCount > 0) {
    return "This quote has been invoiced. Cancel it instead.";
  }
  return null;
}

/**
 * Why a sale can't go ahead with nothing paid, or null. A store decides whether it can
 * (AppSettings.allowSaleWithoutPayment), and the strict answer is the default. Nothing
 * owed needs nothing paid.
 */
export async function saleWithoutPaymentProblem(
  orderId: number,
  allowed: boolean,
): Promise<string | null> {
  if (allowed) return null;
  const { totalDue, totalPaid } = await calculateOrderBalance(orderId);
  if (totalPaid > 0 || totalDue <= 0) return null;
  return "This store takes a payment before a sale goes ahead. Take a payment, or allow sales with no payment in Settings.";
}
