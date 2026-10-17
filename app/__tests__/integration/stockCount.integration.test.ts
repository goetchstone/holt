// /app/__tests__/integration/stockCount.integration.test.ts
//
// Count by place against real Postgres (lib/inventory/count.ts,
// pages/api/scan/count.ts): posting moves the difference as ADJUST
// movements, takes free stock before committed, resyncs a short order, and
// flags the product on the Oversold report.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { postCount, submitCount } from "@/lib/inventory/count";
import { getOversoldReport } from "@/lib/reports/oversold";
import { handler } from "@/pages/api/scan/count";
import { stockAt } from "../helpers/stock";

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
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: any };
}

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const product = (productNumber: string) =>
    prisma.product.create({
      data: {
        productNumber,
        name: productNumber,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
  const lamp = await product("LAMP");
  const chair = await product("CHAIR");
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const bay = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BAY", name: "Bay" },
  });
  const at = (productId: number, quantity: number, salesOrderId: number | null = null) =>
    stockAt({
      productId,
      storeLocationId: store.id,
      stockLocationId: bay.id,
      quantity,
      salesOrderId,
    });
  return { lamp, chair, store, bay, at };
}

const sumAt = async (
  productId: number,
  stockLocationId: number,
  committed: boolean | null = null,
) => {
  const r = await prisma.inventoryPosition.aggregate({
    where: {
      productId,
      stockLocationId,
      ...(committed == null
        ? {}
        : committed
          ? { salesOrderId: { not: null } }
          : { salesOrderId: null }),
    },
    _sum: { quantity: true },
  });
  return Number(r._sum.quantity ?? 0);
};

describe("count by place (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a place count posts the difference and counts the unscanned absent", async () => {
    const { lamp, chair, store, bay, at } = await world();
    await at(lamp.id, 3);
    await at(chair.id, 2);
    await prisma.$transaction(async (tx) => {
      const c = await submitCount(tx, {
        storeLocationId: store.id,
        stockLocationId: bay.id,
        scope: "PLACE",
        lines: [{ productId: lamp.id, counted: 4.5 }],
        actor: "counter",
      });
      await postCount(tx, c.id, { actor: "manager" });
    });
    expect(await sumAt(lamp.id, bay.id)).toBe(4.5);
    expect(await sumAt(chair.id, bay.id)).toBe(0);
    const lines = await prisma.stockCountLine.findMany({ orderBy: { productId: "asc" } });
    expect(
      lines.map((l) => [l.productId, Number(l.counted), Number(l.expected), Number(l.difference)]),
    ).toEqual([
      [lamp.id, 4.5, 3, 1.5],
      [chair.id, 0, 2, -2],
    ]);
    const moves = await prisma.stockMovement.findMany({ where: { reason: "ADJUST" } });
    expect(moves.every((m) => m.sourceType === "StockCount")).toBe(true);
  });

  it("a quick count leaves the products it did not list alone", async () => {
    const { lamp, chair, store, bay, at } = await world();
    await at(lamp.id, 3);
    await at(chair.id, 2);
    await prisma.$transaction(async (tx) => {
      const c = await submitCount(tx, {
        storeLocationId: store.id,
        stockLocationId: bay.id,
        scope: "PRODUCTS",
        lines: [{ productId: lamp.id, counted: 1 }],
        actor: null,
      });
      await postCount(tx, c.id, { actor: null });
    });
    expect(await sumAt(lamp.id, bay.id)).toBe(1);
    expect(await sumAt(chair.id, bay.id)).toBe(2);
  });

  it("short of what an order holds: free goes first, then the order's, which shows as short with the count flagged", async () => {
    const { lamp, store, bay, at } = await world();
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-1",
        status: "ORDER",
        orderDate: new Date(),
        storeLocation: "Mill",
        storeLocationId: store.id,
        lineItems: {
          create: [
            { lineNumber: 1, productId: lamp.id, orderedQuantity: 2, netPrice: 100, cost: 40 },
          ],
        },
      },
    });
    await at(lamp.id, 1);
    await at(lamp.id, 2, order.id);
    await prisma.$transaction(async (tx) => {
      const c = await submitCount(tx, {
        storeLocationId: store.id,
        stockLocationId: bay.id,
        scope: "PLACE",
        lines: [{ productId: lamp.id, counted: 1 }],
        actor: null,
      });
      await postCount(tx, c.id, { actor: null });
    });
    // Counted 1 of 3: the free one went first, then one of the order's two.
    expect(await sumAt(lamp.id, bay.id, false)).toBe(0);
    expect(await sumAt(lamp.id, bay.id, true)).toBe(1);
    const report = await getOversoldReport(prisma);
    expect(report).toEqual([
      expect.objectContaining({
        productId: lamp.id,
        shortfall: 1,
        lastCountVariance: expect.objectContaining({ place: "Bay", difference: -2 }),
      }),
    ]);
  });

  it("clears a stray-box note the count did not find", async () => {
    const { lamp, store, bay, at } = await world();
    await at(lamp.id, 1);
    const note = await prisma.boxNote.create({
      data: {
        kind: "STRAY",
        productId: lamp.id,
        storeLocationId: store.id,
        stockLocationId: bay.id,
        boxes: [2],
        boxesPerUnit: 2,
      },
    });
    await prisma.$transaction(async (tx) => {
      const c = await submitCount(tx, {
        storeLocationId: store.id,
        stockLocationId: bay.id,
        scope: "PLACE",
        lines: [{ productId: lamp.id, counted: 1, boxes: [1] }],
        actor: null,
      });
      await postCount(tx, c.id, { actor: null });
    });
    const after = await prisma.boxNote.findUniqueOrThrow({ where: { id: note.id } });
    expect(after.clearReason).toMatch(/Counted absent/);
  });

  it("the route posts only for someone who may adjust inventory, and a resend is the same count", async () => {
    const { lamp, store, bay, at } = await world();
    await at(lamp.id, 3);
    const session = { user: { email: "counter@example.test" } } as unknown as Session;
    const body = {
      actionKey: "count-0001-abcd",
      storeLocationId: store.id,
      stockLocationId: bay.id,
      scope: "PLACE",
      post: true,
      lines: [{ productId: lamp.id, counted: 2 }],
    };
    const req = (b: unknown) =>
      ({ method: "POST", query: {}, body: b, headers: {} }) as unknown as NextApiRequest;

    const refused = makeRes();
    await handler(req(body), refused, session, { holds: { "inventory.adjust": false } });
    expect(refused.statusCode).toBe(403);
    expect(await prisma.stockCount.count()).toBe(0);

    const ok = makeRes();
    await handler(req(body), ok, session, { holds: { "inventory.adjust": true } });
    expect(ok.statusCode).toBe(201);
    expect(ok.body).toMatchObject({ posted: true, changed: 1 });
    const again = makeRes();
    await handler(req(body), again, session, { holds: { "inventory.adjust": true } });
    expect(again.body.replayed).toBe(true);
    expect(await prisma.stockCount.count()).toBe(1);
    expect(await sumAt(lamp.id, bay.id)).toBe(2);
  });
});
