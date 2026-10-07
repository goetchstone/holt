// /app/__tests__/poSellThrough.test.ts
//
// Pure tests for the PO Sell-Thru per-line receive-date windowing. No I/O.

import {
  buildProductWindowStarts,
  windowSalesByReceipt,
  realizedRetailByFrame,
} from "@/lib/reports/poSellThrough";
// Lives in the data-assembly module; tested here alongside the windowing math
// since both back the same report. Pure — Prisma is a type-only import there.
import { parsePoNumbers } from "@/lib/reports/poSellThru";

const d = (iso: string) => new Date(iso);

describe("buildProductWindowStarts", () => {
  // Frame "F" has stock products 1 (recv Mar 1) and 2 (recv Jan 1); product 3
  // is a frame-mate (special) variant of F with no receipt of its own.
  // Product 9 belongs to frame "G" which has NO stock receipt at all.
  const productToFrame = new Map<number, string>([
    [1, "F"],
    [2, "F"],
    [3, "F"],
    [9, "G"],
  ]);

  it("windows each stock product from its OWN earliest receipt", () => {
    const w = buildProductWindowStarts(
      [
        { productId: 1, receivedDate: d("2026-03-01") },
        { productId: 1, receivedDate: d("2026-04-15") }, // later partial receipt
        { productId: 2, receivedDate: d("2026-01-01") },
      ],
      productToFrame,
    );
    expect(w.get(1)).toEqual(d("2026-03-01")); // earliest of its own receipts
    expect(w.get(2)).toEqual(d("2026-01-01"));
  });

  it("windows a special frame-mate from the frame's EARLIEST stock receipt", () => {
    const w = buildProductWindowStarts(
      [
        { productId: 1, receivedDate: d("2026-03-01") },
        { productId: 2, receivedDate: d("2026-01-01") },
      ],
      productToFrame,
    );
    // product 3 has no receipt of its own -> inherits frame F's earliest (Jan 1)
    expect(w.get(3)).toEqual(d("2026-01-01"));
  });

  it("gives no window to products whose frame had no stock receipt", () => {
    const w = buildProductWindowStarts(
      [{ productId: 1, receivedDate: d("2026-03-01") }],
      productToFrame,
    );
    expect(w.has(9)).toBe(false); // frame G never received
  });
});

describe("windowSalesByReceipt", () => {
  const windows = new Map<number, Date>([
    [1, d("2026-03-01")],
    [3, d("2026-01-01")],
  ]);

  it("keeps sales on or after the product's window start", () => {
    const sales = [
      { productId: 1, orderDate: d("2026-03-01") }, // exactly on start -> keep
      { productId: 1, orderDate: d("2026-05-10") }, // after -> keep
      { productId: 3, orderDate: d("2026-02-02") }, // after F-inherited start -> keep
    ];
    expect(windowSalesByReceipt(sales, windows)).toHaveLength(3);
  });

  it("drops sales before the window start", () => {
    const sales = [{ productId: 1, orderDate: d("2026-02-28") }];
    expect(windowSalesByReceipt(sales, windows)).toHaveLength(0);
  });

  it("drops sales of products with no window (frame not in PO selection)", () => {
    const sales = [{ productId: 99, orderDate: d("2026-06-01") }];
    expect(windowSalesByReceipt(sales, windows)).toHaveLength(0);
  });

  it("drops sales with a null/undefined orderDate", () => {
    const sales = [
      { productId: 1, orderDate: null },
      { productId: 1, orderDate: undefined },
    ];
    expect(windowSalesByReceipt(sales, windows)).toHaveLength(0);
  });
});

describe("realizedRetailByFrame", () => {
  const productToFrame = new Map<number, string>([
    [1, "F"],
    [2, "F"],
    [9, "G"],
  ]);
  const baseRetail = new Map<number, number>([
    [1, 1000],
    [2, 500],
    [9, 0], // no list price -> excluded
  ]);

  it("accumulates actual revenue and full-list per frame over priced units", () => {
    const sales = [
      { productId: 1, qty: 1, netPrice: 1000 }, // full price
      { productId: 2, qty: 2, netPrice: 800 }, // list 2x500=1000, sold 800 -> discounted
    ];
    const r = realizedRetailByFrame(sales, productToFrame, baseRetail);
    expect(r.get("F")).toEqual({ soldRevenue: 1800, fullRetail: 2000 });
    // realized ratio the caller computes = 1800/2000 = 0.9 (10% off list)
  });

  it("excludes units whose product has no/zero baseRetail (can't judge vs list)", () => {
    const sales = [{ productId: 9, qty: 1, netPrice: 300 }];
    expect(realizedRetailByFrame(sales, productToFrame, baseRetail).has("G")).toBe(false);
  });

  it("ignores sales whose product isn't in any in-scope frame", () => {
    const sales = [{ productId: 77, qty: 1, netPrice: 100 }];
    expect(realizedRetailByFrame(sales, productToFrame, baseRetail).size).toBe(0);
  });
});

describe("parsePoNumbers (input parsing for the report)", () => {
  it("splits on commas, trims, dedupes, and drops empties", () => {
    expect(parsePoNumbers(" PO-1042, PO-1055 ,, PO-1042 ")).toEqual(["PO-1042", "PO-1055"]);
  });

  it("returns empty for blank input", () => {
    expect(parsePoNumbers("   ")).toEqual([]);
  });
});
