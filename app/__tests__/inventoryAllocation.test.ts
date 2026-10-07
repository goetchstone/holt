// /app/__tests__/inventoryAllocation.test.ts
//
// Pure arithmetic for src/lib/inventory/allocation.ts. `planDraw` is the one
// piece of the allocate-then-consume model that doesn't need a database --
// both allocate() (draw from free stock) and consume() (draw from an order's
// committed stock) delegate to it. Get this split wrong and a partial sale
// either takes more than a position holds or leaves a position untouched
// that should have been drawn down -- which is how inventory silently
// doubles (see the file header in allocation.ts).
//
// freePositionWhere()'s shape is asserted too: it's the single definition of
// "is this position free to sell," reused by allocate/availableQuantity/the
// warehouse-positions endpoint, so a regression here is a regression
// everywhere at once.

import { freePositionWhere, planDraw } from "@/lib/inventory/allocation";

describe("planDraw", () => {
  it("takes the exact amount from a single position, decrementing it", () => {
    const plan = planDraw([{ id: 1, quantity: 5 }], 2);
    expect(plan.steps).toEqual([{ id: 1, take: 2, exhausts: false }]);
    expect(plan.totalTaken).toBe(2);
    expect(plan.shortfall).toBe(0);
  });

  it("exhausts a position that is fully taken -- caller must delete, not decrement to zero", () => {
    const plan = planDraw([{ id: 1, quantity: 5 }], 5);
    expect(plan.steps).toEqual([{ id: 1, take: 5, exhausts: true }]);
    expect(plan.totalTaken).toBe(5);
    expect(plan.shortfall).toBe(0);
  });

  it("splits a position: qty 5 with 2 sold becomes 3 free + 2 allocated", () => {
    // This is the exact scenario called out as the easiest way to get this
    // module wrong: the position must be decremented (3 remain free), not
    // deleted, and not left at its original quantity while a duplicate
    // allocated row also claims 2.
    const plan = planDraw([{ id: 42, quantity: 5 }], 2);
    expect(plan.steps).toEqual([{ id: 42, take: 2, exhausts: false }]);
    expect(plan.totalTaken).toBe(2);
  });

  it("draws across multiple positions in order until satisfied", () => {
    const plan = planDraw(
      [
        { id: 1, quantity: 2 },
        { id: 2, quantity: 3 },
        { id: 3, quantity: 10 },
      ],
      4,
    );
    // Position 1 fully drained (exhausts), position 2 partially (take 2 of 3),
    // position 3 untouched.
    expect(plan.steps).toEqual([
      { id: 1, take: 2, exhausts: true },
      { id: 2, take: 2, exhausts: false },
    ]);
    expect(plan.totalTaken).toBe(4);
    expect(plan.shortfall).toBe(0);
  });

  it("reports a shortfall instead of erroring when total stock is insufficient", () => {
    // Overselling is allowed by design -- see PosView.tsx: "inventory never
    // blocks a sale." planDraw's job is only to report the gap, not enforce
    // a limit.
    const plan = planDraw(
      [
        { id: 1, quantity: 2 },
        { id: 2, quantity: 1 },
      ],
      10,
    );
    expect(plan.steps).toEqual([
      { id: 1, take: 2, exhausts: true },
      { id: 2, take: 1, exhausts: true },
    ]);
    expect(plan.totalTaken).toBe(3);
    expect(plan.shortfall).toBe(7);
  });

  it("returns an all-shortfall plan when there is no stock at all", () => {
    const plan = planDraw([], 5);
    expect(plan.steps).toEqual([]);
    expect(plan.totalTaken).toBe(0);
    expect(plan.shortfall).toBe(5);
  });

  it("is a no-op for a non-positive request -- never treated as unlimited or negative shortfall", () => {
    expect(planDraw([{ id: 1, quantity: 5 }], 0)).toEqual({
      steps: [],
      totalTaken: 0,
      shortfall: 0,
    });
    expect(planDraw([{ id: 1, quantity: 5 }], -3)).toEqual({
      steps: [],
      totalTaken: 0,
      shortfall: 0,
    });
  });

  it("skips zero-quantity positions in the draw order without erroring", () => {
    const plan = planDraw(
      [
        { id: 1, quantity: 0 },
        { id: 2, quantity: 4 },
      ],
      4,
    );
    expect(plan.steps).toEqual([{ id: 2, take: 4, exhausts: true }]);
  });

  it("stops drawing once satisfied, leaving later positions completely untouched", () => {
    const plan = planDraw(
      [
        { id: 1, quantity: 10 },
        { id: 2, quantity: 10 },
      ],
      3,
    );
    expect(plan.steps).toEqual([{ id: 1, take: 3, exhausts: false }]);
  });
});

describe("freePositionWhere", () => {
  it("filters on an explicit salesOrderId null check, not a `not`", () => {
    // Rule 51: salesOrderId is nullable; `not: <x>` on it would silently
    // drop NULL rows under three-valued logic. The free-stock filter must
    // read the column directly.
    const where = freePositionWhere();
    expect(where.salesOrderId).toBeNull();
    expect("not" in (where as Record<string, unknown>)).toBe(false);
  });

  it("excludes committed-stock locations by flag, with an explicit null branch for no-location rows", () => {
    // Rule 51 again, on the OTHER nullable column. stockLocationId is
    // nullable and a position with no stock location IS free, so the test
    // has to be a disjunction: `NOT: { stockLocation: {...} }` on a nullable
    // to-one relation conflates "the location doesn't hold committed stock"
    // with "there is no location".
    const where = freePositionWhere();
    expect(where.OR).toEqual([
      { stockLocationId: null },
      { stockLocation: { holdsCommittedStock: false } },
    ]);
    // No name matching anywhere: the Ordorite "Customer%" convention lives
    // in the Ordorite adapter now, not in shared inventory code (rule 61).
    expect(JSON.stringify(where)).not.toMatch(/customer/i);
    // And no bare NOT, which is what the flag replaced.
    expect(where.NOT).toBeUndefined();
  });
});
