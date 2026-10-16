// /app/__tests__/integration/stockPlaces.integration.test.ts
//
// Ledger plan phase 3: every unit of stock has a place, and the place decides
// whether it can be sold.
//
// Before this phase InventoryPosition.stockLocationId was nullable, so stock
// could sit "at the store, nowhere in it": every reader had to remember a null
// branch, and a row could also hold zero or less forever. Now the column is NOT
// NULL, quantity > 0 is a CHECK, a caller that names only a store gets the
// store's receiving place, and a place's type (lib/inventory/locationTypes.ts)
// decides whether its free stock is for sale.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { toQty } from "@/lib/inventory/quantity";
import { allocate, availableQuantity } from "@/lib/inventory/allocation";
import { postMovement } from "@/lib/inventory/ledger";
import { RECEIVING_PLACE_CODE } from "@/lib/inventory/places";
import { getBuyersSummary } from "@/lib/reports/buyersReport";
import { handler as receiveHandler } from "@/pages/api/purchasing/orders/[id]/receive";
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
  const vendor = await prisma.vendor.create({ data: { name: "Weaver", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Textiles" } });
  const category = await prisma.category.create({
    data: { name: "Drapery", departmentId: department.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Mill Shop", code: "MILL", type: "STORE" },
  });
  const other = await prisma.storeLocation.create({
    data: { name: "Harbour", code: "HARB", type: "STORE" },
  });
  const back = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "BACK", name: "Back Stock" },
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
  const user = await prisma.user.create({ data: { email: "receiver@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { vendor, store, other, back, product, session };
}

async function placeOfType(storeLocationId: number, locationType: string, code: string) {
  return prisma.stockLocation.create({
    data: { storeLocationId, code, name: code, locationType },
  });
}

describe("every unit has a place (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a receipt with no destination lands in the store's receiving place, made once", async () => {
    const { vendor, store, product, session } = await world();
    const po = await prisma.purchaseOrder.create({
      data: {
        poNumber: "PO-RCV",
        vendorId: vendor.id,
        lineItems: { create: [{ productId: product.id, orderedQuantity: 20 }] },
      },
      include: { lineItems: true },
    });

    for (const quantityReceived of [12.5, 2.125]) {
      const res = makeRes();
      await receiveHandler(
        makeReq(
          "POST",
          { id: String(po.id) },
          {
            storeLocationId: store.id,
            items: [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived }],
          },
        ),
        res,
        session,
      );
      expect(res.statusCode).toBe(200);
    }

    const receiving = await prisma.stockLocation.findMany({
      where: { storeLocationId: store.id, code: RECEIVING_PLACE_CODE },
    });
    expect(receiving).toHaveLength(1);
    expect(receiving[0].locationType).toBe("RECEIVING");
    const storeAfter = await prisma.storeLocation.findUniqueOrThrow({ where: { id: store.id } });
    expect(storeAfter.defaultReceivingStockLocationId).toBe(receiving[0].id);

    const rows = await prisma.inventoryPosition.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].stockLocationId).toBe(receiving[0].id);
    expect(toQty(rows[0].quantity)).toBe(14.625);
    // Received and not yet put away is still for sale.
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(14.625);
  });

  it("uses the receiving place the store is set to, not a new one", async () => {
    const { store, back, product } = await world();
    await prisma.storeLocation.update({
      where: { id: store.id },
      data: { defaultReceivingStockLocationId: back.id },
    });

    const row = await stockAt({ productId: product.id, storeLocationId: store.id, quantity: 3 });

    expect(row.stockLocationId).toBe(back.id);
    expect(await prisma.stockLocation.count({ where: { code: RECEIVING_PLACE_CODE } })).toBe(0);
  });

  it("refuses to record a unit at another store's place", async () => {
    const { store, other, back, product } = await world();

    await expect(
      postMovement(prisma, {
        productId: product.id,
        quantity: 1,
        to: { storeLocationId: other.id, stockLocationId: back.id, salesOrderId: null },
        reason: "ADJUST",
      }),
    ).rejects.toThrow(`Stock location ${back.id} is not at store ${other.id}`);
    expect(await prisma.inventoryPosition.count()).toBe(0);
    expect(await prisma.stockMovement.count()).toBe(0);
    expect(store.id).not.toBe(other.id);
  });

  it("the database refuses a row with no place or nothing in it", async () => {
    const { store, back, product } = await world();

    await expect(
      prisma.$executeRaw`INSERT INTO "InventoryPosition" ("productId", "storeLocationId", "stockLocationId", quantity, updated)
        VALUES (${product.id}, ${store.id}, ${back.id}, 0, now())`,
    ).rejects.toThrow(/InventoryPosition_quantity_positive/);
    await expect(
      prisma.$executeRaw`INSERT INTO "InventoryPosition" ("productId", "storeLocationId", quantity, updated)
        VALUES (${product.id}, ${store.id}, 1, now())`,
    ).rejects.toThrow(/stockLocationId/);
  });

  it("stock in quarantine, in transit or staged is owned, not for sale", async () => {
    const { store, back, product } = await world();
    const quarantine = await placeOfType(store.id, "QUARANTINE", "QUAR");
    const transit = await placeOfType(store.id, "TRANSIT", "TRANS");
    const staging = await placeOfType(store.id, "STAGING", "DOCK");
    for (const place of [quarantine, transit, staging]) {
      await stockAt({
        productId: product.id,
        storeLocationId: store.id,
        stockLocationId: place.id,
        quantity: 5,
      });
    }
    await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: back.id,
      quantity: 2,
    });

    expect(await availableQuantity(product.id, store.id, prisma)).toBe(2);

    const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-Q",
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocation: store.name,
      },
    });
    const result = await allocate(
      order.id,
      [{ productId: product.id, storeLocationId: store.id, quantity: 4 }],
      prisma,
    );
    // Only the 2 in back stock could be committed; the 15 elsewhere stayed put.
    expect(result.shortfalls[0]).toMatchObject({ allocated: 2, shortfall: 2 });
    const committed = await prisma.inventoryPosition.findMany({
      where: { salesOrderId: order.id },
    });
    expect(committed.map((r) => r.stockLocationId)).toEqual([back.id]);
  });

  it("a stock location can only be given a type from the catalog", async () => {
    const { store, back, session } = await world();

    const created = makeRes();
    await storeStockLocationsHandler(
      makeReq(
        "POST",
        { id: String(store.id) },
        { code: "Q1", name: "Damaged", locationType: "QUARANTINE" },
      ),
      created,
      session,
    );
    expect(created.statusCode).toBe(201);

    const refused = makeRes();
    await storeStockLocationsHandler(
      makeReq(
        "POST",
        { id: String(store.id) },
        { code: "Q2", name: "Typo", locationType: "QUARANTEEN" },
      ),
      refused,
      session,
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.body.error).toContain("QUARANTINE");

    const edit = makeRes();
    await stockLocationHandler(
      makeReq("PUT", { id: String(back.id) }, { locationType: "STOCKROOM" }),
      edit,
      session,
    );
    expect(edit.statusCode).toBe(400);
    expect(
      (await prisma.stockLocation.findUniqueOrThrow({ where: { id: back.id } })).locationType,
    ).toBe("STOCK");
  });

  it("a place stock has moved through is kept: delete is refused, deactivate is the way", async () => {
    const { store, back, product, session } = await world();
    const row = await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: back.id,
      quantity: 1,
    });
    // Move it all out, so no position references the place any more.
    await postMovement(prisma, {
      productId: product.id,
      quantity: 1,
      from: { storeLocationId: store.id, stockLocationId: back.id, salesOrderId: null },
      reason: "ADJUST",
    });
    expect(await prisma.inventoryPosition.count({ where: { id: row.id } })).toBe(0);

    const res = makeRes();
    await stockLocationHandler(makeReq("DELETE", { id: String(back.id) }), res, session);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("Deactivate");
    expect(await prisma.stockLocation.count({ where: { id: back.id } })).toBe(1);
  });
});

describe("the Buyers report reads stock as the allocator does (real DB)", () => {
  const RANGE = { startDate: "2026-01-01", endDate: "2026-12-31" };

  beforeEach(async () => {
    await resetTestDb();
  });

  it("keeps a part roll's fraction instead of rounding it to a whole unit", async () => {
    // The sums were cast to bigint: 12.625 read 13, and a 0.375 remnant read 0.
    const { store, back, product } = await world();
    await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: back.id,
      quantity: 12.625,
    });

    const summary = await getBuyersSummary(prisma, RANGE);

    expect(summary.totals.onHand).toBe(12.625);
  });

  it("counts stock committed to an order as the customer's, and quarantine as neither", async () => {
    const { store, back, product } = await world();
    const quarantine = await placeOfType(store.id, "QUARANTINE", "QUAR");
    await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: back.id,
      quantity: 5,
    });
    await stockAt({
      productId: product.id,
      storeLocationId: store.id,
      stockLocationId: quarantine.id,
      quantity: 4,
    });
    const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-B",
        status: "ORDER",
        orderDate: new Date(),
        customerId: customer.id,
        storeLocation: store.name,
      },
    });
    await allocate(
      order.id,
      [{ productId: product.id, storeLocationId: store.id, quantity: 2 }],
      prisma,
    );

    const summary = await getBuyersSummary(prisma, RANGE);

    // 5 in back stock, 2 of them committed: 3 on the floor, 2 the customer's.
    // The 4 in quarantine are owned but neither available nor spoken for.
    expect(summary.totals.onHand).toBe(3);
    expect(summary.totals.customerStock).toBe(2);
  });
});
