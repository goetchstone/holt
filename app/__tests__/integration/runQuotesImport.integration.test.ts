// /app/__tests__/integration/runQuotesImport.integration.test.ts
//
// Phase 0.6.3 + post-failure 2026-05-07 — real-DB tests for runQuotesImport.
//
// The bug class this file guards: the Daily Quote Report from the POS
// includes EVERY order that has ever had a quoteCode, including ones
// that have been promoted to status=ORDER (and beyond). Before the
// 2026-05-07 fix, `reconcileExistingQuoteOrder` reconciled line items
// for any order in that CSV regardless of status — and the quote CSV's
// `Sellingprice Exvat` column is a UNIT price, not a line total. The
// runner was overwriting correct line totals on multi-qty lines AND
// running orphan-cleanup that re-cancelled lines on rewrite-base orders
// every time the auto-import ran.
//
// Real prod incident: SBOM39275 (5/3 Old Saybrook, $7,819 missing from
// the daily total). Caught the second time on 2026-05-07 — the FIRST
// fix (PR #209 rewrite-freeze in runSalesImport) didn't cover the
// quote-runner code path. See post-failure log.
//
// What this file pins:
//
//   1. PROMOTED-ORDER GUARD: runQuotesImport must NOT reconcile line
//      items for an order whose status is no longer QUOTE. Once an
//      order is promoted to ORDER (or RETURNED, or CANCELLED), the
//      sales runner is authoritative — the quote runner stays out.
//
//   2. REWRITE-FREEZE (defense in depth): if a future change ever
//      re-allows this code path for a non-QUOTE order, the freeze
//      still protects rewrite-chain bases from having their kept
//      lines re-cancelled.
//
//   3. ACTIVE QUOTE PATH STILL WORKS: the protections must not break
//      the original use case — reconciling line-item changes on a
//      quote that's still status=QUOTE.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { runQuotesImport } from "@/lib/adapters/ordorite/runners";

const ORDERNO = "SBOM39275";

interface QuoteCsvRow extends Record<string, unknown> {
  Company: string;
  Orderno: string;
  Status: string;
  Salesperson: string;
  Address: string;
  Customer: string;
  Email: string;
  Orderdate: string;
  Quotecode: string;
  Supplier: string;
  Orderqty: number;
  "Part No": string;
  "Product Name": string;
  "Sellingprice Exvat": number;
}

function quoteRow(overrides: Partial<QuoteCsvRow> & { partNo: string; price: number }): QuoteCsvRow {
  return {
    Company: "Old Saybrook",
    Orderno: ORDERNO,
    Status: "active",
    Salesperson: "Molly",
    Address: "",
    Customer: "Sandy Favale",
    Email: "test@example.com",
    Orderdate: "2026-05-03",
    Quotecode: "SBQT32802",
    Supplier: "BAT",
    Orderqty: 1,
    "Part No": overrides.partNo,
    "Product Name": `Product ${overrides.partNo}`,
    "Sellingprice Exvat": overrides.price,
    ...overrides,
  };
}

describe("runQuotesImport — promoted-order guard + rewrite-freeze", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ─── Promoted-order guard (regression for 2026-05-07 SBOM39275) ───────

  it("does NOT touch line items on an order that has been promoted to ORDER status", async () => {
    // Exact prod scenario: SBOM39275 (status=ORDER, has quoteCode) is in
    // the Daily Quote Report. Before the fix: reconcileExistingQuoteOrder
    // overwrites netPrice with unit prices AND cancels orphan lines.
    const customer = await prisma.customer.create({
      data: { firstName: "Sandy", lastName: "Favale" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: ORDERNO,
        status: "ORDER", // promoted from QUOTE
        orderDate: new Date("2026-05-03"),
        customerId: customer.id,
        storeLocation: "Old Saybrook",
        salesperson: "Molly",
        quoteCode: "SBQT32802", // had a quote code at one point
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "BAT-CS14BW",
              productName: "Multi-qty corrected line total",
              netPrice: 2920, // 8 × $365 — CORRECT line total
              cost: 1460,
              orderedQuantity: 8,
              lineItemStatus: "ACTIVE" as const,
            },
            {
              lineNumber: 2,
              partNo: "BAT-CL20",
              productName: "Another correct multi-qty",
              netPrice: 590, // 2 × $295 — CORRECT line total
              cost: 295,
              orderedQuantity: 2,
              lineItemStatus: "ACTIVE" as const,
            },
            // Lines 3-15 simulate the "moved to rewrite" set that
            // shouldn't be re-cancelled by a quote-CSV truncation.
            ...Array.from({ length: 13 }, (_, i) => ({
              lineNumber: i + 3,
              partNo: `BAT-EXTRA-${i + 3}`,
              productName: `Extra ${i + 3}`,
              netPrice: 100,
              cost: 50,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE" as const,
            })),
          ],
        },
      },
    });

    // Quote CSV has just 2 rows with UNIT prices (matching the prod
    // failure's Sellingprice Exvat being unit, not line-total).
    const csv = [
      quoteRow({ partNo: "BAT-CS14BW", price: 365, Orderqty: 8 }), // unit price
      quoteRow({ partNo: "BAT-CL20", price: 295, Orderqty: 2 }), // unit price
    ];

    const result = await runQuotesImport(csv);
    expect(result.errors).toEqual([]);

    // Line totals MUST be preserved (not overwritten with unit prices).
    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines).toHaveLength(15);
    expect(Number(lines[0].netPrice)).toBe(2920); // would be 365 pre-fix
    expect(Number(lines[1].netPrice)).toBe(590); // would be 295 pre-fix
    // Lines 3-15 must stay ACTIVE (no orphan-cancellation).
    for (let i = 2; i < lines.length; i++) {
      expect(lines[i].lineItemStatus).toBe("ACTIVE");
    }
  });

  it("does NOT touch line items on an order with status=RETURNED", async () => {
    // Same protection extends to any non-QUOTE status.
    const customer = await prisma.customer.create({
      data: { firstName: "Test", lastName: "Customer" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: ORDERNO,
        status: "RETURNED",
        orderDate: new Date("2026-04-30"),
        customerId: customer.id,
        storeLocation: "Old Saybrook",
        quoteCode: "Q-1",
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "X-1",
              netPrice: 1000,
              cost: 400,
              orderedQuantity: 1,
              lineItemStatus: "ACTIVE" as const,
            },
          ],
        },
      },
    });

    // Quote CSV provides nothing for this orderno's line items — pre-fix
    // would orphan-cancel line 1.
    const csv: QuoteCsvRow[] = [];
    csv.push(quoteRow({ partNo: "X-OTHER", price: 5, Orderno: "OTHER-1" }));

    await runQuotesImport(csv);
    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].lineItemStatus).toBe("ACTIVE");
    expect(Number(lines[0].netPrice)).toBe(1000);
  });

  // ─── Rewrite-freeze (defense in depth) ────────────────────────────────

  it("freezes orphan-cleanup when a sibling rewrite exists (status=QUOTE base)", async () => {
    // Belt-and-suspenders: even on a still-QUOTE base, if a sibling
    // rewrite exists, the quote runner must not orphan-cancel. This
    // path is rare (a quote that was rewritten without being promoted
    // first), but the freeze covers it for parity with runSalesImport.
    const customer = await prisma.customer.create({
      data: { firstName: "Test", lastName: "Customer" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: ORDERNO,
        status: "QUOTE",
        orderDate: new Date("2026-04-30"),
        customerId: customer.id,
        storeLocation: "Old Saybrook",
        quoteCode: "Q-1",
        lineItems: {
          create: [1, 2, 3, 4, 5].map((n) => ({
            lineNumber: n,
            partNo: `BASE-${n}`,
            netPrice: 100,
            cost: 50,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE" as const,
          })),
        },
      },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: `${ORDERNO} - A`,
        status: "QUOTE",
        orderDate: new Date("2026-05-01"),
        customerId: customer.id,
        storeLocation: "Old Saybrook",
        quoteCode: "Q-1A",
      },
    });

    // CSV truncated to 2 rows — pre-freeze would cancel 3, 4, 5.
    const csv = [
      quoteRow({ partNo: "BASE-1", price: 100 }),
      quoteRow({ partNo: "BASE-2", price: 100 }),
    ];
    await runQuotesImport(csv);

    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l.lineItemStatus === "ACTIVE")).toBe(true);
  });

  // ─── Happy path (still works for actual quotes) ───────────────────────

  it("STILL reconciles line items on an order that's actually status=QUOTE", async () => {
    // The protection must not break the original use case.
    const customer = await prisma.customer.create({
      data: { firstName: "Test", lastName: "Customer" },
    });
    await prisma.salesOrder.create({
      data: {
        orderno: ORDERNO,
        status: "QUOTE",
        orderDate: new Date("2026-04-30"),
        customerId: customer.id,
        storeLocation: "Old Saybrook",
        quoteCode: "Q-1",
        lineItems: {
          create: [1, 2, 3].map((n) => ({
            lineNumber: n,
            partNo: `OLD-${n}`,
            netPrice: 50,
            cost: 25,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE" as const,
          })),
        },
      },
    });

    // Customer edited the quote: line 1 now $200, line 2 now $300, line 3 dropped.
    // No rewrite sibling exists, so orphan-cleanup is allowed.
    const csv = [
      quoteRow({ partNo: "NEW-1", price: 200 }),
      quoteRow({ partNo: "NEW-2", price: 300 }),
    ];
    await runQuotesImport(csv);

    const lines = await prisma.orderLineItem.findMany({
      where: { salesOrder: { orderno: ORDERNO } },
      orderBy: { lineNumber: "asc" },
    });
    expect(lines).toHaveLength(3);
    expect(lines[0].partNo).toBe("NEW-1");
    expect(Number(lines[0].netPrice)).toBe(200);
    expect(lines[1].partNo).toBe("NEW-2");
    expect(Number(lines[1].netPrice)).toBe(300);
    // Line 3 orphan-cancelled (CSV shrunk from 3 to 2 rows).
    expect(lines[2].lineItemStatus).toBe("CANCELLED");
  });
});
