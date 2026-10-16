// /app/__tests__/placeTree.test.ts
//
// The pure walks of the places tree (lib/inventory/placeTree.ts): what is
// inside a place, the chain above it, and the order a screen lists them in.
// Stored data can hold a loop the writers would refuse; a walk never hangs on
// one.

import { ancestry, descendantIds, placePath, treeOrder } from "@/lib/inventory/placeTree";

const place = (id: number, parentId: number | null, name = `P${id}`, sortOrder = 0) => ({
  id,
  parentId,
  name,
  code: name,
  sortOrder,
});

// Barn(1) > Floor 2(2) > Sofas(3) > Shelf(4); Barn > Floor 1(5); Yard(6) on its own.
const tree = [
  place(1, null, "Barn"),
  place(2, 1, "Floor 2", 2),
  place(3, 2, "Sofas"),
  place(4, 3, "Shelf"),
  place(5, 1, "Floor 1", 1),
  place(6, null, "Yard"),
];

describe("descendantIds", () => {
  it("is everything inside, however deep, and not the place itself", () => {
    expect(descendantIds(tree, 1).sort()).toEqual([2, 3, 4, 5]);
    expect(descendantIds(tree, 3)).toEqual([4]);
    expect(descendantIds(tree, 6)).toEqual([]);
  });

  it("stops at a loop in stored data instead of hanging", () => {
    const loop = [place(1, 2), place(2, 1)];
    expect(descendantIds(loop, 1).sort()).toEqual([1, 2]);
  });
});

describe("ancestry and placePath", () => {
  it("runs from the top of the tree down to the place", () => {
    expect(ancestry(tree, 4).map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(placePath(tree, 4)).toBe("Barn › Floor 2 › Sofas › Shelf");
    expect(placePath(tree, 6)).toBe("Yard");
  });

  it("stops at a loop", () => {
    expect(ancestry([place(1, 2), place(2, 1)], 1).map((p) => p.id)).toEqual([2, 1]);
  });
});

describe("treeOrder", () => {
  it("lists each place followed by what is inside it, siblings by sort order", () => {
    expect(treeOrder(tree).map(({ place: p, depth }) => `${depth}:${p.name}`)).toEqual([
      "0:Barn",
      "1:Floor 1",
      "1:Floor 2",
      "2:Sofas",
      "3:Shelf",
      "0:Yard",
    ]);
  });

  it("shows a place whose parent is not in the list at the top", () => {
    const filtered = tree.filter((p) => p.id !== 2);
    expect(treeOrder(filtered).find((r) => r.place.id === 3)?.depth).toBe(0);
  });
});
