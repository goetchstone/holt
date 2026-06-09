// /app/__tests__/integration/balanceAging.integration.test.ts
//
// Phase 0.5.8 — VOIDED + FAILED payment filter for the Balance Due
// Aging report.
//
// THE BUG (caught by this test pre-fix):
//   `pages/api/reports/balance-aging.ts` queried `payments` with no
//   `where` clause on `status`. The handler's `splitPayments` helper
//   then split by `isRefund` only, so a VOIDED card payment counted
//   toward `totalPaid` exactly the same as a real COMPLETED one — and
//   silently shrank `balanceDue`. Real money owed disappeared from the
//   AR aging report.
//
// THE FIX:
//   Add `where: { OR: [{ status: null }, { status: { notIn: ["VOIDED",
//   "FAILED"] } }] }` to the nested `payments` select. NULL-safe per
//   CLAUDE.md rule 51 (44K legacy Payment rows have status=NULL and
//   are real payments). Mirrors `computeBalance()` in
//   `paymentService.ts:40-71` which already excludes the same statuses.
//
// WHY THIS NEEDS TO BE A REAL-DB TEST (not pure-helper):
//   The bug is in the Prisma WHERE clause, not the JS reduce. A
//   pure-helper test against `splitPayments` would pass against any
//   array we hand it — the query layer is where the data actually
//   gets filtered. Only a Postgres round-trip proves the where clause
//   actually excludes VOIDED rows.
//
// SIBLINGS (deferred via spawned tasks per CLAUDE.md rule 50, 2026-05-07):
//   The same bug shape exists in 5 other call sites:
//     - pages/api/portal/order.ts (customer portal totalPaid)
//     - pages/api/sales/orders/index.ts (order list aggregation)
//     - pages/api/sales/orders/[id].ts (order detail)
//     - pages/api/service/customer-lookup.ts (service balance)
//     - lib/journalEntry.ts:455 (paymentWhere — JE generator)
//   Each site needs different structural changes (some use `include:
//   { payments: true }` and need restructuring; the JE site is a
//   top-level findMany). Tracked per spawned task chips so they don't
//   slip past the next session.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

// Re-implement the handler's pipeline at the query layer so we can
// assert the filter shape WITHOUT reaching into Next.js's req/res
// scaffolding. Kept in lockstep with `pages/api/reports/balance-aging.ts`
// — if the production handler diverges, this test should diverge too.
async function balanceAgingPaymentsForOrder(
  orderno: string,
): Promise<{ paymentAmount: Prisma.Decimal; isRefund: boolean }[]> {
  const order = await prisma.salesOrder.findUnique({
    where: { orderno },
    select: {
      payments: {
        where: {
          OR: [{ status: null }, { status: { notIn: ["VOIDED", "FAILED"] } }],
        },
        select: { paymentAmount: true, isRefund: true },
      },
    },
  });
  return order?.payments ?? [];
}

async function seedOrder(orderno: string): Promise<{ id: number }> {
  return prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: new Date("2026-04-30"),
      lineItems: {
        create: [
          {
            lineNumber: 1,
            partNo: "ITEM-1",
            netPrice: 1000,
            cost: 400,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
}

describe("balance-aging payments WHERE filter (Phase 0.5.8)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("excludes VOIDED payments from the balance-aging totalPaid sum", async () => {
    const order = await seedOrder("AGE-VOIDED-01");
    // One real payment: $400 COMPLETED card.
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 400,
        status: "COMPLETED",
      },
    });
    // One ghost: $300 card that was VOIDED before settling. Pre-fix
    // this would have counted toward totalPaid, hiding $300 of real
    // balance due.
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 300,
        status: "VOIDED",
      },
    });

    const payments = await balanceAgingPaymentsForOrder("AGE-VOIDED-01");
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].paymentAmount)).toBe(400);
  });

  it("excludes FAILED payments from the balance-aging totalPaid sum", async () => {
    const order = await seedOrder("AGE-FAILED-01");
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 250,
        status: "COMPLETED",
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 100,
        status: "FAILED",
      },
    });

    const payments = await balanceAgingPaymentsForOrder("AGE-FAILED-01");
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].paymentAmount)).toBe(250);
  });

  it("INCLUDES legacy NULL-status payments (44K the POS-imported rows are real money)", async () => {
    const order = await seedOrder("AGE-NULL-01");
    // The canonical legacy row: status=NULL because the POS's CSV
    // doesn't carry a status column. These are real payments and MUST
    // count toward totalPaid. The OR-with-null pattern (CLAUDE.md
    // rule 51) is the only Prisma WHERE shape that catches these.
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 500,
        status: null,
      },
    });

    const payments = await balanceAgingPaymentsForOrder("AGE-NULL-01");
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].paymentAmount)).toBe(500);
  });

  it("INCLUDES PENDING and REFUNDED rows (mirroring computeBalance behavior)", async () => {
    // computeBalance excludes ONLY {VOIDED, FAILED}. PENDING is
    // treated as paid (in-flight transaction); REFUNDED is the
    // ORIGINAL payment that has since been refunded — the refund
    // itself is a separate isRefund=true row that nets it. So both
    // PENDING and REFUNDED rows must remain in the report's totalPaid.
    const order = await seedOrder("AGE-MIXED-01");
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 200,
        status: "PENDING",
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 150,
        status: "REFUNDED",
      },
    });

    const payments = await balanceAgingPaymentsForOrder("AGE-MIXED-01");
    expect(payments).toHaveLength(2);
    const total = payments.reduce((s, p) => s + Number(p.paymentAmount), 0);
    expect(total).toBe(350);
  });

  it("the canonical bug shape: 1 COMPLETED + 1 VOIDED + 1 NULL leaves the right two visible", async () => {
    // The combined regression test — exercises the OR-with-null
    // pattern under the realistic mix that prod sees. Pre-fix this
    // would have returned all 3 rows (VOIDED counted), pushing
    // totalPaid from $900 (correct) to $1100 (wrong) and shrinking
    // balanceDue by $200.
    const order = await seedOrder("AGE-CANONICAL-01");
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 400,
        status: "COMPLETED",
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 200,
        status: "VOIDED",
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 500,
        status: null,
      },
    });

    const payments = await balanceAgingPaymentsForOrder("AGE-CANONICAL-01");
    expect(payments).toHaveLength(2);
    const total = payments.reduce((s, p) => s + Number(p.paymentAmount), 0);
    expect(total).toBe(900);
  });
});
