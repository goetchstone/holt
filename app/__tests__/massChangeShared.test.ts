// /app/__tests__/massChangeShared.test.ts
//
// What a mass price change accepts (GAP-06, lib/pricing/massChangeShared.ts),
// before anything reaches the database.

import {
  MASS_CHANGE_MAX_PRODUCTS,
  parseMassChangeApplyRows,
  parseMassChangeFilter,
  parseMassChangeOperation,
  parseMassChangeSelection,
  wasAboveRetail,
} from "@/lib/pricing/massChangeShared";

describe("the filter", () => {
  it("reads ids from query text and drops what's blank", () => {
    expect(
      parseMassChangeFilter({ vendorId: "4", departmentId: "", q: "  sofa ", locked: "unlocked" }),
    ).toEqual({ ok: true, value: { vendorId: 4, q: "sofa", locked: "unlocked" } });
  });

  it("refuses an id that isn't one, and a lock state it doesn't know", () => {
    expect(parseMassChangeFilter({ categoryId: "x" }).ok).toBe(false);
    expect(parseMassChangeFilter({ locked: "yes" }).ok).toBe(false);
  });
});

describe("the selection", () => {
  it("takes chosen ids, once each", () => {
    expect(parseMassChangeSelection({ productIds: [3, 1, 3] })).toEqual({
      ok: true,
      value: { productIds: [3, 1] },
    });
  });

  it("refuses more than the cap rather than cutting it short", () => {
    const ids = Array.from({ length: MASS_CHANGE_MAX_PRODUCTS + 1 }, (_, i) => i + 1);
    const parsed = parseMassChangeSelection({ productIds: ids });
    expect(parsed).toEqual({ ok: false, error: expect.stringMatching(/at most 2000/) });
  });

  it("takes a filter instead", () => {
    expect(parseMassChangeSelection({ filter: { vendorId: 2 } })).toEqual({
      ok: true,
      value: { filter: { vendorId: 2 } },
    });
  });
});

describe("the operation", () => {
  it("takes each kind of retail change, with the was price kept by default", () => {
    expect(parseMassChangeOperation({ retail: { kind: "FROM_MARKUP" } })).toEqual({
      ok: true,
      value: { retail: { kind: "FROM_MARKUP" }, was: "KEEP" },
    });
    expect(
      parseMassChangeOperation({
        retail: { kind: "PERCENT", percent: -20 },
        was: "FROM_CURRENT",
        rounding: "END_99",
      }),
    ).toEqual({
      ok: true,
      value: { retail: { kind: "PERCENT", percent: -20 }, was: "FROM_CURRENT", rounding: "END_99" },
    });
  });

  it("refuses a change that changes nothing, a zero or impossible percent, and a price past the cent", () => {
    expect(parseMassChangeOperation({ retail: { kind: "KEEP" }, was: "KEEP" }).ok).toBe(false);
    expect(parseMassChangeOperation({ retail: { kind: "PERCENT", percent: 0 } }).ok).toBe(false);
    expect(parseMassChangeOperation({ retail: { kind: "PERCENT", percent: -100 } }).ok).toBe(false);
    expect(parseMassChangeOperation({ retail: { kind: "AMOUNT", amount: 9.999 } }).ok).toBe(false);
    expect(parseMassChangeOperation({ retail: { kind: "AMOUNT", amount: 0 } }).ok).toBe(false);
    expect(
      parseMassChangeOperation({ retail: { kind: "FROM_MARKUP" }, rounding: "NICKELS" }).ok,
    ).toBe(false);
  });
});

describe("the rows to apply", () => {
  it("takes each previewed row", () => {
    const row = { productId: 1, fromRetail: 100, toRetail: 90, fromWas: null, toWas: 100 };
    expect(parseMassChangeApplyRows([row])).toEqual({ ok: true, value: [row] });
  });

  it("refuses a row twice, a negative price, and none at all", () => {
    const row = { productId: 1, fromRetail: 100, toRetail: 90, fromWas: null, toWas: null };
    expect(parseMassChangeApplyRows([row, row]).ok).toBe(false);
    expect(parseMassChangeApplyRows([{ ...row, toRetail: -1 }]).ok).toBe(false);
    expect(parseMassChangeApplyRows([]).ok).toBe(false);
  });

  it("refuses a was price at or under the retail: a sale tag would refuse it", () => {
    const row = { productId: 1, fromRetail: 100, toRetail: 110, fromWas: null, toWas: 100 };
    expect(parseMassChangeApplyRows([row]).ok).toBe(false);
    expect(parseMassChangeApplyRows([{ ...row, toWas: 110 }]).ok).toBe(false);
    expect(parseMassChangeApplyRows([{ ...row, toWas: 110.01 }]).ok).toBe(true);
    expect(parseMassChangeApplyRows([{ ...row, toRetail: null }]).ok).toBe(true);
  });
});

describe("a was price above the retail", () => {
  it("compares to the cent, and holds with either price absent", () => {
    expect(wasAboveRetail(100, 99.99)).toBe(true);
    expect(wasAboveRetail(100, 100)).toBe(false);
    expect(wasAboveRetail(100.001, 100)).toBe(false);
    expect(wasAboveRetail(null, 100)).toBe(true);
    expect(wasAboveRetail(100, null)).toBe(true);
  });
});
