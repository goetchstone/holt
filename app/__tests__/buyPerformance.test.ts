// /app/__tests__/buyPerformance.test.ts
//
// A-grade tests for the Slice 6 performance aggregator. No DB, no I/O.

import {
  computePerformance,
  STATUS_THRESHOLDS,
  type PerformanceDraft,
  type PerformanceSaleLine,
  type PerformanceReceiptLine,
  type ProductFrameIndex,
  type ComputePerformanceOptions,
} from "@/lib/buyPerformance";

const draft = (
  draftId: number,
  qty: number,
  costPerUnit: number,
  retailPerUnit: number,
  fulfilledProductId: number | null,
  frameKey: string | null,
  frameLabel = frameKey ?? "",
): PerformanceDraft => ({
  draftId,
  qty,
  costPerUnit,
  retailPerUnit,
  fulfilledProductId,
  frameKey,
  frameLabel,
});

const sale = (
  productId: number,
  qty: number,
  netPrice: number,
  cost: number | null = null,
): PerformanceSaleLine => ({
  productId,
  qty,
  netPrice,
  cost,
});

const opts = (daysSinceBuyExported: number, deadAfterDays?: number): ComputePerformanceOptions => ({
  daysSinceBuyExported,
  deadAfterDays,
});

// ─── Basic aggregation ───────────────────────────────────────────────

describe("computePerformance — basic aggregation", () => {
  it("rolls multiple drafts on the same frame into one row", () => {
    const drafts = [
      draft(1, 2, 1000, 2500, 9001, "wh:L2272", "L2272"), // Grade 13
      draft(2, 4, 1100, 2700, 9002, "wh:L2272", "L2272"), // Grade 16
    ];
    const sales: PerformanceSaleLine[] = [];
    const idx: ProductFrameIndex = new Map();
    const rows = computePerformance(drafts, sales, idx, opts(30));
    expect(rows).toHaveLength(1);
    expect(rows[0].qtyOrdered).toBe(6); // 2 + 4
    expect(rows[0].totalCost).toBe(2 * 1000 + 4 * 1100); // 6400
    expect(rows[0].draftCount).toBe(2);
  });

  it("attributes sales across all frame mates (not just the drafted SKU)", () => {
    // Draft was for Grade 13 (product 9001); customer bought Grade 16 (9002).
    // Same frame → counts as a sale on this frame.
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272", "L2272")];
    const sales = [
      sale(9002, 1, 2700), // different product, same frame
      sale(9003, 2, 3000), // another product, same frame
    ];
    const idx: ProductFrameIndex = new Map([
      [9001, "wh:L2272"],
      [9002, "wh:L2272"],
      [9003, "wh:L2272"],
    ]);
    const rows = computePerformance(drafts, sales, idx, opts(30));
    expect(rows[0].qtySold).toBe(3);
    expect(rows[0].revenue).toBe(2700 + 3000);
  });

  it("ignores sales on products NOT in scope", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272")];
    const sales = [
      sale(9001, 1, 2500),
      sale(7777, 5, 99999), // out-of-scope product
    ];
    const idx: ProductFrameIndex = new Map([[9001, "wh:L2272"]]);
    const rows = computePerformance(drafts, sales, idx, opts(30));
    expect(rows[0].qtySold).toBe(1);
    expect(rows[0].revenue).toBe(2500);
  });

  it("sorts results by revenue descending", () => {
    const drafts = [
      draft(1, 1, 100, 200, 1, "low", "Low"),
      draft(2, 1, 100, 200, 2, "high", "High"),
      draft(3, 1, 100, 200, 3, "mid", "Mid"),
    ];
    const sales = [sale(1, 1, 100), sale(2, 1, 5000), sale(3, 1, 1000)];
    const idx: ProductFrameIndex = new Map([
      [1, "low"],
      [2, "high"],
      [3, "mid"],
    ]);
    const rows = computePerformance(drafts, sales, idx, opts(90));
    expect(rows.map((r) => r.frameLabel)).toEqual(["High", "Mid", "Low"]);
  });
});

// ─── Margin math ─────────────────────────────────────────────────────

describe("computePerformance — margin", () => {
  it("uses line.cost when present", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 1, 2500, 1100)]; // explicit cost
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.costOfSold).toBe(1100);
    expect(r.grossProfit).toBe(2500 - 1100);
    expect(r.marginRatio).toBeCloseTo((2500 - 1100) / 2500, 4);
  });

  it("falls back to revenue/2 when line.cost is null, marks row as estimated", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 2, 5000, null)]; // null cost → revenue/2 = 2500
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.costOfSold).toBe(2500); // revenue / 2 (50% margin baseline)
    expect(r.grossProfit).toBe(2500);
    expect(r.marginRatio).toBeCloseTo(0.5, 4);
    expect(r.hasEstimatedCost).toBe(true);
  });

  // Bug-fix 2026-05-13 (user-reported): some line items have cost=0
  // (data-quality issue, not a real "free item"). User direction:
  // "0 costs the only think I can think of is to notate them and use
  // retail / 2 for now". So zero costs use revenue/2 AND flag the row
  // as estimated so the UI can show "(est)".
  it("treats line.cost = 0 as missing and falls back to revenue/2", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 2, 5000, 0)]; // ZERO cost → revenue/2 = 2500
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.costOfSold).toBe(2500); // 50% margin baseline, not 100%
    expect(r.marginRatio).toBeCloseTo(0.5, 4);
    expect(r.hasEstimatedCost).toBe(true);
  });

  it("preserves a legitimate non-zero line.cost (fix doesn't over-apply)", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 2, 5000, 1.5)]; // tiny but legit cost (e.g. salvage sale)
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.costOfSold).toBe(1.5);
    expect(r.hasEstimatedCost).toBe(false);
  });

  it("hasEstimatedCost is FALSE when all sold lines have real costs", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 1, 2500, 1100), sale(9001, 1, 2500, 1100)];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.hasEstimatedCost).toBe(false);
  });

  it("hasEstimatedCost is TRUE when ANY sold line falls back (mixed case)", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 1, 2500, 1100), sale(9001, 1, 2500, 0)];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.hasEstimatedCost).toBe(true); // one line was estimated
    expect(r.costOfSold).toBe(1100 + 1250); // real + revenue/2 for the bad one
  });

  it("clamps grossProfit to 0 when costOfSold exceeds revenue (loss leader)", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 2, 1000, 1500)]; // sold below cost
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.grossProfit).toBe(0); // not negative — display sanity
    expect(r.revenue).toBe(1000);
    expect(r.costOfSold).toBe(1500);
  });

  it("emits 0 margin when revenue is 0", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales: PerformanceSaleLine[] = [];
    const idx: ProductFrameIndex = new Map();
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.marginRatio).toBe(0);
  });
});

// ─── Status hints ────────────────────────────────────────────────────

describe("computePerformance — status", () => {
  it("returns 'no-link' when no draft has a fulfilledProductId yet", () => {
    const drafts = [draft(1, 4, 1000, 2500, null, "frame")]; // never linked
    const r = computePerformance(drafts, [], new Map(), opts(120))[0];
    expect(r.status).toBe("no-link");
  });

  it("returns 'pending' when linked but the Buy is too young to judge", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales: PerformanceSaleLine[] = []; // 0 sold
    const r = computePerformance(drafts, sales, new Map(), opts(30))[0]; // 30 days
    expect(r.status).toBe("pending");
  });

  it("returns 'dead' when linked, 0 sold, and past the dead window", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales: PerformanceSaleLine[] = [];
    const r = computePerformance(drafts, sales, new Map(), opts(120))[0]; // 120 days
    expect(r.status).toBe("dead");
  });

  it("returns 'underbuy' when sold > ordered (sell-through > 1.0)", () => {
    const drafts = [draft(1, 2, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 5, 12500)]; // sold 5 vs ordered 2
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(90))[0];
    expect(r.sellThroughRatio).toBe(2.5);
    expect(r.status).toBe("underbuy");
  });

  it("returns 'healthy' in the 60-100% sell-through band", () => {
    const drafts = [draft(1, 10, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 8, 20000)]; // 80% sell-through
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(90))[0];
    expect(r.status).toBe("healthy");
  });

  it("returns 'soft' below 60% sell-through but not dead", () => {
    const drafts = [draft(1, 10, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 3, 7500)]; // 30% sell-through
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(90))[0];
    expect(r.status).toBe("soft");
  });

  it("status thresholds are exported as constants for traceability", () => {
    expect(STATUS_THRESHOLDS.underbuyAt).toBe(1);
    expect(STATUS_THRESHOLDS.healthyMin).toBe(0.6);
  });

  it("respects custom deadAfterDays override", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales: PerformanceSaleLine[] = [];
    // 30 days < default 60, but caller overrides to 14 days
    const r = computePerformance(drafts, sales, new Map(), opts(30, 14))[0];
    expect(r.status).toBe("dead");
  });
});

// ─── Degenerate inputs ───────────────────────────────────────────────

describe("computePerformance — degenerate inputs", () => {
  it("returns empty when there are no drafts", () => {
    expect(computePerformance([], [], new Map(), opts(30))).toEqual([]);
  });

  it("skips drafts with no frameKey", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, null)]; // no frame
    const r = computePerformance(drafts, [], new Map(), opts(30));
    expect(r).toEqual([]);
  });

  it("handles a frame with zero qtyOrdered (drafts.length=0 case is empty result)", () => {
    // Edge — if a frame somehow lands in the bucket with qty=0,
    // sellThrough should be 0 not NaN.
    const drafts = [draft(1, 0, 1000, 2500, 9001, "frame")];
    const r = computePerformance(drafts, [], new Map(), opts(30))[0];
    expect(r.sellThroughRatio).toBe(0);
    expect(r.qtyOrdered).toBe(0);
  });
});

// ─── Phase 6.3: Stock vs Special split ───────────────────────────────────

describe("computePerformance — stock vs special split", () => {
  it("counts sales of drafted (stock) products as stock-sold and others as special", () => {
    // Buyer drafted Product 9001 (Foundations Hopkins fabric).
    // Frame has many variants in the catalog (9001, 9002, 9003).
    // Customer buys 1 of 9001 (stock) + 2 of 9002 (special).
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const sales = [
      sale(9001, 1, 2500, 1000), // stock — matches drafted productId
      sale(9002, 2, 5000, 1000), // special — other variant of same frame
    ];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.qtyStockSold).toBe(1);
    expect(r.qtySpecialSold).toBe(2);
    expect(r.qtySold).toBe(3); // combined
    expect(r.stockSellThroughRatio).toBeCloseTo(1 / 6, 4);
    expect(r.sellThroughRatio).toBeCloseTo(3 / 6, 4);
  });

  it("status is 'healthy' on stock S/T even when special sales are heavy", () => {
    // Frame drafted 6 units. 4 stock sold + 18 special sold.
    // Stock S/T = 4/6 = 67% (healthy). Total S/T = 22/6 (underbuy)
    // but status uses STOCK only. User's exact scenario from
    // 2026-05-13 spot-check.
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 4, 2500 * 4, 1000 * 4), sale(9002, 18, 5000 * 18, 1000 * 18)];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.qtyStockSold).toBe(4);
    expect(r.qtySpecialSold).toBe(18);
    expect(r.stockSellThroughRatio).toBeCloseTo(4 / 6, 4);
    expect(r.status).toBe("healthy");
  });

  it("underbuy fires ONLY when stock-sold exceeds qtyOrdered (special doesn't trigger)", () => {
    // Drafted 4, stock sold 5 (>4) — actual stock ran out → underbuy
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 5, 2500 * 5, 1000 * 5), sale(9002, 50, 5000 * 50, 1000 * 50)];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.status).toBe("underbuy");
  });

  it("special-only sales (zero stock-sold) past dead window → dead (status uses stock S/T)", () => {
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const sales = [sale(9002, 8, 5000 * 8, 1000 * 8)]; // all special
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 90,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.qtyStockSold).toBe(0);
    expect(r.qtySpecialSold).toBe(8);
    expect(r.status).toBe("dead"); // stock didn't move — even if specials did
  });

  it("backward compat: omitting stockProductIds treats ALL sales as stock", () => {
    // Existing callers (and the API in single-product cases) shouldn't
    // change behavior. Stock-sold == qtySold; special == 0.
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 4, 2500 * 4, 1000 * 4)];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, { daysSinceBuyExported: 30 })[0];
    expect(r.qtyStockSold).toBe(4);
    expect(r.qtySpecialSold).toBe(0);
    expect(r.stockSellThroughRatio).toBeCloseTo(4 / 6, 4);
  });

  it("empty stockProductIds (no drafts linked yet) routes all sales to special", () => {
    // Edge case: buyer drafted items but Slice 5 auto-link hasn't
    // fired yet (no fulfilledProductId on any draft). Every sale of
    // the frame is special by definition; stock-S/T = 0 → status
    // path goes to no-link via hasAnyLink.
    const drafts = [draft(1, 6, 1000, 2500, null, "frame")]; // null fulfilledProductId
    const sales = [sale(9001, 4, 2500 * 4, 1000 * 4)];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set(), // empty
    })[0];
    expect(r.qtyStockSold).toBe(0);
    expect(r.qtySpecialSold).toBe(4);
    expect(r.status).toBe("no-link");
  });

  it("returns (negative qty) subtract from the right bucket", () => {
    // Stock sale +5, special sale +3, stock return -1.
    // Net: stockSold=4, specialSold=3.
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const sales = [
      sale(9001, 5, 2500 * 5, 1000 * 5),
      sale(9002, 3, 5000 * 3, 1000 * 3),
      sale(9001, -1, -2500, -1000), // return of stock
    ];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.qtyStockSold).toBe(4);
    expect(r.qtySpecialSold).toBe(3);
  });
});

// ─── Phase 6.8.1 — per-frame sales window ───────────────────────────

describe("computePerformance — per-frame sales window (Slice 6.8.1)", () => {
  const saleAt = (
    productId: number,
    qty: number,
    netPrice: number,
    orderDate: Date | null,
  ): PerformanceSaleLine => ({
    productId,
    qty,
    netPrice,
    cost: null,
    orderDate,
  });

  it("counts a sale when orderDate ≥ the frame's window start", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272", "L2272")];
    const sales = [saleAt(9001, 1, 2500, new Date("2026-01-15"))];
    const idx: ProductFrameIndex = new Map([[9001, "wh:L2272"]]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      frameWindowStartByKey: new Map([["wh:L2272", new Date("2026-01-01")]]),
    })[0];
    expect(r.qtySold).toBe(1);
    expect(r.revenue).toBe(2500);
  });

  it("excludes a sale that fell BEFORE the frame's window start", () => {
    // Sale on Dec 15 2025 for a frame that didn't arrive until Jan 1 2026.
    // The sale couldn't be from this buy's stock.
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272", "L2272")];
    const sales = [saleAt(9001, 1, 2500, new Date("2025-12-15"))];
    const idx: ProductFrameIndex = new Map([[9001, "wh:L2272"]]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      frameWindowStartByKey: new Map([["wh:L2272", new Date("2026-01-01")]]),
    })[0];
    expect(r.qtySold).toBe(0);
    expect(r.revenue).toBe(0);
  });

  it("counts a sale exactly AT the window start (>= boundary inclusive)", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272", "L2272")];
    const sales = [saleAt(9001, 1, 2500, new Date("2026-01-01"))];
    const idx: ProductFrameIndex = new Map([[9001, "wh:L2272"]]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      frameWindowStartByKey: new Map([["wh:L2272", new Date("2026-01-01")]]),
    })[0];
    expect(r.qtySold).toBe(1);
  });

  it("excludes a sale with no orderDate when a per-frame window is set", () => {
    // Conservative: null orderDate is "we don't know when" — exclude.
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272", "L2272")];
    const sales = [saleAt(9001, 1, 2500, null)];
    const idx: ProductFrameIndex = new Map([[9001, "wh:L2272"]]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      frameWindowStartByKey: new Map([["wh:L2272", new Date("2026-01-01")]]),
    })[0];
    expect(r.qtySold).toBe(0);
  });

  it("applies different window starts to different frames in the same buy", () => {
    // Hooker frame received Oct 2025; CRL frame received Feb 2026.
    // A January 2026 sale should count for Hooker but NOT for CRL.
    const drafts = [
      draft(1, 4, 1000, 2500, 9001, "hook:F1", "Hook F1"),
      draft(2, 4, 1000, 2500, 9002, "crl:F2", "CRL F2"),
    ];
    const sales = [
      saleAt(9001, 1, 1000, new Date("2026-01-15")), // Jan sale — Hooker valid
      saleAt(9002, 1, 1000, new Date("2026-01-15")), // Jan sale — CRL too early
    ];
    const idx: ProductFrameIndex = new Map([
      [9001, "hook:F1"],
      [9002, "crl:F2"],
    ]);
    const result = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      frameWindowStartByKey: new Map([
        ["hook:F1", new Date("2025-10-01")],
        ["crl:F2", new Date("2026-02-01")],
      ]),
    });
    const hook = result.find((r) => r.frameKey === "hook:F1");
    const crl = result.find((r) => r.frameKey === "crl:F2");
    expect(hook?.qtySold).toBe(1);
    expect(crl?.qtySold).toBe(0);
  });

  it("falls through (no per-frame filter) when the frame isn't in the map", () => {
    // Frame not in the map → no filter. Caller's buy-wide SQL window
    // is still in effect (the helper just doesn't add a further
    // restriction).
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272", "L2272")];
    const sales = [saleAt(9001, 1, 2500, new Date("2024-06-15"))]; // way old
    const idx: ProductFrameIndex = new Map([[9001, "wh:L2272"]]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      frameWindowStartByKey: new Map([["other:frame", new Date("2026-01-01")]]),
    })[0];
    expect(r.qtySold).toBe(1); // through-fall: no filter for wh:L2272
  });

  it("treats undefined frameWindowStartByKey as 'no per-frame filter' (backward-compat)", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "wh:L2272", "L2272")];
    const sales = [saleAt(9001, 1, 2500, new Date("2024-06-15"))];
    const idx: ProductFrameIndex = new Map([[9001, "wh:L2272"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.qtySold).toBe(1);
  });
});

// ─── Phase 6.11 — margin split stock vs special ─────────────────────

describe("computePerformance — split margin (Slice 6.11)", () => {
  it("defaults stock + special revenue / costOfSold to 0 with no sales", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, [], idx, opts(30))[0];
    expect(r.stockRevenue).toBe(0);
    expect(r.specialRevenue).toBe(0);
    expect(r.stockCostOfSold).toBe(0);
    expect(r.specialCostOfSold).toBe(0);
    expect(r.stockMarginRatio).toBe(0);
    expect(r.specialMarginRatio).toBe(0);
  });

  it("splits stock + special revenue based on stockProductIds set", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [
      sale(9001, 2, 5000, 2000), // stock — 60% margin
      sale(9002, 1, 4000, 3000), // special — 25% margin
    ];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.stockRevenue).toBe(5000);
    expect(r.specialRevenue).toBe(4000);
    expect(r.stockCostOfSold).toBe(2000);
    expect(r.specialCostOfSold).toBe(3000);
    expect(r.stockMarginRatio).toBeCloseTo(0.6, 5); // (5000-2000)/5000
    expect(r.specialMarginRatio).toBeCloseTo(0.25, 5); // (4000-3000)/4000
    // Combined margin matches the pre-6.11 number for backward compat
    expect(r.marginRatio).toBeCloseTo((9000 - 5000) / 9000, 5);
  });

  it("returns 0 stockMargin when no stock sales (only special)", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9002, 1, 4000, 2000)];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.stockRevenue).toBe(0);
    expect(r.stockMarginRatio).toBe(0);
    expect(r.specialMarginRatio).toBeCloseTo(0.5, 5);
  });

  it("treats all sales as stock margin when stockProductIds is undefined (backward-compat)", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [sale(9001, 2, 5000, 2000)];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, sales, idx, opts(30))[0];
    expect(r.stockRevenue).toBe(5000);
    expect(r.specialRevenue).toBe(0);
    expect(r.stockMarginRatio).toBeCloseTo(0.6, 5);
  });

  it("retail/2 fallback applies symmetrically to stock + special when cost is missing", () => {
    // The fallback fires on cost=0 / null lines on BOTH sides, giving
    // each side a 50% margin estimate. Validates the split doesn't
    // break the fallback's intent (slice 6 zero-cost handling).
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const sales = [
      sale(9001, 2, 5000, null), // stock, no cost → fallback
      sale(9002, 1, 4000, null), // special, no cost → fallback
    ];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const r = computePerformance(drafts, sales, idx, {
      daysSinceBuyExported: 30,
      stockProductIds: new Set([9001]),
    })[0];
    expect(r.stockMarginRatio).toBeCloseTo(0.5, 5);
    expect(r.specialMarginRatio).toBeCloseTo(0.5, 5);
    expect(r.hasEstimatedCost).toBe(true);
  });
});

// ─── Phase 6.8 — qtyReceived ─────────────────────────────────────────

describe("computePerformance — receipts (Slice 6.8)", () => {
  const receipt = (productId: number, qty: number): PerformanceReceiptLine => ({
    productId,
    qty,
  });

  it("defaults qtyReceived to 0 when no receipts passed", () => {
    const drafts = [draft(1, 4, 1000, 2500, 9001, "frame")];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, [], idx, opts(30))[0];
    expect(r.qtyReceived).toBe(0);
    expect(r.qtyStockReceived).toBe(0);
    expect(r.qtySpecialReceived).toBe(0);
  });

  it("rolls receipts into the right frame bucket by productId", () => {
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"], // frame-mate variant
    ]);
    const receipts: PerformanceReceiptLine[] = [
      receipt(9001, 4),
      receipt(9002, 1),
      receipt(7777, 99), // out-of-scope product → ignored
    ];
    const r = computePerformance(drafts, [], idx, opts(30), receipts)[0];
    expect(r.qtyReceived).toBe(5);
  });

  it("splits receipts into stock vs special using stockProductIds", () => {
    // Drafted = 9001 only. Receipts include 9001 (stock) + 9002 (special).
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const idx: ProductFrameIndex = new Map([
      [9001, "frame"],
      [9002, "frame"],
    ]);
    const receipts: PerformanceReceiptLine[] = [receipt(9001, 4), receipt(9002, 2)];
    const r = computePerformance(
      drafts,
      [],
      idx,
      { daysSinceBuyExported: 30, stockProductIds: new Set([9001]) },
      receipts,
    )[0];
    expect(r.qtyReceived).toBe(6);
    expect(r.qtyStockReceived).toBe(4);
    expect(r.qtySpecialReceived).toBe(2);
  });

  it("treats all receipts as stock when stockProductIds is undefined (backward-compat)", () => {
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const r = computePerformance(drafts, [], idx, opts(30), [receipt(9001, 4)])[0];
    expect(r.qtyStockReceived).toBe(4);
    expect(r.qtySpecialReceived).toBe(0);
  });

  it("aggregates multiple receipts of the same productId (partial deliveries)", () => {
    // PON received in two passes: 3 units in week 1, 2 units in week 3.
    const drafts = [draft(1, 6, 1000, 2500, 9001, "frame")];
    const idx: ProductFrameIndex = new Map([[9001, "frame"]]);
    const receipts: PerformanceReceiptLine[] = [receipt(9001, 3), receipt(9001, 2)];
    const r = computePerformance(drafts, [], idx, opts(30), receipts)[0];
    expect(r.qtyReceived).toBe(5);
  });
});
