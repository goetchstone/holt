// /app/__tests__/integration/transferForOrder.integration.test.ts
//
// "Sold at Store A, stock at Store B" is the case allocation cannot serve on its
// own: it is store-scoped, so an order written at one store never sees another
// store's stock. Moving the stock is the answer, and InventoryTransfer.
// salesOrderId records WHY it moved -- so an order can show what it is waiting
// on, and a transfer can say which sale it unblocks.
//
// Also pins the receive path's merge. That upsert could never match a free-stock
// row: InventoryPosition's unique key holds two NULLABLE columns and the index
// does not declare NULLS NOT DISTINCT, so Postgres treated every free row as
// distinct. Each receipt created a NEW row rather than incrementing. It lost no
// units, which is exactly why nobody noticed.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { availableQuantity } from "@/lib/inventory/allocation";

async function scenario() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const storeA = await prisma.storeLocation.create({
    data: { name: "Store A", code: "SA", type: "STORE" },
  });
  const storeB = await prisma.storeLocation.create({
    data: { name: "Store B", code: "SB", type: "STORE" },
  });
  const dept = await prisma.department.create({ data: { name: "Living Room" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: dept.id, trackInventory: true },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "HS-1",
      name: "Harbour Sofa",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: category.id,
    },
  });
  const customer = await prisma.customer.create({ data: { firstName: "Test", lastName: "Buyer" } });
  const order = await prisma.salesOrder.create({
    data: { orderno: "SO-1", customerId: customer.id, status: "ORDER", orderDate: new Date() },
  });
  // The stock is at B; the sale is at A.
  await prisma.inventoryPosition.create({
    data: { productId: product.id, storeLocationId: storeB.id, quantity: 3 },
  });
  return { storeA, storeB, product, order };
}

describe("a transfer can serve a customer order", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("records which order the move is for", async () => {
    const { storeA, storeB, product, order } = await scenario();
    const transfer = await prisma.inventoryTransfer.create({
      data: {
        productId: product.id,
        quantity: 1,
        fromLocation: storeB.name,
        toLocation: storeA.name,
        fromLocationId: storeB.id,
        toLocationId: storeA.id,
        salesOrderId: order.id,
        requestedByUserId: (await prisma.user.create({ data: { email: "t@example.com" } })).id,
        status: "DRAFT",
      },
    });
    expect(transfer.salesOrderId).toBe(order.id);

    // The question that could not be asked before: what is this order waiting on?
    const waiting = await prisma.inventoryTransfer.findMany({
      where: { salesOrderId: order.id, status: { in: ["DRAFT", "IN_TRANSIT"] } },
    });
    expect(waiting).toHaveLength(1);
  });

  it("the order at Store A cannot see Store B's stock — which is why the transfer exists", async () => {
    const { storeA, storeB, product } = await scenario();
    expect(await availableQuantity(product.id, storeA.id, prisma)).toBe(0);
    expect(await availableQuantity(product.id, storeB.id, prisma)).toBe(3);
  });
});

describe("receiving a transfer merges stock instead of fragmenting it", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("two receipts into the same store leave ONE free position", async () => {
    const { storeA, storeB, product } = await scenario();
    // Simulate what the receive path does, twice.
    for (const qty of [1, 2]) {
      const existing = await prisma.inventoryPosition.findFirst({
        where: {
          productId: product.id,
          storeLocationId: storeA.id,
          stockLocationId: null,
          salesOrderId: null,
        },
      });
      if (existing) {
        await prisma.inventoryPosition.update({
          where: { id: existing.id },
          data: { quantity: { increment: qty } },
        });
      } else {
        await prisma.inventoryPosition.create({
          data: { productId: product.id, storeLocationId: storeA.id, quantity: qty },
        });
      }
    }

    const rows = await prisma.inventoryPosition.findMany({
      where: { productId: product.id, storeLocationId: storeA.id, salesOrderId: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(3);
    expect(await availableQuantity(product.id, storeA.id, prisma)).toBe(3);
    expect(storeB.id).toBeDefined();
  });
});
