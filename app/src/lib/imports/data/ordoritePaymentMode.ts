// /app/src/lib/imports/data/ordoritePaymentMode.ts
//
// DATA, not code -- the Stage 1 proof for imports-configurable.md's
// motivating case. Ordorite's resolvePaymentMode() (lib/adapters/ordorite/
// shared.ts) decodes numeric payment-mode codes into display strings
// ("Card Connect", "Credit Note", ...) that land verbatim in
// Payment.paymentType, a free-text column outside holt's bounded
// PaymentMethod enum (CASH/CARD/CHECK/GIFT_CARD/STORE_CREDIT/WIRE/ACH/
// FINANCE/OTHER). journalEntry.ts's paymentGlMap lookup then skips every
// row whose paymentType it doesn't recognise (the "Unmapped payment type"
// warning at lib/journalEntry.ts around line 740).
//
// This module is the value-mapping SHAPE that closes that gap -- exactly
// what would live in the ImportValueMapping table for a real "Ordorite
// Payment Mode" ImportDefinition. Consumed by:
//   - prisma/seed/ordoritePaymentMode.ts, which persists it as real
//     ImportDefinition / ImportFieldMapping / ImportValueMapping rows
//   - __tests__/imports/ordoritePaymentMode.test.ts, which runs it through
//     the pure engine (lib/imports/engine.ts) and asserts the translation
//
// NOT wired to the live Ordorite sales/payments runner in Stage 1.
// resolvePaymentMode() and runners.ts are untouched -- see
// docs/domains/imports-configurable.md, "What Stage 1 does NOT do." This
// only proves the mechanism that a later stage will wire up for real.

import type { FieldMappingInput, ValueMappingInput } from "@/lib/imports/types";

/** The one field this demonstration definition maps. */
export const ORDORITE_PAYMENT_MODE_FIELD_MAPPING: FieldMappingInput = {
  sourceColumn: "Modeofpayment",
  targetField: "paymentType",
  required: false,
  sortOrder: 0,
};

/**
 * Ordorite's display-string payment modes -> holt's bounded PaymentMethod
 * vocabulary. Source values are exactly resolvePaymentMode()'s output
 * strings (see PAYMENT_MODE_MAP in lib/adapters/ordorite/shared.ts) for the
 * eight modes named in the Stage 1 brief.
 */
export const ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS: ValueMappingInput[] = [
  { targetField: "paymentType", sourceValue: "Card Connect", targetValue: "CARD" },
  { targetField: "paymentType", sourceValue: "Card Not Present", targetValue: "CARD" },
  { targetField: "paymentType", sourceValue: "Credit Note", targetValue: "STORE_CREDIT" },
  { targetField: "paymentType", sourceValue: "Marketing", targetValue: "OTHER" },
  { targetField: "paymentType", sourceValue: "Refund", targetValue: "OTHER" },
  { targetField: "paymentType", sourceValue: "Charity", targetValue: "OTHER" },
  { targetField: "paymentType", sourceValue: "Debit", targetValue: "CARD" },
  { targetField: "paymentType", sourceValue: "Other", targetValue: "OTHER" },
];
