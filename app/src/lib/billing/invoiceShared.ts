// /app/src/lib/billing/invoiceShared.ts
//
// Client-safe shared contracts for the billing surface (CLAUDE.md rule 7 —
// one source of truth for values referenced by both the UI and the server).
// Keep this module free of Prisma/server imports: the composer and detail
// views import it into the client bundle.

import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";

export const INVOICE_PAYMENT_METHODS = ["CASH", "CARD", "CHECK", "WIRE", "ACH", "OTHER"] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

// Display labels for manual invoice payments: the same METHOD_DISPLAY labels
// every other payment writer stores, never a second copy (rule 37). They must
// match the POS_PAYMENTS SystemGLMapping labels (case-insensitive) so the
// AR_PAYMENT journal can resolve a cash-side GL account. paymentMethodDisplay
// has no imports, so this module stays client-safe.
export const INVOICE_PAYMENT_LABELS = Object.fromEntries(
  INVOICE_PAYMENT_METHODS.map((method) => [method, METHOD_DISPLAY[method]]),
) as Record<InvoicePaymentMethod, string>;
