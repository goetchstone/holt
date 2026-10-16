// /app/__tests__/integration/warehouseQuantities.integration.test.ts
//
// A stock quantity reaches a screen as a number.
//
// InventoryPosition.quantity and InventoryTransfer.quantity are Decimal(12,3),
// so a part roll is exact. JSON writes a Prisma Decimal as a string ("12.625"),
// and every screen that adds quantities up does it with `+`: the register's
// `(n || 0) + p.quantity` turns 3 on hand into "03". So each route that sends a
// position or a transfer converts the quantity with toQty at the response.
//
// Every route under warehouse/positions and warehouse/transfers is called here
// with a 12.625 quantity (an eighth of a yard past 12.5) and must answer with
// that number, not with text.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler as positionsHandler } from "@/pages/api/warehouse/positions/index";
import { handler as positionHandler } from "@/pages/api/warehouse/positions/[id]";
import { handler as transfersHandler } from "@/pages/api/warehouse/transfers/index";
import { handler as transferHandler } from "@/pages/api/warehouse/transfers/[id]";
import { handler as transferStatusHandler } from "@/pages/api/warehouse/transfers/[id]/status";

const ROLL = 12.625;

function makeReq(method: string, query: Record<string, string>, body: unknown = {}) {
  return { method, query, body, headers: {} } as unknown as NextApiRequest;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    // Through JSON, as res.json sends it, so the body is what a screen gets:
    // a Decimal left in the response arrives as "12.625", not as an object.
    json(payload: unknown) {
      this.body = JSON.parse(JSON.stringify(payload));
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

async function scenario() {
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
  const mill = await prisma.storeLocation.create({
    data: { name: "Mill Shop", code: "MILL", type: "STORE" },
  });
  const annex = await prisma.storeLocation.create({
    data: { name: "Annex", code: "ANX", type: "STORE" },
  });
  const shelf = await prisma.stockLocation.create({
    data: { storeLocationId: mill.id, code: "SHELF", name: "Bolt Shelf" },
  });
  const user = await prisma.user.create({ data: { email: "wh@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { product, mill, annex, shelf, user, session };
}

beforeEach(async () => {
  await resetTestDb();
});

describe("positions routes send the quantity as a number (real DB)", () => {
  it("GET lists a part roll as 12.625, and two rows add up as numbers", async () => {
    const s = await scenario();
    await prisma.inventoryPosition.create({
      data: { productId: s.product.id, storeLocationId: s.mill.id, quantity: ROLL },
    });
    await prisma.inventoryPosition.create({
      data: {
        productId: s.product.id,
        storeLocationId: s.mill.id,
        stockLocationId: s.shelf.id,
        quantity: 3,
      },
    });

    const res = makeRes();
    await positionsHandler(makeReq("GET", { productId: String(s.product.id) }), res, s.session);

    expect(res.statusCode).toBe(200);
    const quantities = res.body.positions.map((p: { quantity: unknown }) => p.quantity);
    for (const q of quantities) expect(typeof q).toBe("number");
    expect([...quantities].sort((a, b) => a - b)).toEqual([3, ROLL]);

    // The register's own sum. With strings this is "012.6253" (or "03" for a
    // single row of 3), not stock.
    const onHand = res.body.positions.reduce(
      (n: number, p: { quantity: number }) => (n || 0) + p.quantity,
      0,
    );
    expect(onHand).toBe(15.625);
  });

  it("POST answers with the place's quantity as a number", async () => {
    const s = await scenario();

    const res = makeRes();
    await positionsHandler(
      makeReq("POST", {}, { productId: s.product.id, storeLocationId: s.mill.id, quantity: ROLL }),
      res,
      s.session,
    );

    expect(res.statusCode).toBe(201);
    expect(typeof res.body.quantity).toBe("number");
    expect(res.body.quantity).toBe(ROLL);
  });

  it("PUT answers with the edited place's quantity as a number", async () => {
    const s = await scenario();
    const row = await prisma.inventoryPosition.create({
      data: { productId: s.product.id, storeLocationId: s.mill.id, quantity: 20 },
    });

    const res = makeRes();
    await positionHandler(
      makeReq("PUT", { id: String(row.id) }, { quantity: ROLL }),
      res,
      s.session,
    );

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.quantity).toBe("number");
    expect(res.body.quantity).toBe(ROLL);
  });
});

describe("transfers routes send the quantity as a number (real DB)", () => {
  async function createTransfer(s: Awaited<ReturnType<typeof scenario>>) {
    const res = makeRes();
    await transfersHandler(
      makeReq(
        "POST",
        {},
        {
          productId: s.product.id,
          fromLocationId: s.mill.id,
          toLocationId: s.annex.id,
          quantity: ROLL,
        },
      ),
      res,
      s.session,
    );
    return res;
  }

  it("POST answers with the new transfer's quantity as a number", async () => {
    const s = await scenario();

    const res = await createTransfer(s);

    expect(res.statusCode).toBe(201);
    expect(typeof res.body.quantity).toBe("number");
    expect(res.body.quantity).toBe(ROLL);
  });

  it("GET lists a part roll as 12.625", async () => {
    const s = await scenario();
    const created = await createTransfer(s);
    expect(created.statusCode).toBe(201);

    const list = makeRes();
    await transfersHandler(makeReq("GET", {}), list, s.session);
    expect(list.statusCode).toBe(200);
    expect(list.body.transfers).toHaveLength(1);
    expect(typeof list.body.transfers[0].quantity).toBe("number");
    expect(list.body.transfers[0].quantity).toBe(ROLL);
  });

  it("GET by id sends a part roll as 12.625", async () => {
    const s = await scenario();
    const created = await createTransfer(s);
    expect(created.statusCode).toBe(201);

    const one = makeRes();
    await transferHandler(makeReq("GET", { id: String(created.body.id) }), one);
    expect(one.statusCode).toBe(200);
    expect(typeof one.body.quantity).toBe("number");
    expect(one.body.quantity).toBe(ROLL);
  });

  it("PUT status answers with the shipped transfer's quantity as a number", async () => {
    const s = await scenario();
    await prisma.inventoryPosition.create({
      data: { productId: s.product.id, storeLocationId: s.mill.id, quantity: 30 },
    });
    const created = await createTransfer(s);
    expect(created.statusCode).toBe(201);

    const res = makeRes();
    await transferStatusHandler(
      makeReq("PUT", { id: String(created.body.id) }, { status: "IN_TRANSIT" }),
      res,
      s.session,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("IN_TRANSIT");
    expect(typeof res.body.quantity).toBe("number");
    expect(res.body.quantity).toBe(ROLL);
  });
});
