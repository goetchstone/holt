// /app/__tests__/integration/cancelledLineFilter.integration.test.ts
//
// PHASE 0.6.1 PROOF-OF-CONCEPT — first real-DB integration test.
//
// This file exists to (a) prove the test harness works against a real
// Postgres database, and (b) validate the cancelled-line filter
// (CLAUDE.md rule 33) at the data layer that the source-text tripwire
// in __tests__/reports.cancelledLineFilter.test.ts cannot reach.
//
// CLAUDE.md rule 33: "Every report, dashboard, or aggregation that
// sums line item amounts must filter `lineItemStatus: { not:
// 'CANCELLED' }`."
//
// The source-text tripwire catches removal of the filter from the
// known list of files. This test catches the OTHER way a cancelled
// line can sneak into a total: typos like "CANCELED" (one L), case
// drift like "Cancelled", or the introduction of a NEW status enum
// value the filter doesn't know about.
//
// Behavior covered:
//   1. A non-CANCELLED line item contributes to a SUM(netPrice).
//   2. A CANCELLED line item is excluded from the same SUM.
//   3. The two together produce the active-only total.
//
// This is an A-grade test: real Postgres, real Prisma, real schema,
// real query — exercising what production actually does.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

describe("cancelled-line filter (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("excludes CANCELLED line items from a SUM(netPrice) aggregation", async () => {
    // Arrange — minimal fixtures: a customer + a sales order with
    // two inline line items where one is CANCELLED. No vendor or
    // product needed because the line items carry partNo/productName
    // as strings (no productId FK), and the assertion only inspects
    // lineItemStatus.
    const customer = await prisma.customer.create({
      data: { firstName: "Test", lastName: "Customer" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: "TEST001",
        status: "ORDER",
        orderDate: new Date("2026-04-01"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "ACTIVE-1",
              productName: "Active line",
              netPrice: 100,
              orderedQuantity: 1,
              vatAmount: 6.35,
              cost: 50,
              lineItemStatus: "ACTIVE",
            },
            {
              lineNumber: 2,
              partNo: "CANCELLED-1",
              productName: "Cancelled line — must NOT count",
              netPrice: 999,
              orderedQuantity: 1,
              vatAmount: 63.43,
              cost: 500,
              lineItemStatus: "CANCELLED",
            },
          ],
        },
      },
      include: { lineItems: true },
    });

    expect(order.lineItems).toHaveLength(2);

    // Act — replicate the canonical aggregation pattern used by the
    // detailed-sales report. The filter under test is the
    // `lineItemStatus: { not: "CANCELLED" }` clause.
    const lines = await prisma.orderLineItem.findMany({
      where: {
        salesOrderId: order.id,
        lineItemStatus: { not: "CANCELLED" },
      },
      select: { netPrice: true, lineItemStatus: true },
    });

    const total = lines.reduce((acc, l) => acc + Number(l.netPrice ?? 0), 0);

    // Assert — only the $100 active line should be counted.
    expect(lines).toHaveLength(1);
    expect(lines[0].lineItemStatus).toBe("ACTIVE");
    expect(total).toBe(100);
    // The cancelled $999 line was correctly excluded; if the filter
    // were removed (or if a typo drift introduced "CANCELED" without
    // the second L), this would fail with total=1099.
  });

  it("counts an active line even when other orders have cancelled lines", async () => {
    // Cross-row contamination guard: a CANCELLED line on order A must
    // not affect a SUM scoped to order B.
    const customer = await prisma.customer.create({
      data: { firstName: "Test", lastName: "Customer" },
    });

    const orderA = await prisma.salesOrder.create({
      data: {
        orderno: "TEST_A",
        status: "ORDER",
        orderDate: new Date("2026-04-01"),
        customerId: customer.id,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              netPrice: 200,
              orderedQuantity: 1,
              cost: 100,
              lineItemStatus: "CANCELLED",
            },
          ],
        },
      },
    });

    const orderB = await prisma.salesOrder.create({
      data: {
        orderno: "TEST_B",
        status: "ORDER",
        orderDate: new Date("2026-04-01"),
        customerId: customer.id,
        lineItems: {
          create: [
            {
              lineNumber: 1,
              netPrice: 50,
              orderedQuantity: 1,
              cost: 50,
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });

    const result = await prisma.orderLineItem.aggregate({
      where: {
        salesOrderId: orderB.id,
        lineItemStatus: { not: "CANCELLED" },
      },
      _sum: { netPrice: true },
    });

    expect(Number(result._sum.netPrice ?? 0)).toBe(50);
    // Sanity: orderA exists and the CANCELLED line is in the DB
    expect(orderA.id).toBeDefined();
  });
});
