// /app/__tests__/integration/balanceAging.integration.test.ts
//
// Phase 0.5.8 — VOIDED + FAILED payment filter for the Balance Due
// Aging report.
//
// THE BUG (caught by this test pre-fix):
//   The balance-aging query (now `getBalanceAging` in
//   `lib/reports/balanceAging.ts`; formerly a Pages API route of the
//   same name, since removed) queried `payments` with no `where`
//   clause on `status`. The handler's `splitPayments` helper then
//   split by `isRefund` only, so a VOIDED card payment counted toward
//   `totalPaid` exactly the same as a real COMPLETED one — and
//   silently shrank `balanceDue`. Real money owed disappeared from the
//   AR aging report.
//
// THE FIX:
//   Add `where: { OR: [{ status: null }, { status: { notIn: [...] } }] }`
//   to the nested `payments` select, with the excluded-statuses list
//   coming from `@/lib/paymentBalance` — the same shared rule
//   `computeBalance()` (paymentService.ts) uses, so the two can't drift
//   apart the way this bug and the pending-balance bug below both did
//   before that file existed. NULL-safe per CLAUDE.md rule 51 (44K
//   legacy Payment rows have status=NULL and are real payments).
//
// 2026-08-05 UPDATE — PENDING joined the excluded list:
//   A second, unrelated bug shared this file's blast radius: PENDING
//   used to be treated as PAID everywhere (including here), on the
//   theory that a PENDING row meant "a checkout is genuinely open."
//   That let an abandoned or declined hosted checkout permanently zero
//   a real balance — same failure mode as the VOIDED bug above (money
//   owed disappears from this exact report), just a different status
//   value. computeBalance/getBalanceAging now exclude PENDING too; the
//   double-charge protection PENDING used to provide moved to an
//   explicit pre-checkout check (paymentService.findActivePendingPayment)
//   instead of living inside balance math. See the updated test below
//   ("EXCLUDES PENDING... mirroring computeBalance's PENDING fix").
//
// WHY THIS NEEDS TO BE A REAL-DB TEST (not pure-helper):
//   The bug is in the Prisma WHERE clause, not the JS reduce. A
//   pure-helper test against `splitPayments` would pass against any
//   array we hand it — the query layer is where the data actually
//   gets filtered. Only a Postgres round-trip proves the where clause
//   actually excludes VOIDED rows.
//
// SIBLINGS (deferred via spawned tasks per CLAUDE.md rule 50, 2026-05-07):
//   The same bug shape existed in 5 other call sites (customerLedger.ts and
//   this file have since been brought onto the shared @/lib/paymentBalance
//   rule; the rest are unaudited as of this writing):
//     - pages/api/portal/order.ts (customer portal totalPaid)
//     - pages/api/sales/orders/index.ts (order list aggregation)
//     - pages/api/service/customer-lookup.ts (service balance)
//     - lib/journalEntry.ts:455 (paymentWhere — JE generator)
//   pages/api/sales/orders/[id].ts's OWN totalPaid field (a separately
//   stored/denormalized column, unrelated to this query) is unaudited too;
//   OrderDetailView.tsx's CLIENT-SIDE recompute of the same order's total
//   (a different, worse bug — no status filter at all) was fixed alongside
//   the PENDING change above.
//   Each remaining site needs different structural changes (some use
//   `include: { payments: true }` and need restructuring; the JE site is a
//   top-level findMany). Tracked per spawned task chips so they don't slip
//   past the next session.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { getBalanceAging } from "@/lib/reports/balanceAging";
import { PAYMENT_STATUSES_EXCLUDED_FROM_BALANCE } from "@/lib/paymentBalance";

// Re-implement the handler's pipeline at the query layer so we can
// assert the filter shape WITHOUT reaching into Next.js's req/res
// scaffolding. Kept in lockstep with `lib/reports/balanceAging.ts`'s
// `getBalanceAging` — if that diverges, this test should diverge too.
// (A second test below, "the real getBalanceAging...", calls the actual
// production function directly rather than this re-implementation, so a
// divergence between the two would show up as a failure there.)
async function balanceAgingPaymentsForOrder(
  orderno: string,
): Promise<{ paymentAmount: Prisma.Decimal; isRefund: boolean }[]> {
  const order = await prisma.salesOrder.findUnique({
    where: { orderno },
    select: {
      payments: {
        where: {
          OR: [
            { status: null },
            { status: { notIn: [...PAYMENT_STATUSES_EXCLUDED_FROM_BALANCE] } },
          ],
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

  it("EXCLUDES PENDING but still INCLUDES REFUNDED rows (mirroring computeBalance's PENDING fix)", async () => {
    // This test used to assert the OPPOSITE of what it does now — it pinned
    // PENDING as included, on the theory that a PENDING row meant "a
    // checkout is genuinely open, count it as paid so a second one doesn't
    // start." That protection was real, but keeping it INSIDE the balance
    // computation meant an abandoned or declined hosted checkout (customer
    // closes the tab, card declines and they never retry) permanently
    // zeroed the balance here too — the exact same failure mode as the
    // VOIDED bug this file was originally written for, just via a
    // different status value, and with no product-level fix (direct SQL
    // was the only way to clear the row).
    //
    // The fix: PENDING no longer counts as paid ANYWHERE (see
    // @/lib/paymentBalance, computeBalance's PENDING note in
    // paymentService.ts). The double-charge protection PENDING used to
    // provide now lives in `paymentService.findActivePendingPayment`, an
    // explicit check the payment-creation routes run before starting a new
    // checkout — evaluated once, at the moment it matters, instead of
    // baked into every balance read (including this report) forever.
    //
    // REFUNDED is untouched by any of this: it's the ORIGINAL payment that
    // has since been refunded — the refund itself is a separate
    // isRefund=true row that nets it out — so it must stay INCLUDED in
    // totalPaid or the refund gets double-counted.
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
    expect(payments).toHaveLength(1);
    expect(Number(payments[0].paymentAmount)).toBe(150);
  });

  it("the real getBalanceAging: an order with ONLY a PENDING payment still shows the full balance due", async () => {
    // The end-to-end version of the bug this file guards against: before
    // the fix, an order whose only payment activity was an abandoned
    // checkout (a single PENDING row for the full order total) would show
    // balanceDue = $0 in the AR aging report — money owed vanished from the
    // one report whose entire purpose is surfacing money owed. Calls the
    // REAL production function (not the re-implemented query helper above)
    // so this proves the shipped code path, not just a mirror of it.
    const order = await seedOrder("AGE-PENDING-ONLY-01");
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 1000,
        status: "PENDING",
      },
    });

    const result = await getBalanceAging(prisma);
    const row = result.rows.find((r) => r.orderno === "AGE-PENDING-ONLY-01");
    expect(row).toBeDefined();
    expect(row!.totalPaid).toBe(0);
    expect(row!.balanceDue).toBe(1000);
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
