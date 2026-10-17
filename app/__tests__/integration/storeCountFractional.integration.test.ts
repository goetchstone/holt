// /app/__tests__/integration/storeCountFractional.integration.test.ts
//
// The store-grain count (the POS cutover check) keeps a part
// roll's count, against real Postgres:
//
//   - a count of 12.5 yards is stored and sent back as 12.5, a number;
//   - a count that is not a number, or is negative, is refused; zero is a count;
//   - the variance report sums scans to the stock precision, so 0.1 + 0.2
//     counted against 0.3 expected is accurate, not a variance;
//   - reconciling a part roll keeps its fractions, and the reconciled-items
//     list and scan history send numbers.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { clearLocationCache } from "@/lib/storeLocationResolver";
import { handler as countHandler } from "@/pages/api/inventory/physical-count";
import { handler as historyHandler } from "@/pages/api/inventory/scan-history";
import { handler as varianceHandler } from "@/pages/api/inventory/variance-report";
import { handler as accurateHandler } from "@/pages/api/inventory/accurate-scans";
import { handler as reconcileHandler } from "@/pages/api/inventory/reconcile";
import { handler as reconciledHandler } from "@/pages/api/inventory/reconciled-items";

function makeReq(method: string, query: Record<string, string>, body: unknown = {}) {
  return { method, query, body, headers: {} } as unknown as NextApiRequest;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: any };
}

async function world() {
  const user = await prisma.user.create({ data: { email: "counter@test" } });
  const session = { user: { id: user.id, email: user.email } } as unknown as Session;
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Fabric" } });
  const category = await prisma.category.create({
    data: { name: "Linen", departmentId: department.id, trackInventory: true },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "LINEN",
      name: "Linen",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  clearLocationCache();
  return { session, product, store };
}

async function count(session: Session, productId: number, quantity: unknown) {
  const res = makeRes();
  await countHandler(
    makeReq("POST", {}, { productId, stockLocation: "Mill", quantity }),
    res,
    session,
  );
  return res;
}

describe("the store-grain count keeps a part roll", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("stores and sends back a fractional count as a number", async () => {
    const { session, product } = await world();

    const res = await count(session, product.id, 12.5);
    expect(res.statusCode).toBe(201);
    expect(res.body.quantity).toBe(12.5);

    const row = await prisma.physicalInventoryCount.findFirstOrThrow({});
    expect(row.quantity.toString()).toBe("12.5");

    const history = makeRes();
    await historyHandler(makeReq("GET", { location: "Mill" }), history, session);
    expect(history.body.counts[0].quantity).toBe(12.5);
  });

  it("refuses a count that is not a number or is negative, and takes zero", async () => {
    const { session, product } = await world();

    expect((await count(session, product.id, "lots")).statusCode).toBe(400);
    expect((await count(session, product.id, -1)).statusCode).toBe(400);
    expect((await count(session, product.id, 0)).statusCode).toBe(201);
    expect(await prisma.physicalInventoryCount.count()).toBe(1);
  });

  it("sums scans to the stock precision, so float noise is not a variance", async () => {
    const { session, product, store } = await world();
    await prisma.inventorySnapshot.create({
      data: { productId: product.id, storeLocationId: store.id, quantity: 0.3 },
    });
    await count(session, product.id, 0.1);
    await count(session, product.id, 0.2);

    const variance = makeRes();
    await varianceHandler(makeReq("GET", { location: "Mill" }), variance);
    expect(variance.statusCode).toBe(200);
    expect(variance.body.records).toEqual([]);
    expect(variance.body.accurateCount).toBe(1);

    const accurate = makeRes();
    await accurateHandler(makeReq("GET", { location: "Mill" }), accurate);
    expect(accurate.body.records).toEqual([
      expect.objectContaining({ productId: product.id, counted: 0.3, variance: 0 }),
    ]);
  });

  it("reconciles a part roll with its fractions, and lists it with numbers", async () => {
    const { session, product, store } = await world();
    await prisma.inventorySnapshot.create({
      data: { productId: product.id, storeLocationId: store.id, quantity: 12.625 },
    });
    await count(session, product.id, 12.5);

    const variance = makeRes();
    await varianceHandler(makeReq("GET", { location: "Mill" }), variance);
    const [item] = variance.body.records;
    expect(item).toEqual(expect.objectContaining({ expected: 12.625, counted: 12.5 }));
    expect(item.variance).toBe(-0.125);

    const reconcile = makeRes();
    await reconcileHandler(
      makeReq(
        "POST",
        {},
        { item: { ...item, location: "Mill" }, action: "correct", correctedCount: 12.375 },
      ),
      reconcile,
      session,
    );
    expect(reconcile.statusCode).toBe(200);
    expect(reconcile.body.reconciliation).toEqual(
      expect.objectContaining({
        initialExpected: 12.625,
        initialCounted: 12.5,
        initialVariance: -0.125,
        finalCount: 12.375,
        finalVariance: -0.25,
      }),
    );

    const listed = makeRes();
    await reconciledHandler(makeReq("GET", { location: "Mill" }), listed);
    expect(listed.body).toEqual([
      expect.objectContaining({ finalCount: 12.375, finalVariance: -0.25 }),
    ]);
  });
});
