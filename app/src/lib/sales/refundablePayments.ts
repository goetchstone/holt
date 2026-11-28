// /app/src/lib/sales/refundablePayments.ts
//
// What can still be refunded on each of an order's payments, for the order
// page's Refund action. The rule is processRefund's own (lib/paymentService.ts):
// only a completed payment that is not itself a refund, and only its amount
// less every refund of it that paid out or may still pay out. This asks the
// same question ahead of time so the screen can offer the action and the
// amount; processRefund still decides, under its lock, when the refund is made.
//
// A refund is found by the payment it refunds, not by the order it sits on: a
// return's refund is booked on the return's own order, and counts all the same.

import type { PrismaClient } from "@prisma/client";
import { computeRefundable } from "@/lib/paymentService";
import { refundCounts } from "@/lib/returns/returnMoney";

interface PaymentToRefund {
  id: number;
  paymentAmount: unknown;
  status: string | null;
  isRefund: boolean;
}

/** Each refundable payment's id and what is left to refund on it; others are absent. */
export async function refundableByPayment(
  db: Pick<PrismaClient, "payment">,
  payments: readonly PaymentToRefund[],
): Promise<Map<number, number>> {
  const open = payments.filter((p) => !p.isRefund && p.status === "COMPLETED");
  if (open.length === 0) return new Map();

  const refunds = await db.payment.findMany({
    where: { originalPaymentId: { in: open.map((p) => p.id) } },
    select: { originalPaymentId: true, paymentAmount: true, status: true },
  });
  const refundedOf = new Map<number, number[]>();
  for (const refund of refunds) {
    if (refund.originalPaymentId == null || !refundCounts(refund.status)) continue;
    const amounts = refundedOf.get(refund.originalPaymentId) ?? [];
    amounts.push(Number(refund.paymentAmount));
    refundedOf.set(refund.originalPaymentId, amounts);
  }

  const left = new Map<number, number>();
  for (const payment of open) {
    const refundable = computeRefundable(
      Number(payment.paymentAmount),
      refundedOf.get(payment.id) ?? [],
    );
    if (refundable > 0) left.set(payment.id, refundable);
  }
  return left;
}
