// /app/__tests__/boxes.test.ts
//
// Boxes are evidence, never a quantity (lib/inventory/boxes.ts): box scans
// assemble into whole units, and what is left is incomplete sets.

import { assembleUnits, BoxError, boxNumbers, stillMissing } from "@/lib/inventory/boxes";

describe("assembleUnits", () => {
  it("makes whole units from complete sets of boxes, in any order", () => {
    expect(assembleUnits(3, [3, 1, 2, 2, 3, 1])).toEqual({ units: 2, incomplete: [] });
  });

  it("leaves partial units as incomplete sets, most complete first", () => {
    expect(assembleUnits(3, [1, 1, 2, 3, 1, 2])).toEqual({
      units: 1,
      incomplete: [
        { present: [1, 2], missing: [3] },
        { present: [1], missing: [2, 3] },
      ],
    });
  });

  it("treats a one-box product's every scan as a unit", () => {
    expect(assembleUnits(1, [1, 1, 1])).toEqual({ units: 3, incomplete: [] });
    expect(assembleUnits(0, [])).toEqual({ units: 0, incomplete: [] });
  });

  it("refuses a box number the product does not have", () => {
    expect(() => assembleUnits(2, [1, 3])).toThrow(BoxError);
  });
});

describe("stillMissing", () => {
  it("takes arrived boxes off what a set misses", () => {
    expect(stillMissing([2, 3], [3])).toEqual([2]);
    expect(stillMissing([2, 3], [2, 3])).toEqual([]);
    expect(() => stillMissing([3], [2])).toThrow("not one this set is missing");
  });

  it("numbers boxes from 1", () => {
    expect(boxNumbers(3)).toEqual([1, 2, 3]);
  });
});
