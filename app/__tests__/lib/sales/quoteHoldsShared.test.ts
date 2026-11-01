// /app/__tests__/lib/sales/quoteHoldsShared.test.ts
//
// GAP-16: the rules a quote hold follows (lib/sales/quoteHoldsShared.ts). The
// routes and the database are in quoteHolds.integration.test.ts; these pin the
// day arithmetic and the rule itself.

import {
  QUOTE_HOLD_DEFAULT_MAX_DAYS,
  addDays,
  holdDateProblem,
  holdDateString,
  holdDateValue,
  holdDaysLeft,
  holdIsOpen,
  isQuoteHoldMaxDays,
  isStockedProduct,
  latestHoldDate,
  lineCommitsStock,
  lineHoldProblem,
} from "@/lib/sales/quoteHoldsShared";

describe("what a store may set as its longest hold", () => {
  it("is a whole number of days from 0 to 365, and ships at the strict 3", () => {
    expect([0, 1, 3, 365].every(isQuoteHoldMaxDays)).toBe(true);
    expect([-1, 366, 2.5, "3", null, undefined, Number.NaN].some(isQuoteHoldMaxDays)).toBe(false);
    expect(QUOTE_HOLD_DEFAULT_MAX_DAYS).toBe(3);
  });
});

// Which strings name a real day is isDayKey's, pinned in businessDay.test.ts.
describe("calendar days", () => {
  it("counts days across months, years and a leap day", () => {
    expect(addDays("2026-11-29", 3)).toBe("2026-12-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("round-trips through the DATE column's value", () => {
    expect(holdDateValue("2026-11-03").toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(holdDateString(holdDateValue("2026-11-03"))).toBe("2026-11-03");
    expect(holdDateString("2026-11-03T00:00:00.000Z")).toBe("2026-11-03");
  });
});

describe("the days a hold may end on", () => {
  const ctx = { today: "2026-11-01", maxDays: 3 };

  it("runs from today to the store's longest", () => {
    expect(latestHoldDate("2026-11-01", 3)).toBe("2026-11-04");
    expect(holdDateProblem("2026-11-01", ctx)).toBeNull();
    expect(holdDateProblem("2026-11-04", ctx)).toBeNull();
  });

  it("refuses a day past it, before today, or not a day, saying which", () => {
    expect(holdDateProblem("2026-11-05", ctx)).toBe(
      "A quote may hold stock for at most 3 days: until 2026-11-04.",
    );
    expect(holdDateProblem("2026-11-02", { today: "2026-11-01", maxDays: 1 })).toBeNull();
    expect(holdDateProblem("2026-11-03", { today: "2026-11-01", maxDays: 1 })).toMatch(
      /at most 1 day:/,
    );
    expect(holdDateProblem("2026-10-31", ctx)).toBe("A hold can't end before today.");
    expect(holdDateProblem("Saturday", ctx)).toBe("holdUntil must be a date (YYYY-MM-DD).");
  });

  it("is never allowed when the store holds nothing", () => {
    expect(latestHoldDate("2026-11-01", 0)).toBeNull();
    expect(holdDateProblem("2026-11-01", { today: "2026-11-01", maxDays: 0 })).toMatch(
      /don't hold stock/,
    );
  });
});

describe("what a sale commits", () => {
  it("an order commits every line, held or not", () => {
    for (const orderStatus of ["ORDER", "FULFILLED"]) {
      expect(lineCommitsStock({ orderStatus, holdUntil: null, today: "2026-11-01" })).toBe(true);
    }
  });

  it("a quote commits a line only through its hold's last day", () => {
    const quote = (holdUntil: string | null) =>
      lineCommitsStock({ orderStatus: "QUOTE", holdUntil, today: "2026-11-01" });
    expect(quote(null)).toBe(false);
    expect(quote("2026-11-02")).toBe(true);
    expect(quote("2026-11-01")).toBe(true);
    expect(quote("2026-10-31")).toBe(false);
    expect(holdIsOpen(holdDateValue("2026-11-01"), "2026-11-01")).toBe(true);
  });

  it("counts days left to 0 on the last day", () => {
    expect(holdDaysLeft("2026-11-04", "2026-11-01")).toBe(3);
    expect(holdDaysLeft(holdDateValue("2026-11-01"), "2026-11-01")).toBe(0);
  });
});

describe("what can be held", () => {
  it("a product drawn from stock: not made to order, in a category that keeps stock", () => {
    expect(isStockedProduct({ madeToOrder: false, category: { trackInventory: true } })).toBe(true);
    expect(isStockedProduct({ madeToOrder: true, category: { trackInventory: true } })).toBe(false);
    expect(isStockedProduct({ madeToOrder: false, category: { trackInventory: false } })).toBe(
      false,
    );
  });

  it("an active floor-stock line only", () => {
    const line = { lineItemStatus: "ACTIVE", source: "FLOOR", stocked: true };
    expect(lineHoldProblem(line)).toBeNull();
    expect(lineHoldProblem({ ...line, source: null })).toBeNull();
    expect(lineHoldProblem({ ...line, lineItemStatus: "CANCELLED" })).toMatch(/active/);
    expect(lineHoldProblem({ ...line, source: "ORDER" })).toMatch(/special-order/);
    expect(lineHoldProblem({ ...line, stocked: false })).toMatch(/floor stock/);
    expect(lineHoldProblem({ ...line, stocked: null })).toMatch(/floor stock/);
  });
});
