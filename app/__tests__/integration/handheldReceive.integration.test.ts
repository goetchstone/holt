// /app/__tests__/integration/handheldReceive.integration.test.ts
//
// Receiving on a handheld against real Postgres (pages/api/scan/receive.ts):
// box scans become whole units, an incomplete set waits in quarantine with a
// note of its missing boxes, its last box completes it, and a resend of the
// same action receives nothing twice.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler } from "@/pages/api/scan/receive";
import { stockAt } from "../helpers/stock";

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
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: any };
}

async function world(opts: { forOrder?: boolean } = {}) {
  const vendor = await prisma.vendor.create({ data: { name: "Weaver", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Upholstery" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const sofa = await prisma.product.create({
    data: {
      productNumber: "SOFA-3BOX",
      name: "Sectional",
      boxesPerUnit: 3,
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Mill", code: "MILL", type: "STORE" },
  });
  const order = opts.forOrder
    ? await prisma.salesOrder.create({
        data: {
          orderno: "SO-1",
          status: "ORDER",
          orderDate: new Date(),
          storeLocation: "Mill",
          storeLocationId: store.id,
          lineItems: {
            create: [
              { lineNumber: 1, productId: sofa.id, orderedQuantity: 1, netPrice: 2000, cost: 900 },
            ],
          },
        },
        include: { lineItems: true },
      })
    : null;
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: "PO-100",
      vendorId: vendor.id,
      status: "SUBMITTED",
      salesOrderId: order?.id ?? null,
      lineItems: {
        create: [
          {
            productId: sofa.id,
            orderedQuantity: 2,
            orderLineItemId: order?.lineItems[0].id ?? null,
          },
        ],
      },
    },
    include: { lineItems: true },
  });
  const user = await prisma.user.create({ data: { email: "receiver@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  return { sofa, store, po, order, session };
}

const post = async (session: Session, body: unknown) => {
  const res = makeRes();
  await handler(
    { method: "POST", query: {}, body, headers: {} } as unknown as NextApiRequest,
    res,
    session,
  );
  return res;
};

describe("receiving on a handheld (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("assembles box scans into whole units and quarantines an incomplete set with a note", async () => {
    const { sofa, store, po, session } = await world();
    const res = await post(session, {
      actionKey: "recv-0001-aaaa",
      purchaseOrderId: po.id,
      storeLocationId: store.id,
      lines: [{ purchaseOrderItemId: po.lineItems[0].id, boxes: [1, 2, 3, 1, 2] }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ units: 1, incompleteSets: 1, completedSets: 0 });

    const rows = await prisma.inventoryPosition.findMany({
      where: { productId: sofa.id },
      include: { stockLocation: { select: { locationType: true } } },
    });
    const byType = Object.fromEntries(
      rows.map((r) => [r.stockLocation.locationType, Number(r.quantity)]),
    );
    expect(byType).toEqual({ RECEIVING: 1, QUARANTINE: 1 });

    const note = await prisma.boxNote.findFirstOrThrow({ where: { productId: sofa.id } });
    expect(note).toMatchObject({
      kind: "INCOMPLETE",
      boxes: [3],
      boxesPerUnit: 3,
      clearedAt: null,
    });
    // Both units count against the PO line: one whole, one incomplete.
    const received = await prisma.receivingRecord.aggregate({
      where: { purchaseOrderId: po.id },
      _sum: { quantityReceived: true },
    });
    expect(Number(received._sum.quantityReceived)).toBe(2);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe(
      "RECEIVED_FULL",
    );
  });

  it("a resend of the same action receives nothing twice", async () => {
    const { sofa, store, po, session } = await world();
    const body = {
      actionKey: "recv-dup-0001",
      purchaseOrderId: po.id,
      storeLocationId: store.id,
      lines: [{ purchaseOrderItemId: po.lineItems[0].id, boxes: [1, 2, 3] }],
    };
    expect((await post(session, body)).statusCode).toBe(201);
    const again = await post(session, body);
    expect(again.statusCode).toBe(200);
    expect(again.body.replayed).toBe(true);
    const total = await prisma.inventoryPosition.aggregate({
      where: { productId: sofa.id },
      _sum: { quantity: true },
    });
    expect(Number(total._sum.quantity)).toBe(1);
  });

  it("the last box completes the set: out of quarantine, committed to the order, note cleared", async () => {
    const { sofa, store, po, order, session } = await world({ forOrder: true });
    await post(session, {
      actionKey: "recv-part-0001",
      purchaseOrderId: po.id,
      storeLocationId: store.id,
      lines: [{ purchaseOrderItemId: po.lineItems[0].id, boxes: [1, 2] }],
    });
    const note = await prisma.boxNote.findFirstOrThrow({ where: { productId: sofa.id } });
    expect(note.boxes).toEqual([3]);

    const res = await post(session, {
      actionKey: "recv-done-0001",
      purchaseOrderId: po.id,
      storeLocationId: store.id,
      completeSets: [{ noteId: note.id, boxes: [3] }],
    });
    expect(res.body).toMatchObject({ completedSets: 1 });
    expect(
      (await prisma.boxNote.findUniqueOrThrow({ where: { id: note.id } })).clearedAt,
    ).not.toBeNull();
    const rows = await prisma.inventoryPosition.findMany({
      where: { productId: sofa.id },
      include: { stockLocation: { select: { locationType: true } } },
    });
    expect(rows).toEqual([expect.objectContaining({ salesOrderId: order!.id })]);
    expect(rows[0].stockLocation.locationType).toBe("RECEIVING");
  });

  it("refuses a box the product does not have, and writes nothing", async () => {
    const { sofa, store, po, session } = await world();
    const res = await post(session, {
      actionKey: "recv-bad-0001",
      purchaseOrderId: po.id,
      storeLocationId: store.id,
      lines: [{ purchaseOrderItemId: po.lineItems[0].id, boxes: [4] }],
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.inventoryPosition.count({ where: { productId: sofa.id } })).toBe(0);
    expect(await prisma.stockAction.count()).toBe(0);
  });

  it("lists the PO's lines and the sets waiting for its products", async () => {
    const { sofa, store, po, session } = await world();
    await post(session, {
      actionKey: "recv-list-0001",
      purchaseOrderId: po.id,
      storeLocationId: store.id,
      lines: [{ purchaseOrderItemId: po.lineItems[0].id, boxes: [2] }],
    });
    const res = makeRes();
    await handler(
      {
        method: "GET",
        query: { po: "po-100", storeLocationId: String(store.id) },
        headers: {},
      } as unknown as NextApiRequest,
      res,
      session,
    );
    expect(res.body.lines).toEqual([
      expect.objectContaining({ productId: sofa.id, boxesPerUnit: 3, ordered: 2, received: 1 }),
    ]);
    expect(res.body.incompleteSets).toEqual([
      expect.objectContaining({ productId: sofa.id, missing: [1, 3], fromThisPo: true }),
    ]);
    void stockAt;
  });
});
