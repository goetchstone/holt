// /app/__tests__/splitSpaceBy.test.ts
//
// How the Stock and space report splits floor space (lib/reports/stockBy.ts):
// each unit counts toward its nearest measured place, a measured place's
// footage is shared by unit, an empty measured place is "Empty space", units
// with nothing measured above them are "Unmeasured units", and a measured
// place inside another is flagged as counting the same floor twice.

import { EMPTY_SPACE, splitSpaceBy, UNMEASURED } from "@/lib/reports/stockBy";

const place = (id: number, parentId: number | null, squareFootage: number | null = null) => ({
  id,
  parentId,
  squareFootage,
});

describe("splitSpaceBy", () => {
  it("shares a measured place's footage by unit share", () => {
    const { rows } = splitSpaceBy(
      [place(1, null, 1000)],
      [
        { placeId: 1, group: "Sofas", units: 3 },
        { placeId: 1, group: "Chairs", units: 1 },
      ],
    );
    expect(rows).toEqual([
      { group: "Sofas", units: 3, squareFeet: 750 },
      { group: "Chairs", units: 1, squareFeet: 250 },
    ]);
  });

  it("counts units in an unmeasured place toward the nearest measured place above it", () => {
    // Floor(1, 600 sq ft) > Bay(2, unmeasured) > Shelf(3, unmeasured)
    const { rows } = splitSpaceBy(
      [place(1, null, 600), place(2, 1), place(3, 2)],
      [
        { placeId: 3, group: "Rugs", units: 2 },
        { placeId: 1, group: "Tables", units: 1 },
      ],
    );
    expect(rows).toEqual([
      { group: "Rugs", units: 2, squareFeet: 400 },
      { group: "Tables", units: 1, squareFeet: 200 },
    ]);
  });

  it("reports an empty measured place as empty space and unplaced footage as unmeasured units", () => {
    const { rows } = splitSpaceBy(
      [place(1, null, 500), place(2, null, 300), place(3, null)],
      [
        { placeId: 1, group: "Sofas", units: 1 },
        { placeId: 3, group: "Sofas", units: 4 },
        { placeId: 3, group: "Lamps", units: 2.5 },
      ],
    );
    expect(rows).toEqual([
      { group: "Sofas", units: 5, squareFeet: 500 },
      { group: "Lamps", units: 2.5, squareFeet: 0 },
      { group: EMPTY_SPACE, units: 0, squareFeet: 300 },
      { group: UNMEASURED, units: 6.5, squareFeet: 0 },
    ]);
  });

  it("keeps part rolls exact", () => {
    const { rows } = splitSpaceBy(
      [place(1, null, 100)],
      [
        { placeId: 1, group: "Fabric", units: 12.625 },
        { placeId: 1, group: "Fabric", units: 0.375 },
      ],
    );
    expect(rows).toEqual([{ group: "Fabric", units: 13, squareFeet: 100 }]);
  });

  it("ignores rows with no units", () => {
    const { rows } = splitSpaceBy([place(1, null, 100)], [{ placeId: 1, group: "X", units: 0 }]);
    expect(rows).toEqual([{ group: EMPTY_SPACE, units: 0, squareFeet: 100 }]);
  });

  it("flags a measured place inside a measured place, naming the nearest one above", () => {
    // Building(1, 10000) > Floor(2) > Room(3, 400)
    const { doubleCounts } = splitSpaceBy(
      [place(1, null, 10000), place(2, 1), place(3, 2, 400)],
      [],
    );
    expect(doubleCounts).toEqual([{ placeId: 3, insideId: 1 }]);
    expect(splitSpaceBy([place(1, null, 100), place(2, 1)], []).doubleCounts).toEqual([]);
  });
});
