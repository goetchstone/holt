// /app/src/lib/sales/refundPaymentShared.ts
//
// The order page's Refund action, in the parts the screen and its test share:
// what a payment must carry to be offered one, where the money goes for each
// way of paying, and whether an amount can be refunded. Client-safe (no
// database). The refund itself, its cap and its lock are processRefund's
// (lib/paymentService.ts); the figures here come from the order route
// (lib/sales/refundablePayments.ts).
//
// Until 2026-11-28 no screen offered a plain refund of a payment: the route
// existed (orders/[id]/refunds.ts) with nothing calling it, and money went back
// only through a line cancel or a return.

export interface RefundablePayment {
  id: number;
  /** The label it was recorded under: "Card", "Cash", a store tender's name. */
  paymentType: string;
  method: string | null;
  /** What is left to refund on it; 0 when nothing is, or it is not a completed payment. */
  refundable: number;
  /** Taken through a card processor, so the refund goes back through it. */
  viaProcessor: boolean;
}

/**
 * Where the money goes when a payment made this way is refunded, as the screen
 * says it before the refund is made. A refund goes back the way the payment was
 * taken; there is no choosing another way here.
 */
export function refundGoesTo(
  payment: Pick<RefundablePayment, "method" | "paymentType" | "viaProcessor">,
): string {
  if (payment.viaProcessor) {
    return "It goes back to the card it was paid with, through the card processor.";
  }
  if (payment.method === "CASH") {
    return "Hand it back in cash. It comes out of the till at this register.";
  }
  if (payment.method === "GIFT_CARD") return "It goes back onto the gift card.";
  if (payment.method === "STORE_CREDIT") return "It goes back onto the customer's store credit.";
  return (
    `This records the refund. Give the money back the way it was taken ` +
    `(${payment.paymentType}).`
  );
}

/** A cash refund comes out of a till, so it needs one open at this register. */
export function refundNeedsTill(method: string | null): boolean {
  return method === "CASH";
}

/** Why what was typed can't be refunded, or null when it can. Compared in whole cents. */
export function refundAmountProblem(
  typed: string,
  refundable: number,
  fmt: (n: number) => string,
): string | null {
  const amount = Number(typed);
  if (typed.trim() === "" || !Number.isFinite(amount) || amount <= 0) {
    return "Enter the amount to refund.";
  }
  if (Math.round(amount * 100) > Math.round(refundable * 100)) {
    return `At most ${fmt(refundable)} is left to refund on this payment.`;
  }
  return null;
}
