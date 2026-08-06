// /app/__tests__/integration/inventoryOrderWiring.integration.test.ts
//
// Real-DB coverage for the WIRING between SalesOrder/OrderLineItem writes and
// the allocation module (src/lib/inventory/allocation.ts, already proven by
// inventoryAllocation.integration.test.ts). That file tests allocate/release/
// consume/availableQuantity in isolation; this file proves the API routes
// actually call them at the right moment:
//
//   - a POS sale (create-from-cart) commits stock
//   - a return line in that same cart never allocates
//   - an oversold sale still succeeds AND leaves an InventoryException row
//     for back office (the owner's rule -- never block the register)
//   - cancelling an order (status -> CANCELLED) releases committed stock
//   - fulfilling an order (status -> FULFILLED) consumes it
//   - the dispatch route's dispatchStatus -> FULFILLED/CANCELLED does the
//     same, wrapped in its own transaction
//   - editing line items (add / cancel) resyncs the order's allocation
//
// Calls the exported handlers directly against the real Prisma client with a
// fake req/res + session (same pattern as inventorySnapshotGenerate and
// tillVarianceEnforcement integration tests) -- bypasses requireAuthWithRole,
// which needs real cookies; role enforcement is covered by the
// apiRouteAuthorization tripwire.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { availableQuantity } from "@/lib/inventory/allocation";
import { handler as createFromCartHandler } from "@/pages/api/sales/orders/create-from-cart";
import { handler as orderHandler } from "@/pages/api/sales/orders/[id]";
import { handler as dispatchHandler } from "@/pages/api/sales/orders/[id]/dispatch";
import { handler as lineItemsHandler } from "@/pages/api/sales/orders/[id]/line-items";
import { handler as lineItemHandler } from "@/pages/api/sales/orders/[id]/line-items/[lineItemId]";

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: "POST",
    query: {},
    body: {},
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as NextApiResponse & { statusCode: number; body: unknown };
  return res;
}

const registerSession = { user: { email: "register@example.com" } } as unknown as Session;

async function seed() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  const floor = await prisma.stockLocation.create({
    data: { storeLocationId: store.id, code: "FLOOR", name: "Floor" },
  });
  const product = await prisma.product.create({
    data: { productNumber: "P1", name: "Sofa", vendorId: vendor.id, departmentId: dept.id, categoryId: cat.id },
  });
  return { store, floor, product };
}

async function createOrderViaCart(
  storeName: string,
  items: Array<{
    productId?: number;
    quantity: number;
    unitPrice: number;
    isReturn?: boolean;
    type?: "PRODUCT" | "CONFIGURED" | "CUSTOM";
    name?: string;
  }>,
) {
  const req = makeReq({
    method: "POST",
    body: {
      items: items.map((i) => ({ type: "PRODUCT", ...i })),
      storeLocation: storeName,
    },
  });
  const res = makeRes();
  await createFromCartHandler(req, res, registerSession);
  return res;
}

describe("inventory order wiring (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a POS sale (create-from-cart) reduces available stock", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });

    const res = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);

    expect(res.statusCode).toBe(201);
    const orderId = (res.body as { id: number }).id;

    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);
    const committed = await prisma.inventoryPosition.findMany({ where: { salesOrderId: orderId } });
    expect(committed).toHaveLength(1);
    expect(committed[0].quantity).toBe(2);
  });

  it("a return line in the cart never allocates", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });

    // The client sign-flips a return's quantity before sending it.
    const res = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: -1, unitPrice: 100, isReturn: true },
    ]);

    expect(res.statusCode).toBe(201);
    const orderId = (res.body as { id: number }).id;

    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(5);
  });

  it("an oversold sale still succeeds AND leaves an InventoryException row", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 1 },
    });

    const res = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 3, unitPrice: 100 },
    ]);

    // The register is never blocked -- the sale succeeds regardless.
    expect(res.statusCode).toBe(201);
    const orderId = (res.body as { id: number }).id;

    const exceptions = await prisma.inventoryException.findMany({ where: { salesOrderId: orderId } });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      productId: product.id,
      storeLocationId: store.id,
      requested: 3,
      allocated: 1,
      shortfall: 2,
    });
    expect(exceptions[0].resolvedAt).toBeNull();
  });

  it("a made-to-order line does NOT raise an exception", async () => {
    // CONFIGURED and CUSTOM lines mint a brand-new Product during the sale, so
    // they have no InventoryPosition by construction. Allocating them would
    // post a full-shortfall exception on every made-to-order sale -- for a
    // furniture retailer, a large share of them. A queue full of the normal
    // case is a queue nobody reads.
    const { store } = await seed();

    const res = await createOrderViaCart(store.name, [
      { type: "CONFIGURED", name: "Custom Sectional", quantity: 1, unitPrice: 4200 },
    ]);

    expect(res.statusCode).toBe(201);
    const orderId = (res.body as { id: number }).id;

    expect(await prisma.inventoryException.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
  });

  it("a stocked line on the SAME order still allocates and still reports", async () => {
    // The filter must be per-line, not per-order -- a mixed cart is ordinary.
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 1 },
    });

    const res = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
      { type: "CUSTOM", name: "Bespoke Ottoman", quantity: 1, unitPrice: 900 },
    ]);

    expect(res.statusCode).toBe(201);
    const orderId = (res.body as { id: number }).id;

    const exceptions = await prisma.inventoryException.findMany({ where: { salesOrderId: orderId } });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ productId: product.id, requested: 2, allocated: 1, shortfall: 1 });
  });

  it("a sale with no matching StoreLocation skips allocation instead of failing the sale", async () => {
    const { product } = await seed();

    const res = await createOrderViaCart("Nonexistent Store", [
      { productId: product.id, quantity: 1, unitPrice: 100 },
    ]);

    expect(res.statusCode).toBe(201);
    const orderId = (res.body as { id: number }).id;
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await prisma.inventoryException.count({ where: { salesOrderId: orderId } })).toBe(0);
  });

  it("cancelling an order (status -> CANCELLED) releases committed stock", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });
    const createRes = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    const orderId = (createRes.body as { id: number }).id;
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);

    const res = makeRes();
    await orderHandler(
      makeReq({ method: "PUT", query: { id: String(orderId) }, body: { status: "CANCELLED" } }),
      res,
      registerSession,
    );

    expect(res.statusCode).toBe(200);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(5);
  });

  it("fulfilling an order (status -> FULFILLED) consumes committed stock outright", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });
    const createRes = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    const orderId = (createRes.body as { id: number }).id;

    const res = makeRes();
    await orderHandler(
      makeReq({ method: "PUT", query: { id: String(orderId) }, body: { status: "FULFILLED" } }),
      res,
      registerSession,
    );

    expect(res.statusCode).toBe(200);
    // The goods left the building: committed rows are gone, and the 2 units
    // never come back to available stock (unlike a cancel/release).
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);
  });

  it("dispatchStatus -> FULFILLED also consumes committed stock", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });
    const createRes = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    const orderId = (createRes.body as { id: number }).id;

    const res = makeRes();
    await dispatchHandler(
      makeReq({ method: "PUT", query: { id: String(orderId) }, body: { dispatchStatus: "FULFILLED" } }),
      res,
      registerSession,
    );

    expect(res.statusCode).toBe(200);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);
  });

  it("dispatchStatus -> CANCELLED releases committed stock", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });
    const createRes = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    const orderId = (createRes.body as { id: number }).id;

    const res = makeRes();
    await dispatchHandler(
      makeReq({ method: "PUT", query: { id: String(orderId) }, body: { dispatchStatus: "CANCELLED" } }),
      res,
      registerSession,
    );

    expect(res.statusCode).toBe(200);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(5);
  });

  it("a routine dispatch write (no terminal transition) does not touch inventory", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });
    const createRes = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    const orderId = (createRes.body as { id: number }).id;

    const res = makeRes();
    await dispatchHandler(
      makeReq({
        method: "PUT",
        query: { id: String(orderId) },
        body: { dispatchStatus: "SCHEDULED_DELIVERY" },
      }),
      res,
      registerSession,
    );

    expect(res.statusCode).toBe(200);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(1);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);
  });

  it("adding a line item resyncs allocation to commit the new line's stock", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });
    const createRes = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    const orderId = (createRes.body as { id: number }).id;
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(3);

    const res = makeRes();
    await lineItemsHandler(
      makeReq({
        method: "POST",
        query: { id: String(orderId) },
        body: { productName: "Sofa", quantity: 1, unitPrice: 100, productId: product.id },
      }),
      res,
      registerSession,
    );

    expect(res.statusCode).toBe(201);
    // 2 (original) + 1 (new line) = 3 committed, 2 left free.
    const committed = await prisma.inventoryPosition.findMany({ where: { salesOrderId: orderId } });
    expect(committed).toHaveLength(1);
    expect(committed[0].quantity).toBe(3);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(2);
  });

  it("cancelling a line item resyncs allocation to release its stock", async () => {
    const { store, floor, product } = await seed();
    await prisma.inventoryPosition.create({
      data: { productId: product.id, storeLocationId: store.id, stockLocationId: floor.id, quantity: 5 },
    });
    const createRes = await createOrderViaCart(store.name, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    const orderId = (createRes.body as { id: number }).id;
    const order = await prisma.salesOrder.findUnique({
      where: { id: orderId },
      include: { lineItems: true },
    });
    const lineItemId = order!.lineItems[0].id;

    const res = makeRes();
    await lineItemHandler(
      makeReq({
        method: "PUT",
        query: { id: String(orderId), lineItemId: String(lineItemId) },
        body: { action: "cancel", reason: "Customer changed mind" },
      }),
      res,
      registerSession,
    );

    expect(res.statusCode).toBe(200);
    expect(await prisma.inventoryPosition.count({ where: { salesOrderId: orderId } })).toBe(0);
    expect(await availableQuantity(product.id, store.id, prisma)).toBe(5);
  });
});
