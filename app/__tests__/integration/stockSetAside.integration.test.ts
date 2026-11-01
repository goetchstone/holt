// /app/__tests__/integration/stockSetAside.integration.test.ts
//
// GAP-15 and GAP-16: stock that isn't for sale.
//
// Floor samples (GAP-15): a floor model was stock in a FLOOR place, which the
// allocator drew last for any sale, so nothing kept the sample on the floor. A
// DISPLAY place's stock is owned and counted but drawn by nothing except a
// take-with sale at its own store, last: the customer carrying out that piece.
//
// Damaged (GAP-16): "damaged" existed only at a PO receipt and on a customer
// return. Stock already on hand can now be set aside into the store's
// quarantine place, then put back on sale or written off.
//
// Discontinued (GAP-16): Product.isDiscontinued was set only by the POS import.
// Staff set it now, and the PO pickers leave a discontinued product out.
//
// Real routes, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { allocate, availableQuantity } from "@/lib/inventory/allocation";
import { recordShortfalls } from "@/lib/inventory/orderInventorySync";
import { handler as damagedRoute } from "@/pages/api/inventory/set-aside/damaged";
import { handler as dispositionRoute } from "@/pages/api/inventory/set-aside/[positionId]";
import { handler as listRoute } from "@/pages/api/inventory/set-aside/index";
import { handler as stockLocationRoute } from "@/pages/api/warehouse/stock-locations/[id]";
import { handler as vendorProductsRoute } from "@/pages/api/purchasing/vendor-products";
import productRoute from "@/pages/api/products/[id]";
import productListRoute from "@/pages/api/products/index";
import { stockAt } from "../helpers/stock";

const warehouse = { user: { email: "warehouse@example.com" } } as unknown as Session;

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
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
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as TestRes;
}

function request(method: string, query: Record<string, string>, body?: unknown): NextApiRequest {
  return { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest;
}

/** Two stores; at the first a stock room, a display and a sales floor; a sofa. */
async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Furniture" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  const other = await prisma.storeLocation.create({
    data: { name: "Store B", code: "SB", type: "STORE" },
  });
  const place = (storeLocationId: number, code: string, locationType: string) =>
    prisma.stockLocation.create({
      data: { storeLocationId, code, name: code, locationType },
    });
  const stockRoom = await place(store.id, "STOCK-1", "STOCK");
  const display = await place(store.id, "DISPLAY-1", "DISPLAY");
  const floor = await place(store.id, "FLOOR-1", "FLOOR");
  const staging = await place(store.id, "STAGING-1", "STAGING");
  const otherRoom = await place(other.id, "STOCK-B", "STOCK");
  const sofa = await prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Camelback Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseRetail: 1000,
    },
  });
  return { vendor, store, other, stockRoom, display, floor, staging, otherRoom, sofa };
}

type World = Awaited<ReturnType<typeof world>>;

async function order(w: World) {
  return prisma.salesOrder.create({
    data: { orderno: `SO-${Math.random()}`, status: "ORDER", storeLocation: w.store.name },
  });
}

async function sell(w: World, orderId: number, takeWith: boolean, quantity = 1) {
  return prisma.$transaction(async (tx) => {
    const result = await allocate(
      orderId,
      [{ productId: w.sofa.id, quantity, storeLocationId: w.store.id, takeWith }],
      tx,
    );
    await recordShortfalls(orderId, result.shortfalls, tx);
    return result;
  });
}

async function unitsAt(stockLocationId: number, salesOrderId?: number | null): Promise<number> {
  const sum = await prisma.inventoryPosition.aggregate({
    where: {
      stockLocationId,
      ...(salesOrderId !== undefined ? { salesOrderId } : {}),
    },
    _sum: { quantity: true },
  });
  return Number(sum._sum.quantity ?? 0);
}

async function damaged(body: unknown) {
  const res = makeRes();
  await damagedRoute(request("POST", {}, body), res, warehouse);
  return res;
}

async function dispose(positionId: number, body: unknown) {
  const res = makeRes();
  await dispositionRoute(request("POST", { positionId: String(positionId) }, body), res, warehouse);
  return res;
}

async function rowAt(stockLocationId: number) {
  return prisma.inventoryPosition.findFirstOrThrow({ where: { stockLocationId } });
}

async function quarantineOf(storeLocationId: number) {
  const store = await prisma.storeLocation.findUniqueOrThrow({ where: { id: storeLocationId } });
  return store.quarantineStockLocationId as number;
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("floor samples stay put (GAP-15)", () => {
  it("a sale for delivery never draws a floor sample: it goes short instead", async () => {
    const w = await world();
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.display.id,
      quantity: 1,
    });
    const o = await order(w);

    const result = await sell(w, o.id, false);

    expect(result.shortfalls).toEqual([expect.objectContaining({ shortfall: 1 })]);
    expect(await unitsAt(w.display.id, null)).toBe(1);
    expect(await availableQuantity(w.sofa.id, w.store.id, prisma)).toBe(0);
  });

  it("a take-with sale draws the floor piece and back stock before the sample", async () => {
    const w = await world();
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.display.id,
      quantity: 1,
    });
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 1,
    });
    const o = await order(w);

    await sell(w, o.id, true);

    expect(await unitsAt(w.stockRoom.id, o.id)).toBe(1);
    expect(await unitsAt(w.display.id, null)).toBe(1);
  });

  it("a take-with sale with nothing else at the store carries out the sample itself", async () => {
    const w = await world();
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.display.id,
      quantity: 1,
    });
    const o = await order(w);

    const result = await sell(w, o.id, true);

    expect(result.shortfalls).toEqual([]);
    expect(await unitsAt(w.display.id, o.id)).toBe(1);
  });

  it("a store makes a place a display from Warehouse › Locations", async () => {
    const w = await world();
    const res = makeRes();
    await stockLocationRoute(
      request("PUT", { id: String(w.floor.id) }, { locationType: "DISPLAY" }),
      res,
      warehouse,
    );
    expect(res.statusCode).toBe(200);
    const place = await prisma.stockLocation.findUniqueOrThrow({ where: { id: w.floor.id } });
    expect(place.locationType).toBe("DISPLAY");
  });
});

describe("stock set aside as damaged (GAP-16)", () => {
  it("goes to the store's quarantine place, off sale, with what is wrong on the journal", async () => {
    const w = await world();
    const row = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 2,
    });

    const res = await damaged({ positionId: row.id, quantity: 1, note: "  Torn arm  " });

    expect(res.statusCode).toBe(200);
    const quarantine = await quarantineOf(w.store.id);
    expect(res.body).toEqual({ stockLocationId: quarantine });
    expect([await unitsAt(w.stockRoom.id), await unitsAt(quarantine)]).toEqual([1, 1]);
    expect(await availableQuantity(w.sofa.id, w.store.id, prisma)).toBe(1);
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { reason: "DAMAGE" } });
    expect([Number(movement.quantity), movement.note]).toEqual([1, "Damaged: Torn arm"]);
    expect((await rowAt(quarantine)).notes).toBe("Damaged: Torn arm");
  });

  it("taken from an order, the order draws another unit or goes short", async () => {
    const w = await world();
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 1,
    });
    const o = await order(w);
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: o.id,
        productId: w.sofa.id,
        orderedQuantity: 1,
        netPrice: 1000,
        cost: 0,
      },
    });
    await sell(w, o.id, false);
    const committed = await prisma.inventoryPosition.findFirstOrThrow({
      where: { salesOrderId: o.id },
    });

    // Spare stock: the order draws it in place of the damaged unit.
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.floor.id,
      quantity: 1,
    });
    await damaged({ positionId: committed.id, quantity: 1, note: "Dropped" });
    expect(await unitsAt(w.floor.id, o.id)).toBe(1);

    // No spare left: the next damaged unit leaves the order short.
    const again = await prisma.inventoryPosition.findFirstOrThrow({
      where: { salesOrderId: o.id },
    });
    await damaged({ positionId: again.id, quantity: 1, note: "Dropped again" });
    const short = await prisma.inventoryException.findFirstOrThrow({
      where: { salesOrderId: o.id },
    });
    expect([Number(short.shortfall), short.resolvedAt]).toEqual([1, null]);
    expect(await unitsAt(await quarantineOf(w.store.id), null)).toBe(2);
  });

  it("refuses, saying why: no note, too many, none, already set aside, gone", async () => {
    const w = await world();
    const row = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 2,
    });
    const cases: [unknown, number, RegExp][] = [
      [{ positionId: row.id, quantity: 1, note: " " }, 400, /what is wrong/],
      [{ positionId: row.id, quantity: 3, note: "x" }, 400, /Only 2 are there/],
      [{ positionId: row.id, quantity: 0, note: "x" }, 400, /more than 0/],
      [{ positionId: 999999, quantity: 1, note: "x" }, 404, /no longer there/],
      [{ positionId: "1", quantity: 1, note: "x" }, 400, /positionId/],
    ];
    for (const [body, status, message] of cases) {
      const res = await damaged(body);
      expect([res.statusCode, res.body.error]).toEqual([status, expect.stringMatching(message)]);
    }
    await damaged({ positionId: row.id, quantity: 1, note: "Torn" });
    const set = await rowAt(await quarantineOf(w.store.id));
    const twice = await damaged({ positionId: set.id, quantity: 1, note: "Still torn" });
    expect([twice.statusCode, twice.body.error]).toEqual([
      409,
      expect.stringMatching(/already set aside/),
    ]);
    expect(await unitsAt(w.stockRoom.id)).toBe(1);
  });
});

describe("what is set aside, and what happens to it", () => {
  it("is listed, with what was wrong; a store's returns place and an incomplete set are told apart", async () => {
    const w = await world();
    const row = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 1,
    });
    await damaged({ positionId: row.id, quantity: 1, note: "Torn" });
    // Store B points its returns place at a quarantine place: the returned-stock
    // queue looks after that one.
    const returnsQ = await prisma.stockLocation.create({
      data: {
        storeLocationId: w.other.id,
        code: "RQ",
        name: "Returns quarantine",
        locationType: "QUARANTINE",
      },
    });
    await prisma.storeLocation.update({
      where: { id: w.other.id },
      data: { returnsStockLocationId: returnsQ.id },
    });
    await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.other.id,
      stockLocationId: returnsQ.id,
      quantity: 1,
    });

    const res = makeRes();
    await listRoute(request("GET", {}), res);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        productNumber: "SOFA-1",
        storeName: "Store A",
        quantity: 1,
        note: "Damaged: Torn",
        incompleteSet: false,
      }),
    ]);

    await prisma.boxNote.create({
      data: {
        kind: "INCOMPLETE",
        productId: w.sofa.id,
        storeLocationId: w.store.id,
        stockLocationId: await quarantineOf(w.store.id),
        boxes: [2],
        boxesPerUnit: 2,
      },
    });
    const again = makeRes();
    await listRoute(request("GET", {}), again);
    expect(again.body.items[0].incompleteSet).toBe(true);
  });

  it("goes back on sale at a sellable place in its store, and nowhere else", async () => {
    const w = await world();
    const row = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 2,
    });
    await damaged({ positionId: row.id, quantity: 2, note: "Scuffed" });
    const set = await rowAt(await quarantineOf(w.store.id));

    for (const [stockLocationId, message] of [
      [w.staging.id, /not a place stock is sold from/],
      [w.display.id, /not a place stock is sold from/],
      [w.otherRoom.id, /different store/],
      [999999, /doesn't exist/],
    ] as const) {
      const res = await dispose(set.id, { action: "put-back", quantity: 1, stockLocationId });
      expect([res.statusCode, res.body.error]).toEqual([400, expect.stringMatching(message)]);
    }

    const res = await dispose(set.id, {
      action: "put-back",
      quantity: 1,
      stockLocationId: w.floor.id,
    });
    expect(res.statusCode).toBe(200);
    expect([await unitsAt(w.floor.id), await unitsAt(set.stockLocationId)]).toEqual([1, 1]);
    expect(await availableQuantity(w.sofa.id, w.store.id, prisma)).toBe(1);
  });

  it("is written off with why, out of the books", async () => {
    const w = await world();
    const row = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 1,
    });
    await damaged({ positionId: row.id, quantity: 1, note: "Frame cracked" });
    const set = await rowAt(await quarantineOf(w.store.id));

    const noWhy = await dispose(set.id, { action: "write-off", quantity: 1, note: "" });
    expect([noWhy.statusCode, noWhy.body.error]).toEqual([400, expect.stringMatching(/why/)]);

    const res = await dispose(set.id, { action: "write-off", quantity: 1, note: "Not repairable" });
    expect(res.statusCode).toBe(200);
    expect(await prisma.inventoryPosition.count({ where: { productId: w.sofa.id } })).toBe(0);
    const off = await prisma.stockMovement.findFirstOrThrow({ where: { reason: "WRITE_OFF" } });
    expect([off.toStoreLocationId, off.note]).toEqual([null, "Not repairable"]);
  });

  it("refuses stock that isn't set aside, a returns place, and an incomplete set", async () => {
    const w = await world();
    const loose = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: w.stockRoom.id,
      quantity: 1,
    });
    const notAside = await dispose(loose.id, { action: "write-off", quantity: 1, note: "x" });
    expect([notAside.statusCode, notAside.body.error]).toEqual([
      409,
      expect.stringMatching(/isn't set aside/),
    ]);

    const returnsQ = await prisma.stockLocation.create({
      data: {
        storeLocationId: w.store.id,
        code: "RQ",
        name: "Returns quarantine",
        locationType: "QUARANTINE",
      },
    });
    await prisma.storeLocation.update({
      where: { id: w.store.id },
      data: { returnsStockLocationId: returnsQ.id },
    });
    const returned = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: returnsQ.id,
      quantity: 1,
    });
    const fromReturns = await dispose(returned.id, { action: "write-off", quantity: 1, note: "x" });
    expect([fromReturns.statusCode, fromReturns.body.error]).toEqual([
      409,
      expect.stringMatching(/Returned stock/),
    ]);

    const q = await prisma.stockLocation.create({
      data: {
        storeLocationId: w.store.id,
        code: "Q2",
        name: "Quarantine 2",
        locationType: "QUARANTINE",
      },
    });
    const set = await stockAt({
      productId: w.sofa.id,
      storeLocationId: w.store.id,
      stockLocationId: q.id,
      quantity: 1,
    });
    await prisma.boxNote.create({
      data: {
        kind: "INCOMPLETE",
        productId: w.sofa.id,
        storeLocationId: w.store.id,
        stockLocationId: q.id,
        boxes: [2],
        boxesPerUnit: 2,
      },
    });
    const incomplete = await dispose(set.id, {
      action: "put-back",
      quantity: 1,
      stockLocationId: w.floor.id,
    });
    expect([incomplete.statusCode, incomplete.body.error]).toEqual([
      409,
      expect.stringMatching(/incomplete set/),
    ]);

    const bad = await dispose(set.id, { action: "repair", quantity: 1 });
    expect(bad.statusCode).toBe(400);
  });
});

describe("staff set a product discontinued (GAP-16)", () => {
  async function asAdmin() {
    await syncBuiltInRoles({ prisma });
    await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    await prisma.staffMember.create({
      data: {
        userId: "owner",
        email: "owner@example.com",
        displayName: "Owner",
        role: "ADMIN",
        roleId: role.id,
      },
    });
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { id: "owner", email: "owner@example.com" },
    });
  }

  async function patch(productId: number, body: unknown) {
    const res = makeRes();
    await productRoute(request("PATCH", { id: String(productId) }, body), res);
    return res;
  }

  async function orderable(w: World): Promise<string[]> {
    const res = makeRes();
    await vendorProductsRoute(request("GET", { vendorId: String(w.vendor.id) }), res, warehouse, {
      holds: { "catalog.cost": false },
    });
    return res.body.products.map((p: { productNumber: string }) => p.productNumber);
  }

  it("is saved, and a purchase order no longer offers it; clearing it brings it back", async () => {
    const w = await world();
    await asAdmin();
    await prisma.product.update({ where: { id: w.sofa.id }, data: { serviceType: "DELIVERY" } });
    expect(await orderable(w)).toEqual(["SOFA-1"]);

    expect((await patch(w.sofa.id, { isDiscontinued: true })).statusCode).toBe(200);
    const saved = await prisma.product.findUniqueOrThrow({ where: { id: w.sofa.id } });
    // A field the PATCH didn't send is left alone.
    expect([saved.isDiscontinued, saved.serviceType]).toEqual([true, "DELIVERY"]);
    expect(await orderable(w)).toEqual([]);

    expect((await patch(w.sofa.id, { isDiscontinued: false })).statusCode).toBe(200);
    expect(await orderable(w)).toEqual(["SOFA-1"]);

    const bad = await patch(w.sofa.id, { isDiscontinued: "yes" });
    expect([bad.statusCode, bad.body.error]).toEqual([400, expect.stringMatching(/true or false/)]);
  });

  it("the product list sends every field its edit form saves, so an edit there clears nothing", async () => {
    const w = await world();
    await asAdmin();
    const group = await prisma.taxGroup.create({ data: { name: "Furniture" } });
    await prisma.product.update({
      where: { id: w.sofa.id },
      data: { boxesPerUnit: 3, taxGroupId: group.id, isDiscontinued: true },
    });
    const res = makeRes();
    await productListRoute(request("GET", { page: "1", limit: "10", search: "" }), res);
    expect(res.body.products[0]).toMatchObject({
      boxesPerUnit: 3,
      taxGroupId: group.id,
      isDiscontinued: true,
    });
  });
});
