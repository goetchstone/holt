// /app/__tests__/integration/poSellThru.integration.test.ts
//
// Real-DB proof of the PO Sell-Thru data assembly (lib/reports/poSellThru.ts):
// seeds a vendor/product/PO/receipt/sales chain and verifies the report's
// frames + rollup, the receive-date windowing (pre-receipt sales excluded),
// and the notFound passthrough. The pure windowing math is covered in
// poSellThrough.test.ts; this proves the Prisma queries feeding it.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { getPoSellThru } from "@/lib/reports/poSellThru";

async function seedChain() {
  const user = await prisma.user.create({
    data: { id: "receiver-1", email: "receiver@test.holt" },
  });
  const vendor = await prisma.vendor.create({ data: { name: "Test Vendor" } });
  const dept = await prisma.department.create({ data: { name: "Furniture" } });
  const cat = await prisma.category.create({
    data: { name: "Seating", departmentId: dept.id },
  });
  const product = await prisma.product.create({
    data: {
      productNumber: "TV-100",
      name: "Test Chair",
      vendorId: vendor.id,
      departmentId: dept.id,
      categoryId: cat.id,
      baseCost: 100,
      baseRetail: 250,
    },
  });
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: "PO-TEST-1", vendorId: vendor.id, orderDate: new Date(2026, 0, 5) },
  });
  const poItem = await prisma.purchaseOrderItem.create({
    data: { purchaseOrderId: po.id, productId: product.id, orderedQuantity: 10, unitCost: 100 },
  });
  await prisma.receivingRecord.create({
    data: {
      purchaseOrderId: po.id,
      purchaseOrderItemId: poItem.id,
      quantityReceived: 10,
      receivedDate: new Date(2026, 1, 1), // Feb 1 — window start
      receiverUserId: user.id,
    },
  });
  return { vendor, product, po };
}

async function seedSale(
  productId: number,
  orderno: string,
  orderDate: Date,
  qty: number,
  lineTotal: number,
) {
  await prisma.salesOrder.create({
    data: {
      orderno,
      orderDate,
      status: "ORDER",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productId,
            productName: "Test Chair",
            partNo: "TV-100",
            orderedQuantity: qty,
            netPrice: lineTotal,
            cost: qty * 100,
            barcode: "",
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
}

describe("getPoSellThru against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("builds frames + rollup from a seeded PO/receipt/sales chain, windowed from receipt", async () => {
    const { product } = await seedChain();
    // After the Feb 1 receipt: counts. Before it: excluded by the window.
    await seedSale(product.id, "SO-1", new Date(2026, 2, 1), 4, 1000);
    await seedSale(product.id, "SO-PRE", new Date(2026, 0, 20), 2, 500);

    const result = await getPoSellThru(prisma, { poNumbers: ["PO-TEST-1", "PO-MISSING"] });

    expect(result.notFound).toEqual(["PO-MISSING"]);
    expect(result.pos).toHaveLength(1);
    expect(result.pos[0]).toMatchObject({ poNumber: "PO-TEST-1", vendorName: "Test Vendor" });

    expect(result.frames).toHaveLength(1);
    const frame = result.frames[0];
    expect(frame.qtyOrdered).toBe(10);
    expect(frame.qtyReceived).toBe(10);
    // Only the post-receipt sale counts — the January sale is outside the window.
    expect(frame.qtyStockSold).toBe(4);
    expect(frame.revenue).toBe(1000);
    // Realized retail: sold 1000 vs list 4 x 250 = 1000 -> full price.
    expect(frame.realizedRetailRatio).toBe(1);

    expect(result.rollup.totalQtyOrdered).toBe(10);
    expect(result.rollup.totalQtyStockSold).toBe(4);
    expect(result.rollup.overallStockSellThrough).toBe(0.4);
    expect(result.rollup.totalRevenue).toBe(1000);
  });

  it("excludes cancelled lines and returns empty for unknown POs", async () => {
    const { product } = await seedChain();
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-CANCELLED-LINE",
        orderDate: new Date(2026, 2, 5),
        status: "ORDER",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              productId: product.id,
              productName: "Test Chair",
              partNo: "TV-100",
              orderedQuantity: 3,
              netPrice: 750,
              cost: 300,
              barcode: "",
              vatRate: 0,
              vatAmount: 0,
              lineItemStatus: "CANCELLED",
            },
          ],
        },
      },
    });

    const result = await getPoSellThru(prisma, { poNumbers: ["PO-TEST-1"] });
    expect(result.frames[0].qtyStockSold).toBe(0);

    const empty = await getPoSellThru(prisma, { poNumbers: ["NOPE"] });
    expect(empty.pos).toHaveLength(0);
    expect(empty.notFound).toEqual(["NOPE"]);
    expect(empty.frames).toHaveLength(0);
  });
});
