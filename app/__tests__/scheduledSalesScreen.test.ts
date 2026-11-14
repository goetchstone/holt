// /app/__tests__/scheduledSalesScreen.test.ts
//
// GAP-06 part B: the pure pieces the Sales screen, the register and New Quote
// lean on -- building a sale's draft from previews (lib/pricing/salesShared.ts),
// the list's order, a store day as people read it, reading a product route's
// sale answer (lib/pos/cartPricing.ts catalogSale) and whether a line still
// shows it (lineSale), the cap on a draft (saleSizeProblem), and splitting a tag
// run into batch-print requests (lib/labels/batchPrintShared.ts).

import {
  addPreviewToItems,
  SALE_MAX_ITEMS,
  itemsToSave,
  parseSaleItems,
  saleDayText,
  saleSizeProblem,
  salesInListOrder,
  type SaleItemRow,
  type SalePreviewRow,
} from "@/lib/pricing/salesShared";
import { catalogSale, lineSale } from "@/lib/pos/cartPricing";
import { PRINT_BATCH_MAX_ITEMS, inBatches } from "@/lib/labels/batchPrintShared";

const row = (productId: number, over: Partial<SalePreviewRow> = {}): SalePreviewRow => ({
  productId,
  productNumber: `P-${productId}`,
  name: `Product ${productId}`,
  regularPrice: 100,
  salePrice: 80,
  skipped: null,
  overlaps: null,
  ...over,
});

const item = (productId: number, salePrice: number): SaleItemRow => ({
  productId,
  productNumber: `P-${productId}`,
  name: `Product ${productId}`,
  regularPrice: 100,
  salePrice,
});

describe("addPreviewToItems", () => {
  it("adds the priced rows and leaves the skipped ones out", () => {
    const items = addPreviewToItems(
      [],
      [row(1), row(2, { skipped: "OVERLAPS", overlaps: { id: 9, name: "Other" } }), row(3)],
    );
    expect(items.map((i) => i.productId)).toEqual([1, 3]);
    expect(items[0]).toEqual(item(1, 80));
  });

  it("gives a product already in the draft the new price, once", () => {
    const items = addPreviewToItems([item(1, 90), item(2, 70)], [row(1, { salePrice: 75 })]);
    expect(items).toEqual([item(1, 75), item(2, 70)]);
  });

  it("never adds a row with no sale price", () => {
    expect(addPreviewToItems([], [row(1, { salePrice: null, skipped: "NO_RETAIL" })])).toEqual([]);
  });
});

describe("itemsToSave", () => {
  it("sends each product's id and sale price, nothing else", () => {
    expect(itemsToSave([item(4, 50)])).toEqual([{ productId: 4, salePrice: 50 }]);
  });
});

describe("salesInListOrder", () => {
  it("lists sales on now, then upcoming, then ended, keeping the order within each", () => {
    const sales = [
      { id: 1, status: "ENDED" as const },
      { id: 2, status: "UPCOMING" as const },
      { id: 3, status: "ON" as const },
      { id: 4, status: "UPCOMING" as const },
    ];
    expect(salesInListOrder(sales).map((s) => s.id)).toEqual([3, 2, 4, 1]);
  });
});

describe("saleDayText", () => {
  it("reads a store day in the store's locale without shifting it", () => {
    expect(saleDayText("2026-11-30", "en-US")).toBe("Nov 30, 2026");
    expect(saleDayText("2026-11-30", "en-GB")).toBe("30 Nov 2026");
  });

  it("is blank for no day or a value that isn't one", () => {
    expect(saleDayText(null, "en-US")).toBe("");
    expect(saleDayText("not a day", "en-US")).toBe("");
  });
});

describe("catalogSale", () => {
  it("is the regular price and last day while the route says the product is on sale", () => {
    expect(
      catalogSale({ baseRetail: 80, regularRetail: 100, onSale: true, saleEndsOn: "2026-11-30" }),
    ).toEqual({ salePrice: 80, regularPrice: 100, endsOn: "2026-11-30" });
  });

  it("is null off sale, or when the route's answer isn't a saving", () => {
    expect(catalogSale({ baseRetail: 100, regularRetail: 100, onSale: false })).toBeNull();
    // The route's word decides, never a comparison made here.
    expect(catalogSale({ baseRetail: 80, regularRetail: 100, onSale: false })).toBeNull();
    expect(catalogSale({ baseRetail: 100 })).toBeNull();
    expect(catalogSale({ baseRetail: 100, regularRetail: 90, onSale: true })).toBeNull();
    expect(catalogSale({ baseRetail: 80, regularRetail: null, onSale: true })).toBeNull();
  });

  it("reads the strings a Decimal serializes to", () => {
    expect(catalogSale({ baseRetail: "80.00", regularRetail: "100.00", onSale: true })).toEqual({
      salePrice: 80,
      regularPrice: 100,
      endsOn: null,
    });
  });
});

describe("lineSale", () => {
  const sale = { salePrice: 800, regularPrice: 1000, endsOn: "2026-11-30" };

  it("shows the sale while the line is at the sale price it was added at", () => {
    expect(lineSale(800, sale)).toBe(sale);
    expect(lineSale(800.001, sale)).toBe(sale);
  });

  it("drops it once another price is typed over the line, below or above the regular", () => {
    expect(lineSale(950, sale)).toBeNull();
    expect(lineSale(1100, sale)).toBeNull();
    expect(lineSale(799.99, sale)).toBeNull();
  });

  it("is null for a line added off sale", () => {
    expect(lineSale(800, null)).toBeNull();
    expect(lineSale(800, undefined)).toBeNull();
  });
});

describe("saleSizeProblem", () => {
  it("is nothing up to the cap, and says what to remove past it, in the sale's own words", () => {
    expect(saleSizeProblem(SALE_MAX_ITEMS)).toBeNull();
    const problem = saleSizeProblem(SALE_MAX_ITEMS + 500);
    expect(problem).toBe(
      `A sale takes at most ${SALE_MAX_ITEMS} products; this one has ${SALE_MAX_ITEMS + 500}. Remove 500 before saving.`,
    );
    expect(problem).not.toMatch(/mass price change|filter/);
  });

  it("is the refusal the save routes give a draft over the cap", () => {
    const items = Array.from({ length: SALE_MAX_ITEMS + 1 }, (_, i) => ({
      productId: i + 1,
      salePrice: 10,
    }));
    expect(parseSaleItems(items)).toEqual({
      ok: false,
      error: saleSizeProblem(SALE_MAX_ITEMS + 1),
    });
  });
});

describe("inBatches", () => {
  it("splits a run into requests the batch route takes, in order", () => {
    const ids = Array.from({ length: PRINT_BATCH_MAX_ITEMS * 2 + 1 }, (_, i) => i + 1);
    const batches = inBatches(ids);
    expect(batches.map((b) => b.length)).toEqual([PRINT_BATCH_MAX_ITEMS, PRINT_BATCH_MAX_ITEMS, 1]);
    expect(batches.flat()).toEqual(ids);
  });

  it("sends nothing for nothing", () => {
    expect(inBatches([])).toEqual([]);
  });
});
