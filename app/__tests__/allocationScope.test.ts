// /app/__tests__/allocationScope.test.ts
//
// allocationTiers: the order an order line draws free stock in. Back stock
// before floor models; the order's own store before the store it is fulfilled
// from; and a take-with line only at its own store, the floor piece first --
// the customer leaves with the piece in front of them.

import { allocationTiers } from "@/lib/inventory/allocation";

describe("allocationTiers", () => {
  it("draws back stock in reach first, own store first, floor models last", () => {
    expect(allocationTiers({ storeLocationId: 1, fulfilmentStoreLocationId: 9 }, false)).toEqual([
      { storeLocationId: 1, floor: false },
      { storeLocationId: 9, floor: false },
      { storeLocationId: 1, floor: true },
      { storeLocationId: 9, floor: true },
    ]);
  });

  it("with no fulfilment store, stays at its own store", () => {
    expect(allocationTiers({ storeLocationId: 1, fulfilmentStoreLocationId: null }, false)).toEqual(
      [
        { storeLocationId: 1, floor: false },
        { storeLocationId: 1, floor: true },
      ],
    );
  });

  it("a fulfilment store pointing at itself adds nothing", () => {
    expect(
      allocationTiers({ storeLocationId: 1, fulfilmentStoreLocationId: 1 }, false),
    ).toHaveLength(2);
  });

  it("take-with: own store only, the floor piece first", () => {
    expect(allocationTiers({ storeLocationId: 1, fulfilmentStoreLocationId: 9 }, true)).toEqual([
      { storeLocationId: 1, floor: true },
      { storeLocationId: 1, floor: false },
    ]);
  });
});
