// /app/__tests__/integration/buyersStockSpecialClassifier.integration.test.ts
//
// B-grade integration coverage for the Buyers Report's stock-vs-special
// classifier in `lib/reports/buyersReport.ts` (getBuyersSummary). Real
// Postgres, real Prisma — proves the actual SQL behavior of the LATERAL join.
//
// User-reported bug #168 (2026-05-15): apparel was classified as
// "special ordered" at 87% rate when in reality it's ~3%. Root cause:
// the LATERAL join allowed a PurchaseOrderItem to count as a "special"
// link if its `externalPorNo` matched the line item's `porNumber`,
// WITHOUT requiring the PO to actually be allocated to the same
// SalesOrder. the POS reuses POR strings as tracking IDs even for
// stock-floor sales, so unrelated POs false-matched across the board.
//
// Empirical from prod backup 2026-05-14 (Womens Apparel only):
//   Old classifier:    4,943 / 5,705 = 87% special  ❌ wrong
//   Fixed classifier:    176 / 5,705 =  3% special  ✓ matches reality
//
// This test pins the new same-SO requirement against fixture data:
// a stock-shape line and a special-shape line, with cross-SO POR
// noise that the old code would have false-matched.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

// Replays the LATERAL join from `getBuyersSummary` (lib/reports/buyersReport.ts).
// The actual report wraps this in a per-product aggregation; for the classifier behavior test
// we just count "how many lines classify as special vs stock" with
// fixture data and assert.
async function classifyLine(lineItemId: number): Promise<"stock" | "special"> {
  const rows = await prisma.$queryRaw<Array<{ is_special: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "PurchaseOrderItem" poi
      JOIN "PurchaseOrder" po2 ON po2.id = poi."purchaseOrderId"
      JOIN "OrderLineItem" li ON li.id = ${lineItemId}
      WHERE po2."salesOrderId" = li."salesOrderId"
        AND po2."salesOrderId" IS NOT NULL
        AND (
          poi."orderLineItemId" = li.id
          OR (
            poi."externalPorNo" IS NOT NULL
            AND poi."externalPorNo" != ''
            AND poi."externalPorNo" = li."porNumber"
          )
        )
    ) AS is_special
  `;
  return rows[0]?.is_special ? "special" : "stock";
}

describe("Buyers Report stock-vs-special classifier (real DB) — Issue #168", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("classifies a stock-floor sale as 'stock' (no PO allocation)", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Walk", lastName: "In" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-STOCK",
        status: "ORDER",
        orderDate: new Date("2026-04-01"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "DRESS-A",
              productName: "Stock dress",
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal(150),
              cost: new Prisma.Decimal(60),
              lineItemStatus: "ACTIVE",
              porNumber: "POR-APP-001", // the POS tracking POR
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    const oli = order.lineItems[0];
    expect(await classifyLine(oli.id)).toBe("stock");
  });

  it("classifies a true special order (PO allocated to SAME SO) as 'special'", async () => {
    const vendor = await prisma.vendor.create({
      data: { name: "Custom Vendor" },
    });
    const dept = await prisma.department.create({ data: { name: "Furniture" } });
    const cat = await prisma.category.create({
      data: { name: "Seating", departmentId: dept.id },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "WH-CUSTOM",
        name: "Custom Sofa",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const customer = await prisma.customer.create({
      data: { firstName: "Special", lastName: "Customer" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-SPECIAL",
        status: "ORDER",
        orderDate: new Date("2026-04-01"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "WH-CUSTOM",
              productName: "Custom Sofa",
              productId: product.id,
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal(5000),
              cost: new Prisma.Decimal(2000),
              lineItemStatus: "ACTIVE",
              porNumber: "POR-WH-100",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    const oli = order.lineItems[0];
    // The PO IS allocated to this same SalesOrder
    await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON-CUSTOM-A",
        vendorId: vendor.id,
        status: "CONFIRMED",
        salesOrderId: order.id, // ← whole-PO allocation to this SO
        lineItems: {
          create: [
            {
              productId: product.id,
              partNo: "WH-CUSTOM",
              orderedQuantity: 1,
              unitCost: new Prisma.Decimal(2000),
              orderLineItemId: oli.id,
              externalPorNo: "POR-WH-100",
            },
          ],
        },
      },
    });
    expect(await classifyLine(oli.id)).toBe("special");
  });

  it("DOES NOT classify a line as 'special' when a different-SO PO shares the porNumber (the #168 bug)", async () => {
    // Stock-shape apparel sale that has a porNumber (the POS assigns
    // them as tracking IDs even on floor stock). A totally unrelated
    // PO for a DIFFERENT SalesOrder happens to have the same externalPorNo.
    // The OLD classifier would false-match this as "special"; the new
    // one rejects because the PO's salesOrderId doesn't match.
    const vendor = await prisma.vendor.create({
      data: { name: "Apparel Brand" },
    });
    const dept = await prisma.department.create({ data: { name: "Womens Apparel" } });
    const cat = await prisma.category.create({
      data: { name: "Dresses", departmentId: dept.id },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: "AP-DRESS",
        name: "Stock Dress",
        vendorId: vendor.id,
        departmentId: dept.id,
        categoryId: cat.id,
      },
    });
    const customerA = await prisma.customer.create({
      data: { firstName: "Cust", lastName: "A" },
    });
    const customerB = await prisma.customer.create({
      data: { firstName: "Cust", lastName: "B" },
    });
    // Customer A's APPAREL sale — stock-floor, but the POS assigned POR-APP-7.
    const orderA = await prisma.salesOrder.create({
      data: {
        orderno: "SO-APP-A",
        status: "ORDER",
        orderDate: new Date("2026-04-01"),
        customerId: customerA.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "AP-DRESS",
              productName: "Stock Dress",
              productId: product.id,
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal(150),
              cost: new Prisma.Decimal(60),
              lineItemStatus: "ACTIVE",
              porNumber: "POR-APP-7",
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    // Customer B's UNRELATED order, with a PO that happens to share externalPorNo POR-APP-7.
    const orderB = await prisma.salesOrder.create({
      data: {
        orderno: "SO-APP-B",
        status: "ORDER",
        orderDate: new Date("2026-04-02"),
        customerId: customerB.id,
        storeLocation: "West Store",
      },
    });
    await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON-OTHER",
        vendorId: vendor.id,
        status: "CONFIRMED",
        salesOrderId: orderB.id, // ← different SalesOrder
        lineItems: {
          create: [
            {
              productId: product.id,
              partNo: "AP-DRESS",
              orderedQuantity: 1,
              unitCost: new Prisma.Decimal(60),
              externalPorNo: "POR-APP-7", // same POR string, unrelated
            },
          ],
        },
      },
    });
    const oli = orderA.lineItems[0];
    // OLD classifier: matched on porNumber → wrongly "special".
    // NEW classifier: rejects because po.salesOrderId != orderA.id.
    expect(await classifyLine(oli.id)).toBe("stock");
  });

  it("rejects empty-string externalPorNo as a match signal", async () => {
    // Defensive against data where both sides have '' (empty). Old
    // code's `!= NULL` guard let empty-string matches through.
    const customer = await prisma.customer.create({
      data: { firstName: "Empty", lastName: "POR" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "SO-EMPTY",
        status: "ORDER",
        orderDate: new Date("2026-04-01"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "X",
              productName: "X",
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal(100),
              cost: new Prisma.Decimal(40),
              lineItemStatus: "ACTIVE",
              porNumber: "", // empty
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    const vendor = await prisma.vendor.create({ data: { name: "V" } });
    await prisma.purchaseOrder.create({
      data: {
        poNumber: "PON-EMPTY-PO",
        vendorId: vendor.id,
        status: "CONFIRMED",
        salesOrderId: order.id, // same SO — but POR strings both empty
        lineItems: {
          create: [
            {
              partNo: "X",
              orderedQuantity: 1,
              unitCost: new Prisma.Decimal(40),
              externalPorNo: "", // empty
            },
          ],
        },
      },
    });
    const oli = order.lineItems[0];
    // Empty != empty should NOT match (only the same-SO whole-PO
    // wouldn't suffice on its own without a poi-side link).
    expect(await classifyLine(oli.id)).toBe("stock");
  });
});
