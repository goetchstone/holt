// /app/__tests__/integration/stockMove.integration.test.ts
//
// Put away and move on a handheld against real Postgres
// (pages/api/scan/move.ts, lib/inventory/floorMove.ts): free units first, sold
// units keep their order, a tracked place's move mode reaches the bays inside
// it, boxes moved on their own leave stray notes, and a resend moves nothing
// twice.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler } from "@/pages/api/scan/move";
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

const session = { user: { email: "mover@example.test" } } as unknown as Session;
const post = async (body: unknown) => {
  const res = makeRes();
  await handler(
    { method: "POST", query: {}, body, headers: {} } as unknown as NextApiRequest,
    res,
    session,
  );
  return res;
};

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "D" } });
  const category = await prisma.category.create({
    data: { name: "C", departmentId: department.id, trackInventory: true },
  });
  const sofa = await prisma.product.create({
    data: {
      productNumber: "SOFA",
      name: "Sofa",
      boxesPerUnit: 3,
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const place = (code: string, extra: object = {}) =>
    prisma.stockLocation.create({
      data: { storeLocationId: store.id, code, name: code, ...extra },
    });
  const receiving = await place("RECEIVING", { locationType: "RECEIVING" });
  const bay = await place("BAY");
  const loft = await place("LOFT");
  const order = await prisma.salesOrder.create({
    data: { orderno: "SO-1", status: "ORDER", orderDate: new Date(), storeLocation: "Mill" },
  });
  return { sofa, store, receiving, bay, loft, order };
}

const at = async (productId: number, stockLocationId: number) =>
  (
    await prisma.inventoryPosition.findMany({
      where: { productId, stockLocationId },
      orderBy: { salesOrderId: "asc" },
    })
  ).map((r) => [r.salesOrderId, Number(r.quantity)]);

describe("put away and move (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("moves free units first, then sold ones keeping their order", async () => {
    const { sofa, store, receiving, bay, order } = await world();
    await stockAt({
      productId: sofa.id,
      storeLocationId: store.id,
      stockLocationId: receiving.id,
      quantity: 1,
    });
    await stockAt({
      productId: sofa.id,
      storeLocationId: store.id,
      stockLocationId: receiving.id,
      quantity: 1,
      salesOrderId: order.id,
    });
    const one = await post({
      actionKey: "move-0001-aaaa",
      fromStockLocationId: receiving.id,
      toStockLocationId: bay.id,
      items: [{ productId: sofa.id, units: 1 }],
    });
    expect(one.body).toMatchObject({ units: 1, committed: 0 });
    expect(await at(sofa.id, bay.id)).toEqual([[null, 1]]);

    const two = await post({
      actionKey: "move-0002-aaaa",
      fromStockLocationId: receiving.id,
      toStockLocationId: bay.id,
      items: [{ productId: sofa.id, units: 1 }],
    });
    expect(two.body).toMatchObject({ units: 1, committed: 1 });
    expect(await at(sofa.id, bay.id)).toEqual([
      [order.id, 1],
      [null, 1],
    ]);
    expect(await at(sofa.id, receiving.id)).toEqual([]);
  });

  it("refuses more than is there, and a resend moves nothing twice", async () => {
    const { sofa, store, receiving, bay } = await world();
    await stockAt({
      productId: sofa.id,
      storeLocationId: store.id,
      stockLocationId: receiving.id,
      quantity: 2,
    });
    const tooMany = await post({
      actionKey: "move-many-0001",
      fromStockLocationId: receiving.id,
      toStockLocationId: bay.id,
      items: [{ productId: sofa.id, units: 3 }],
    });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.body.error).toContain("Only 2");
    expect(await at(sofa.id, bay.id)).toEqual([]);

    const body = {
      actionKey: "move-dup-0001",
      fromStockLocationId: receiving.id,
      toStockLocationId: bay.id,
      items: [{ productId: sofa.id, units: 1 }],
    };
    await post(body);
    expect((await post(body)).body.replayed).toBe(true);
    expect(await at(sofa.id, bay.id)).toEqual([[null, 1]]);
  });

  it("a tracked group's mode reaches the places inside it", async () => {
    const { sofa, store, receiving } = await world();
    const barn = await prisma.stockLocation.create({
      data: {
        storeLocationId: store.id,
        code: "BARN",
        name: "Barn",
        locationType: "GROUP",
        moveMode: "TRACKED",
      },
    });
    const inBarn = await prisma.stockLocation.create({
      data: { storeLocationId: store.id, code: "BARN-1", name: "Barn bay", parentId: barn.id },
    });
    await stockAt({
      productId: sofa.id,
      storeLocationId: store.id,
      stockLocationId: receiving.id,
      quantity: 1,
    });
    const res = await post({
      actionKey: "move-track-0001",
      fromStockLocationId: receiving.id,
      toStockLocationId: inBarn.id,
      items: [{ productId: sofa.id, units: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("start a transfer");
  });

  it("a box moved on its own leaves a stray note, which clears when it rejoins its unit", async () => {
    const { sofa, store, bay, loft } = await world();
    await stockAt({
      productId: sofa.id,
      storeLocationId: store.id,
      stockLocationId: bay.id,
      quantity: 1,
    });
    const away = await post({
      actionKey: "move-stray-0001",
      fromStockLocationId: bay.id,
      toStockLocationId: loft.id,
      strayBoxes: [{ productId: sofa.id, boxes: [3] }],
    });
    expect(away.body).toMatchObject({ units: 0, strayNotes: 1 });
    const note = await prisma.boxNote.findFirstOrThrow({ where: { kind: "STRAY" } });
    expect(note).toMatchObject({ stockLocationId: loft.id, boxes: [3], clearedAt: null });
    // No stock moved: the sofa is still one unit in the bay.
    expect(await at(sofa.id, bay.id)).toEqual([[null, 1]]);

    const back = await post({
      actionKey: "move-stray-0002",
      fromStockLocationId: loft.id,
      toStockLocationId: bay.id,
      strayBoxes: [{ productId: sofa.id, boxes: [3] }],
    });
    expect(back.body).toMatchObject({ reunited: 1, strayNotes: 0 });
    expect(
      (await prisma.boxNote.findUniqueOrThrow({ where: { id: note.id } })).clearedAt,
    ).not.toBeNull();
  });
});
