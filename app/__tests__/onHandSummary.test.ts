// /app/__tests__/onHandSummary.test.ts
//
// The register's "on hand here" figures. /api/warehouse/positions sends each
// row's store as `locationName`; the register read `storeLocation.name`, which
// the route does not send, so every row was skipped and every line read 0.

import { onHandByStore } from "@/lib/inventory/onHandSummary";

describe("onHandByStore", () => {
  it("folds the positions route's rows by the store name it actually sends", () => {
    expect(
      onHandByStore([
        { locationName: "Showroom", quantity: 2 },
        { locationName: "Warehouse", quantity: 12.625 },
        { locationName: "Showroom", quantity: 1 },
      ]),
    ).toEqual([
      { locationName: "Showroom", available: 3 },
      { locationName: "Warehouse", available: 12.625 },
    ]);
  });

  it("adds part rolls without float noise", () => {
    expect(
      onHandByStore([
        { locationName: "Mill", quantity: 0.1 },
        { locationName: "Mill", quantity: 0.2 },
      ]),
    ).toEqual([{ locationName: "Mill", available: 0.3 }]);
  });

  it("skips rows with no store name or nothing in them", () => {
    expect(
      onHandByStore([
        { locationName: null, quantity: 4 },
        { locationName: "Showroom", quantity: 0 },
      ]),
    ).toEqual([]);
  });
});
