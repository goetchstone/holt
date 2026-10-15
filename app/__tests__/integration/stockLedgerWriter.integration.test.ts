// /app/__tests__/integration/stockLedgerWriter.integration.test.ts
//
// Every path that changes stock now goes through lib/inventory/ledger.ts, the
// single writer of InventoryPosition. Each case below pins a bug that existed
// while nine files wrote the table their own way, and is written against real
// Postgres because the main one -- a unique key with two nullable columns that
// Postgres treats as distinct, so upserts through it never matched (CLAUDE.md
// rule 64) -- only exists against real Postgres.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { toQty } from "@/lib/inventory/quantity";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { allocate } from "@/lib/inventory/allocation";
import { InsufficientStockError, postMovement, setPlaceQuantity } from "@/lib/inventory/ledger";
import { handler as receiveHandler } from "@/pages/api/purchasing/orders/[id]/receive";
import { handler as returnStatusHandler } from "@/pages/api/returns/[id]/status";
import { handler as transferStatusHandler } from "@/pages/api/warehouse/transfers/[id]/status";
import { handler as positionsHandler } from "@/pages/api/warehouse/positions/index";
import { handler as orderHandler } from "@/pages/api/sales/orders/[id]";

function makeReq(
  method: string,
  query: Record<string, string>,
  body: unknown = {},
): NextApiRequest {
  return { method, query, body, headers: {} } as any;
}

function makeRes() {
  const res = {
    statusCode: 0 as number,
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
  } as any as NextApiResponse & { statusCode: number; body: any };
  return res;
}

async function scenario() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Living Room" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const storeA = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  const storeB = await prisma.storeLocation.create({
    data: { name: "Store B", code: "SB", type: "STORE" },
  });
  const backA = await prisma.stockLocation.create({
    data: { storeLocationId: storeA.id, code: "BACK", name: "Back Stock" },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "HS-1",
      name: "Harbour Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
    },
  });
  const user = await prisma.user.create({ data: { email: "warehouse@example.com" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { vendor, storeA, storeB, backA, product, user, session };
}

const rowsAt = (productId: number, storeLocationId: number, stockLocationId: number | null) =>
  prisma.inventoryPosition.findMany({
    where: { productId, storeLocationId, stockLocationId, salesOrderId: null },
  });

const totalAt = async (productId: number, storeLocationId: number) =>
  (await prisma.inventoryPosition.findMany({ where: { productId, storeLocationId } })).reduce(
    (sum, r) => sum + toQty(r.quantity),
    0,
  );

describe("InventoryPosition's single writer", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("receiving the same product twice into a store leaves one row, not two (rule 64)", async () => {
    const { vendor, storeA, product, session } = await scenario();
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PO-1",
        vendorId: vendor.id,
        lineItems: { create: [{ productId: product.id, orderedQuantity: 5 }] },
      },
      include: { lineItems: true },
    });

    for (const qty of [2, 1]) {
      const res = makeRes();
      await receiveHandler(
        makeReq(
          "POST",
          { id: String(po.id) },
          {
            storeLocationId: storeA.id,
            items: [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: qty }],
          },
        ),
        res,
        session,
      );
      expect(res.statusCode).toBe(200);
    }

    // No stock location: exactly the NULL the old upsert key could never match.
    const rows = await rowsAt(product.id, storeA.id, null);
    expect(rows).toHaveLength(1);
    expect(toQty(rows[0].quantity)).toBe(3);
  });

  it("restocking two returns to the same store merges into one free row (rule 64)", async () => {
    const { storeA, product, session } = await scenario();
    const order = await prisma.salesOrder.create({ data: { orderno: "SO-R", status: "ORDER" } });
    for (const n of [1, 2]) {
      const ret = await prisma.return.create({
        data: {
          returnNumber: `RET-${n}`,
          reason: "CUSTOMER_CHANGED_MIND",
          salesOrderId: order.id,
          productId: product.id,
          quantity: 1,
          status: "INSPECTED",
        },
      });
      const res = makeRes();
      await returnStatusHandler(
        makeReq(
          "PUT",
          { id: String(ret.id) },
          { status: "RESTOCKED", restockedLocationId: String(storeA.id) },
        ),
        res,
        session,
      );
      expect(res.statusCode).toBe(200);
    }

    const rows = await rowsAt(product.id, storeA.id, null);
    expect(rows).toHaveLength(1);
    expect(toQty(rows[0].quantity)).toBe(2);
  });

  describe("transfers", () => {
    async function transfer(
      s: Awaited<ReturnType<typeof scenario>>,
      quantity: number,
      fromStockLocationId: number | null,
    ) {
      return prisma.inventoryTransfer.create({
        data: {
          productId: s.product.id,
          quantity,
          fromLocation: s.storeA.name,
          toLocation: s.storeB.name,
          fromLocationId: s.storeA.id,
          toLocationId: s.storeB.id,
          fromStockLocationId,
          requestedByUserId: s.user.id,
          status: "DRAFT",
        },
      });
    }

    async function advance(s: Awaited<ReturnType<typeof scenario>>, id: number, status: string) {
      const res = makeRes();
      await transferStatusHandler(makeReq("PUT", { id: String(id) }, { status }), res, s.session);
      return res;
    }

    it("'any stock location' takes the units from where they actually sit, so none appear from nowhere", async () => {
      const s = await scenario();
      // Imported stock always carries a stock location. The old IN_TRANSIT
      // looked only for a row with NO stock location, found none, shipped
      // nothing -- and RECEIVED then created the units at Store B anyway.
      await postMovement(prisma, {
        productId: s.product.id,
        quantity: 3,
        to: { storeLocationId: s.storeA.id, stockLocationId: s.backA.id, salesOrderId: null },
      });
      const t = await transfer(s, 2, null);

      expect((await advance(s, t.id, "IN_TRANSIT")).statusCode).toBe(200);
      expect(await totalAt(s.product.id, s.storeA.id)).toBe(1);

      expect((await advance(s, t.id, "RECEIVED")).statusCode).toBe(200);
      expect(await totalAt(s.product.id, s.storeB.id)).toBe(2);
      // Conserved: three units before, three after.
      expect(
        (await totalAt(s.product.id, s.storeA.id)) + (await totalAt(s.product.id, s.storeB.id)),
      ).toBe(3);
    });

    it("refuses to ship more than the source holds, says why, and moves nothing", async () => {
      const s = await scenario();
      await postMovement(prisma, {
        productId: s.product.id,
        quantity: 1,
        to: { storeLocationId: s.storeA.id, stockLocationId: null, salesOrderId: null },
      });
      const t = await transfer(s, 2, null);

      const res = await advance(s, t.id, "IN_TRANSIT");
      expect(res.statusCode).toBe(409);
      expect(res.body.error).toContain("Only 1 of the 2");
      expect(await totalAt(s.product.id, s.storeA.id)).toBe(1);
      expect(
        (await prisma.inventoryTransfer.findUniqueOrThrow({ where: { id: t.id } })).status,
      ).toBe("DRAFT");
    });

    it("cancelling an in-transit transfer puts the units back in one row (rule 64)", async () => {
      const s = await scenario();
      await postMovement(prisma, {
        productId: s.product.id,
        quantity: 3,
        to: { storeLocationId: s.storeA.id, stockLocationId: null, salesOrderId: null },
      });
      const t = await transfer(s, 2, null);
      await advance(s, t.id, "IN_TRANSIT");
      expect((await advance(s, t.id, "CANCELLED")).statusCode).toBe(200);

      const rows = await rowsAt(s.product.id, s.storeA.id, null);
      expect(rows).toHaveLength(1);
      expect(toQty(rows[0].quantity)).toBe(3);
    });
  });

  it("an admin stating a quantity twice for one place leaves one row holding it (rule 64)", async () => {
    const { storeA, backA, product, session } = await scenario();
    for (const quantity of [4, 6]) {
      const res = makeRes();
      await positionsHandler(
        makeReq(
          "POST",
          {},
          {
            productId: product.id,
            storeLocationId: storeA.id,
            stockLocationId: backA.id,
            quantity,
          },
        ),
        res,
        session,
      );
      expect(res.statusCode).toBe(201);
    }
    const rows = await rowsAt(product.id, storeA.id, backA.id);
    expect(rows).toHaveLength(1);
    expect(toQty(rows[0].quantity)).toBe(6);
  });

  it("setting a place's quantity counts every row already there, so duplicates cannot add on top", async () => {
    const { storeA, backA, product } = await scenario();
    // Duplicates as the old upserts left them.
    for (const quantity of [2, 3]) {
      await prisma.inventoryPosition.create({
        data: {
          productId: product.id,
          storeLocationId: storeA.id,
          stockLocationId: backA.id,
          quantity,
        },
      });
    }
    const place = { storeLocationId: storeA.id, stockLocationId: backA.id, salesOrderId: null };

    await setPlaceQuantity(prisma, { productId: product.id, place, target: 4 });
    expect(await totalAt(product.id, storeA.id)).toBe(4);

    await setPlaceQuantity(prisma, { productId: product.id, place, target: 7 });
    expect(await totalAt(product.id, storeA.id)).toBe(7);

    await expect(
      setPlaceQuantity(prisma, { productId: product.id, place, target: -1 }),
    ).rejects.toThrow(/negative/);
  });

  it("deleting an order returns its committed stock to free stock instead of destroying it", async () => {
    const { storeA, backA, product, user } = await scenario();
    await prisma.staffMember.create({
      data: {
        displayName: "Manager",
        role: "MANAGER",
        isActive: true,
        aliases: [],
        userId: user.id,
      },
    });
    const managerSession = { user: { email: user.email, id: user.id } } as unknown as Session;
    const order = await prisma.salesOrder.create({
      data: { orderno: "SO-D", status: "ORDER", storeLocation: storeA.name },
    });
    await postMovement(prisma, {
      productId: product.id,
      quantity: 2,
      to: { storeLocationId: storeA.id, stockLocationId: backA.id, salesOrderId: null },
    });
    await allocate(
      order.id,
      [{ productId: product.id, quantity: 2, storeLocationId: storeA.id }],
      prisma,
    );

    const res = makeRes();
    await orderHandler(makeReq("DELETE", { id: String(order.id) }), res, managerSession);
    expect(res.statusCode).toBe(204);

    const free = await rowsAt(product.id, storeA.id, backA.id);
    expect(free).toHaveLength(1);
    expect(toQty(free[0].quantity)).toBe(2);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: { not: null } } })).toBe(
      0,
    );
  });

  it("refuses to take more than a place holds, and writes nothing", async () => {
    const { storeA, product } = await scenario();
    const place = { storeLocationId: storeA.id, stockLocationId: null, salesOrderId: null };
    await postMovement(prisma, { productId: product.id, quantity: 1, to: place });

    await expect(
      postMovement(prisma, { productId: product.id, quantity: 2, from: place }),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await totalAt(product.id, storeA.id)).toBe(1);
  });

  it("two registers selling the last unit at once: one gets it, the other is recorded short", async () => {
    const { storeA, product } = await scenario();
    await postMovement(prisma, {
      productId: product.id,
      quantity: 1,
      to: { storeLocationId: storeA.id, stockLocationId: null, salesOrderId: null },
    });
    const [o1, o2] = await Promise.all(
      ["SO-1", "SO-2"].map((orderno) =>
        prisma.salesOrder.create({
          data: { orderno, status: "ORDER", storeLocation: storeA.name },
        }),
      ),
    );

    const results = await Promise.all(
      [o1, o2].map((o) =>
        prisma.$transaction((tx) =>
          allocate(o.id, [{ productId: product.id, quantity: 1, storeLocationId: storeA.id }], tx),
        ),
      ),
    );

    const shortCount = results.filter((r) => r.shortfalls.length > 0).length;
    expect(shortCount).toBe(1);
    const committed = await prisma.inventoryPosition.findMany({
      where: { productId: product.id, salesOrderId: { not: null } },
    });
    expect(committed.reduce((sum, r) => sum + toQty(r.quantity), 0)).toBe(1);
    expect(await prisma.inventoryPosition.count({ where: { quantity: { lt: 0 } } })).toBe(0);
  });
});
