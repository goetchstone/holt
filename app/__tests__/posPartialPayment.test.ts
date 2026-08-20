// /app/__tests__/posPartialPayment.test.ts
//
// The register must be able to take LESS than the order total.
//
// A furniture store's normal transaction is a deposit now and the balance on
// delivery, and a customer splitting across two tenders is routine. Neither was
// possible: `handleRecordPayment` sent `createdOrder.total` on every payment,
// so the only ringable transaction was payment in full.
//
// Worth stating because it shapes the fix: the BACKEND always allowed this.
// `recordPayment` accepts any positive amount and `calculateOrderBalance`
// already tracked partial payment. Only the UI insisted on the full total, so
// this is a screen change, not a money-path change.
//
// Source-text assertions because the behaviour lives in component state that a
// unit test cannot reach without rendering the whole POS. They pin the shape of
// the regression rather than the behaviour, which is honest about what they
// cover: if someone reverts the amount to the order total, this fails.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const POS = readFileSync(
  join(__dirname, "..", "src", "app", "(dashboard)", "app", "sales", "pos", "PosView.tsx"),
  "utf8",
);

describe("POS takes partial payments", () => {
  it("does not send the order total as the payment amount", () => {
    // The exact line this replaces: `const amount = createdOrder.total;`.
    //
    // Matched on ANY local bound straight to createdOrder.total, not just the
    // name `amount`. A first version pinned only that one identifier, and a
    // probe that reverted the logic under a different name (`requested`) sailed
    // through -- the guard also matched a SECOND, unrelated occurrence of the
    // same ternary further down the file, in the panel. Two lessons in one
    // false pass: pin the shape, and check the pattern is unique.
    expect(POS).not.toMatch(/const\s+\w+\s*=\s*createdOrder\.total\s*;/);
  });

  it("derives the amount from an operator-entered value, defaulting to the balance", () => {
    const uses = POS.match(/payAmount\.trim\(\)\s*===\s*""\s*\?\s*balanceDue/g) ?? [];
    // Two by design: the handler computes what to POST, the panel computes what
    // to display. Asserting the count keeps this from passing on the panel's
    // copy alone if the handler's is removed.
    expect(uses).toHaveLength(2);
  });

  it("refuses more than the balance due rather than silently overpaying", () => {
    expect(POS).toMatch(/requested\s*>\s*balanceDue/);
  });

  it("tracks what has been paid so a second tender knows the remainder", () => {
    expect(POS).toMatch(/setPaidSoFar\(/);
    expect(POS).toMatch(/createdOrder\.total\s*-\s*newPaid/);
  });

  it("stays on the payment screen while a balance remains", () => {
    // Jumping to the receipt after the first tender is what made a deposit
    // impossible even though the backend accepted it.
    expect(POS).toMatch(/if\s*\(remaining\s*>\s*0\.005\)/);
  });

  it("resets what has been paid when a new transaction starts", () => {
    // Otherwise the next customer's first payment is measured against the
    // previous customer's balance.
    expect(POS).toMatch(/setCreatedOrder\(null\);\s*\n\s*setPaidSoFar\(0\);/);
  });
});
