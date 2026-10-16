// /app/__tests__/integration/stockReturns.integration.test.ts
//
// Ledger plan phase 8, as the owner directed on 2026-10-16: a return never
// holds up the customer, and each store has a queue of returned pieces to put
// back on the shelf or write off.
//
// RECEIVED puts the piece into the store's returns place (owned, not for sale)
// and records where. The return can be inspected and closed at once. The
// returned-stock queue lists every piece still waiting; putting it back moves
// it from the recorded place to a sellable one, writing it off takes it out of
// the books, and the journal generator reads that decision even after the
// return is closed. Before this, restocking added a unit that had never been
// recorded as back, and a return closed without restocking left the piece
// invisible to the books.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { availableQuantity } from "@/lib/inventory/allocation";
import { toQty } from "@/lib/inventory/quantity";
import { classifyReturnDisposition } from "@/lib/journalEntry";
import { handler as createReturnHandler } from "@/pages/api/returns/index";
import { handler as statusHandler } from "@/pages/api/returns/[id]/status";
import { handler as dispositionHandler } from "@/pages/api/returns/[id]/disposition";
import { handler as queueHandler } from "@/pages/api/warehouse/returns/returned-stock";

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
  const store = await prisma.storeLocation.create({
    data: { name: "Mill Shop", code: "MILL", type: "STORE" },
  });
  const floor = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "FLOOR", name: "Floor", locationType: "FLOOR" },
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
  const customer = await prisma.customer.create({ data: { firstName: "R", lastName: "Turner" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-R",
      status: "FULFILLED",
      orderDate: new Date(),
      customerId: customer.id,
      storeLocation: store.name,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: product.id,
            productName: "Linen",
            orderedQuantity: 6,
            netPrice: 300,
            cost: 120,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
    include: { lineItems: true },
  });
  const session = { user: { email: "returns@example.test" } } as unknown as Session;
  return { store, floor, product, order, session };
}

type World = Awaited<ReturnType<typeof world>>;

async function newReturn(w: World, quantity = "2.5") {
  const res = makeRes();
  await createReturnHandler(
    makeReq(
      "POST",
      {},
      {
        salesOrderId: w.order.id,
        lineItemId: w.order.lineItems[0].id,
        reason: "CUSTOMER_CHANGED_MIND",
        quantity,
      },
    ),
    res,
    w.session,
  );
  expect(res.statusCode).toBe(201);
  return res.body.id ?? res.body.return?.id;
}

async function status(w: World, id: number, next: string, fields: Record<string, unknown> = {}) {
  const res = makeRes();
  await statusHandler(
    makeReq("PUT", { id: String(id) }, { status: next, ...fields }),
    res,
    w.session,
  );
  return res;
}

async function dispose(w: World, id: number, body: Record<string, unknown>) {
  const res = makeRes();
  await dispositionHandler(makeReq("POST", { id: String(id) }, body), res, w.session);
  return res;
}

async function queue(storeLocationId?: number) {
  const res = makeRes();
  await queueHandler(
    makeReq("GET", storeLocationId ? { storeLocationId: String(storeLocationId) } : {}),
    res,
  );
  return res.body.items as { id: number; quantity: number }[];
}

describe("returns and the returned-stock queue (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a received part roll goes into the store's returns place: owned, not for sale", async () => {
    const w = await world();
    const id = await newReturn(w);

    // No store named: the order's store is used. The customer is never refused.
    const received = await status(w, id, "RECEIVED");
    expect(received.statusCode).toBe(200);
    expect(received.body.quantity).toBe(2.5);

    const ret = await prisma.return.findUniqueOrThrow({ where: { id } });
    const store = await prisma.storeLocation.findUniqueOrThrow({ where: { id: w.store.id } });
    expect(ret.receivedLocationId).toBe(w.store.id);
    expect(ret.receivedStockLocationId).toBe(store.returnsStockLocationId);
    const place = await prisma.stockLocation.findUniqueOrThrow({
      where: { id: ret.receivedStockLocationId! },
    });
    expect(place.locationType).toBe("QUARANTINE");

    const row = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: w.product.id },
    });
    expect(toQty(row.quantity)).toBe(2.5);
    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(0);
  });

  it("the customer's return closes while the piece waits in the store's queue", async () => {
    const w = await world();
    const id = await newReturn(w);
    await status(w, id, "RECEIVED");
    await status(w, id, "INSPECTED", { inspectionCondition: "LIKE_NEW" });
    expect((await status(w, id, "CLOSED")).statusCode).toBe(200);

    expect((await queue(w.store.id)).map((r) => [r.id, r.quantity])).toEqual([[id, 2.5]]);
  });

  it("putting it back moves it to a sellable place and the journal books a restock", async () => {
    const w = await world();
    const id = await newReturn(w);
    await status(w, id, "RECEIVED");
    await status(w, id, "INSPECTED", { inspectionCondition: "MAJOR_DAMAGE" });
    await status(w, id, "CLOSED");

    const put = await dispose(w, id, {
      action: "PUT_BACK",
      storeLocationId: w.store.id,
      stockLocationId: w.floor.id,
    });
    expect(put.statusCode).toBe(200);

    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(2.5);
    expect(await queue(w.store.id)).toEqual([]);
    const moves = await prisma.stockMovement.findMany({
      where: { sourceType: "Return", sourceId: id },
    });
    expect(moves.map((m) => m.reason)).toEqual(["RETURN", "TRANSFER"]);

    // The inspector called it major damage, but someone put it back: the
    // recorded decision wins over the condition, after the return was closed.
    const ret = await prisma.return.findUniqueOrThrow({ where: { id } });
    expect(classifyReturnDisposition(ret)).toBe("RESTOCK");

    // A second click on the same piece moves nothing.
    const again = await dispose(w, id, { action: "WRITE_OFF" });
    expect(again.statusCode).toBe(409);
  });

  it("a second action on one return never takes another return's piece", async () => {
    // Two returns of the same product wait in the same returns place. Without
    // the claim on the return, a second "put back" on the first would move the
    // second return's piece and leave that return in the queue with nothing.
    const w = await world();
    const first = await newReturn(w, "1");
    const second = await newReturn(w, "1");
    await status(w, first, "RECEIVED");
    await status(w, second, "RECEIVED");
    const back = { action: "PUT_BACK", storeLocationId: w.store.id, stockLocationId: w.floor.id };

    expect((await dispose(w, first, back)).statusCode).toBe(200);
    expect((await dispose(w, first, back)).statusCode).toBe(409);

    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(1);
    expect((await queue(w.store.id)).map((r) => r.id)).toEqual([second]);
  });

  it("writing it off takes it out of the books", async () => {
    const w = await world();
    const id = await newReturn(w, "1");
    await status(w, id, "RECEIVED");

    const off = await dispose(w, id, { action: "WRITE_OFF", reason: "Torn" });
    expect(off.statusCode).toBe(200);

    expect(await prisma.inventoryPosition.count({ where: { productId: w.product.id } })).toBe(0);
    const ret = await prisma.return.findUniqueOrThrow({ where: { id } });
    expect(ret.writeOffReason).toBe("Torn");
    expect(classifyReturnDisposition(ret)).toBe("WRITEOFF");
    // The customer's return is still where it was: nothing waited on this.
    expect(ret.status).toBe("RECEIVED");
  });

  it("refuses to put a piece back on a place stock is not sold from", async () => {
    const w = await world();
    const id = await newReturn(w);
    await status(w, id, "RECEIVED");
    const store = await prisma.storeLocation.findUniqueOrThrow({ where: { id: w.store.id } });

    const res = await dispose(w, id, {
      action: "PUT_BACK",
      storeLocationId: w.store.id,
      stockLocationId: store.returnsStockLocationId,
    });
    expect(res.statusCode).toBe(400);
    expect(await queue(w.store.id)).toHaveLength(1);
  });

  it("a store whose returns place is sellable has returns back on sale at once", async () => {
    const w = await world();
    await prisma.storeLocation.update({
      where: { id: w.store.id },
      data: { returnsStockLocationId: w.floor.id },
    });
    const id = await newReturn(w);
    await status(w, id, "RECEIVED");

    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(2.5);
  });

  it("restocking a return received before returns places existed adds the piece, the old way", async () => {
    const w = await world();
    const legacy = await prisma.return.create({
      data: {
        returnNumber: "RET-OLD",
        reason: "DEFECTIVE",
        salesOrderId: w.order.id,
        productId: w.product.id,
        quantity: 1,
        status: "INSPECTED",
      },
    });

    const res = await status(w, legacy.id, "RESTOCKED", {
      restockedLocationId: String(w.store.id),
      restockedStockLocationId: String(w.floor.id),
    });
    expect(res.statusCode).toBe(200);
    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(1);
  });
});
