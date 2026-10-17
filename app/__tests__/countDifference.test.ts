// /app/__tests__/countDifference.test.ts
//
// What posting a count moves (lib/inventory/count.ts countDifference).

import { countDifference } from "@/lib/inventory/count";

const book = [
  { productId: 1, free: 3, committed: 0 },
  { productId: 2, free: 1, committed: 2 },
];

describe("countDifference", () => {
  it("a place count says what is not there: an uncounted product on the books was counted absent", () => {
    const d = countDifference([{ productId: 1, counted: 3 }], book, "PLACE");
    expect(d).toEqual([
      {
        productId: 1,
        counted: 3,
        expected: 3,
        difference: 0,
        addFree: 0,
        removeFree: 0,
        removeCommitted: 0,
      },
      {
        productId: 2,
        counted: 0,
        expected: 3,
        difference: -3,
        addFree: 0,
        removeFree: 1,
        removeCommitted: 2,
      },
    ]);
  });

  it("a quick count speaks only for what it lists", () => {
    expect(countDifference([{ productId: 1, counted: 5 }], book, "PRODUCTS")).toEqual([
      {
        productId: 1,
        counted: 5,
        expected: 3,
        difference: 2,
        addFree: 2,
        removeFree: 0,
        removeCommitted: 0,
      },
    ]);
  });

  it("takes free stock before committed, and adds a product the books did not have", () => {
    const d = countDifference(
      [
        { productId: 2, counted: 2 },
        { productId: 9, counted: 1.5 },
      ],
      book,
      "PLACE",
    );
    expect(d.find((x) => x.productId === 2)).toMatchObject({ removeFree: 1, removeCommitted: 0 });
    expect(d.find((x) => x.productId === 9)).toMatchObject({ expected: 0, addFree: 1.5 });
    expect(d.find((x) => x.productId === 1)).toMatchObject({ removeFree: 3 });
  });

  it("adds up lines for the same product", () => {
    expect(
      countDifference(
        [
          { productId: 1, counted: 1 },
          { productId: 1, counted: 2 },
        ],
        book,
        "PRODUCTS",
      )[0].counted,
    ).toBe(3);
  });
});
