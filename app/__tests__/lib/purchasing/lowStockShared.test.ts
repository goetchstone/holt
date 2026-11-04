// /app/__tests__/lib/purchasing/lowStockShared.test.ts
//
// GAP-14: what "low" means, and reading who the daily list goes to.

import { readAlertEmails, shortfall } from "@/lib/purchasing/lowStockShared";

const q = (free: number, onOrder = 0, onDraft = 0, orderQuantity: number | null = null) => ({
  minQuantity: 5,
  orderQuantity,
  free,
  onOrder,
  onDraft,
});

describe("what's low", () => {
  it("is below the level, not at it", () => {
    expect(shortfall(q(5))).toBeNull();
    expect(shortfall(q(6))).toBeNull();
    expect(shortfall(q(4))).toEqual({ shortBy: 1, suggested: 1 });
  });

  it("counts what's on sent POs toward the level", () => {
    expect(shortfall(q(2, 3))).toBeNull();
    expect(shortfall(q(2, 1))).toEqual({ shortBy: 2, suggested: 2 });
  });

  it("stays low with a draft, but doesn't suggest what the draft covers", () => {
    expect(shortfall(q(2, 0, 3))).toEqual({ shortBy: 3, suggested: 0 });
    expect(shortfall(q(2, 0, 1))).toEqual({ shortBy: 3, suggested: 2 });
    expect(shortfall(q(2, 0, 9))).toEqual({ shortBy: 3, suggested: 0 });
  });

  it("orders at least the least, once anything is needed", () => {
    expect(shortfall(q(4, 0, 0, 6))).toEqual({ shortBy: 1, suggested: 6 });
    expect(shortfall(q(0, 0, 0, 2))).toEqual({ shortBy: 5, suggested: 5 });
    expect(shortfall(q(2, 0, 3, 6))).toEqual({ shortBy: 3, suggested: 0 });
  });

  it("handles oversold stock and fractions", () => {
    expect(shortfall(q(-2))).toEqual({ shortBy: 7, suggested: 7 });
    expect(shortfall({ ...q(1.25), minQuantity: 2.5 })).toEqual({ shortBy: 1.25, suggested: 1.25 });
    // No float dust: 0.3 - 0.2 is 0.09999999999999998 unrounded.
    expect(shortfall({ ...q(0.1, 0.1), minQuantity: 0.3 })).toEqual({
      shortBy: 0.1,
      suggested: 0.1,
    });
  });
});

describe("who the list goes to", () => {
  it("reads addresses separated by commas, semicolons or spaces", () => {
    expect(readAlertEmails("a@x.com, b@x.com;c@x.com  d@x.com")).toEqual({
      emails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com"],
    });
    expect(readAlertEmails("  ")).toEqual({ emails: [] });
  });

  it("names one that isn't an address, and refuses too many", () => {
    expect(readAlertEmails("a@x.com, nope")).toEqual({
      problem: "nope doesn't look like an email address.",
    });
    const many = Array.from({ length: 11 }, (_, i) => `a${i}@x.com`).join(",");
    expect(readAlertEmails(many)).toEqual({ problem: expect.stringMatching(/at most 10/) });
  });
});
