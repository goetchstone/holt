// /app/__tests__/integration/lineItemReplacePrice.integration.test.ts
//
// Replacing a line (fabric out of stock, customer re-selects) marks the
// original REPLACED and writes a new line in its place. The order screen's
// Replace dialog sends only a name, part number and grade -- no quantity, no
// price -- so the new line must carry the original's unit price. netPrice is
// the LINE total, so the unit price is netPrice / orderedQuantity; reading
// netPrice as a unit price priced a 2-unit $500 line at $1,000 and doubled its
// tax. Pinned against real Postgres through the route the screen calls.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handler as lineItemHandler } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as NextApiResponse & { statusCode: number; body: unknown };
  return res;
}

const session = { user: { email: "staff@example.com" } } as unknown as Session;

let orderSeq = 0;

async function orderWithLine(orderedQuantity: number, netPrice: number, vatRate: number) {
  orderSeq += 1;
  const order = await prisma.salesOrder.create({
    data: { orderno: `SO-REPL-${orderSeq}`, status: "ORDER" },
  });
  const line = await prisma.orderLineItem.create({
    data: {
      salesOrderId: order.id,
      lineNumber: 1,
      productName: "Sofa in Linen",
      partNo: "SOFA-LIN",
      orderedQuantity,
      netPrice,
      vatRate,
      vatAmount: Math.round(netPrice * vatRate * 100) / 100,
      cost: 0,
    },
  });
  return { order, line };
}

async function replace(orderId: number, lineItemId: number, replacement: Record<string, unknown>) {
  const res = makeRes();
  await lineItemHandler(
    {
      method: "PUT",
      query: { id: String(orderId), lineItemId: String(lineItemId) },
      body: { action: "replace", reason: "Fabric discontinued", replacement },
    } as unknown as NextApiRequest,
    res,
    session,
    // A replacement priced below the line's list is a discount; who may give
    // one is discountPolicy.integration.test.ts (GAP-06).
    { holds: { "sales.discount": true } },
  );
  expect(res.statusCode).toBe(200);
  const { replacementId } = res.body as { replacementId: number };
  const created = await prisma.orderLineItem.findUniqueOrThrow({ where: { id: replacementId } });
  return {
    orderedQuantity: Number(created.orderedQuantity),
    netPrice: Number(created.netPrice),
    vatAmount: Number(created.vatAmount),
  };
}

describe("replacing an order line keeps the line's price", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("prices a dialog replacement (name only) at the original line total", async () => {
    const { order, line } = await orderWithLine(2, 500, 0.07);

    const created = await replace(order.id, line.id, {
      productName: "Sofa in Velvet",
      partNo: "SOFA-VEL",
    });

    expect(created).toEqual({ orderedQuantity: 2, netPrice: 500, vatAmount: 35 });
  });

  it("keeps the unit price when the replacement changes the quantity", async () => {
    const { order, line } = await orderWithLine(2, 500, 0.07);

    const created = await replace(order.id, line.id, { productName: "Chair", quantity: 3 });

    expect(created).toEqual({ orderedQuantity: 3, netPrice: 750, vatAmount: 52.5 });
  });

  it("takes an explicit unit price, including zero", async () => {
    const { order, line } = await orderWithLine(2, 500, 0.07);

    expect(await replace(order.id, line.id, { productName: "Ottoman", unitPrice: 120 })).toEqual({
      orderedQuantity: 2,
      netPrice: 240,
      vatAmount: 16.8,
    });

    const second = await orderWithLine(1, 300, 0.07);
    expect(
      await replace(second.order.id, second.line.id, { productName: "Courtesy", unitPrice: 0 }),
    ).toEqual({ orderedQuantity: 1, netPrice: 0, vatAmount: 0 });
  });

  it("refuses a zero quantity and leaves the original line in place", async () => {
    const { order, line } = await orderWithLine(2, 500, 0.07);

    const res = makeRes();
    await lineItemHandler(
      {
        method: "PUT",
        query: { id: String(order.id), lineItemId: String(line.id) },
        body: { action: "replace", replacement: { productName: "Chair", quantity: 0 } },
      } as unknown as NextApiRequest,
      res,
      session,
    );

    expect(res.statusCode).toBe(400);
    const lines = await prisma.orderLineItem.findMany({ where: { salesOrderId: order.id } });
    expect(lines.map((l) => l.lineItemStatus)).toEqual(["ACTIVE"]);
  });
});
