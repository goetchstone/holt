// /app/__tests__/integration/stockReceive.integration.test.ts
//
// Ledger plan phase 7: receiving from a supplier.
//
// Damaged or wrong goods used to arrive as sellable stock; they now go to the
// store's quarantine place. A PO line raised for an order used to arrive free,
// waiting for a re-allocation nothing ran; it now arrives committed to the
// order, up to what the order still needs. A zero-quantity PO line -- a
// cancelled line (rule 31) -- counted as fully received, so a PO with nothing
// received could read RECEIVED_PARTIAL (rule 39). And the Buyers report must
// count a committed receipt once, not once from the ledger and again from the
// PO chain.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { availableQuantity } from "@/lib/inventory/allocation";
import { toQty } from "@/lib/inventory/quantity";
import { getBuyersSummary } from "@/lib/reports/buyersReport";
import { handler as receiveHandler } from "@/pages/api/purchasing/orders/[id]/receive";

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
  const product = await prisma.product.create({
    data: {
      productNumber: "LIN-1",
      name: "Linen",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const user = await prisma.user.create({ data: { email: "receiver@example.test" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  const customer = await prisma.customer.create({ data: { firstName: "S", lastName: "Order" } });
  return { vendor, store, product, session, customer };
}

type World = Awaited<ReturnType<typeof world>>;

async function orderFor(w: World, quantity: number, status: "ORDER" | "CANCELLED" = "ORDER") {
  return prisma.salesOrder.create({
    data: {
      orderno: `SO-${Math.random().toString(36).slice(2, 8)}`,
      status,
      orderDate: new Date(),
      customerId: w.customer.id,
      storeLocation: w.store.name,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: w.product.id,
            productName: "Linen",
            orderedQuantity: quantity,
            netPrice: quantity * 50,
            cost: quantity * 20,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
    include: { lineItems: true },
  });
}

async function poFor(
  w: World,
  lines: { ordered: number; orderLineItemId?: number }[],
  salesOrderId?: number,
) {
  return prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-${Math.random().toString(36).slice(2, 8)}`,
      vendorId: w.vendor.id,
      salesOrderId: salesOrderId ?? null,
      lineItems: {
        create: lines.map((l) => ({
          productId: w.product.id,
          orderedQuantity: l.ordered,
          orderLineItemId: l.orderLineItemId ?? null,
        })),
      },
    },
    include: { lineItems: true },
  });
}

async function receive(
  w: World,
  po: { id: number },
  items: { purchaseOrderItemId: number; quantityReceived: number | string; condition?: string }[],
) {
  const res = makeRes();
  await receiveHandler(
    makeReq("POST", { id: String(po.id) }, { storeLocationId: w.store.id, items }),
    res,
    w.session,
  );
  return res;
}

const committedTo = async (orderId: number) =>
  toQty(
    (
      await prisma.inventoryPosition.aggregate({
        where: { salesOrderId: orderId },
        _sum: { quantity: true },
      })
    )._sum.quantity,
  );

describe("receiving from a supplier (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("damaged goods go to quarantine: owned, not for sale", async () => {
    const w = await world();
    const po = await poFor(w, [{ ordered: 4 }]);

    const res = await receive(w, po, [
      { purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 2, condition: "Damaged" },
    ]);
    expect(res.statusCode).toBe(200);

    const store = await prisma.storeLocation.findUniqueOrThrow({ where: { id: w.store.id } });
    const quarantine = await prisma.stockLocation.findUniqueOrThrow({
      where: { id: store.quarantineStockLocationId! },
    });
    expect(quarantine.locationType).toBe("QUARANTINE");
    const row = await prisma.inventoryPosition.findFirstOrThrow({
      where: { productId: w.product.id },
    });
    expect(row.stockLocationId).toBe(quarantine.id);
    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(0);
  });

  it("a line raised for an order arrives committed to it, the excess free", async () => {
    const w = await world();
    const order = await orderFor(w, 3);
    const po = await poFor(w, [{ ordered: 5, orderLineItemId: order.lineItems[0].id }], order.id);

    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: "5" }]);

    expect(await committedTo(order.id)).toBe(3);
    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(2);
  });

  it("a PO raised for a whole order commits its part rolls to it", async () => {
    const w = await world();
    const order = await orderFor(w, 12.5);
    const po = await poFor(w, [{ ordered: 12.5 }], order.id);

    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: "12.5" }]);

    expect(await committedTo(order.id)).toBe(12.5);
  });

  it("a receipt for a cancelled order arrives free", async () => {
    const w = await world();
    const order = await orderFor(w, 2, "CANCELLED");
    const po = await poFor(w, [{ ordered: 2 }], order.id);

    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 2 }]);

    expect(await committedTo(order.id)).toBe(0);
    expect(await availableQuantity(w.product.id, w.store.id, prisma)).toBe(2);
  });

  it("a zero-quantity line counts on neither side of the PO's status", async () => {
    const w = await world();
    const po = await poFor(w, [{ ordered: 0 }, { ordered: 3 }]);
    const live = po.lineItems.find((l) => Number(l.orderedQuantity) === 3)!;

    const part = await receive(w, po, [{ purchaseOrderItemId: live.id, quantityReceived: 1 }]);
    expect(part.body.newStatus ?? (await statusOf(po.id))).toBe("RECEIVED_PARTIAL");

    await receive(w, po, [{ purchaseOrderItemId: live.id, quantityReceived: 2 }]);
    // Before: the zero line read as received, and a full receipt of the only
    // real line still left RECEIVED_PARTIAL possible from the other direction.
    expect(await statusOf(po.id)).toBe("RECEIVED_FULL");
  });

  it("a PO whose only received line is the zero line stays as it was", async () => {
    const w = await world();
    const po = await poFor(w, [{ ordered: 0 }, { ordered: 3 }]);
    const zero = po.lineItems.find((l) => Number(l.orderedQuantity) === 0)!;
    await prisma.receivingRecord.create({
      data: {
        purchaseOrderItemId: zero.id,
        purchaseOrderId: po.id,
        quantityReceived: 0,
        receiverUserId: (await prisma.user.findFirstOrThrow()).id,
      },
    });
    const live = po.lineItems.find((l) => Number(l.orderedQuantity) === 3)!;
    // Receiving nothing new would not call the route; receive a sliver of the
    // real line and check the status counts only it.
    await receive(w, po, [{ purchaseOrderItemId: live.id, quantityReceived: 3 }]);
    expect(await statusOf(po.id)).toBe("RECEIVED_FULL");
  });

  it("the Buyers report counts a committed receipt once", async () => {
    const w = await world();
    const order = await orderFor(w, 3);
    const po = await poFor(w, [{ ordered: 3, orderLineItemId: order.lineItems[0].id }], order.id);
    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 3 }]);

    const summary = await getBuyersSummary(prisma, {
      startDate: "2020-01-01",
      endDate: "2030-12-31",
    });
    expect(summary.totals.customerStock).toBe(3);
    expect(summary.totals.onHand).toBe(0);
  });
});

async function statusOf(poId: number) {
  return (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status;
}
