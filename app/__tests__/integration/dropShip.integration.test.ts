// /app/__tests__/integration/dropShip.integration.test.ts
//
// Drop ship (GAP-20, DECISIONS 55). Owner, 2026-11-05: "as easy as putting that on the po
// if the vendor allows for it". Owner, 2026-11-10: receiving it hands the sale over, "once
// received we assume the customer has it". Real routes and database: what a PO needs to
// go to the customer, what the vendor is sent, what stock the line holds, what receiving
// does, and what can't be undone.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { toQty } from "@/lib/inventory/quantity";
import { availableQuantity } from "@/lib/inventory/allocation";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { unreceive, UnreceiveError } from "@/lib/purchasing/unreceive";
import { keepPoAsStock, readSalePos } from "@/lib/sales/salePos";
import * as pdf from "@/lib/purchasing/purchaseOrderPdf";
import { purchaseOrderDocument } from "@/lib/purchasing/purchaseOrderDocument";
import { loadPoForEditor } from "@/lib/purchasing/stockPurchaseOrder";
import { addressInUseProblem } from "@/lib/purchasing/dropShip";
import { handler as editHandler } from "@/pages/api/purchasing/orders/[id]/edit";
import { handler as receiveHandler } from "@/pages/api/purchasing/orders/[id]/receive";
import { stockAt } from "../helpers/stock";

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));

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

const req = (method: string, query: Record<string, string>, body: unknown = {}) =>
  ({ method, query, body, headers: {} }) as unknown as NextApiRequest;

async function world({ dropShips = true } = {}) {
  const vendor = await prisma.vendor.create({
    data: { name: "Larkmoor", pricingModel: "FLAT", dropShips },
  });
  const department = await prisma.department.create({ data: { name: "Living" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Main Street", code: "MAIN", type: "STORE" },
  });
  const product = (productNumber: string, name: string) =>
    prisma.product.create({
      data: {
        productNumber,
        name,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
        baseCost: 400,
      },
    });
  const sofa = await product("SOFA-1", "Sofa");
  const chair = await product("CHAIR-1", "Chair");
  const user = await prisma.user.create({ data: { email: "buyer@example.com" } });
  const session = { user: { email: user.email, id: user.id } } as unknown as Session;
  const customer = await prisma.customer.create({
    data: { firstName: "Ada", lastName: "Lane", phone: "555-0100" },
  });
  const address = await prisma.customerAddress.create({
    data: {
      customerId: customer.id,
      address1: "1 Elm St",
      city: "Elmhurst Ridge",
      state: "MI",
      zip: "49101",
    },
  });
  return { vendor, store, sofa, chair, session, customer, address };
}

type World = Awaited<ReturnType<typeof world>>;

/** A sale with one line per product given, and the PO raised for it, as a sale raises one. */
async function saleWithPo(w: World, products = [w.sofa]) {
  const order = await prisma.salesOrder.create({
    data: {
      orderno: `SO-${Math.random().toString(36).slice(2, 8)}`,
      status: "ORDER",
      orderDate: new Date(),
      customerId: w.customer.id,
      storeLocation: w.store.name,
      deliveryMethod: "DELIVERY",
      lineItems: {
        create: products.map((p, i) => ({
          lineNumber: i + 1,
          productId: p.id,
          productName: p.name,
          orderedQuantity: 1,
          netPrice: 1000,
          cost: 400,
          vatRate: 0,
          vatAmount: 0,
        })),
      },
    },
    include: { lineItems: { orderBy: { id: "asc" } } },
  });
  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: `PO-${Math.random().toString(36).slice(2, 8)}`,
      vendorId: w.vendor.id,
      salesOrderId: order.id,
      lineItems: {
        create: order.lineItems.map((l) => ({
          productId: l.productId,
          productName: l.productName,
          orderedQuantity: 1,
          unitCost: 400,
          orderLineItemId: l.id,
        })),
      },
    },
    include: { lineItems: { orderBy: { id: "asc" } } },
  });
  return { order, po };
}

async function edit(
  w: World,
  po: { id: number; lineItems: { id: number; productId: number | null }[] },
  body: object,
) {
  const res = makeRes();
  await editHandler(
    req(
      "PUT",
      { id: String(po.id) },
      {
        expectedDelivery: null,
        notes: null,
        lines: po.lineItems.map((l) => ({
          id: l.id,
          productId: l.productId,
          quantity: 1,
          unitCost: 400,
        })),
        ...body,
      },
    ),
    res,
    w.session,
    { holds: { "catalog.cost": true } } as never,
  );
  return res;
}

const toCustomer = (w: World, po: Parameters<typeof edit>[1]) => edit(w, po, { dropShip: true });

async function receive(
  w: World,
  po: { id: number },
  items: { purchaseOrderItemId: number; quantityReceived: number }[],
) {
  const res = makeRes();
  await receiveHandler(
    req("POST", { id: String(po.id) }, { storeLocationId: w.store.id, items }),
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

const stockOf = async (productId: number) =>
  toQty(
    (await prisma.inventoryPosition.aggregate({ where: { productId }, _sum: { quantity: true } }))
      ._sum.quantity,
  );

beforeEach(async () => {
  await resetTestDb();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("shipping a sale's PO to the customer", () => {
  it("names the customer's address instead of a store", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    const res = await toCustomer(w, po);
    expect(res.statusCode).toBe(200);
    const saved = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(saved).toMatchObject({ dropShipAddressId: w.address.id, shipToLocationId: null });
  });

  it("goes back to a store, clearing the customer", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    await toCustomer(w, po);
    const res = await edit(w, po, { shipToLocationId: w.store.id });
    expect(res.statusCode).toBe(200);
    const saved = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(saved).toMatchObject({ dropShipAddressId: null, shipToLocationId: w.store.id });
  });

  it("uses the sale's own delivery address over the customer's first", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w);
    const lake = await prisma.customerAddress.create({
      data: {
        customerId: w.customer.id,
        address1: "9 Lake Rd",
        city: "Lakeside Bend",
        state: "MI",
        zip: "49102",
      },
    });
    await prisma.salesOrder.update({
      where: { id: order.id },
      data: { deliveryAddressId: lake.id },
    });
    await toCustomer(w, po);
    expect(
      (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).dropShipAddressId,
    ).toBe(lake.id);
  });

  it.each([
    ["a vendor that isn't set to drop ship", { dropShips: false }, "isn't set to drop ship"],
  ])("refuses %s", async (_what, opts, message) => {
    const w = await world(opts);
    const { po } = await saleWithPo(w);
    const res = await toCustomer(w, po);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain(message);
  });

  it("refuses a customer with no address", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    await prisma.customerAddress.delete({ where: { id: w.address.id } });
    const res = await toCustomer(w, po);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("no address on file");
  });

  it("refuses a PO that also carries stock lines", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    const stockLine = await prisma.purchaseOrderItem.create({
      data: { purchaseOrderId: po.id, productId: w.chair.id, orderedQuantity: 2, unitCost: 100 },
    });
    const res = await toCustomer(w, { ...po, lineItems: [...po.lineItems, stockLine] });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("stock lines");
  });

  it("refuses a PO carrying lines for two sales", async () => {
    const w = await world();
    const first = await saleWithPo(w);
    const second = await saleWithPo(w);
    await prisma.purchaseOrderItem.update({
      where: { id: second.po.lineItems[0].id },
      data: { purchaseOrderId: first.po.id },
    });
    const lines = await prisma.purchaseOrderItem.findMany({
      where: { purchaseOrderId: first.po.id },
    });
    const res = await toCustomer(w, { id: first.po.id, lineItems: lines });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toContain("more than one sale");
  });

  it("refuses a brand-new PO, which has no sale", async () => {
    const { parseNewPo } = await import("@/lib/purchasing/purchaseOrderShared");
    expect(
      parseNewPo({ vendorId: 1, dropShip: true, lines: [{ productId: 1, quantity: 1 }] }).ok,
    ).toBe(false);
  });

  it("offers it in the editor only for a vendor that drop ships, saying why when it can't", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    expect((await loadPoForEditor(po.id, true))?.dropShip).toEqual({
      on: false,
      offer: "Ada Lane, 1 Elm St, Elmhurst Ridge, MI 49101",
      problem: null,
    });
    await prisma.customerAddress.delete({ where: { id: w.address.id } });
    expect((await loadPoForEditor(po.id, true))?.dropShip?.problem).toContain("no address");
  });

  it("isn't offered for a vendor that doesn't drop ship", async () => {
    const w = await world({ dropShips: false });
    const { po } = await saleWithPo(w);
    expect((await loadPoForEditor(po.id, true))?.dropShip).toBeNull();
  });
});

describe("what the vendor is sent", () => {
  it("prints the customer, their address and phone as ship-to", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    await toCustomer(w, po);
    const spy = jest.spyOn(pdf, "generatePurchaseOrderPdf");
    await purchaseOrderDocument(po.id, true);
    expect(spy.mock.calls[0][0].shipTo).toEqual({
      name: "Ada Lane (drop ship)",
      lines: ["1 Elm St", "Elmhurst Ridge, MI 49101", "555-0100"],
    });
  });

  it("can't lose the address it ships to: the route says why, and the database refuses too", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    expect(await addressInUseProblem(prisma, w.address.id)).toBeNull();
    await toCustomer(w, po);
    expect(await addressInUseProblem(prisma, w.address.id)).toBe(
      `${po.poNumber} ships to this address, so it can't be deleted.`,
    );
    await expect(prisma.customerAddress.delete({ where: { id: w.address.id } })).rejects.toThrow();
  });
});

describe("the stock a drop-shipped line holds", () => {
  it("gives back the store's piece it was holding, and takes it again if it goes back to a store", async () => {
    const w = await world();
    await stockAt({ productId: w.sofa.id, storeLocationId: w.store.id, quantity: 1 });
    const { order, po } = await saleWithPo(w);
    await prisma.$transaction((tx) => resyncOrderAllocation(order.id, w.store.name, tx));
    expect(await committedTo(order.id)).toBe(1);

    await toCustomer(w, po);
    expect(await committedTo(order.id)).toBe(0);
    expect(await availableQuantity(w.sofa.id, w.store.id, prisma)).toBe(1);

    await edit(w, po, { shipToLocationId: w.store.id });
    expect(await committedTo(order.id)).toBe(1);
  });

  it("takes its place again once the drop-ship PO is cancelled", async () => {
    const w = await world();
    await stockAt({ productId: w.sofa.id, storeLocationId: w.store.id, quantity: 1 });
    const { order, po } = await saleWithPo(w);
    await toCustomer(w, po);
    expect(await committedTo(order.id)).toBe(0);
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: "CANCELLED" } });
    await prisma.$transaction((tx) => resyncOrderAllocation(order.id, w.store.name, tx));
    expect(await committedTo(order.id)).toBe(1);
  });

  it("takes no stock on a later resync either", async () => {
    const w = await world();
    await stockAt({ productId: w.sofa.id, storeLocationId: w.store.id, quantity: 1 });
    const { order, po } = await saleWithPo(w);
    await toCustomer(w, po);
    await prisma.$transaction((tx) => resyncOrderAllocation(order.id, w.store.name, tx));
    expect(await committedTo(order.id)).toBe(0);
  });
});

describe("receiving a drop-shipped PO", () => {
  it("puts nothing into stock and hands the sale over", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w);
    // A sale the customer was to collect: the vendor's delivery doesn't change how it was sold.
    await prisma.salesOrder.update({ where: { id: order.id }, data: { deliveryMethod: "PICKUP" } });
    await toCustomer(w, po);
    const res = await receive(w, po, [
      { purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe(
      "1 item(s) received. Recorded only: The vendor shipped it straight to the customer, so nothing goes into stock. The sale is now handed over.",
    );

    expect(await stockOf(w.sofa.id)).toBe(0);
    const record = await prisma.receivingRecord.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
    });
    expect(record).toMatchObject({ intoStock: false, landedUnitCost: null, tagsPrinted: false });

    const sale = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lineItems: true },
    });
    expect(sale).toMatchObject({
      status: "FULFILLED",
      dispatchStatus: "FULFILLED",
      deliveryMethod: "PICKUP",
    });
    expect(sale.deliveredAt).not.toBeNull();
    expect(toQty(sale.lineItems[0].fulfilledQty)).toBe(1);
    const handover = await prisma.orderHandover.findFirstOrThrow({
      where: { salesOrderId: order.id },
    });
    expect(handover.method).toBe("DROP_SHIP");
    const history = await prisma.orderChangeLog.findFirstOrThrow({
      where: { salesOrderId: order.id, changeType: "DROP_SHIPPED" },
    });
    expect(history.newValue).toBe("Sofa x1");
  });

  it("leaves the product's average cost alone, since nothing was stocked", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    await toCustomer(w, po);
    const before = await prisma.product.findUniqueOrThrow({ where: { id: w.sofa.id } });
    await prisma.purchaseOrderItem.update({
      where: { id: po.lineItems[0].id },
      data: { unitCost: 999 },
    });
    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 }]);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: w.sofa.id } });
    expect(after.landedCost?.toString() ?? null).toBe(before.landedCost?.toString() ?? null);
  });

  it("hands over only the lines that came, until the last one", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w, [w.sofa, w.chair]);
    await toCustomer(w, po);
    const first = await receive(w, po, [
      { purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 },
    ]);
    expect(first.body.message).toContain("Those lines of the sale are handed over.");
    let sale = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lineItems: { orderBy: { id: "asc" } } },
    });
    expect(sale.deliveredAt).toBeNull();
    expect(sale.lineItems.map((l) => toQty(l.fulfilledQty))).toEqual([1, 0]);

    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[1].id, quantityReceived: 1 }]);
    sale = await prisma.salesOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: { lineItems: true },
    });
    expect(sale.deliveredAt).not.toBeNull();
  });

  it("never delivers more of a line than the sale ordered", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w, [w.sofa, w.chair]);
    await toCustomer(w, po);
    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 3 }]);
    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrderId: order.id },
      orderBy: { id: "asc" },
    });
    expect(lines.map((l) => toQty(l.fulfilledQty))).toEqual([1, 0]);
  });

  it("records it, and hands nothing over, when the sale isn't open", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w);
    await toCustomer(w, po);
    await prisma.salesOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    const res = await receive(w, po, [
      { purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body.message).not.toContain("handed over");
    expect(
      (await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } })).deliveredAt,
    ).toBeNull();
    expect(await prisma.orderHandover.count()).toBe(0);
  });

  it("leaves a sale's other lines to be delivered by the store", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w);
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: order.id,
        lineNumber: 2,
        productId: w.chair.id,
        productName: "Chair",
        orderedQuantity: 1,
        netPrice: 200,
        cost: 80,
        vatRate: 0,
        vatAmount: 0,
      },
    });
    await toCustomer(w, po);
    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 }]);
    const sale = await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(sale.deliveredAt).toBeNull();
    expect(sale.status).toBe("ORDER");
  });

  it("still stocks an ordinary PO's goods, as before", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w);
    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 }]);
    expect(await committedTo(order.id)).toBe(1);
    expect(
      (await prisma.salesOrder.findUniqueOrThrow({ where: { id: order.id } })).deliveredAt,
    ).toBeNull();
  });

  it("can't be taken back, since it handed the sale over", async () => {
    const w = await world();
    const { po } = await saleWithPo(w);
    await toCustomer(w, po);
    await receive(w, po, [{ purchaseOrderItemId: po.lineItems[0].id, quantityReceived: 1 }]);
    const record = await prisma.receivingRecord.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
    });
    await expect(
      prisma.$transaction((tx) =>
        unreceive(tx, { receivingRecordId: record.id, quantity: 1, actor: null }),
      ),
    ).rejects.toThrow(UnreceiveError);
    expect(await prisma.receivingRecord.count({ where: { purchaseOrderId: po.id } })).toBe(1);
  });
});

describe("keeping a drop-shipped piece when the sale is cancelled", () => {
  it("brings it to the store instead", async () => {
    const w = await world();
    const { order, po } = await saleWithPo(w);
    await toCustomer(w, po);
    const [salePo] = await readSalePos(prisma, order.id);
    await prisma.$transaction((tx) => keepPoAsStock(tx, salePo, w.store.id, null));
    const saved = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(saved).toMatchObject({
      dropShipAddressId: null,
      shipToLocationId: w.store.id,
      salesOrderId: null,
    });
  });
});
