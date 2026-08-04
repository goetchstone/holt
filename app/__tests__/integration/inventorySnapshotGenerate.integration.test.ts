// /app/__tests__/integration/inventorySnapshotGenerate.integration.test.ts
//
// Real-DB coverage for POST /api/inventory/snapshot/generate (Step 1 of a
// physical count, sourced from holt's own data -- see that file's header for
// the "why"). Proves two things a mocked-Prisma test can't:
//
//   1. The generated InventorySnapshot rows actually include a product that
//      has no externalId -- i.e. this is really fixed, not just recompiling.
//      The whole point of this migration was that native-born products were
//      silently absent from their own count.
//   2. Same-day re-run is idempotent: it replaces today's LOCAL rows rather
//      than crashing on the (snapshotDate, productId, storeLocationId)
//      unique constraint or leaving stale + fresh rows mixed together.
//
// Calls the exported handlePost directly against the real `prisma` client
// with a fake req/res + session (same pattern as
// __tests__/integration/tillVarianceEnforcement.integration.test.ts) --
// bypasses requireAuthWithRole, which needs real cookies; role enforcement
// itself is covered by __tests__/roleDecision.test.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handlePost } from "@/pages/api/inventory/snapshot/generate";

function makeReq(): NextApiRequest {
  return {
    method: "POST",
    query: {},
    body: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRes() {
  const res = {
    statusCode: 0 as number,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as NextApiResponse & { statusCode: number; body: unknown };
  return res;
}

const managerSession = { user: { email: "manager@example.com" } } as unknown as Session;

async function seedCatalog() {
  const vendor = await prisma.vendor.create({ data: { name: "Test Vendor", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const storeA = await prisma.storeLocation.create({
    data: { name: "Store A", code: "STORE-A", type: "STORE" },
  });
  const storeB = await prisma.storeLocation.create({
    data: { name: "Store B", code: "STORE-B", type: "STORE" },
  });

  // Native-born product: created in holt, never imported from the POS --
  // no externalId. This is exactly the product shape the old
  // externalId-keyed InventorySnapshot silently excluded.
  const nativeProduct = await prisma.product.create({
    data: { productNumber: "NATIVE-1", name: "Native Sofa", vendorId: vendor.id, departmentId: dept.id, categoryId: cat.id },
  });
  // POS-imported product, for contrast.
  const importedProduct = await prisma.product.create({
    data: {
      productNumber: "IMPORTED-1",
      name: "Imported Chair",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
      externalId: 555,
    },
  });

  return { vendor, dept, cat, storeA, storeB, nativeProduct, importedProduct };
}

describe("POST /api/inventory/snapshot/generate (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("generates LOCAL snapshot rows from InventoryPosition, including a product with no externalId", async () => {
    const { storeA, storeB, nativeProduct, importedProduct } = await seedCatalog();

    await prisma.inventoryPosition.createMany({
      data: [
        { productId: nativeProduct.id, storeLocationId: storeA.id, quantity: 4 },
        { productId: importedProduct.id, storeLocationId: storeA.id, quantity: 6 },
        { productId: importedProduct.id, storeLocationId: storeB.id, quantity: 2 },
        // Zero/negative positions are not stock on the floor -- excluded.
        { productId: nativeProduct.id, storeLocationId: storeB.id, quantity: 0 },
      ],
    });

    const req = makeReq();
    const res = makeRes();
    await handlePost(req, res, managerSession);

    expect(res.statusCode).toBe(201);
    const body = res.body as { products: number; units: number; stores: number };
    expect(body.products).toBe(2);
    expect(body.units).toBe(12); // 4 + 6 + 2
    expect(body.stores).toBe(2);

    const rows = await prisma.inventorySnapshot.findMany({ orderBy: { productId: "asc" } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "LOCAL")).toBe(true);
    expect(rows.every((r) => r.createdBy === "manager@example.com")).toBe(true);
    // externalId/externalStockLocation are IMPORT-only provenance -- LOCAL
    // rows carry neither, regardless of whether the underlying product has
    // a POS externalId.
    expect(rows.every((r) => r.externalId === null)).toBe(true);

    const nativeRow = rows.find((r) => r.productId === nativeProduct.id);
    expect(nativeRow).toBeDefined();
    expect(nativeRow?.storeLocationId).toBe(storeA.id);
    expect(nativeRow?.quantity).toBe(4);
  });

  it("a same-day re-run replaces LOCAL rows instead of duplicating or crashing", async () => {
    const { storeA, nativeProduct, importedProduct } = await seedCatalog();

    await prisma.inventoryPosition.create({
      data: { productId: nativeProduct.id, storeLocationId: storeA.id, quantity: 4 },
    });
    await handlePost(makeReq(), makeRes(), managerSession);
    expect(await prisma.inventorySnapshot.count()).toBe(1);

    // Inventory moves during the day (e.g. a receiving event, or a mapping
    // fix); the count should reflect current data on a re-run, not stack up
    // stale rows next to fresh ones.
    await prisma.inventoryPosition.create({
      data: { productId: importedProduct.id, storeLocationId: storeA.id, quantity: 9 },
    });

    const res2 = makeRes();
    await handlePost(makeReq(), res2, managerSession);

    expect(res2.statusCode).toBe(201);
    const rows = await prisma.inventorySnapshot.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, r) => sum + r.quantity, 0)).toBe(13);
  });

  it("IMPORT-source rows from a prior POS cutover import are left untouched", async () => {
    const { storeA, nativeProduct } = await seedCatalog();

    await prisma.inventorySnapshot.create({
      data: {
        productId: nativeProduct.id,
        storeLocationId: storeA.id,
        quantity: 999,
        source: "IMPORT",
        externalId: 4242,
        externalStockLocation: "Some POS Location",
      },
    });

    await prisma.inventoryPosition.create({
      data: { productId: nativeProduct.id, storeLocationId: storeA.id, quantity: 4 },
    });
    await handlePost(makeReq(), makeRes(), managerSession);

    const rows = await prisma.inventorySnapshot.findMany();
    expect(rows).toHaveLength(2);
    const importRow = rows.find((r) => r.source === "IMPORT");
    expect(importRow?.quantity).toBe(999);
    expect(importRow?.externalId).toBe(4242);
    const localRow = rows.find((r) => r.source === "LOCAL");
    expect(localRow?.quantity).toBe(4);
  });
});
