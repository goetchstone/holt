// /app/__tests__/integration/fractionalStock.integration.test.ts
//
// A roll of fabric is a length, not a count.
//
// The selling side has always been Decimal -- OrderLineItem.orderedQuantity and
// fulfilledQty both -- while InventoryPosition.quantity and
// InventoryTransfer.quantity were Int. So holt could take an order for 12.5
// yards and could not hold 12.5 yards, and the mismatch was invisible until
// somebody received a part roll: every count, transfer and allocation silently
// rounded.
//
// These tests buy, hold, allocate, split and consume fractional stock, and
// assert the eighth-of-a-yard case explicitly, because 0.125 is the smallest
// unit fabric is actually sold in.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { setStock, stockAt } from "../helpers/stock";
import { allocate, consume, availableQuantity, planDraw } from "@/lib/inventory/allocation";
import { toQty, roundQty, qtyEquals, qtyIsZero } from "@/lib/inventory/quantity";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { generatePickList } from "@/lib/deliveryService";
import { handlePost as freezePost } from "@/pages/api/inventory/freeze/index";
import { handleGet as freezeGet } from "@/pages/api/inventory/freeze/[id]";
import { handleGet as freezeCompare } from "@/pages/api/inventory/freeze/compare";
import { handler as pickListsHandler } from "@/pages/api/dispatch/pick-lists/index";
import { handler as pickListHandler } from "@/pages/api/dispatch/pick-lists/[id]";

let productId: number;
let storeId: number;

beforeEach(async () => {
  await resetTestDb();
  const store = await prisma.storeLocation.create({
    data: { name: "Mill Shop", code: "MILL", type: "STORE" },
  });
  const vendor = await prisma.vendor.create({
    data: { name: "Weaver", code: "WV", pricingModel: "FLAT" },
  });
  const department = await prisma.department.create({ data: { name: "Textiles" } });
  const category = await prisma.category.create({
    data: { name: "Drapery", departmentId: department.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "LINEN-01",
      name: "Belgian Linen",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  productId = product.id;
  storeId = store.id;
});

async function bolt(yards: number) {
  return stockAt({ productId, storeLocationId: storeId, quantity: yards });
}

async function orderFor(yards: number, orderno: string) {
  const customer = await prisma.customer.create({
    data: { firstName: "Yardage", lastName: "Buyer" },
  });
  return prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      storeLocation: "Mill Shop",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId,
            productName: "Belgian Linen",
            orderedQuantity: yards,
            netPrice: yards * 48,
            cost: yards * 22,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
}

describe("fractional stock (real DB)", () => {
  it("holds a part roll", async () => {
    await bolt(37.5);
    expect(await availableQuantity(productId, storeId, prisma)).toBe(37.5);
  });

  it("sells to the eighth of a yard", async () => {
    // 0.125 is the smallest unit fabric is sold in. It is exactly representable
    // at 3dp, which is why the column is Decimal(12,3) and not (12,2) -- two
    // places would round an eighth to 0.13 and lose stock on every cut.
    await bolt(10);
    const order = await orderFor(2.125, "SO-EIGHTH");

    const result = await prisma.$transaction((tx) =>
      allocate(order.id, [{ productId, storeLocationId: storeId, quantity: 2.125 }], tx),
    );
    expect(result.shortfalls).toHaveLength(0);

    const held = await prisma.inventoryPosition.findFirst({
      where: { salesOrderId: order.id },
    });
    expect(toQty(held?.quantity)).toBe(2.125);
    expect(await availableQuantity(productId, storeId, prisma)).toBe(7.875);
  });

  it("cuts one order across two bolts and leaves the remnant sellable", async () => {
    await bolt(8.25);
    await bolt(12.5);
    const order = await orderFor(15, "SO-TWO-BOLTS");

    await prisma.$transaction((tx) =>
      allocate(order.id, [{ productId, storeLocationId: storeId, quantity: 15 }], tx),
    );

    // 8.25 from the first bolt, 6.75 from the second. The 5.75 left on the
    // second is still free stock -- a remnant somebody can still buy.
    expect(await availableQuantity(productId, storeId, prisma)).toBe(5.75);

    const held = await prisma.inventoryPosition.findMany({
      where: { salesOrderId: order.id },
    });
    const committed = held.reduce((sum, p) => sum + toQty(p.quantity), 0);
    expect(roundQty(committed)).toBe(15);
  });

  it("shorts honestly rather than rounding", async () => {
    // The sale always wins: allocate what exists, record the rest as a
    // shortfall. Before, a request for 4.5 against 4.2 on hand could round.
    await bolt(4.2);
    const order = await orderFor(4.5, "SO-SHORT");

    const result = await prisma.$transaction((tx) =>
      allocate(order.id, [{ productId, storeLocationId: storeId, quantity: 4.5 }], tx),
    );

    expect(result.shortfalls).toHaveLength(1);
    expect(result.shortfalls[0].allocated).toBe(4.2);
    expect(result.shortfalls[0].shortfall).toBe(0.3);
  });

  it("consumes a fractional allocation completely, leaving no sliver", async () => {
    // An exhausted position must be deleted, not left at 0.0000001 -- present
    // in every count, sellable to nobody.
    await bolt(6.375);
    const order = await orderFor(6.375, "SO-EXACT");

    await prisma.$transaction((tx) =>
      allocate(order.id, [{ productId, storeLocationId: storeId, quantity: 6.375 }], tx),
    );
    await prisma.$transaction((tx) => consume(order.id, [{ productId, quantity: 6.375 }], tx));

    const left = await prisma.inventoryPosition.findMany({ where: { productId } });
    expect(left).toHaveLength(0);
    expect(await availableQuantity(productId, storeId, prisma)).toBe(0);
  });

  it("moves a part roll between locations", async () => {
    const user = await prisma.user.create({ data: { email: "wh@example.test" } });
    await prisma.inventoryTransfer.create({
      data: {
        productId,
        quantity: 18.75,
        fromLocation: "MILL",
        toLocation: "SHOWROOM",
        requestedByUserId: user.id,
        status: "RECEIVED",
      },
    });
    const t = await prisma.inventoryTransfer.findFirstOrThrow({ where: { productId } });
    expect(toQty(t.quantity)).toBe(18.75);
  });
});

// The columns that record stock rather than hold it -- an oversell's shortfall,
// a freeze's count, a pick list's line -- stayed Int when the balance became
// Decimal. Each one is written from a fractional quantity, so a part roll that
// reached any of them was refused by Postgres (or, on the run pick list,
// replaced by a 1).

const session = { user: { email: "wh@example.test" } } as unknown as Session;

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

async function freeze() {
  const res = makeRes();
  await freezePost(makeReq("POST", {}), res, session);
  expect(res.statusCode).toBe(201);
  return res.body;
}

async function compare(a: number, b: number) {
  const res = makeRes();
  await freezeCompare(makeReq("GET", { freezeId1: String(a), freezeId2: String(b) }), res, session);
  expect(res.statusCode).toBe(200);
  return res.body;
}

async function deliveryRunFor(salesOrderId: number, customerId: number) {
  const vehicle = await prisma.vehicle.create({ data: { name: "Box Truck 1" } });
  const appointment = await prisma.serviceAppointment.create({
    data: {
      appointmentNumber: "APPT-YARDS",
      type: "DELIVERY",
      salesOrderId,
      customerId,
      storeLocationId: storeId,
      scheduledDate: new Date("2026-10-15T15:00:00Z"),
    },
  });
  const run = await prisma.deliveryRun.create({
    data: {
      runNumber: "RUN-YARDS",
      runDate: new Date("2026-10-15T00:00:00Z"),
      vehicleId: vehicle.id,
    },
  });
  await prisma.deliveryStop.create({
    data: { deliveryRunId: run.id, serviceAppointmentId: appointment.id, stopOrder: 1 },
  });
  return run;
}

describe("fractional quantities outside the balance (real DB)", () => {
  it("records an oversold part roll as an exception instead of failing the sale", async () => {
    // allocate() reports 4.5 asked, 4.2 committed, 0.3 short. Writing that into
    // Int columns threw inside the sale's own transaction, so selling a cut the
    // shop was short of failed the sale -- the one thing overselling is
    // allowed in order to prevent.
    await bolt(4.2);
    const order = await orderFor(4.5, "SO-OVERSOLD");

    await prisma.$transaction((tx) => resyncOrderAllocation(order.id, "Mill Shop", tx));

    const exception = await prisma.inventoryException.findFirstOrThrow({
      where: { salesOrderId: order.id },
    });
    expect(toQty(exception.requested)).toBe(4.5);
    expect(toQty(exception.allocated)).toBe(4.2);
    expect(toQty(exception.shortfall)).toBe(0.3);
  });

  it("freezes a part roll at its length, and answers in numbers", async () => {
    await bolt(37.5);
    await bolt(0.125);

    const created = await freeze();
    expect(created.totalUnits).toBe(37.625);

    const res = makeRes();
    await freezeGet(makeReq("GET", { id: String(created.id) }), res, session);
    expect(res.statusCode).toBe(200);
    expect(res.body.totalUnits).toBe(37.625);
    expect(res.body.groups.MILL.items.map((i: { quantity: unknown }) => i.quantity)).toEqual([
      37.625,
    ]);
  });

  it("compares two freezes of an untouched roll as unchanged, and a cut as the cut", async () => {
    const roll = await bolt(12.5);
    const before = await freeze();
    const again = await freeze();

    expect((await compare(before.id, again.id)).differences).toEqual([]);

    await setStock(roll, 10);
    const after = await freeze();

    const { differences } = await compare(before.id, after.id);
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ quantity1: 12.5, quantity2: 10, difference: -2.5 });
  });

  it("a delivery run's pick list asks for the line's yardage, not 1", async () => {
    await bolt(30);
    const order = await orderFor(12.5, "SO-RUN");
    const run = await deliveryRunFor(order.id, order.customerId!);

    const pickList = await generatePickList(run.id, "wh@example.test");

    expect(pickList!.items.map((i) => toQty(i.quantity))).toEqual([12.5]);
  });

  it("an order's pick list is created and read back with the yardage as a number", async () => {
    await bolt(30);
    const order = await orderFor(12.5, "SO-PICK");

    const created = makeRes();
    await pickListsHandler(
      makeReq("POST", {}, { salesOrderId: String(order.id) }),
      created,
      session,
    );
    expect(created.statusCode).toBe(201);
    expect(created.body.items.map((i: { quantity: unknown }) => i.quantity)).toEqual([12.5]);

    const read = makeRes();
    await pickListHandler(makeReq("GET", { id: String(created.body.id) }), read, session);
    expect(read.statusCode).toBe(200);
    expect(read.body.items.map((i: { quantity: unknown }) => i.quantity)).toEqual([12.5]);
  });
});

describe("quantity arithmetic", () => {
  it("treats rounding noise as nothing, not as stock", () => {
    expect(qtyIsZero(0.0001)).toBe(true);
    expect(qtyIsZero(0.001)).toBe(false);
    expect(qtyEquals(2.125, 2.1250004)).toBe(true);
  });

  it("planDraw exhausts a position it has fully drawn, despite float error", () => {
    // 0.1 + 0.2 is the canonical float trap. If `exhausts` used ===, the
    // position survives at a sliver and is never cleaned up.
    const plan = planDraw([{ id: 1, quantity: 0.3 }], 0.1 + 0.2);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].exhausts).toBe(true);
    expect(plan.shortfall).toBe(0);
  });
});
