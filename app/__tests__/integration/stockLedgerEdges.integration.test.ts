// /app/__tests__/integration/stockLedgerEdges.integration.test.ts
//
// Edges of the single stock writer (lib/inventory/ledger.ts) found by review
// after it was written, each pinned against real Postgres.
//
// The lock-order cases are deterministic, not a race left to chance. A holder
// transaction takes the LOWER product's lock and keeps it; the flow under test
// starts and is observed (via pg_locks) to be waiting on a lock; then a probe
// checks whether the HIGHER product is still free. A flow that locks its whole
// product set once, in ascending order, waits on the lower lock before taking
// the higher one -- so the higher one is free. A flow that took the higher
// product first (release before allocate, or receipt lines in request order)
// already holds it, and the probe times out. That is exactly the precondition
// for the deadlock the review found: two flows each holding one lock and
// wanting the other.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { placeAt } from "@/lib/inventory/places";
import { toQty } from "@/lib/inventory/quantity";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { allocate } from "@/lib/inventory/allocation";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { lockProducts, postMovement, setPlaceQuantity } from "@/lib/inventory/ledger";
import { handler as receiveHandler } from "@/pages/api/purchasing/orders/[id]/receive";
import { handler as returnStatusHandler } from "@/pages/api/returns/[id]/status";
import { handler as transferStatusHandler } from "@/pages/api/warehouse/transfers/[id]/status";
import { handler as positionsHandler } from "@/pages/api/warehouse/positions/index";
import { handler as positionHandler } from "@/pages/api/warehouse/positions/[id]";

function makeReq(
  method: string,
  query: Record<string, string>,
  body: unknown = {},
): NextApiRequest {
  return { method, query, body, headers: {} } as any;
}

function makeRes() {
  return {
    statusCode: 0 as number,
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
  } as any as NextApiResponse & { statusCode: number; body: any };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Hold one product's lock in its own transaction until `release` resolves. */
async function holdLock(productId: number) {
  const held = deferred();
  const release = deferred();
  const done = prisma.$transaction(
    async (tx) => {
      await lockProducts(tx, [productId]);
      held.resolve();
      await release.promise;
    },
    { timeout: 30_000 },
  );
  await held.promise;
  return { release: release.resolve, done };
}

/** Wait until some transaction is blocked on an advisory lock. */
async function waitUntilSomeoneWaits() {
  for (let i = 0; i < 200; i++) {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
    if (Number(rows[0].n) > 0) return;
    await sleep(25);
  }
  throw new Error("the flow under test never waited on a lock");
}

/** Can this product's lock be taken right now (within 300ms)? */
async function canLockNow(productId: number): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '300ms'`);
      await lockProducts(tx, [productId]);
    });
    return true;
  } catch {
    return false;
  }
}

async function scenario() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Living Room" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  const other = await prisma.storeLocation.create({
    data: { name: "Store B", code: "SB", type: "STORE" },
  });
  const mk = (n: string) =>
    prisma.product.create({
      data: {
        productNumber: n,
        name: n,
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
  // Created in this order, so low.id < high.id.
  const low = await mk("LOW");
  const high = await mk("HIGH");
  const user = await prisma.user.create({ data: { email: "warehouse@example.com" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  const free = async (productId: number, quantity: number, stockLocationId: number | null = null) =>
    postMovement(prisma, {
      productId,
      quantity,
      to: await placeAt(prisma, { storeLocationId: store.id, stockLocationId }),
      reason: "OPENING",
    });
  return { vendor, store, other, low, high, user, session, free };
}

describe("single stock writer: edges found in review", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  describe("multi-product flows lock their whole product set first, in ascending order", () => {
    it("an order resync does not take the product it held before the one its line now wants", async () => {
      const s = await scenario();
      await s.free(s.low.id, 1);
      await s.free(s.high.id, 1);
      const order = await prisma.salesOrder.create({
        data: { orderno: "SO-X", status: "ORDER", storeLocation: s.store.name },
      });
      const line = await prisma.orderLineItem.create({
        data: {
          salesOrderId: order.id,
          productId: s.high.id,
          orderedQuantity: 1,
          netPrice: 100,
          cost: 50,
          lineItemStatus: "ACTIVE",
        },
      });
      await allocate(
        order.id,
        [{ productId: s.high.id, quantity: 1, storeLocationId: s.store.id }],
        prisma,
      );
      // The line now wants the LOW product; the order still holds the HIGH one.
      await prisma.orderLineItem.update({ where: { id: line.id }, data: { productId: s.low.id } });

      const holder = await holdLock(s.low.id);
      const flow = prisma.$transaction((tx) => resyncOrderAllocation(order.id, s.store.name, tx), {
        timeout: 30_000,
      });
      await waitUntilSomeoneWaits();

      // Before the fix, release locked HIGH first and allocate then waited on
      // LOW -- holding HIGH. Now the whole set is locked LOW-then-HIGH.
      expect(await canLockNow(s.high.id)).toBe(true);

      holder.release();
      await holder.done;
      await flow;

      const committed = await prisma.inventoryPosition.findMany({
        where: { salesOrderId: order.id },
      });
      expect(committed.map((r) => [r.productId, toQty(r.quantity)])).toEqual([[s.low.id, 1]]);
    });

    it("a PO receipt does not lock its lines in request order", async () => {
      const s = await scenario();
      const po = await prisma.purchaseOrder.create({
        data: {
          poNumber: "PO-L",
          vendorId: s.vendor.id,
          lineItems: {
            create: [
              { productId: s.high.id, orderedQuantity: 1 },
              { productId: s.low.id, orderedQuantity: 1 },
            ],
          },
        },
        include: { lineItems: true },
      });
      const highLine = po.lineItems.find((l) => l.productId === s.high.id)!;
      const lowLine = po.lineItems.find((l) => l.productId === s.low.id)!;

      const holder = await holdLock(s.low.id);
      const res = makeRes();
      // HIGH first in the request: the order a deadlock needs.
      const flow = receiveHandler(
        makeReq(
          "POST",
          { id: String(po.id) },
          {
            storeLocationId: s.store.id,
            items: [
              { purchaseOrderItemId: highLine.id, quantityReceived: 1 },
              { purchaseOrderItemId: lowLine.id, quantityReceived: 1 },
            ],
          },
        ),
        res,
        s.session,
      );
      await waitUntilSomeoneWaits();
      expect(await canLockNow(s.high.id)).toBe(true);

      holder.release();
      await holder.done;
      await flow;
      expect(res.statusCode).toBe(200);
    });
  });

  describe("transfers", () => {
    async function transfer(
      s: Awaited<ReturnType<typeof scenario>>,
      quantity: number,
      fromStockLocationId: number | null,
    ) {
      return prisma.inventoryTransfer.create({
        data: {
          productId: s.low.id,
          quantity,
          fromLocation: s.store.name,
          toLocation: s.other.name,
          fromLocationId: s.store.id,
          toLocationId: s.other.id,
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

    it("ships from a chosen place even when that place holds customers' stock", async () => {
      const s = await scenario();
      const hold = await prisma.stockLocation.create({
        data: {
          storeLocationId: s.store.id,
          code: "HOLD",
          name: "Holding",
          holdsCommittedStock: true,
        },
      });
      await s.free(s.low.id, 2, hold.id);
      const t = await transfer(s, 2, hold.id);

      const res = await advance(s, t.id, "IN_TRANSIT");
      expect(res.statusCode).toBe(200);
      expect(
        await prisma.inventoryPosition.count({
          where: { productId: s.low.id, stockLocationId: hold.id },
        }),
      ).toBe(0);
    });

    it("'any place' still never takes customers' stock", async () => {
      const s = await scenario();
      const hold = await prisma.stockLocation.create({
        data: {
          storeLocationId: s.store.id,
          code: "HOLD",
          name: "Holding",
          holdsCommittedStock: true,
        },
      });
      await s.free(s.low.id, 2, hold.id);
      const t = await transfer(s, 1, null);
      expect((await advance(s, t.id, "IN_TRANSIT")).statusCode).toBe(409);
    });

    it("a double-submitted ship moves the units once", async () => {
      const s = await scenario();
      await s.free(s.low.id, 5);
      const t = await transfer(s, 2, null);

      const results = await Promise.all([
        advance(s, t.id, "IN_TRANSIT"),
        advance(s, t.id, "IN_TRANSIT"),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const left = await prisma.inventoryPosition.findMany({ where: { productId: s.low.id } });
      expect(left.reduce((sum, r) => sum + toQty(r.quantity), 0)).toBe(3);
    });
  });

  it("a double-submitted return restock adds the unit once", async () => {
    const s = await scenario();
    const order = await prisma.salesOrder.create({ data: { orderno: "SO-R", status: "ORDER" } });
    const ret = await prisma.return.create({
      data: {
        returnNumber: "RET-1",
        reason: "CUSTOMER_CHANGED_MIND",
        salesOrderId: order.id,
        productId: s.low.id,
        quantity: 1,
        status: "INSPECTED",
      },
    });
    const restock = async () => {
      const res = makeRes();
      await returnStatusHandler(
        makeReq(
          "PUT",
          { id: String(ret.id) },
          { status: "RESTOCKED", restockedLocationId: String(s.store.id) },
        ),
        res,
        s.session,
      );
      return res.statusCode;
    };

    const codes = await Promise.all([restock(), restock()]);
    expect(codes.sort()).toEqual([200, 409]);
    const rows = await prisma.inventoryPosition.findMany({ where: { productId: s.low.id } });
    expect(rows.reduce((sum, r) => sum + toQty(r.quantity), 0)).toBe(1);
  });

  describe("admin position edits", () => {
    async function create(s: Awaited<ReturnType<typeof scenario>>, body: Record<string, unknown>) {
      const res = makeRes();
      await positionsHandler(
        makeReq("POST", {}, { productId: s.low.id, storeLocationId: s.store.id, ...body }),
        res,
        s.session,
      );
      return res;
    }

    it("setting a position to zero answers with the empty place, not 'not found'", async () => {
      const s = await scenario();
      const created = await create(s, { quantity: 3 });
      const res = makeRes();
      await positionHandler(
        makeReq("PUT", { id: String(created.body.id) }, { quantity: 0 }),
        res,
        s.session,
      );
      expect(res.statusCode).toBe(200);
      expect(Number(res.body.quantity)).toBe(0);
      expect(await prisma.inventoryPosition.count({ where: { productId: s.low.id } })).toBe(0);
    });

    it("a note set to null is cleared; an absent note is left alone", async () => {
      const s = await scenario();
      const created = await create(s, { quantity: 2, notes: "check the legs" });
      expect(created.body.notes).toBe("check the legs");

      await create(s, { quantity: 4 }); // no notes field: leave it
      const kept = await prisma.inventoryPosition.findFirstOrThrow({
        where: { productId: s.low.id },
      });
      expect(kept.notes).toBe("check the legs");

      const res = makeRes();
      await positionHandler(
        makeReq("PUT", { id: String(kept.id) }, { notes: null }),
        res,
        s.session,
      );
      expect(res.statusCode).toBe(200);
      const cleared = await prisma.inventoryPosition.findFirstOrThrow({
        where: { productId: s.low.id },
      });
      expect(cleared.notes).toBeNull();
      expect(toQty(cleared.quantity)).toBe(4);
    });
  });

  it("refuses a quantity that is not a number instead of silently doing nothing", async () => {
    const s = await scenario();
    const place = await placeAt(prisma, { storeLocationId: s.store.id });
    await expect(
      setPlaceQuantity(prisma, {
        productId: s.low.id,
        place,
        target: Number.NaN,
        reason: "ADJUST",
      }),
    ).rejects.toThrow(/number/);
    await expect(
      postMovement(prisma, {
        productId: s.low.id,
        quantity: Number.NaN,
        to: place,
        reason: "ADJUST",
      }),
    ).rejects.toThrow(/numeric/);
  });
});
