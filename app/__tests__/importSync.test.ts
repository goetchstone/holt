// /app/__tests__/importSync.test.ts
//
// planImportSync: a POS stock file, turned into one physical target per place.
// The rules it encodes are the ones the old per-row writer got wrong: two POS
// names aliased to one place overwrote each other instead of adding, a zero row
// was skipped instead of zeroing the place, and a product the file no longer
// listed at a place it covers kept its old quantity forever.

import { planImportSync, type ImportStockRow } from "@/lib/inventory/importSync";

const row = (over: Partial<ImportStockRow>): ImportStockRow => ({
  productId: 1,
  storeLocationId: 10,
  stockLocationId: 100,
  quantity: 1,
  ...over,
});

const byPlace = (targets: ReturnType<typeof planImportSync>) =>
  Object.fromEntries(targets.map((t) => [`${t.productId}@${t.stockLocationId}`, t.physical]));

describe("planImportSync", () => {
  it("adds rows that land on one place instead of letting the last one win", () => {
    const targets = planImportSync([row({ quantity: 3 }), row({ quantity: 2.5 })], []);
    expect(byPlace(targets)).toEqual({ "1@100": 5.5 });
  });

  it("reads a negative on-hand as nothing before adding", () => {
    const targets = planImportSync([row({ quantity: 4 }), row({ quantity: -6 })], []);
    expect(byPlace(targets)).toEqual({ "1@100": 4 });
  });

  it("a zero row zeroes its place rather than being skipped", () => {
    expect(byPlace(planImportSync([row({ quantity: 0 })], []))).toEqual({ "1@100": 0 });
  });

  it("zeroes a product the file leaves out at a place it covers", () => {
    const targets = planImportSync(
      [row({ productId: 1, quantity: 2 })],
      [
        { productId: 2, storeLocationId: 10, stockLocationId: 100 },
        // A place the file never mentions: not covered, not touched.
        { productId: 3, storeLocationId: 10, stockLocationId: 200 },
      ],
    );
    expect(byPlace(targets)).toEqual({ "1@100": 2, "2@100": 0 });
  });

  it("names every POS location an unmatched place's units came from", () => {
    const targets = planImportSync(
      [
        row({ stockLocationId: 900, quantity: 1, unmatchedName: "Annex" }),
        row({ stockLocationId: 900, quantity: 2, unmatchedName: "Attic" }),
        row({ stockLocationId: 900, quantity: 1, unmatchedName: "Annex" }),
      ],
      [],
    );
    expect(targets).toEqual([
      expect.objectContaining({ physical: 4, note: "Unmatched CSV location: Annex, Attic" }),
    ]);
  });

  it("leaves a matched place's note alone", () => {
    expect(planImportSync([row({})], [])[0].note).toBeUndefined();
  });

  it("ignores a row whose quantity is not a number", () => {
    expect(planImportSync([row({ quantity: Number.NaN })], [])).toEqual([]);
  });
});
