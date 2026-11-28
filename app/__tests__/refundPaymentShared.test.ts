// /app/__tests__/refundPaymentShared.test.ts
//
// The order page's Refund action: what it says about where the money goes,
// which refunds need a till, and which amounts it lets through
// (lib/sales/refundPaymentShared.ts), and the register a browser remembers
// (lib/pos/registerChoice.ts).

import {
  refundAmountProblem,
  refundGoesTo,
  refundNeedsTill,
} from "@/lib/sales/refundPaymentShared";
import { REGISTER_STORAGE_KEY, rememberedRegisterId } from "@/lib/pos/registerChoice";

const usd = (n: number) => `$${n.toFixed(2)}`;

describe("where a refund goes, as the screen says it", () => {
  const paid = (method: string | null, viaProcessor = false, paymentType = "Card") => ({
    method,
    viaProcessor,
    paymentType,
  });

  it("is the card processor for a payment taken through one, whatever its method", () => {
    expect(refundGoesTo(paid("CARD", true))).toBe(
      "It goes back to the card it was paid with, through the card processor.",
    );
  });

  it("is the till for cash, the card for a gift card, the account for store credit", () => {
    expect(refundGoesTo(paid("CASH", false, "Cash"))).toBe(
      "Hand it back in cash. It comes out of the till at this register.",
    );
    expect(refundGoesTo(paid("GIFT_CARD", false, "Gift Card"))).toBe(
      "It goes back onto the gift card.",
    );
    expect(refundGoesTo(paid("STORE_CREDIT", false, "Store Credit"))).toBe(
      "It goes back onto the customer's store credit.",
    );
  });

  it("is only a record for anything Holt cannot send back itself, named as it was taken", () => {
    // A card taken on the store's own terminal: no processor to ask.
    expect(refundGoesTo(paid("CARD"))).toBe(
      "This records the refund. Give the money back the way it was taken (Card).",
    );
    expect(refundGoesTo(paid("CHECK", false, "Check"))).toContain("(Check)");
    expect(refundGoesTo(paid("OTHER", false, "Store Financing"))).toContain("(Store Financing)");
    expect(refundGoesTo(paid(null, false, "Imported"))).toContain("(Imported)");
  });
});

describe("which refunds come out of a till", () => {
  it("is cash only", () => {
    expect(refundNeedsTill("CASH")).toBe(true);
    for (const method of ["CARD", "CHECK", "GIFT_CARD", "STORE_CREDIT", "OTHER", null]) {
      expect(refundNeedsTill(method)).toBe(false);
    }
  });
});

describe("the amount typed for a refund", () => {
  it("passes anything from a cent up to what is left", () => {
    expect(refundAmountProblem("0.01", 400, usd)).toBeNull();
    expect(refundAmountProblem("400", 400, usd)).toBeNull();
    expect(refundAmountProblem("400.00", 400, usd)).toBeNull();
    // To the cent: 0.1 + 0.2 is what is left, and 0.3 is typed.
    expect(refundAmountProblem("0.3", 0.1 + 0.2, usd)).toBeNull();
  });

  it("refuses nothing, a non-number, zero and less", () => {
    for (const typed of ["", "   ", "abc", "0", "-5", "Infinity"]) {
      expect(refundAmountProblem(typed, 400, usd)).toBe("Enter the amount to refund.");
    }
  });

  it("refuses a cent more than is left, and says what is", () => {
    expect(refundAmountProblem("400.01", 400, usd)).toBe(
      "At most $400.00 is left to refund on this payment.",
    );
  });
});

describe("the register a browser remembers", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const remember = (value: string | null | Error) => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => {
          if (value instanceof Error) throw value;
          return key === REGISTER_STORAGE_KEY ? value : null;
        },
      },
    });
  };
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("is the id the register screen saved", () => {
    remember("4");
    expect(rememberedRegisterId()).toBe(4);
  });

  it("is none when nothing was saved, or what was saved is not an id", () => {
    for (const value of [null, "", "abc", "0", "-3"]) {
      remember(value);
      expect(rememberedRegisterId()).toBeNull();
    }
  });

  it("is none when storage cannot be read", () => {
    remember(new Error("blocked"));
    expect(rememberedRegisterId()).toBeNull();
  });
});
