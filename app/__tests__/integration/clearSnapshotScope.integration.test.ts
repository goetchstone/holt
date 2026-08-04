// /app/__tests__/integration/clearSnapshotScope.integration.test.ts
//
// Real-DB coverage for POST /api/inventory/clear-snapshot.
//
// The behaviour under test only became necessary when InventorySnapshot gained
// a second writer. It used to be filled solely by the POS CSV importer, so the
// importer's "clear before upload" step and "delete everything" were the same
// statement. Once the baseline could also be GENERATED from holt's own
// InventoryPosition, that unscoped delete meant uploading a POS file silently
// destroyed the locally generated snapshot -- and a physical count would then
// be measured against whatever the POS happened to know, which is precisely
// the coupling the local-snapshot work existed to remove.
//
// A mocked-Prisma test cannot prove this: the whole claim is about which rows
// survive a real `deleteMany` with a real enum filter.
//
// Calls the exported handlePost directly with a fake req/res + session, the
// same pattern as inventorySnapshotGenerate.integration.test.ts --
// requireAuthWithRole needs real cookies, and role enforcement is covered by
// __tests__/roleDecision.test.ts.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handlePost } from "@/pages/api/inventory/clear-snapshot";

function makeReq(body: unknown = {}): NextApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { method: "POST", query: {}, body } as any;
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

const adminSession = { user: { email: "admin@example.com" } } as unknown as Session;

async function seedBothSources() {
  const vendor = await prisma.vendor.create({ data: { name: "Test Vendor", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Store A", code: "STORE-A", type: "STORE" },
  });

  const local = await prisma.product.create({
    data: {
      productNumber: "NATIVE-1",
      name: "Native Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
    },
  });
  const imported = await prisma.product.create({
    data: {
      productNumber: "IMPORTED-1",
      name: "Imported Chair",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
      externalId: 555,
    },
  });

  // Distinct snapshotDates so the (snapshotDate, productId, storeLocationId)
  // unique key can't be what separates them -- `source` has to be doing the
  // work.
  await prisma.inventorySnapshot.create({
    data: {
      productId: local.id,
      storeLocationId: store.id,
      quantity: 4,
      snapshotDate: new Date("2026-08-01T00:00:00Z"),
      source: "LOCAL",
    },
  });
  await prisma.inventorySnapshot.create({
    data: {
      productId: imported.id,
      storeLocationId: store.id,
      quantity: 9,
      snapshotDate: new Date("2026-08-02T00:00:00Z"),
      source: "IMPORT",
      externalId: 555,
      externalStockLocation: "MAIN",
    },
  });

  return { store, local, imported };
}

async function sourcesInDb(): Promise<string[]> {
  const rows = await prisma.inventorySnapshot.findMany({ select: { source: true } });
  return rows.map((r) => r.source).sort();
}

describe("POST /api/inventory/clear-snapshot (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("clearing IMPORT leaves the locally generated baseline intact", async () => {
    // The regression that motivated the change: this is what the POS import
    // page sends before every upload.
    await seedBothSources();
    expect(await sourcesInDb()).toEqual(["IMPORT", "LOCAL"]);

    const res = makeRes();
    await handlePost(makeReq({ source: "IMPORT" }), res, adminSession);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ deleted: 1, scope: "IMPORT" });
    expect(await sourcesInDb()).toEqual(["LOCAL"]);
  });

  it("clearing LOCAL leaves an imported snapshot intact", async () => {
    await seedBothSources();

    const res = makeRes();
    await handlePost(makeReq({ source: "LOCAL" }), res, adminSession);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ deleted: 1, scope: "LOCAL" });
    expect(await sourcesInDb()).toEqual(["IMPORT"]);
  });

  it("omitting source still clears everything — the deliberate start-over", async () => {
    await seedBothSources();

    const res = makeRes();
    await handlePost(makeReq({}), res, adminSession);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ deleted: 2, scope: "ALL" });
    expect(await sourcesInDb()).toEqual([]);
  });

  it("reports the deleted count rather than a fixed success message", async () => {
    // The old handler always said "cleared successfully", so an operator could
    // not tell a 40k-row wipe from a no-op.
    const res = makeRes();
    await handlePost(makeReq({ source: "IMPORT" }), res, adminSession);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ deleted: 0 });
    expect((res.body as { message: string }).message).toMatch(/No IMPORT snapshot rows to clear/);
  });

  it("rejects an unrecognised source instead of guessing", async () => {
    // Guessing here means silently widening the blast radius: a typo'd scope
    // must not fall back to deleting everything.
    await seedBothSources();

    const res = makeRes();
    await handlePost(makeReq({ source: "EVERYTHING" }), res, adminSession);

    expect(res.statusCode).toBe(400);
    expect(await sourcesInDb()).toEqual(["IMPORT", "LOCAL"]);
  });
});
