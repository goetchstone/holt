// /app/__tests__/registerLookupShared.test.ts
//
// The register's lookup: what it says about a sale it found, when it offers a
// payment on it, and what it says about a gift card
// (lib/pos/registerLookupShared.ts).

import {
  SALE_SEARCH_MIN,
  giftCardLine,
  lookupLabel,
  saleMoneyLine,
  saleTakesPayment,
} from "@/lib/pos/registerLookupShared";

const usd = (n: number) => `$${n.toFixed(2)}`;
const sale = (status: string, balanceDue: number, totalAmount = 1854.32) => ({
  status,
  balanceDue,
  totalAmount,
});

describe("a sale found from the register", () => {
  it("can take a payment while it owes something and is not cancelled", () => {
    expect(saleTakesPayment(sale("ORDER", 927.16))).toBe(true);
    // A deposit on a quote makes it a sale.
    expect(saleTakesPayment(sale("QUOTE", 1854.32))).toBe(true);
    expect(saleTakesPayment(sale("FULFILLED", 12.5))).toBe(true);
  });

  it("cannot once it is paid, cancelled, or owed to the customer", () => {
    expect(saleTakesPayment(sale("ORDER", 0))).toBe(false);
    expect(saleTakesPayment(sale("CANCELLED", 927.16))).toBe(false);
    expect(saleTakesPayment(sale("RETURNED", -40))).toBe(false);
  });

  it("says what it owes, or that it is a quote, paid or cancelled", () => {
    expect(saleMoneyLine(sale("ORDER", 927.16), usd)).toBe("Owes $927.16 of $1854.32");
    expect(saleMoneyLine(sale("FULFILLED", 0), usd)).toBe("Paid, $1854.32");
    // A quote is not owed, whatever it comes to.
    expect(saleMoneyLine(sale("QUOTE", 1854.32), usd)).toBe("Quote for $1854.32");
    expect(saleMoneyLine(sale("CANCELLED", 927.16), usd)).toBe("Cancelled");
  });

  it("says a return is one, in the amount taken back", () => {
    // A return is its own sale with negative amounts; "Paid, $-9113.29" is what it read.
    expect(saleMoneyLine(sale("RETURNED", 0, -9113.29), usd)).toBe("Return of $9113.29");
    expect(saleMoneyLine(sale("RETURNED", -9113.29, -9113.29), usd)).toBe("Return of $9113.29");
  });

  it("is searched for from two characters up", () => {
    expect(SALE_SEARCH_MIN).toBe(2);
  });

  it("is offered only to someone who may view orders; the gift card check to anyone", () => {
    expect(lookupLabel(true)).toBe("Look up a sale or a gift card");
    expect(lookupLabel(false)).toBe("Check a gift card");
  });
});

describe("a gift card checked from the register", () => {
  const card = (status: string, currentBalance: number) => ({
    barcode: "GC-700003",
    status,
    initialAmount: 50,
    currentBalance,
  });

  it("says what is left on it", () => {
    expect(giftCardLine(card("ACTIVE", 23.25), usd)).toBe("GC-700003: $23.25 left of $50.00");
  });

  it("says so when the card is not active", () => {
    expect(giftCardLine(card("REDEEMED", 0), usd)).toBe(
      "GC-700003: $0.00 left of $50.00 (redeemed)",
    );
    expect(giftCardLine(card("VOIDED", 50), usd)).toContain("(voided)");
  });
});
