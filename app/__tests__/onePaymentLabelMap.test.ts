// /app/__tests__/onePaymentLabelMap.test.ts
//
// A payment's label (`Payment.paymentType`, and the words a screen shows for a
// method) comes from METHOD_DISPLAY in lib/paymentMethodDisplay.ts, the one
// home for that catalog (rule 37). The label is what the sales journal and the
// AR_PAYMENT journal match against the POS_PAYMENTS GL mappings, so a second
// copy that drifts by one word books money to no account. Break-apart item 2,
// step 3 found five copies: the invoice label map, a hardcoded "Card" in
// invoiceService's Stripe posting, and three screens' own maps.
//
// A ratchet (rule 65): a method written out next to its label, or a tender
// label written into a `label:` field, may appear only in the files below,
// each with the reason it is not a copy.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { INVOICE_PAYMENT_LABELS, INVOICE_PAYMENT_METHODS } from "@/lib/billing/invoiceShared";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";

const APP = join(__dirname, "..");
const TENDER = "Cash|Card|Check|Gift Card|Store Credit|Wire|ACH|Finance";
// `CARD: "Card"`, `GIFT_CARD: 'Gift Card'`, `label: "Card"`.
const HAND_WRITTEN_LABEL =
  String.raw`(CASH|CARD|CHECK|GIFT_CARD|STORE_CREDIT|WIRE|ACH|FINANCE)[[:space:]]*:[[:space:]]*["'](${TENDER})["']` +
  "|" +
  String.raw`label:[[:space:]]*["'](${TENDER})["']`;

const ACCEPTED: Record<string, string> = {
  "src/lib/paymentMethodDisplay.ts": "METHOD_DISPLAY itself: the one home.",
  "src/lib/adapters/ordorite/shared.ts":
    "PAYMENT_METHOD_MAP runs the other way: the source system's own tender names (one of which is spelled `ACH`) translated into holt's PaymentMethod. An adapter's vocabulary, not holt's labels.",
};

function filesWithHandWrittenLabels(): string[] {
  let out: string;
  try {
    out = execFileSync("grep", ["-rlE", HAND_WRITTEN_LABEL, "src"], { cwd: APP, encoding: "utf8" });
  } catch (err) {
    // grep exits 1 when nothing matches; anything else is an error, not a pass.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
  return out.trim().split("\n").filter(Boolean).sort();
}

describe("payment labels have one home", () => {
  it("writes a method's label by hand only in the listed files", () => {
    expect(filesWithHandWrittenLabels()).toEqual(Object.keys(ACCEPTED).sort());
  });

  // Derived, so a method added to the invoice list without a METHOD_DISPLAY
  // label would store `undefined` as its paymentType. It must have one.
  it("labels every invoice payment method from METHOD_DISPLAY", () => {
    for (const method of INVOICE_PAYMENT_METHODS) {
      expect(INVOICE_PAYMENT_LABELS[method]).toBe(METHOD_DISPLAY[method]);
      expect(INVOICE_PAYMENT_LABELS[method]).toEqual(expect.any(String));
    }
  });

  it("gives every accepted file a reason", () => {
    expect(Object.entries(ACCEPTED).filter(([, reason]) => reason.trim() === "")).toEqual([]);
  });
});
