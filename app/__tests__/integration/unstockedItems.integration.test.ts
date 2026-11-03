// /app/__tests__/integration/unstockedItems.integration.test.ts
//
// GAP-21, the stock side: an item whose category doesn't track inventory (a
// service, a fee, supplies) never goes on the books. Receiving it used to put
// it into stock like anything else, where it showed in counts and stock value
// and, since a sale never draws it, never sold down.
//
// Owner, 2026-11-02: a receipt records it and stocks nothing; switching a
// category off leaves the stock it already has, visible and countable, until
// someone counts it out. And "an item is an item no matter if it was speciall
// made to order or not": a spare one is stock a sale takes.
//
// Real routes and database; the routes' handlers are called past their gates.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { postMovement } from "@/lib/inventory/ledger";
import { landingPlaceId } from "@/lib/inventory/places";
import { toQty } from "@/lib/inventory/quantity";
import { NotStockedError } from "@/lib/inventory/stocked";
import { CountError, postCount, submitCount } from "@/lib/inventory/count";
import { applyImportSync } from "@/lib/inventory/importSync";
import { putBackReturn, receiveReturnStock } from "@/lib/inventory/returnStock";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { addCharge } from "@/lib/purchasing/landedCost";
import { handler as receiveHandler } from "@/pages/api/purchasing/orders/[id]/receive";
import { handler as unreceiveHandler } from "@/pages/api/purchasing/receiving/[id]/unreceive";
import { handler as positionsHandler } from "@/pages/api/warehouse/positions/index";
import { handler as positionHandler } from "@/pages/api/warehouse/positions/[id]";

function makeReq(method: string, query: Record<string, string>, body: unknown = {}) {
  return { method, query, body, headers: {} } as unknown as NextApiRequest;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
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
  return res as unknown as NextApiResponse & { statusCode: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const NOT_STOCKED = "Assembly isn't stocked: its category, Services, doesn't track inventory.";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "Maker", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const sofas = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const services = await prisma.category.create({
    data: { name: "Services", departmentId: department.id, trackInventory: false },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Harbor", code: "HBR", type: "STORE" },
  });
  const floor = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "FLOOR", name: "Floor" },
  });
  const back = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BACK", name: "Back room" },
  });
  const product = (productNumber: string, name: string, categoryId: number) =>
    prisma.product.create({
      data: { productNumber, name, vendorId: vendor.id, departmentId: department.id, categoryId },
    });
  const sofa = await product("SOFA-1", "Sofa", sofas.id);
  const assembly = await product("ASSEMBLY", "Assembly", services.id);
  const user = await prisma.user.create({ data: { email: "dock@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { vendor, services, store, floor, back, sofa, assembly, session };
}

type World = Awaited<ReturnType<typeof world>>;

const at = (w: World, stockLocationId: number) => ({
  storeLocationId: w.store.id,
  stockLocationId,
  salesOrderId: null,
});

async function held(productId: number): Promise<number> {
  const sum = await prisma.inventoryPosition.aggregate({
    where: { productId },
    _sum: { quantity: true },
  });
  return toQty(sum._sum.quantity);
}

async function heldAt(productId: number, stockLocationId: number): Promise<number> {
  const sum = await prisma.inventoryPosition.aggregate({
    where: { productId, stockLocationId },
    _sum: { quantity: true },
  });
  return toQty(sum._sum.quantity);
}

/** Stock it held before its category stopped keeping any. */
async function heldBeforeSwitchOff(w: World, quantity: number) {
  await prisma.category.update({ where: { id: w.services.id }, data: { trackInventory: true } });
  await postMovement(prisma, {
    productId: w.assembly.id,
    quantity,
    to: at(w, w.floor.id),
    reason: "OPENING",
  });
  await prisma.category.update({ where: { id: w.services.id }, data: { trackInventory: false } });
}

async function poFor(w: World, lines: { productId: number; ordered: number; unitCost: number }[]) {
  return prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-${Math.random().toString(36).slice(2, 8)}`,
      vendorId: w.vendor.id,
      status: "SUBMITTED",
      lineItems: {
        create: lines.map((l) => ({
          productId: l.productId,
          orderedQuantity: l.ordered,
          unitCost: l.unitCost,
        })),
      },
    },
    include: { lineItems: { orderBy: { id: "asc" } } },
  });
}

async function receive(w: World, poId: number, items: unknown[]) {
  const res = makeRes();
  await receiveHandler(
    makeReq("POST", { id: String(poId) }, { storeLocationId: w.store.id, items }),
    res,
    w.session,
  );
  return res;
}

describe("receiving an item whose category keeps no stock", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("records it, stocks nothing, and still closes the PO", async () => {
    const w = await world();
    const po = await poFor(w, [
      { productId: w.sofa.id, ordered: 1, unitCost: 500 },
      { productId: w.assembly.id, ordered: 2, unitCost: 30 },
    ]);
    const [sofaLine, assemblyLine] = po.lineItems;

    const res = await receive(w, po.id, [
      { purchaseOrderItemId: sofaLine.id, quantityReceived: 1, printTag: true },
      {
        purchaseOrderItemId: assemblyLine.id,
        quantityReceived: 2,
        printTag: true,
        // The Receive PO screen sends a destination for every line.
        destinationStockLocationId: w.back.id,
      },
    ]);

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(`2 item(s) received. Recorded only: ${NOT_STOCKED}`);
    expect(res.body.newStatus).toBe("RECEIVED_FULL");
    expect(res.body.printItems).toEqual([{ productId: w.sofa.id, quantity: 1 }]);
    expect(await held(w.sofa.id)).toBe(1);
    expect(await held(w.assembly.id)).toBe(0);
    expect(await prisma.stockMovement.count({ where: { productId: w.assembly.id } })).toBe(0);

    const records = await prisma.receivingRecord.findMany({
      where: { purchaseOrderId: po.id },
      orderBy: { purchaseOrderItemId: "asc" },
    });
    expect(
      records.map((r) => ({
        intoStock: r.intoStock,
        landed: r.landedUnitCost === null ? null : Number(r.landedUnitCost),
        place: r.destinationStockLocationId !== null,
        tag: r.tagsPrinted,
      })),
    ).toEqual([
      { intoStock: true, landed: 500, place: true, tag: true },
      { intoStock: false, landed: null, place: false, tag: false },
    ]);
    // Nothing on hand to average over: its cost stays the catalog's.
    const assembly = await prisma.product.findUniqueOrThrow({ where: { id: w.assembly.id } });
    expect(assembly.landedCost).toBeNull();
  });

  it("refuses it as boxes of an incomplete set", async () => {
    const w = await world();
    await prisma.product.update({ where: { id: w.assembly.id }, data: { boxesPerUnit: 2 } });
    const po = await poFor(w, [{ productId: w.assembly.id, ordered: 1, unitCost: 30 }]);

    const res = await receive(w, po.id, [
      {
        purchaseOrderItemId: po.lineItems[0].id,
        quantityReceived: 0,
        incompleteSets: [{ missing: [2] }],
      },
    ]);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe(NOT_STOCKED);
    expect(await prisma.receivingRecord.count()).toBe(0);
  });

  it("takes the receipt back with nothing taken out, even once its category keeps stock", async () => {
    const w = await world();
    const po = await poFor(w, [{ productId: w.assembly.id, ordered: 2, unitCost: 30 }]);
    await receive(w, po.id, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 2 }]);
    const record = await prisma.receivingRecord.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
    });
    // The receipt's own record decides (rule 60), not the category now.
    await prisma.category.update({ where: { id: w.services.id }, data: { trackInventory: true } });

    const res = makeRes();
    await unreceiveHandler(
      makeReq("POST", { id: String(record.id) }, { quantity: 1 }),
      res,
      w.session,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ remaining: 1, newStatus: "RECEIVED_PARTIAL" });
    expect(await prisma.stockMovement.count({ where: { productId: w.assembly.id } })).toBe(0);
  });

  it("is left out when a landed charge re-spreads the PO", async () => {
    const w = await world();
    const po = await poFor(w, [
      { productId: w.sofa.id, ordered: 1, unitCost: 500 },
      { productId: w.assembly.id, ordered: 1, unitCost: 100 },
    ]);
    await receive(w, po.id, [
      { purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 },
      { purchaseOrderItemId: po.lineItems[1].id, quantityReceived: 1 },
    ]);

    const charge = await prisma.$transaction((tx) =>
      addCharge(tx, {
        poId: po.id,
        description: "Freight",
        amount: 60,
        splitBy: "VALUE",
        actor: null,
      }),
    );

    // Had its receipt carried a cost, its share would have found no stock to
    // land on and come back unabsorbed.
    expect(charge.unabsorbed).toBe(0);
    const assemblyReceipt = await prisma.receivingRecord.findFirstOrThrow({
      where: { purchaseOrderItemId: po.lineItems[1].id },
    });
    expect(assemblyReceipt.landedUnitCost).toBeNull();
  });
});

describe("nothing else puts it on the books", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("the ledger refuses units arriving from outside, and moves what is already there", async () => {
    const w = await world();
    await expect(
      postMovement(prisma, {
        productId: w.assembly.id,
        quantity: 1,
        to: at(w, w.floor.id),
        reason: "ADJUST",
      }),
    ).rejects.toThrow(new NotStockedError(w.assembly.id, NOT_STOCKED));

    await heldBeforeSwitchOff(w, 3);
    await postMovement(prisma, {
      productId: w.assembly.id,
      quantity: 2,
      from: at(w, w.floor.id),
      to: at(w, w.back.id),
      reason: "TRANSFER",
    });
    expect(await heldAt(w.assembly.id, w.back.id)).toBe(2);
  });

  it("an edit by hand can take it down, not up", async () => {
    const w = await world();
    await heldBeforeSwitchOff(w, 3);
    const set = async (quantity: number) => {
      const res = makeRes();
      await positionsHandler(
        makeReq(
          "POST",
          {},
          {
            productId: w.assembly.id,
            storeLocationId: w.store.id,
            stockLocationId: w.floor.id,
            quantity,
          },
        ),
        res,
        w.session,
      );
      return res;
    };

    const up = await set(5);
    expect(up.statusCode).toBe(400);
    expect(up.body.error).toBe(NOT_STOCKED);
    expect(await held(w.assembly.id)).toBe(3);

    expect((await set(1)).statusCode).toBe(201);
    expect(await held(w.assembly.id)).toBe(1);

    // Editing the row itself is the same rule.
    const row = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: w.assembly.id },
    });
    const edit = async (quantity: number) => {
      const res = makeRes();
      await positionHandler(makeReq("PUT", { id: String(row.id) }, { quantity }), res, w.session);
      return res;
    };
    const editUp = await edit(2);
    expect(editUp.statusCode).toBe(400);
    expect(editUp.body.error).toBe(NOT_STOCKED);
    expect((await edit(0)).statusCode).toBe(200);
    expect(await held(w.assembly.id)).toBe(0);
  });

  it("a count can take it down, not add to it, when submitted and again when posted", async () => {
    const w = await world();
    await heldBeforeSwitchOff(w, 3);
    const count = (counted: number) =>
      prisma.$transaction((tx) =>
        submitCount(tx, {
          storeLocationId: w.store.id,
          stockLocationId: w.floor.id,
          scope: "PLACE",
          lines: [{ productId: w.assembly.id, counted }],
          actor: null,
        }),
      );

    await expect(count(4)).rejects.toThrow(
      new CountError(`${NOT_STOCKED} A count can take it down, not add to it.`),
    );

    const down = await count(1);
    await prisma.$transaction((tx) => postCount(tx, down.id, { actor: null }));
    expect(await held(w.assembly.id)).toBe(1);

    // Counted at what the books said, then the books dropped before posting.
    const level = await count(1);
    await postMovement(prisma, {
      productId: w.assembly.id,
      quantity: 1,
      from: at(w, w.floor.id),
      reason: "ADJUST",
    });
    await expect(
      prisma.$transaction((tx) => postCount(tx, level.id, { actor: null })),
    ).rejects.toThrow(CountError);
    expect(await held(w.assembly.id)).toBe(0);
    expect((await prisma.stockCount.findUniqueOrThrow({ where: { id: level.id } })).status).toBe(
      "SUBMITTED",
    );
  });

  it("a return comes back to no place, so there is nothing to put back", async () => {
    const w = await world();
    const customer = await prisma.customer.create({ data: { firstName: "R", lastName: "Turn" } });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-RET",
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocation: w.store.name,
      },
    });
    const ret = await prisma.return.create({
      data: {
        returnNumber: "RET-1",
        reason: "CUSTOMER_CHANGED_MIND",
        salesOrderId: order.id,
        productId: w.assembly.id,
        quantity: 1,
      },
    });

    const place = await prisma.$transaction((tx) => receiveReturnStock(tx, ret, w.store.id, null));
    expect(place).toBeNull();
    expect(await held(w.assembly.id)).toBe(0);

    await expect(
      prisma.$transaction((tx) =>
        putBackReturn(tx, ret, { storeLocationId: w.store.id, actor: null }),
      ),
    ).rejects.toThrow(`${NOT_STOCKED} There is nothing to put back.`);
    expect(await held(w.assembly.id)).toBe(0);
  });

  it("the stock import takes it down, never up", async () => {
    const w = await world();
    await heldBeforeSwitchOff(w, 3);
    const target = (productId: number, physical: number) => ({
      productId,
      storeLocationId: w.store.id,
      stockLocationId: w.floor.id,
      physical,
    });

    const up = await applyImportSync(
      prisma,
      [target(w.assembly.id, 5), target(w.sofa.id, 4)],
      null,
    );
    expect(up).toMatchObject({ placesChanged: 1, notStocked: 1 });
    expect(await held(w.assembly.id)).toBe(3);
    expect(await held(w.sofa.id)).toBe(4);

    const down = await applyImportSync(prisma, [target(w.assembly.id, 1)], null);
    expect(down).toMatchObject({ placesChanged: 1, notStocked: 0 });
    expect(await held(w.assembly.id)).toBe(1);
  });
});

describe("an item made to order is an item", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("a sale takes a spare one from stock like anything else", async () => {
    const w = await world();
    const custom = await prisma.product.create({
      data: {
        productNumber: "CUSTOM-1",
        name: "Custom sofa",
        vendorId: w.vendor.id,
        departmentId: w.sofa.departmentId,
        categoryId: w.sofa.categoryId,
        madeToOrder: true,
      },
    });
    // Its first customer cancelled after it arrived: it is free stock now.
    await postMovement(prisma, {
      productId: custom.id,
      quantity: 1,
      to: at(w, await landingPlaceId(prisma, w.store.id, "RECEIVING")),
      reason: "RECEIVE",
    });
    const customer = await prisma.customer.create({ data: { firstName: "N", lastName: "Ext" } });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-NEXT",
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocation: w.store.name,
        storeLocationId: w.store.id,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: custom.id,
              productName: "Custom sofa",
              orderedQuantity: 1,
              netPrice: 2000,
              cost: 900,
              vatRate: 0,
              vatAmount: 0,
            },
          ],
        },
      },
    });

    await prisma.$transaction((tx) => resyncOrderAllocation(order.id, w.store.name, tx));

    const committed = await prisma.inventoryPosition.aggregate({
      where: { productId: custom.id, salesOrderId: order.id },
      _sum: { quantity: true },
    });
    expect(toQty(committed._sum.quantity)).toBe(1);
    expect(await prisma.inventoryException.count({ where: { salesOrderId: order.id } })).toBe(0);
  });
});
