// /app/__tests__/stripeLedgerWiring.test.ts
//
// Ledger Risk #137: a Stripe payment must post to the AR ledger only when the
// charge is CONFIRMED (webhook), not when the checkout is created — otherwise an
// abandoned checkout leaves a phantom PAYMENT entry in the books. These source
// tripwires guard the wiring; the math lives in paymentService (unit-tested).

import fs from "node:fs";
import path from "node:path";

const APP_ROOT = path.join(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(APP_ROOT, rel), "utf8");

describe("Stripe payment → AR ledger wiring (#137)", () => {
  it("create-checkout records a PENDING payment with NO ledger entry", () => {
    const src = read("src/pages/api/stripe/create-checkout.ts");
    expect(src).toMatch(/recordPendingPayment\(/);
    // The ledger-posting recordPayment() must NOT be used here.
    expect(src).not.toMatch(/[^g]recordPayment\(/);
  });

  it("webhook posts the ledger at completion via completePayment", () => {
    const src = read("src/pages/api/stripe/webhook.ts");
    expect(src).toMatch(/completePayment\(/);
  });

  it("completePayment is idempotent — a re-fired webhook never double-posts", () => {
    const src = read("src/lib/paymentService.ts");
    expect(src).toMatch(/status === "COMPLETED"\) return payment/);
  });
});
