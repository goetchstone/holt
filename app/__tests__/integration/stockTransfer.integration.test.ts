// /app/__tests__/integration/stockTransfer.integration.test.ts
//
// Ledger plan phase 6: transfers through an in-transit place.
//
// A shipped unit used to leave the books until it was received, so stock on a
// truck was nowhere. Now it waits in the source store's TRANSIT place: owned,
// counted, not for sale. A transfer can be received in parts, a cancel sends
// what is still on its way back to the exact places it left (read from the
// journal), a transfer for an order carries the order's commitment the whole
// way, and a quick move is one movement -- where the move mode allows it.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { availableQuantity, release } from "@/lib/inventory/allocation";
import { postMovement } from "@/lib/inventory/ledger";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { toQty } from "@/lib/inventory/quantity";
import { handler as statusHandler } from "@/pages/api/warehouse/transfers/[id]/status";
import { handler as transfersHandler } from "@/pages/api/warehouse/transfers/index";
import { handler as positionHandler } from "@/pages/api/warehouse/positions/[id]";
import { stockAt } from "../helpers/stock";

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
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Textiles" } });
  const category = await prisma.category.create({
    data: { name: "Drapery", departmentId: department.id, trackInventory: true },
  });
  const storeA = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  const storeB = await prisma.storeLocation.create({
    data: { name: "Store B", code: "SB", type: "STORE" },
  });
  const backA = await prisma.stockLocation.create({
    data: { storeLocationId: storeA.id, code: "BACK", name: "Back A" },
  });
  const floorA = await prisma.stockLocation.create({
    data: { storeLocationId: storeA.id, code: "FLOOR", name: "Floor A", locationType: "FLOOR" },
  });
  const backB = await prisma.stockLocation.create({
    data: { storeLocationId: storeB.id, code: "BACK", name: "Back B" },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "LIN-1",
      name: "Linen",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const user = await prisma.user.create({ data: { email: "wh@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { storeA, storeB, backA, floorA, backB, product, user, session };
}

type World = Awaited<ReturnType<typeof world>>;

async function transfer(w: World, over: Record<string, unknown> = {}) {
  const res = makeRes();
  await transfersHandler(
    makeReq(
      "POST",
      {},
      {
        productId: w.product.id,
        fromLocationId: w.storeA.id,
        toLocationId: w.storeB.id,
        toStockLocationId: w.backB.id,
        quantity: "2.5",
        ...over,
      },
    ),
    res,
    w.session,
  );
  return res;
}

async function setStatus(w: World, id: number, status: string, quantity?: number) {
  const res = makeRes();
  await statusHandler(
    makeReq("PUT", { id: String(id) }, { status, ...(quantity != null ? { quantity } : {}) }),
    res,
    w.session,
  );
  return res;
}

const held = async (
  productId: number,
  stockLocationId: number,
  salesOrderId: number | null = null,
) =>
  toQty(
    (
      await prisma.inventoryPosition.aggregate({
        where: { productId, stockLocationId, salesOrderId },
        _sum: { quantity: true },
      })
    )._sum.quantity,
  );

async function transitOf(storeLocationId: number) {
  const store = await prisma.storeLocation.findUniqueOrThrow({ where: { id: storeLocationId } });
  return store.transitStockLocationId!;
}

async function orderAt(storeName: string, orderno: string) {
  const customer = await prisma.customer.create({ data: { firstName: "C", lastName: orderno } });
  return prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      storeLocation: storeName,
    },
  });
}

describe("transfers through an in-transit place (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a shipped part roll waits in transit: owned, not for sale", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 10,
    });
    const created = await transfer(w);
    expect(created.statusCode).toBe(201);
    expect(created.body.quantity).toBe(2.5);

    expect((await setStatus(w, created.body.id, "IN_TRANSIT")).statusCode).toBe(200);

    const transit = await transitOf(w.storeA.id);
    expect(await held(w.product.id, transit)).toBe(2.5);
    expect(await held(w.product.id, w.backA.id)).toBe(7.5);
    // Free to sell at A is only what is still in back stock.
    expect(await availableQuantity(w.product.id, w.storeA.id, prisma)).toBe(7.5);
  });

  it("receives in parts, and is RECEIVED only once all of it has arrived", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 10,
    });
    const { body } = await transfer(w);
    await setStatus(w, body.id, "IN_TRANSIT");

    const first = await setStatus(w, body.id, "RECEIVED", 1);
    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({ status: "IN_TRANSIT", receivedQuantity: 1 });
    expect(await held(w.product.id, w.backB.id)).toBe(1);

    const tooMuch = await setStatus(w, body.id, "RECEIVED", 2);
    expect(tooMuch.statusCode).toBe(400);

    const rest = await setStatus(w, body.id, "RECEIVED");
    expect(rest.body).toMatchObject({ status: "RECEIVED", receivedQuantity: 2.5 });
    expect(await held(w.product.id, w.backB.id)).toBe(2.5);
    expect(await held(w.product.id, await transitOf(w.storeA.id))).toBe(0);
  });

  it("a cancel sends what is still on its way back to the places it left", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 1,
    });
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.floorA.id,
      quantity: 2,
    });
    // "Any free stock at this store": 1 from back stock, 1.5 from the floor.
    const { body } = await transfer(w, { quantity: 2.5 });
    await setStatus(w, body.id, "IN_TRANSIT");
    expect(await held(w.product.id, w.backA.id)).toBe(0);
    expect(await held(w.product.id, w.floorA.id)).toBe(0.5);

    await setStatus(w, body.id, "RECEIVED", 1);
    expect((await setStatus(w, body.id, "CANCELLED")).statusCode).toBe(200);

    // 1.5 was still on its way. Newest leg first: the floor gave 1.5, so the
    // floor gets 1.5 back; back stock's unit was the one received.
    expect(await held(w.product.id, w.floorA.id)).toBe(2);
    expect(await held(w.product.id, w.backA.id)).toBe(0);
    expect(await held(w.product.id, w.backB.id)).toBe(1);
    expect(await held(w.product.id, await transitOf(w.storeA.id))).toBe(0);
  });

  it("a transfer for an order arrives committed to it, with nothing re-allocated", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 4,
    });
    const order = await orderAt(w.storeB.name, "SO-T");
    const { body } = await transfer(w, { quantity: 2, salesOrderId: order.id });
    await setStatus(w, body.id, "IN_TRANSIT");

    const transit = await transitOf(w.storeA.id);
    expect(await held(w.product.id, transit, order.id)).toBe(2);

    await setStatus(w, body.id, "RECEIVED");
    expect(await held(w.product.id, w.backB.id, order.id)).toBe(2);
    expect(await held(w.product.id, w.backB.id, null)).toBe(0);
    const allocations = await prisma.stockMovement.count({ where: { reason: "ALLOCATE" } });
    expect(allocations).toBe(0);
  });

  it("an order cancelled while its transfer is on the road: the units land free, the receipt still goes through", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 4,
    });
    const order = await orderAt(w.storeB.name, "SO-C");
    const { body } = await transfer(w, { quantity: 2, salesOrderId: order.id });
    await setStatus(w, body.id, "IN_TRANSIT");

    await release(order.id, prisma);
    const received = await setStatus(w, body.id, "RECEIVED");

    expect(received.statusCode).toBe(200);
    expect(await held(w.product.id, w.backB.id, null)).toBe(2);
    expect(await held(w.product.id, w.backB.id, order.id)).toBe(0);
  });

  it("a line edit on the order keeps the commitment that is in transit", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 4,
    });
    const order = await orderAt(w.storeB.name, "SO-E");
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 1,
        productId: w.product.id,
        productName: "Linen",
        orderedQuantity: 2,
        netPrice: 100,
        cost: 40,
        vatRate: 0,
        vatAmount: 0,
      },
    });
    const { body } = await transfer(w, { quantity: 2, salesOrderId: order.id });
    await setStatus(w, body.id, "IN_TRANSIT");

    // Any line edit resyncs the order. A full release-then-reallocate would
    // free the 2 in the truck (allocation never draws from transit) and leave
    // the order short.
    await prisma.$transaction((tx) => resyncOrderAllocation(order.id, w.storeB.name, tx));

    expect(await held(w.product.id, await transitOf(w.storeA.id), order.id)).toBe(2);
    expect(await prisma.inventoryException.count()).toBe(0);
  });

  it("moving now is one movement within a store, and refused between stores", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 3,
    });

    const quick = await transfer(w, {
      toLocationId: w.storeA.id,
      fromStockLocationId: w.backA.id,
      toStockLocationId: w.floorA.id,
      quantity: 1,
      moveNow: true,
    });
    expect(quick.statusCode).toBe(201);
    expect(quick.body).toMatchObject({ status: "RECEIVED", receivedQuantity: 1 });
    expect(await held(w.product.id, w.floorA.id)).toBe(1);
    expect(await prisma.stockMovement.count({ where: { reason: "TRANSFER" } })).toBe(1);

    const between = await transfer(w, {
      fromStockLocationId: w.backA.id,
      toStockLocationId: w.backB.id,
      quantity: 1,
      moveNow: true,
    });
    expect(between.statusCode).toBe(409);
    expect(await held(w.product.id, w.backB.id)).toBe(0);
  });

  it("a store set to quick lets an admin move stock to it in one step", async () => {
    const w = await world();
    const row = await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 2,
    });
    const refused = makeRes();
    await positionHandler(
      makeReq(
        "PUT",
        { id: String(row.id) },
        { storeLocationId: w.storeB.id, stockLocationId: w.backB.id },
      ),
      refused,
      w.session,
    );
    expect(refused.statusCode).toBe(409);

    await prisma.storeLocation.updateMany({ data: { moveMode: "QUICK" } });
    const allowed = makeRes();
    await positionHandler(
      makeReq(
        "PUT",
        { id: String(row.id) },
        { storeLocationId: w.storeB.id, stockLocationId: w.backB.id },
      ),
      allowed,
      w.session,
    );
    expect(allowed.statusCode).toBe(200);
    expect(await held(w.product.id, w.backB.id)).toBe(2);
  });

  it("a transfer shipped out of the books before transit places existed is received the old way", async () => {
    const w = await world();
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.storeA.id,
      stockLocationId: w.backA.id,
      quantity: 2,
    });
    const legacy = await prisma.inventoryTransfer.create({
      data: {
        productId: w.product.id,
        quantity: 2,
        fromLocation: "Store A",
        toLocation: "Store B",
        fromLocationId: w.storeA.id,
        toLocationId: w.storeB.id,
        toStockLocationId: w.backB.id,
        requestedByUserId: w.user.id,
        status: "IN_TRANSIT",
      },
    });
    await postMovement(prisma, {
      productId: w.product.id,
      quantity: 2,
      from: { storeLocationId: w.storeA.id, stockLocationId: w.backA.id, salesOrderId: null },
      reason: "TRANSFER",
      source: { type: "InventoryTransfer", id: legacy.id },
    });

    expect((await setStatus(w, legacy.id, "RECEIVED")).statusCode).toBe(200);
    expect(await held(w.product.id, w.backB.id)).toBe(2);
  });
});
