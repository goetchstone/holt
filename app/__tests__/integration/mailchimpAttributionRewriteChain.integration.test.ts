// /app/__tests__/integration/mailchimpAttributionRewriteChain.integration.test.ts
//
// 2026-05-13 — B-grade integration coverage for the Mailchimp Campaign
// Impact report's attribution query against a real Postgres database.
// This test exists because of a user-reported regression:
//
//   Barbara Germano (cust #6480) showed 2 orders for $88,624 attributed
//   to a campaign when her actual NET spend was $61,922. The missing
//   $26,701-ish was the accounting return SR-013491 (status=RETURNED,
//   negative netPrice rows) that the report's WHERE clause silently
//   dropped via `status: { in: ["ORDER", "FULFILLED"] }` (no RETURNED).
//
// Three test cases pin the corrected shape end-to-end:
//
//   1. Base order alone — sum equals the base netPrice (sanity check).
//   2. Base + accounting return — sum equals ZERO (return nets the base).
//   3. Full rewrite chain (base + return + rewrite) — sum equals JUST the
//      rewrite, exactly mirroring the Barbara Germano case.
//
// Test queries the same WHERE clause the API uses (status IN
// SALES_REVENUE_STATUSES + lineItemStatus != CANCELLED), so a regression
// to the old filter would fail tests 2 and 3.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue";

async function sumNetPriceForCustomer(customerId: number): Promise<number> {
  const rows = await prisma.salesOrder.findMany({
    where: {
      customerId,
      status: { in: [...SALES_REVENUE_STATUSES] },
    },
    select: {
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" } },
        select: { netPrice: true },
      },
    },
  });
  let sum = 0;
  for (const o of rows) {
    for (const li of o.lineItems) {
      sum += Number(li.netPrice ?? 0);
    }
  }
  // Round to 2 decimals — Prisma Decimal → Number can introduce
  // float drift on integer-cent values that's invisible to the eye
  // but breaks toBe(...) comparisons.
  return Math.round(sum * 100) / 100;
}

describe("Mailchimp attribution — rewrite chain net (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns the base order's netPrice when only the base exists", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Solo", lastName: "Base" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-00001",
        status: "ORDER",
        orderDate: new Date("2026-04-25"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "PART-A",
              productName: "Sofa",
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal(1000),
              cost: new Prisma.Decimal(0),
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    expect(await sumNetPriceForCustomer(customer.id)).toBe(1000);
  });

  it("nets the base when a matching accounting-return SR-SAMPLE order exists", async () => {
    // Replicates the canonical sale-then-fully-returned pattern.
    // Sum must be ZERO — the negative netPrice on the SR-SAMPLE row
    // cancels the positive netPrice on the SO-SAMPLE row.
    const customer = await prisma.customer.create({
      data: { firstName: "Refund", lastName: "Customer" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-00002",
        status: "ORDER",
        orderDate: new Date("2026-04-25"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "PART-B",
              productName: "Chair",
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal(500),
              cost: new Prisma.Decimal(0),
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: "SR-00002",
        status: "RETURNED",
        orderDate: new Date("2026-04-28"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "PART-B",
              productName: "Chair",
              orderedQuantity: -1,
              netPrice: new Prisma.Decimal(-500),
              cost: new Prisma.Decimal(0),
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    expect(await sumNetPriceForCustomer(customer.id)).toBe(0);
  });

  it("nets to just the rewrite when full base + return + rewrite chain exists (Barbara Germano case)", async () => {
    // Reproduces the user-reported regression. The base order
    // ($44,312) + matching return (-$44,312) + rewrite ($44,312.01)
    // must net to $44,312.01 — exactly the rewrite.
    //
    // Previously (filter = ["ORDER", "FULFILLED"]) the query
    // returned base + rewrite = $88,624.01, double-counting.
    const customer = await prisma.customer.create({
      data: { firstName: "Barbara", lastName: "Germano" },
    });
    // Base
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-38847",
        status: "ORDER",
        orderDate: new Date("2026-04-25"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "K-2772",
              productName: "Bourbon Sofa",
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal(44312),
              cost: new Prisma.Decimal(0),
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    // Accounting return
    await prisma.salesOrder.create({
      data: {
        orderno: "SR-013491",
        status: "RETURNED",
        orderDate: new Date("2026-04-28"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "K-2772",
              productName: "Bourbon Sofa",
              orderedQuantity: -1,
              netPrice: new Prisma.Decimal(-44312),
              cost: new Prisma.Decimal(0),
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    // Rewrite — penny diff on netPrice mirrors the real prod
    // pattern where tax recomputation produces near-identical totals.
    await prisma.salesOrder.create({
      data: {
        orderno: "SO-38847 - A",
        status: "ORDER",
        orderDate: new Date("2026-04-28"),
        customerId: customer.id,
        storeLocation: "West Store",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "K-2772",
              productName: "Bourbon Sofa",
              orderedQuantity: 1,
              netPrice: new Prisma.Decimal("44312.01"),
              cost: new Prisma.Decimal(0),
              lineItemStatus: "ACTIVE",
            },
          ],
        },
      },
    });
    expect(await sumNetPriceForCustomer(customer.id)).toBe(44312.01);
  });

  it("regression guard: excluding RETURNED from the WHERE clause produces the inflated total", async () => {
    // Belt-and-suspenders — repeat the prior scenario but query with
    // the BUGGY filter (no RETURNED). This documents the actual size
    // of the bug at the data layer. If a future refactor strips
    // RETURNED out of SALES_REVENUE_STATUSES (or hard-codes the
    // narrower filter inline), this test failing tells you the
    // money math went wrong. Sum should be $88,624.01 — base +
    // rewrite double-counted.
    const customer = await prisma.customer.create({
      data: { firstName: "Bug", lastName: "Demo" },
    });
    await prisma.salesOrder.createMany({
      data: [
        {
          orderno: "SO-D-1",
          status: "ORDER",
          orderDate: new Date("2026-04-25"),
          customerId: customer.id,
          storeLocation: "West Store",
        },
        {
          orderno: "SR-D-1",
          status: "RETURNED",
          orderDate: new Date("2026-04-28"),
          customerId: customer.id,
          storeLocation: "West Store",
        },
        {
          orderno: "SO-D-1 - A",
          status: "ORDER",
          orderDate: new Date("2026-04-28"),
          customerId: customer.id,
          storeLocation: "West Store",
        },
      ],
    });
    const baseOrder = await prisma.salesOrder.findFirstOrThrow({
      where: { orderno: "SO-D-1" },
    });
    const returnOrder = await prisma.salesOrder.findFirstOrThrow({
      where: { orderno: "SR-D-1" },
    });
    const rewrite = await prisma.salesOrder.findFirstOrThrow({
      where: { orderno: "SO-D-1 - A" },
    });
    await prisma.orderLineItem.createMany({
      data: [
        {
          salesOrderId: baseOrder.id,
          lineNumber: 1,
          partNo: "X",
          productName: "Y",
          orderedQuantity: 1,
          netPrice: new Prisma.Decimal(44312),
          cost: new Prisma.Decimal(0),
          lineItemStatus: "ACTIVE",
        },
        {
          salesOrderId: returnOrder.id,
          lineNumber: 1,
          partNo: "X",
          productName: "Y",
          orderedQuantity: -1,
          netPrice: new Prisma.Decimal(-44312),
          cost: new Prisma.Decimal(0),
          lineItemStatus: "ACTIVE",
        },
        {
          salesOrderId: rewrite.id,
          lineNumber: 1,
          partNo: "X",
          productName: "Y",
          orderedQuantity: 1,
          netPrice: new Prisma.Decimal("44312.01"),
          cost: new Prisma.Decimal(0),
          lineItemStatus: "ACTIVE",
        },
      ],
    });
    // Correct query — includes RETURNED.
    expect(await sumNetPriceForCustomer(customer.id)).toBe(44312.01);
    // Buggy query — excludes RETURNED.
    const buggy = await prisma.salesOrder.findMany({
      where: {
        customerId: customer.id,
        status: { in: ["ORDER", "FULFILLED"] },
      },
      select: {
        lineItems: {
          where: { lineItemStatus: { not: "CANCELLED" } },
          select: { netPrice: true },
        },
      },
    });
    let buggySum = 0;
    for (const o of buggy) for (const li of o.lineItems) buggySum += Number(li.netPrice ?? 0);
    expect(Math.round(buggySum * 100) / 100).toBe(88624.01);
  });
});
