// /app/__tests__/lib/payments/tenderShared.test.ts
//
// A store tender's name becomes its payments' label, which the sales journal
// maps to a GL account and the reconciliation counts as tender. So it may not
// take a built-in's label or the deposit offset's, in any case.

import { isTenderKind, tenderNameProblem, TENDER_NAME_MAX } from "@/lib/payments/tenderShared";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import { DEPOSIT_OFFSET_LABELS } from "@/lib/glMapping";

describe("tenderNameProblem", () => {
  it("accepts a payer's name", () => {
    expect(tenderNameProblem("Synchrony")).toBeNull();
    expect(tenderNameProblem("  Zelle ")).toBeNull();
  });

  it("refuses every built-in label and every deposit offset label, whatever the case", () => {
    for (const label of [...Object.values(METHOD_DISPLAY), ...DEPOSIT_OFFSET_LABELS]) {
      expect(tenderNameProblem(label)).not.toBeNull();
      expect(tenderNameProblem(` ${label.toUpperCase()} `)).not.toBeNull();
    }
  });

  it("refuses a blank or overlong name", () => {
    expect(tenderNameProblem("   ")).toBe("Name the payment type.");
    expect(tenderNameProblem("x".repeat(TENDER_NAME_MAX + 1))).toContain("at most");
  });
});

describe("isTenderKind", () => {
  it("admits only the kinds with no machinery of their own", () => {
    expect(["FINANCE", "WIRE", "ACH", "OTHER"].every(isTenderKind)).toBe(true);
    for (const kind of ["CASH", "CARD", "CHECK", "GIFT_CARD", "STORE_CREDIT", "finance", null]) {
      expect(isTenderKind(kind)).toBe(false);
    }
  });
});
