// /app/__tests__/ordoritePaymentMethod.test.ts
//
// `Payment.method` is holt's bounded tender vocabulary. Before this, the
// Ordorite importer wrote `paymentType` (the source's own display string) and
// left `method` NULL — on 47,878 of 47,880 rows in the restored dataset. A
// bounded enum nothing populates is not a vocabulary, it is a column, and every
// query written against it silently returns nothing.
//
// Two things are pinned here:
//
//   1. Every mode the adapter can decode resolves to a method. A gap between
//      PAYMENT_MODE_MAP and PAYMENT_METHOD_MAP is a tender that imports with a
//      NULL method forever, which is how this started.
//   2. The map agrees with config/presets/ordorite-payment-modes.yaml. That
//      preset is where these decisions were reviewed; two sources for the same
//      decision is how they drift.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePaymentMode, resolvePaymentMethod } from "@/lib/adapters/ordorite/shared";

// The numeric codes Ordorite exports, from PAYMENT_MODE_MAP.
const ORDORITE_CODES = [
  "1",
  "2",
  "4",
  "5",
  "6",
  "9",
  "11",
  "20",
  "27",
  "28",
  "29",
  "30",
  "32",
  "33",
];

describe("resolvePaymentMethod", () => {
  it("classifies every mode the adapter can decode", () => {
    const unclassified = ORDORITE_CODES.map((c) => resolvePaymentMode(c)).filter(
      (t) => resolvePaymentMethod(t) === null,
    );
    // A decoded tender with no method imports as NULL forever.
    expect(unclassified).toEqual([]);
  });

  it("collapses all three card rails to CARD", () => {
    // Ordorite splits processor and card-present; holt's ledger does not, and
    // they settle to the same GL account.
    expect(resolvePaymentMethod("Card Connect")).toBe("CARD");
    expect(resolvePaymentMethod("Card Not Present")).toBe("CARD");
    expect(resolvePaymentMethod("Debit")).toBe("CARD");
  });

  it("maps a credit note to STORE_CREDIT, not CASH", () => {
    // It draws down a liability holt already recorded; calling it cash would
    // invent a receipt.
    expect(resolvePaymentMethod("Credit Note")).toBe("STORE_CREDIT");
  });

  it("keeps non-cash settlements as OTHER rather than something truer-looking", () => {
    for (const t of ["Marketing", "Charity", "Refund", "Other"]) {
      expect(resolvePaymentMethod(t)).toBe("OTHER");
    }
  });

  it("returns null for a mode it cannot classify", () => {
    // Honest gap: it stays visible in the Unmapped Payments report instead of
    // being guessed into a bucket that looks reconciled.
    expect(resolvePaymentMethod("Crypto")).toBeNull();
    expect(resolvePaymentMethod("")).toBeNull();
  });

  it("agrees with the shipped preset, which is where these were reviewed", () => {
    const yaml = readFileSync(
      join(__dirname, "..", "..", "config", "presets", "ordorite-payment-modes.yaml"),
      "utf8",
    );
    // The preset's value block is `paymentType:` followed by `  Source: TARGET`
    // lines. Parsed with a regex rather than a YAML dep — we control the file.
    const block = yaml.slice(yaml.indexOf("valueMappings:"));
    const pairs = [...block.matchAll(/^\s{8}([A-Za-z][A-Za-z ]*?):\s*([A-Z_]+)\s*$/gm)];
    expect(pairs.length).toBeGreaterThan(4); // the parse itself must not silently find nothing

    for (const [, source, target] of pairs) {
      expect({ source, method: resolvePaymentMethod(source) }).toEqual({ source, method: target });
    }
  });
});
