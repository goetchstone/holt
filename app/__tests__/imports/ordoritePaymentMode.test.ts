// /app/__tests__/imports/ordoritePaymentMode.test.ts
//
// Stage 1's proof for the motivating case in
// docs/domains/imports-configurable.md: Ordorite's resolvePaymentMode()
// (lib/adapters/ordorite/shared.ts) decodes payment-mode codes into display
// strings that land verbatim in Payment.paymentType, a free-text column
// outside holt's bounded PaymentMethod vocabulary. This runs the exact
// seeded value-mapping DATA (lib/imports/data/ordoritePaymentMode.ts --
// the same module prisma/seed/ordoritePaymentMode.ts persists) through the
// pure engine and asserts every one of the eight modes named in the Stage 1
// brief lands on holt's bounded vocabulary.
//
// This does NOT exercise the live Ordorite sales/payments runner --
// resolvePaymentMode() and lib/adapters/ordorite/runners.ts are untouched.
// It proves the mechanism only.

import { runImportEngine } from "@/lib/imports/engine";
import {
  ORDORITE_PAYMENT_MODE_FIELD_MAPPING,
  ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
} from "@/lib/imports/data/ordoritePaymentMode";

// holt's bounded PaymentMethod enum (prisma/schema.prisma) -- what every
// translated value must land on.
const BOUNDED_PAYMENT_METHODS = new Set([
  "CASH",
  "CARD",
  "CHECK",
  "GIFT_CARD",
  "STORE_CREDIT",
  "WIRE",
  "ACH",
  "FINANCE",
  "OTHER",
]);

describe("Ordorite payment-mode value mapping", () => {
  test("every Card Connect/Card Not Present/Debit mode translates to CARD", () => {
    for (const sourceValue of ["Card Connect", "Card Not Present", "Debit"]) {
      const result = runImportEngine({
        importMode: "INSERT_ONLY",
        fieldMappings: [ORDORITE_PAYMENT_MODE_FIELD_MAPPING],
        valueMappings: ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
        rows: [{ Modeofpayment: sourceValue }],
      });
      expect(result.rows[0]).toMatchObject({
        outcome: "would-create",
        record: { paymentType: "CARD" },
      });
    }
  });

  test("Credit Note translates to STORE_CREDIT", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings: [ORDORITE_PAYMENT_MODE_FIELD_MAPPING],
      valueMappings: ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
      rows: [{ Modeofpayment: "Credit Note" }],
    });
    expect(result.rows[0].record.paymentType).toBe("STORE_CREDIT");
  });

  test("Marketing, Refund, Charity, and Other all translate to OTHER", () => {
    for (const sourceValue of ["Marketing", "Refund", "Charity", "Other"]) {
      const result = runImportEngine({
        importMode: "INSERT_ONLY",
        fieldMappings: [ORDORITE_PAYMENT_MODE_FIELD_MAPPING],
        valueMappings: ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
        rows: [{ Modeofpayment: sourceValue }],
      });
      expect(result.rows[0].record.paymentType).toBe("OTHER");
    }
  });

  test("running the full eight-row batch at once: every row lands on a bounded PaymentMethod value", () => {
    const rows = ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS.map((vm) => ({
      Modeofpayment: vm.sourceValue,
    }));
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings: [ORDORITE_PAYMENT_MODE_FIELD_MAPPING],
      valueMappings: ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
      rows,
    });

    expect(result.summary).toEqual({
      total: 8,
      wouldCreate: 8,
      wouldUpdate: 0,
      skipped: 0,
      errors: 0,
    });
    for (const row of result.rows) {
      expect(BOUNDED_PAYMENT_METHODS.has(row.record.paymentType as string)).toBe(true);
    }
  });

  test("a payment mode not in the seeded set (e.g. a future Ordorite code) is reported, not silently passed through", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings: [ORDORITE_PAYMENT_MODE_FIELD_MAPPING],
      valueMappings: ORDORITE_PAYMENT_MODE_VALUE_MAPPINGS,
      rows: [{ Modeofpayment: "Cryptocurrency" }],
    });
    expect(result.rows[0].outcome).toBe("error");
    expect(result.rows[0].record.paymentType).toBeUndefined();
    expect(result.unmappedValues).toEqual([
      { targetField: "paymentType", sourceValue: "Cryptocurrency", count: 1, rowIndexes: [0] },
    ]);
  });
});
