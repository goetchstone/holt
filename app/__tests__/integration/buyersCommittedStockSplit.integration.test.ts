// /app/__tests__/integration/buyersCommittedStockSplit.integration.test.ts
//
// The Buyers Report's floor-stock vs customer-stock split, against real
// Postgres, because the split IS raw SQL (`getBuyersSummary` query 1 and
// `getBuyersPositions`) and nothing short of a database exercises it.
//
// Until 2026-08 that SQL asked `sl.name ILIKE 'customer%'` -- an Ordorite /
// Saybrook location-naming convention hardcoded into shared reporting code.
// Any deployment that named its holding locations anything else had its
// committed stock counted as available to sell (CLAUDE.md rule 61). It now
// reads `StockLocation.holdsCommittedStock`.
//
// The fixture is deliberately INVERTED against the old heuristic:
//
//   "Warehouse B"        + holdsCommittedStock -> must be customer stock
//   "Customer Overflow"  + no flag             -> must be floor stock
//
// so a surviving `ILIKE 'customer%'` anywhere in the query flips both
// numbers and the test fails. A same-name-same-flag fixture would pass
// against either implementation and prove nothing.
//
// Also pins the LEFT JOIN's NULL case: a position with no stock location at
// all is floor stock, not committed. `sl."holdsCommittedStock"` is NULL for
// those rows, and an un-COALESCEd NULL in the CASE would silently move them.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { getBuyersPositions, getBuyersSummary } from "@/lib/reports/buyersReport";

async function seed() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  // Flagged, but named nothing like "Customer".
  const committed = await prisma.stockLocation.create({
    data: {
      storeLocationId: store.id,
      code: "HOLD",
      name: "Warehouse B",
      holdsCommittedStock: true,
    },
  });
  // Named exactly like the old heuristic's target, but NOT flagged.
  const decoy = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "CUST", name: "Customer Overflow" },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "P1",
      name: "Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
    },
  });
  return { store, committed, decoy, product };
}

const RANGE = { startDate: "2026-01-01", endDate: "2026-12-31" };

describe("Buyers Report committed-stock split (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("splits on the flag, not the location name", async () => {
    const { store, committed, decoy, product } = await seed();
    await prisma.inventoryPosition.create({
      data: {
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: committed.id,
        quantity: 6,
      },
    });
    await prisma.inventoryPosition.create({
      data: {
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: decoy.id,
        quantity: 4,
      },
    });

    const summary = await getBuyersSummary(prisma, RANGE);

    // Under the old name heuristic these would be exactly reversed.
    expect(summary.totals.onHand).toBe(4);
    expect(summary.totals.customerStock).toBe(6);
  });

  it("counts a position with no stock location as floor stock (LEFT JOIN NULL)", async () => {
    const { store, committed, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, quantity: 5 },
    });
    await prisma.inventoryPosition.create({
      data: {
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: committed.id,
        quantity: 2,
      },
    });

    const summary = await getBuyersSummary(prisma, RANGE);

    expect(summary.totals.onHand).toBe(5);
    expect(summary.totals.customerStock).toBe(2);
  });

  it("flags the same way in the per-product location breakdown", async () => {
    const { store, committed, decoy, product } = await seed();
    await prisma.inventoryPosition.create({
      data: {
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: committed.id,
        quantity: 6,
      },
    });
    await prisma.inventoryPosition.create({
      data: {
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: decoy.id,
        quantity: 4,
      },
    });
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, quantity: 1 },
    });

    const positions = await getBuyersPositions(prisma, product.id);

    expect(positions.totalFloor).toBe(5);
    expect(positions.totalCustomer).toBe(6);

    // Per row: a flagged location reports its quantity as customerQty, an
    // unflagged one as floorQty -- again, inverted against the old names.
    const byName = new Map(positions.positions.map((p) => [p.locationName ?? "(none)", p]));
    expect(byName.get("Warehouse B")).toMatchObject({ floorQty: 0, customerQty: 6 });
    expect(byName.get("Customer Overflow")).toMatchObject({ floorQty: 4, customerQty: 0 });
    expect(byName.get("(none)")).toMatchObject({ floorQty: 1, customerQty: 0 });
  });

  it("flipping the flag moves the stock between the two columns", async () => {
    // The admin-facing behaviour the flag exists for: a deployment that
    // doesn't use Ordorite naming can now classify its own locations.
    const { store, decoy, product } = await seed();
    await prisma.inventoryPosition.create({
      data: {
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: decoy.id,
        quantity: 9,
      },
    });

    const before = await getBuyersSummary(prisma, RANGE);
    expect(before.totals.onHand).toBe(9);
    expect(before.totals.customerStock).toBe(0);

    await prisma.stockLocation.update({
      where: { id: decoy.id },
      data: { holdsCommittedStock: true },
    });

    const after = await getBuyersSummary(prisma, RANGE);
    expect(after.totals.onHand).toBe(0);
    expect(after.totals.customerStock).toBe(9);
  });
});
