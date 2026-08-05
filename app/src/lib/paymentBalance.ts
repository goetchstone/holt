// /app/src/lib/paymentBalance.ts
//
// Canonical "which payments count as money received toward a balance" rule,
// shared by every balance computation in the app: paymentService.computeBalance
// (order balance), customerLedger.computeSourceBalance (customer AR
// recompute), reports/balanceAging.getBalanceAging (AR aging report), and
// OrderDetailView's client-side total. Before this file existed, each of
// those re-implemented its own exclusion list and they drifted --
// OrderDetailView.tsx summed payments with NO status filter at all. One
// export, four call sites, can't drift again.
//
// Only a Prisma TYPE crosses this file's boundary (`import type`, erased at
// compile time -- no `@prisma/client` runtime code is ever bundled), so this
// is safe to import from a "use client" component without pulling
// server-only code (like @/lib/prisma) into the browser bundle.
//
// PENDING is excluded: a hosted-checkout row isn't money in hand until a
// processor webhook confirms it (see paymentService.recordPendingPayment).
// Counting it let an abandoned or declined checkout permanently zero a real
// balance, with every re-charge path refusing and nothing in the product
// able to clear the row. VOIDED and FAILED are excluded because they never
// settled, for the same reason they always were. REFUNDED stays OUT of this
// list on purpose -- it IS money that was received; the refund is a
// separate isRefund=true row that nets it out, so excluding REFUNDED too
// would double-count the refund. A null status (44K legacy POS-imported
// rows, CLAUDE.md rule 51) is never in this set either -- every caller must
// use the `status == null || !excluded` shape (or this file's
// `isPaymentExcludedFromBalance`, which already does), never a bare Prisma
// `notIn`, because Postgres's three-valued NULL logic silently drops NULL
// rows under `notIn`.

import type { PaymentStatus } from "@prisma/client";

export const PAYMENT_STATUSES_EXCLUDED_FROM_BALANCE: readonly PaymentStatus[] = [
  "VOIDED",
  "FAILED",
  "PENDING",
];

const EXCLUDED_AS_STRINGS: readonly string[] = PAYMENT_STATUSES_EXCLUDED_FROM_BALANCE;

/** True for VOIDED/FAILED/PENDING. False for null/undefined (legacy rows,
 *  real money) and for every other status, including REFUNDED. */
export function isPaymentExcludedFromBalance(status: string | null | undefined): boolean {
  return status != null && EXCLUDED_AS_STRINGS.includes(status);
}

interface PaymentForTotal {
  paymentAmount: number;
  status?: string | null;
  isRefund: boolean;
}

/**
 * Sums a payments array the same way computeBalance does: excluded-status
 * rows contribute nothing, everything else is signed by isRefund. Does NOT
 * round -- callers that need round2 apply it themselves, since some (e.g.
 * computeSourceBalance, summing across many orders) round per-step instead
 * of once at the end.
 */
export function computeTotalPaid(payments: readonly PaymentForTotal[]): number {
  return payments.reduce((sum, p) => {
    if (isPaymentExcludedFromBalance(p.status)) return sum;
    return sum + (p.isRefund ? -Math.abs(p.paymentAmount) : p.paymentAmount);
  }, 0);
}
