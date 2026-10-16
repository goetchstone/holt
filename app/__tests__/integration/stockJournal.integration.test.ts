// /app/__tests__/integration/stockJournal.integration.test.ts
//
// Ledger plan phase 4: every change to stock is written down.
//
// lib/inventory/ledger.ts postMovement writes a StockMovement row with every
// change to InventoryPosition, in the same transaction: what moved, from where
// to where, why, and the document that moved it. The journal is append-only (a
// trigger refuses UPDATE and DELETE), so the balance at any place can always
// be re-derived from it, and ledgerDrift() reports any place where it cannot.
// jest.integration.afterEach.ts runs that check after every integration test.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { allocate, consume, release } from "@/lib/inventory/allocation";
import { InsufficientStockError, ledgerDrift, postMovement } from "@/lib/inventory/ledger";
import { handler as transferStatusHandler } from "@/pages/api/warehouse/transfers/[id]/status";
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
  const department = await prisma.department.create({ data: { name: "Living" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
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
  const floorB = await prisma.stockLocation.create({
    data: { storeLocationId: storeB.id, code: "FLOOR", name: "Floor", locationType: "FLOOR" },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "HS-1",
      name: "Harbour Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const user = await prisma.user.create({ data: { email: "warehouse@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  const customer = await prisma.customer.create({ data: { firstName: "C", lastName: "D" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-J",
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      storeLocation: storeA.name,
    },
  });
  return { storeA, storeB, backA, floorB, product, user, session, order };
}

const journal = () =>
  prisma.stockMovement.findMany({
    orderBy: { id: "asc" },
    select: {
      reason: true,
      quantity: true,
      sourceType: true,
      sourceId: true,
      fromStockLocationId: true,
      fromSalesOrderId: true,
      toStockLocationId: true,
      toSalesOrderId: true,
    },
  });

describe("the stock journal (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("records a sale's commit, release and delivery against the order", async () => {
    const { storeA, backA, product, order } = await world();
    await stockAt({
      productId: product.id,
      storeLocationId: storeA.id,
      stockLocationId: backA.id,
      quantity: 5,
    });

    await allocate(
      order.id,
      [{ productId: product.id, storeLocationId: storeA.id, quantity: 3 }],
      prisma,
    );
    await release(order.id, prisma);
    await allocate(
      order.id,
      [{ productId: product.id, storeLocationId: storeA.id, quantity: 2 }],
      prisma,
    );
    await consume(order.id, [{ productId: product.id, quantity: 2 }], prisma);

    const rows = await journal();
    expect(rows.map((r) => [r.reason, Number(r.quantity)])).toEqual([
      ["OPENING", 5],
      ["ALLOCATE", 3],
      ["RELEASE", 3],
      ["ALLOCATE", 2],
      ["DELIVER", 2],
    ]);
    // Allocation changes the owner, not the place; delivery leaves the books.
    expect(rows[1]).toMatchObject({
      sourceType: "SalesOrder",
      sourceId: order.id,
      fromStockLocationId: backA.id,
      fromSalesOrderId: null,
      toStockLocationId: backA.id,
      toSalesOrderId: order.id,
    });
    expect(rows[4]).toMatchObject({ fromSalesOrderId: order.id, toStockLocationId: null });
    expect(await ledgerDrift(prisma)).toEqual([]);
  });

  it("records a transfer's ship and receipt against the transfer", async () => {
    const { storeA, storeB, backA, floorB, product, user, session } = await world();
    await stockAt({
      productId: product.id,
      storeLocationId: storeA.id,
      stockLocationId: backA.id,
      quantity: 4,
    });
    const transfer = await prisma.inventoryTransfer.create({
      data: {
        productId: product.id,
        quantity: 2.5,
        fromLocation: "SA",
        toLocation: "SB",
        fromLocationId: storeA.id,
        toLocationId: storeB.id,
        fromStockLocationId: backA.id,
        toStockLocationId: floorB.id,
        requestedByUserId: user.id,
        status: "DRAFT",
      },
    });

    for (const status of ["IN_TRANSIT", "RECEIVED"]) {
      const res = makeRes();
      await transferStatusHandler(
        makeReq("PUT", { id: String(transfer.id) }, { status }),
        res,
        session,
      );
      expect(res.statusCode).toBe(200);
    }

    const moves = (await journal()).filter((r) => r.reason === "TRANSFER");
    expect(moves).toHaveLength(2);
    for (const move of moves) {
      expect(move).toMatchObject({ sourceType: "InventoryTransfer", sourceId: transfer.id });
      expect(Number(move.quantity)).toBe(2.5);
    }
    expect(moves[0].fromStockLocationId).toBe(backA.id);
    expect(moves[1].toStockLocationId).toBe(floorB.id);
  });

  it("records an admin's edit and delete as corrections by hand", async () => {
    const { storeA, backA, product, session } = await world();
    const row = await stockAt({
      productId: product.id,
      storeLocationId: storeA.id,
      stockLocationId: backA.id,
      quantity: 6,
    });

    const edit = makeRes();
    await positionHandler(makeReq("PUT", { id: String(row.id) }, { quantity: 4 }), edit, session);
    expect(edit.statusCode).toBe(200);
    const gone = makeRes();
    await positionHandler(makeReq("DELETE", { id: String(edit.body.id) }), gone, session);
    expect(gone.statusCode).toBe(200);

    const rows = await journal();
    expect(rows.map((r) => [r.reason, Number(r.quantity)])).toEqual([
      ["OPENING", 6],
      ["ADJUST", 2],
      ["ADJUST", 4],
    ]);
    expect(await prisma.inventoryPosition.count()).toBe(0);
  });

  it("a movement that is refused writes nothing, in the balance or the journal", async () => {
    const { storeA, backA, product } = await world();
    await stockAt({
      productId: product.id,
      storeLocationId: storeA.id,
      stockLocationId: backA.id,
      quantity: 1,
    });

    await expect(
      postMovement(prisma, {
        productId: product.id,
        quantity: 2,
        from: { storeLocationId: storeA.id, stockLocationId: backA.id, salesOrderId: null },
        reason: "ADJUST",
      }),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect((await journal()).map((r) => r.reason)).toEqual(["OPENING"]);
  });

  it("refuses an unknown reason before it touches stock", async () => {
    const { storeA, backA, product } = await world();
    await expect(
      postMovement(prisma, {
        productId: product.id,
        quantity: 1,
        to: { storeLocationId: storeA.id, stockLocationId: backA.id, salesOrderId: null },
        reason: "BECAUSE" as never,
      }),
    ).rejects.toThrow("Unknown stock movement reason");
    expect(await prisma.inventoryPosition.count()).toBe(0);
  });

  it("the journal cannot be rewritten", async () => {
    const { storeA, backA, product } = await world();
    await stockAt({
      productId: product.id,
      storeLocationId: storeA.id,
      stockLocationId: backA.id,
      quantity: 1,
    });
    const [first] = await prisma.stockMovement.findMany();

    await expect(
      prisma.stockMovement.update({ where: { id: first.id }, data: { quantity: 9 } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.stockMovement.delete({ where: { id: first.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it("ledgerDrift names a place whose stock was written without the journal", async () => {
    // The check exists to disagree. Prove it can: write a balance the way no
    // production path may (stockWriterTripwire.test.ts), and it is reported.
    const { storeA, backA, product } = await world();
    await stockAt({
      productId: product.id,
      storeLocationId: storeA.id,
      stockLocationId: backA.id,
      quantity: 2,
    });
    await prisma.$executeRaw`UPDATE "InventoryPosition" SET quantity = quantity + 1`;

    expect(await ledgerDrift(prisma)).toEqual([
      {
        productId: product.id,
        storeLocationId: storeA.id,
        stockLocationId: backA.id,
        salesOrderId: null,
        journal: 2,
        balance: 3,
      },
    ]);
    expect(await ledgerDrift(prisma, [product.id + 1])).toEqual([]);

    // Leave the database as the suite-wide check expects it.
    await resetTestDb();
  });
});
