// /app/src/lib/billing/invoiceShared.ts
//
// Client-safe shared contracts for the billing surface (CLAUDE.md rule 7 —
// one source of truth for values referenced by both the UI and the server).
// Keep this module free of Prisma/server imports: the composer and detail
// views import it into the client bundle.

export const INVOICE_PAYMENT_METHODS = ["CASH", "CARD", "CHECK", "WIRE", "ACH", "OTHER"] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

// Display labels for manual invoice payments. Must match the POS_PAYMENTS
// SystemGLMapping labels (case-insensitive) so the AR_PAYMENT journal can
// resolve a cash-side GL account.
export const INVOICE_PAYMENT_LABELS: Record<InvoicePaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  WIRE: "Wire",
  ACH: "ACH",
  OTHER: "Other",
};
