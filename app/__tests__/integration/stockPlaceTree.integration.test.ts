// /app/__tests__/integration/stockPlaceTree.integration.test.ts
//
// Places contain places (ledger plan phase 12) against real Postgres: every
// writer of a place keeps the tree sound (lib/inventory/placeTree.ts, rule 42)
// -- a parent is at the same store, a place is never inside itself, a group
// holds no stock, and a place with places inside it is not deleted out from
// under them.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { postMovement } from "@/lib/inventory/ledger";
import { landingPlaceProblem } from "@/lib/inventory/places";
import { handler as stockLocationHandler } from "@/pages/api/warehouse/stock-locations/[id]";
import { handler as storeStockLocationsHandler } from "@/pages/api/warehouse/locations/[id]/stock-locations";
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
  const store = await prisma.storeLocation.create({
    data: { name: "Mill Shop", code: "MILL", type: "STORE" },
  });
  const other = await prisma.storeLocation.create({
    data: { name: "Harbour", code: "HARB", type: "STORE" },
  });
  const barn = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BARN", name: "North Barn", locationType: "GROUP" },
  });
  const sofas = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "SOFAS", name: "Stock Sofas", parentId: barn.id },
  });
  const away = await prisma.stockLocation.create({
    data: { storeLocationId: other.id, code: "AWAY", name: "Harbour Back" },
  });
  const vendor = await prisma.vendor.create({ data: { name: "Weaver", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Upholstery" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "SOFA-01",
      name: "Camelback Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const user = await prisma.user.create({ data: { email: "placer@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { store, other, barn, sofas, away, product, session };
}

async function put(id: number, body: unknown, session: Session) {
  const res = makeRes();
  await stockLocationHandler(makeReq("PUT", { id: String(id) }, body), res, session);
  return res;
}

describe("places contain places (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a new place goes inside a place at its own store, never another store's", async () => {
    const { store, barn, away, session } = await world();

    const created = makeRes();
    await storeStockLocationsHandler(
      makeReq(
        "POST",
        { id: String(store.id) },
        { code: "SHELF", name: "Shelf 3", parentId: barn.id },
      ),
      created,
      session,
    );
    expect(created.statusCode).toBe(201);
    expect(created.body.parentId).toBe(barn.id);

    const refused = makeRes();
    await storeStockLocationsHandler(
      makeReq("POST", { id: String(store.id) }, { code: "BAD", name: "Bad", parentId: away.id }),
      refused,
      session,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toContain("same store");
    expect(await prisma.stockLocation.count({ where: { code: "BAD" } })).toBe(0);
  });

  it("moving a place refuses another store, itself, and a place inside it", async () => {
    const { barn, sofas, away, session } = await world();

    expect((await put(sofas.id, { parentId: away.id }, session)).statusCode).toBe(400);

    const self = await put(sofas.id, { parentId: sofas.id }, session);
    expect(self.statusCode).toBe(400);
    expect(self.body.error).toContain("inside itself");

    // Barn > Sofas: putting Barn inside Sofas would make a loop.
    const loop = await put(barn.id, { parentId: sofas.id }, session);
    expect(loop.statusCode).toBe(400);
    expect(loop.body.error).toContain("inside it");

    expect(await prisma.stockLocation.findUniqueOrThrow({ where: { id: barn.id } })).toMatchObject({
      parentId: null,
    });

    // Taking it out to the top of the store is fine.
    const top = await put(sofas.id, { parentId: null }, session);
    expect(top.statusCode).toBe(200);
    expect(
      (await prisma.stockLocation.findUniqueOrThrow({ where: { id: sofas.id } })).parentId,
    ).toBeNull();
  });

  it("a group holds no stock: the ledger refuses it, and a place with stock cannot become one", async () => {
    const { store, barn, sofas, product, session } = await world();

    await expect(
      postMovement(prisma, {
        productId: product.id,
        quantity: 1,
        to: { storeLocationId: store.id, stockLocationId: barn.id, salesOrderId: null },
        reason: "OPENING",
      }),
    ).rejects.toThrow("holds no stock itself");

    await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: sofas.id,
      quantity: 2,
    });
    const refused = await put(sofas.id, { locationType: "GROUP" }, session);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toContain("holds stock");
    expect(
      (await prisma.stockLocation.findUniqueOrThrow({ where: { id: sofas.id } })).locationType,
    ).toBe("STOCK");

    // Once the stock is out, it can.
    await postMovement(prisma, {
      productId: product.id,
      quantity: 2,
      from: { storeLocationId: store.id, stockLocationId: sofas.id, salesOrderId: null },
      reason: "ADJUST",
    });
    expect((await put(sofas.id, { locationType: "GROUP" }, session)).statusCode).toBe(200);
  });

  it("a group is never a landing place, even for a setting that takes any type", async () => {
    const { store, barn, sofas, session } = await world();
    expect(await landingPlaceProblem(prisma, store.id, { RETURNS: barn.id })).toBe(
      'Returns place: "North Barn" is a GROUP place; it must be a place that holds stock.',
    );
    expect(await landingPlaceProblem(prisma, store.id, { RETURNS: sofas.id })).toBeNull();

    // And the place a store lands stock in cannot be made a group.
    await prisma.storeLocation.update({
      where: { id: store.id },
      data: { returnsStockLocationId: sofas.id },
    });
    const refused = await put(sofas.id, { locationType: "GROUP" }, session);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toContain("where Mill Shop lands stock");
  });

  it("an inactive place takes no places, and a place with active places inside stays active", async () => {
    const { store, barn, sofas, session } = await world();

    const refused = await put(barn.id, { isActive: false }, session);
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toContain("1 active place(s) are inside this one");

    expect((await put(sofas.id, { isActive: false }, session)).statusCode).toBe(200);
    expect((await put(barn.id, { isActive: false }, session)).statusCode).toBe(200);

    const shelf = await prisma.stockLocation.create({
      data: { storeLocationId: store.id, code: "SHELF", name: "Shelf" },
    });
    const intoInactive = await put(shelf.id, { parentId: barn.id }, session);
    expect(intoInactive.statusCode).toBe(400);
    expect(intoInactive.body.error).toContain("inactive");
  });

  it("a place with places inside it is not deleted", async () => {
    const { barn, sofas, session } = await world();

    const res = makeRes();
    await stockLocationHandler(makeReq("DELETE", { id: String(barn.id) }), res, session);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("inside this one");
    expect(await prisma.stockLocation.count({ where: { id: barn.id } })).toBe(1);

    // Empty of places, it goes.
    await prisma.stockLocation.delete({ where: { id: sofas.id } });
    const gone = makeRes();
    await stockLocationHandler(makeReq("DELETE", { id: String(barn.id) }), gone, session);
    expect(gone.statusCode).toBe(200);
    expect(await prisma.stockLocation.count({ where: { id: barn.id } })).toBe(0);
  });

  it("the database refuses a parent that does not exist", async () => {
    const { store } = await world();
    await expect(
      prisma.stockLocation.create({
        data: { storeLocationId: store.id, code: "GHOST", name: "Ghost", parentId: 999_999 },
      }),
    ).rejects.toThrow();
  });
});
