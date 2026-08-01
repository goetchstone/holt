// /app/src/lib/paymentMethodDisplay.ts
//
// Single source of truth for mapping the bounded `PaymentMethod` enum to the
// human-readable string stored on `Payment.paymentType`. Extracted out of
// paymentService.ts (which still re-exports it for backward compatibility)
// so any other caller -- notably prisma/seed/*.ts, which must derive
// paymentType the exact same way production code does instead of hand-
// writing strings -- can import just this tiny, dependency-free constant
// without pulling in paymentService's whole module graph (payment provider
// seam, service dispatch, consignment, logger, etc).
//
// `SystemGLMapping` rows for section POS_PAYMENTS must have a `label` that
// case-insensitively matches one of these values (see
// generateSalesJournal()'s `paymentGlMap` in lib/journalEntry.ts) or the
// payment type is skipped from the journal with only a warning.
export const METHOD_DISPLAY: Record<string, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  GIFT_CARD: "Gift Card",
  STORE_CREDIT: "Store Credit",
  WIRE: "Wire",
  ACH: "ACH",
  FINANCE: "Finance",
  OTHER: "Other",
};
