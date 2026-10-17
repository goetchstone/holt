// /app/__tests__/integration/oversoldReport.integration.test.ts
//
// Ledger plan phase 11: the Oversold report.
//
// A sale short of stock records an InventoryException. Re-syncing the order
// after each line edit used to add another row every time, so the queue
// counted one gap many times, and nothing ever closed a row when the stock
// arrived. Now there is one open row per (order, product), it closes itself
// once the order holds what it needs -- through a sale, a receipt for the
// order, or a transfer arriving for it -- and the report suggests the fix.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { resyncOrderAllocation } from "@/lib/inventory/orderInventorySync";
import { receiveIntoStock } from "@/lib/inventory/receiving";
import { getOversoldReport, oversoldCsv } from "@/lib/reports/oversold";
import { stockAt } from "../helpers/stock";

async function world() {
  const vendor = await prisma.vendor.create({ data: { name: "V", pricingModel: "FLAT" } });
  const department = await prisma.department.create({ data: { name: "Living" } });
  const category = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id, trackInventory: true },
  });
  const store = await prisma.storeLocation.create({
    data: { name: "Showroom", code: "SR", type: "STORE" },
  });
  const other = await prisma.storeLocation.create({
    data: { name: "Harbour", code: "HB", type: "STORE" },
  });
  const otherBack = await prisma.stockLocation.create({
    data: { storeLocationId: other.id, code: "BACK", name: "Back" },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "SOFA-1",
      name: "Harbour Sofa",
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    },
  });
  const customer = await prisma.customer.create({ data: { firstName: "A", lastName: "B" } });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: "SO-OVER",
      status: "ORDER",
      orderDate: new Date(),
      customerId: customer.id,
      storeLocation: store.name,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId: product.id,
            productName: "Harbour Sofa",
            orderedQuantity: 2,
            netPrice: 2000,
            cost: 900,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
  return { vendor, store, other, otherBack, product, order };
}

const resync = (orderId: number, storeName: string) =>
  prisma.$transaction((tx) => resyncOrderAllocation(orderId, storeName, tx));

describe("the Oversold report (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("one open row per order and product, however many times the order re-syncs", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    await resync(w.order.id, w.store.name);
    await resync(w.order.id, w.store.name);

    const open = await prisma.inventoryException.findMany({ where: { resolvedAt: null } });
    expect(open).toHaveLength(1);
    const [row] = await getOversoldReport(prisma);
    expect(row).toMatchObject({ productId: w.product.id, shortfall: 2 });
  });

  it("suggests stock free at another store first", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.other.id,
      stockLocationId: w.otherBack.id,
      quantity: 3,
    });

    const [row] = await getOversoldReport(prisma);
    expect(row.fix).toEqual({ kind: "FREE_ELSEWHERE", storeName: "Harbour", quantity: 3 });
  });

  it("stock free at the order's own store needs committing, not transferring", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    // Arrives free after the sale (not through a PO for the order).
    await stockAt({ productId: w.product.id, storeLocationId: w.store.id, quantity: 2 });
    await stockAt({
      productId: w.product.id,
      storeLocationId: w.other.id,
      stockLocationId: w.otherBack.id,
      quantity: 9,
    });

    const [row] = await getOversoldReport(prisma);
    expect(row.fix).toEqual({ kind: "FREE_HERE", storeName: "Showroom", quantity: 2 });
  });

  it("then units already on an open PO, the earliest due", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    for (const [poNumber, days] of [
      ["PO-LATE", 20],
      ["PO-SOON", 5],
    ] as const) {
      await prisma.purchaseOrder.create({
        data: {
          poNumber,
          vendorId: w.vendor.id,
          status: "CONFIRMED",
          expectedDelivery: new Date(Date.now() + days * 86_400_000),
          lineItems: { create: [{ productId: w.product.id, orderedQuantity: 4 }] },
        },
      });
    }

    const [row] = await getOversoldReport(prisma);
    expect(row.fix).toMatchObject({ kind: "ON_PO", poNumber: "PO-SOON", quantity: 4 });
  });

  it("and with nothing anywhere, to order it", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    const [row] = await getOversoldReport(prisma);
    expect(row.fix).toEqual({ kind: "ORDER_IT" });
  });

  it("closes itself when a receipt for the order covers it", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    const po = await prisma.purchaseOrder.create({
      data: { poNumber: "PO-1", vendorId: w.vendor.id, salesOrderId: w.order.id },
    });

    await prisma.$transaction((tx) =>
      receiveIntoStock(tx, {
        po,
        poItem: { orderLineItemId: null },
        productId: w.product.id,
        quantity: 2,
        storeLocationId: w.store.id,
        actor: "test",
      }),
    );

    expect(await getOversoldReport(prisma)).toEqual([]);
    const ex = await prisma.inventoryException.findFirstOrThrow();
    expect(ex.resolvedAt).not.toBeNull();
    expect(ex.resolvedBy).toBe("system");
  });

  it("a partial cover leaves the row open with what is still short", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    await stockAt({ productId: w.product.id, storeLocationId: w.store.id, quantity: 1 });

    await resync(w.order.id, w.store.name);

    const [row] = await getOversoldReport(prisma);
    expect(row.shortfall).toBe(1);
  });

  it("exports one CSV row per order short", async () => {
    const w = await world();
    await resync(w.order.id, w.store.name);
    const csv = oversoldCsv(await getOversoldReport(prisma));
    expect(csv.split("\n")[0]).toBe(
      "Product,Part No,Order,Store,Short,Since,Suggested fix,Last count off by",
    );
    expect(csv).toContain("Harbour Sofa,SOFA-1,SO-OVER,Showroom,2,");
    expect(csv).toContain("Nothing on order: start a draft PO");
  });
});
