// /app/src/lib/returns/refundReturn.ts
//
// Paying out a native return (ledger plan PR 2b), the owner's direction of
// 2026-10-16: the money goes back to the way it was paid, or onto the
// customer's account as store credit toward a new sale or a rewrite, and the
// return may keep a restocking fee. The customer never waits on the piece
// being put back or written off (that is the returned-stock queue).
//
// Every refund:
//   1. books the return as its own order if it is not yet (bookReturn.ts),
//      with the fee staff typed, fixed from then on;
//   2. pays what the original order still owes first, from the return, as
//      store credit spent on that order -- a customer who still owed $500 and
//      returns a $400 piece owes $100 and is refunded nothing;
//   3. pays out at most what is left (returnMoney.ts computeReturnRefundable),
//      under the return's lock so two refunds cannot both pass the cap:
//        ORIGINAL_PAYMENT -- a payment on the original order, refunded the way
//                            it was taken (paymentService.processRefund);
//        STORE_CREDIT     -- credit on the customer's account, no processor,
//                            no till, nothing refunded to a card.

import type { Payment, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  computeBalance,
  processRefund,
  recordPaymentTx,
  refundToStoreCreditTx,
  RefundError,
} from "@/lib/paymentService";
import { bookReturn, lockReturn, type BookedReturn } from "./bookReturn";
import { computeReturnRefundable, ReturnMoneyError, type RestockingFeeInput } from "./returnMoney";

type Tx = Prisma.TransactionClient;

export const REFUND_DESTINATIONS = ["ORIGINAL_PAYMENT", "STORE_CREDIT"] as const;
export type RefundDestination = (typeof REFUND_DESTINATIONS)[number];

export function isRefundDestination(value: unknown): value is RefundDestination {
  return typeof value === "string" && (REFUND_DESTINATIONS as readonly string[]).includes(value);
}

export interface RefundReturnInput {
  destination: RefundDestination;
  /** ORIGINAL_PAYMENT: the payment on the original order to refund. */
  paymentId?: number;
  amount: number;
  /** The restocking fee, on the first refund only; undefined keeps what was booked (0 by default). */
  restockingFee?: RestockingFeeInput;
  reason?: string;
  registerId?: number;
  tillId?: number;
  staffMemberId?: number;
  createdBy?: string;
}

/** What is still refundable on a booked return, read in the caller's transaction. */
export async function returnRefundableTx(
  tx: Tx,
  returnId: number,
  booked: BookedReturn,
): Promise<number> {
  const refunds = await tx.payment.findMany({
    where: { returnId, isRefund: true },
    select: { paymentAmount: true, status: true },
  });
  return computeReturnRefundable({
    value: booked.value,
    fee: booked.fee,
    refunds: refunds.map((r) => ({ amount: Number(r.paymentAmount), status: r.status })),
  }).refundable;
}

function assertWithinCap(amount: number, refundable: number): void {
  if (amount > refundable) {
    throw new ReturnMoneyError(
      refundable > 0
        ? `Only $${refundable.toFixed(2)} of this return can still be refunded.`
        : "Nothing on this return is left to refund.",
    );
  }
}

/** The customer whose credit the return's money is. */
async function returnCustomer(tx: Tx, returnId: number) {
  const ret = await tx.return.findUniqueOrThrow({
    where: { id: returnId },
    select: {
      returnNumber: true,
      salesOrderId: true,
      customerId: true,
      salesOrder: { select: { customerId: true, orderno: true } },
    },
  });
  return { ...ret, customerId: ret.customerId ?? ret.salesOrder.customerId };
}

/**
 * Step 2: whatever the original order still owes is paid from the return,
 * once, as store credit spent on it. Needs a customer to hold the credit; a
 * walk-in sale has nobody to owe, so it is skipped.
 */
async function payOriginalBalanceFirst(
  tx: Tx,
  returnId: number,
  booked: BookedReturn,
  createdBy?: string,
): Promise<void> {
  const ret = await returnCustomer(tx, returnId);
  if (ret.customerId == null) return;
  const original = await tx.salesOrder.findUniqueOrThrow({
    where: { id: ret.salesOrderId },
    select: {
      lineItems: {
        select: { netPrice: true, orderedQuantity: true, vatAmount: true, lineItemStatus: true },
      },
      payments: { select: { paymentAmount: true, status: true, isRefund: true } },
    },
  });
  const { balanceDue } = computeBalance(original.lineItems, original.payments);
  if (balanceDue <= 0) return;
  const applied = Math.min(balanceDue, await returnRefundableTx(tx, returnId, booked));
  if (applied <= 0) return;
  await refundToStoreCreditTx(tx, {
    customerId: ret.customerId,
    amount: applied,
    salesOrderId: booked.returnOrderId,
    returnId,
    reason: `Applied to what ${ret.salesOrder.orderno} still owed`,
    createdBy,
  });
  await recordPaymentTx(tx, ret.salesOrderId, {
    method: "STORE_CREDIT",
    amount: applied,
    customerId: ret.customerId,
    createdBy,
  });
}

/** Book the return (if not yet) and pay the original's balance from it. */
export async function prepareReturnForRefund(
  returnId: number,
  opts: { restockingFee?: RestockingFeeInput; createdBy?: string },
): Promise<BookedReturn> {
  return prisma.$transaction(async (tx) => {
    const booked = await bookReturn(tx, returnId, {
      fee: opts.restockingFee,
      createdBy: opts.createdBy,
    });
    await payOriginalBalanceFirst(tx, returnId, booked, opts.createdBy);
    return booked;
  });
}

/**
 * Pay out a return. An amount of 0 books it and pays what the original order
 * still owes, and refunds nothing more: for a return worth no more than that.
 */
export async function refundReturn(
  returnId: number,
  input: RefundReturnInput,
): Promise<Payment | null> {
  if (!(input.amount >= 0)) throw new RefundError("Refund amount must be positive");
  const booked = await prepareReturnForRefund(returnId, {
    restockingFee: input.restockingFee,
    createdBy: input.createdBy,
  });
  if (input.amount === 0) return null;

  if (input.destination === "STORE_CREDIT") {
    return prisma.$transaction(async (tx) => {
      await lockReturn(tx, returnId);
      assertWithinCap(input.amount, await returnRefundableTx(tx, returnId, booked));
      const ret = await returnCustomer(tx, returnId);
      if (ret.customerId == null) {
        throw new ReturnMoneyError(
          "Store credit needs a customer to hold it: add the customer to the order, or refund the original payment.",
        );
      }
      return refundToStoreCreditTx(tx, {
        customerId: ret.customerId,
        amount: input.amount,
        salesOrderId: booked.returnOrderId,
        returnId,
        reason: input.reason ?? `Return ${ret.returnNumber}`,
        staffMemberId: input.staffMemberId,
        createdBy: input.createdBy,
      });
    });
  }

  if (!input.paymentId) throw new RefundError("Choose the payment to refund.");
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId },
    select: { salesOrderId: true, isRefund: true },
  });
  const ret = await prisma.return.findUniqueOrThrow({
    where: { id: returnId },
    select: { salesOrderId: true, returnNumber: true },
  });
  if (!payment || payment.isRefund || payment.salesOrderId !== ret.salesOrderId) {
    throw new RefundError("That payment is not a payment on this return's order.");
  }
  return processRefund(input.paymentId, {
    amount: input.amount,
    reason: input.reason ?? `Return ${ret.returnNumber}`,
    registerId: input.registerId,
    tillId: input.tillId,
    staffMemberId: input.staffMemberId,
    createdBy: input.createdBy,
    returnId,
    salesOrderId: booked.returnOrderId,
    guard: async (tx) => {
      await lockReturn(tx, returnId);
      assertWithinCap(input.amount, await returnRefundableTx(tx, returnId, booked));
    },
  });
}
