// /app/src/lib/openCheckoutPrompt.ts
//
// What a screen asks when a pay endpoint refuses because a checkout is
// already open (portal/pay, client-portal/pay and stripe/send-payment-link
// answer 409 with `existingPayment`; see paymentService.startHostedCheckout).
// The screen offers to start a new one with `force`, in its own words: nobody
// reads the endpoint's "retry with force:true". Pure and client-safe.

export interface OpenCheckout {
  amount: number;
  ageMinutes: number;
}

/** The open checkout a 409 body names, or null when the body is not that
 *  refusal (any other error keeps the screen's ordinary handling). */
export function openCheckoutFrom(body: unknown): OpenCheckout | null {
  const open = (body as { existingPayment?: unknown } | null)?.existingPayment as
    { amount?: unknown; ageMinutes?: unknown } | undefined;
  if (!open || typeof open.amount !== "number" || typeof open.ageMinutes !== "number") {
    return null;
  }
  return { amount: open.amount, ageMinutes: open.ageMinutes };
}

function ago(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/** The confirm text a customer sees before a retry voids their open checkout. */
export function customerRetryPrompt(open: OpenCheckout, formatMoney: (n: number) => string) {
  return (
    `You started a payment of ${formatMoney(open.amount)} ${ago(open.ageMinutes)}. ` +
    `If you didn't finish it, start a new one?`
  );
}
