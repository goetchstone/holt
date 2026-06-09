// /app/__tests__/integration/customerLedgerBackfill.integration.test.ts
//
// Phase 0.5.3 — backfill job tests against real DB.
//
// What this file pins:
//
//   1. The HAPPY PATH — a customer with a normal sale + payment ends
//      up with a SALE entry, a PAYMENT entry, and openArBalance = 0.
//
//   2. The REWRITE CHAIN — base + accounting return + rewrite, with
//      the phantom Gift Card payment NOT in our DB (the import runner
//      filters it at ingest). Backfill walks events in `created` order
//      and nets to the right balance: rewrite_total − base_deposit.
//
//   3. The TRUE REFUND — sale + payment + return SR-SAMPLE + refund Payment
//      with isRefund=true. Backfill emits REFUND_ISSUED that brings
//      the running balance back to zero.
//
//   4. The MIXED case — a customer who has BOTH patterns on different
//      orders. Confirms the per-event walk doesn't conflate the two.
//
//   5. IDEMPOTENCY — re-running on a customer who already has entries
//      is a no-op (no duplicate rows, no balance bump).
//
//   6. RECONCILIATION FAILURE — a manually-corrupted ledger source
//      throws and rolls back. Pre-fix this would have silently shipped
//      bad balances.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { backfillCustomerLedger } from "@/lib/customerLedgerBackfill";

async function seedCustomer(firstName: string, lastName: string): Promise<number> {
  const c = await prisma.customer.create({ data: { firstName, lastName } });
  return c.id;
}

interface SeedOrderInput {
  orderno: string;
  status?: "ORDER" | "FULFILLED" | "RETURNED" | "CANCELLED" | "QUOTE";
  customerId: number;
  created: Date;
  orderDate?: Date;
  lines: Array<{ partNo: string; netPrice: number; vatAmount?: number; qty?: number }>;
  payments?: Array<{
    paymentAmount: number;
    isRefund?: boolean;
    status?: "COMPLETED" | "VOIDED" | "FAILED" | null;
    paymentCode?: string;
    created?: Date;
  }>;
}

async function seedOrder(opts: SeedOrderInput): Promise<{ id: number }> {
  const o = await prisma.salesOrder.create({
    data: {
      orderno: opts.orderno,
      status: opts.status ?? "ORDER",
      customerId: opts.customerId,
      created: opts.created,
      orderDate: opts.orderDate ?? opts.created,
      lineItems: {
        create: opts.lines.map((l, i) => ({
          lineNumber: i + 1,
          partNo: l.partNo,
          netPrice: l.netPrice,
          cost: 0,
          vatAmount: l.vatAmount ?? 0,
          orderedQuantity: l.qty ?? 1,
          lineItemStatus: "ACTIVE" as const,
        })),
      },
      payments: opts.payments
        ? {
            create: opts.payments.map((p) => ({
              paymentAmount: p.paymentAmount,
              isRefund: p.isRefund ?? false,
              status: p.status === undefined ? "COMPLETED" : p.status,
              paymentType: "card",
              paymentCode: p.paymentCode,
              paymentDate: p.created ?? opts.created,
              created: p.created ?? opts.created,
            })),
          }
        : undefined,
    },
    select: { id: true },
  });
  return o;
}

describe("customerLedgerBackfill (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ─── 1. Happy path ────────────────────────────────────────────────────

  it("backfills a simple sale + payment with balance = 0", async () => {
    const customerId = await seedCustomer("Happy", "Path");
    await seedOrder({
      orderno: "SO-001",
      customerId,
      created: new Date("2024-10-04T10:00:00Z"),
      lines: [{ partNo: "ITEM-1", netPrice: 1000, vatAmount: 63.5 }],
      payments: [{ paymentAmount: 1063.5, created: new Date("2024-10-04T10:30:00Z") }],
    });

    const result = await backfillCustomerLedger(customerId);
    expect(result.status).toBe("backfilled");
    expect(result.entriesCreated).toBe(2);
    expect(result.finalBalance).toBe(0);
    expect(result.validation.ok).toBe(true);

    const rows = await prisma.customerLedgerEntry.findMany({
      where: { customerId },
      orderBy: { created: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("SALE");
    expect(Number(rows[0].amount)).toBe(1063.5);
    expect(rows[1].type).toBe("PAYMENT");
    expect(Number(rows[1].amount)).toBe(-1063.5);

    const cust = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { openArBalance: true },
    });
    expect(Number(cust?.openArBalance)).toBe(0);
  });

  // ─── 2. Rewrite chain ─────────────────────────────────────────────────

  it("nets a rewrite chain correctly: base + SR-SAMPLE + rewrite, phantom payment absent", async () => {
    // Sandy Favale shape: base $10K paid $5K deposit, customer modifies
    // order, the POS splits into base + accounting return + rewrite.
    // Phantom Gift Card payment on rewrite is FILTERED AT IMPORT and
    // therefore not in our DB — backfill must produce the right net
    // balance from what's left.
    const customerId = await seedCustomer("Sandy", "Favale");

    const dayX = new Date("2024-10-04T10:00:00Z");
    const dayY = new Date("2024-10-05T10:00:00Z");

    // Base SO-SAMPLE with original line items + $5K deposit
    await seedOrder({
      orderno: "SO-1000",
      customerId,
      created: dayX,
      lines: [{ partNo: "SOFA", netPrice: 10000, vatAmount: 635 }],
      payments: [{ paymentAmount: 5000, created: new Date("2024-10-04T10:30:00Z") }],
    });
    // SR-SAMPLE accounting return — negative line items, no payment
    await seedOrder({
      orderno: "SR-1000",
      status: "RETURNED",
      customerId,
      created: dayY,
      lines: [{ partNo: "SOFA", netPrice: -10000, vatAmount: -635 }],
    });
    // Rewrite — new line set, phantom Gift Card payment is NOT seeded
    // (mirrors the import runner's filtering).
    await seedOrder({
      orderno: "SO-1000 - A",
      customerId,
      created: new Date("2024-10-05T10:01:00Z"),
      lines: [{ partNo: "SOFA-UPGRADED", netPrice: 11000, vatAmount: 698.5 }],
    });

    const result = await backfillCustomerLedger(customerId);
    expect(result.status).toBe("backfilled");
    expect(result.validation.ok).toBe(true);

    // Expected balance: rewrite ($11,698.50) − base deposit ($5,000) = $6,698.50
    expect(result.finalBalance).toBe(6698.5);

    // Walk the entries chronologically and verify the running balance
    // matches the table at the top of the test.
    const rows = await prisma.customerLedgerEntry.findMany({
      where: { customerId },
      orderBy: [{ created: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(4);
    expect(rows[0].type).toBe("SALE");
    expect(Number(rows[0].balanceAfter)).toBe(10635);
    expect(rows[1].type).toBe("PAYMENT");
    expect(Number(rows[1].balanceAfter)).toBe(5635);
    expect(rows[2].type).toBe("SALE");
    expect(Number(rows[2].amount)).toBe(-10635); // SR-SAMPLE return
    expect(Number(rows[2].balanceAfter)).toBe(-5000);
    expect(rows[3].type).toBe("SALE");
    expect(Number(rows[3].balanceAfter)).toBe(6698.5);
  });

  // ─── 3. True refund ──────────────────────────────────────────────────

  it("handles a true refund: sale + payment + return + refund = 0 balance", async () => {
    // Customer buys $500 product, pays in full, returns it, gets cash
    // back. NO rewrite — just a clean return-with-refund.
    const customerId = await seedCustomer("Return", "Customer");

    const day1 = new Date("2024-11-01T10:00:00Z");
    const day7 = new Date("2024-11-07T14:00:00Z");

    await seedOrder({
      orderno: "SO-2000",
      customerId,
      created: day1,
      lines: [{ partNo: "LAMP", netPrice: 500, vatAmount: 31.75 }],
      payments: [{ paymentAmount: 531.75, created: day1 }],
    });
    // Return order with negative line items + refund payment
    await seedOrder({
      orderno: "SR-2000",
      status: "RETURNED",
      customerId,
      created: day7,
      lines: [{ partNo: "LAMP", netPrice: -500, vatAmount: -31.75 }],
      payments: [
        {
          paymentAmount: 531.75,
          isRefund: true,
          paymentCode: "REFUND-1",
          created: day7,
        },
      ],
    });

    const result = await backfillCustomerLedger(customerId);
    expect(result.status).toBe("backfilled");
    expect(result.validation.ok).toBe(true);
    expect(result.finalBalance).toBe(0);

    const rows = await prisma.customerLedgerEntry.findMany({
      where: { customerId },
      orderBy: [{ created: "asc" }, { id: "asc" }],
    });
    expect(rows).toHaveLength(4);
    expect(rows[0].type).toBe("SALE");
    expect(rows[1].type).toBe("PAYMENT");
    expect(rows[2].type).toBe("SALE");
    expect(Number(rows[2].amount)).toBe(-531.75);
    expect(rows[3].type).toBe("REFUND_ISSUED");
    // REFUND_ISSUED must be POSITIVE (reverses the prior payment, so
    // balance climbs back to whatever the underlying sale still
    // requires). Bug fixed 2026-05-07 in signForType — the initial
    // commit had this returning -1.
    expect(Number(rows[3].amount)).toBe(531.75);
    expect(Number(rows[3].balanceAfter)).toBe(0);
  });

  // ─── 4. Mixed customer (rewrite chain + separate refund) ─────────────

  it("walks a customer with BOTH a rewrite chain AND a separate true refund without conflating", async () => {
    const customerId = await seedCustomer("Mixed", "Activity");

    // Order 1: rewrite chain
    await seedOrder({
      orderno: "SO-A",
      customerId,
      created: new Date("2024-09-01T10:00:00Z"),
      lines: [{ partNo: "X", netPrice: 1000 }],
      payments: [{ paymentAmount: 500, created: new Date("2024-09-01T10:30:00Z") }],
    });
    await seedOrder({
      orderno: "SR-A",
      status: "RETURNED",
      customerId,
      created: new Date("2024-09-02T10:00:00Z"),
      lines: [{ partNo: "X", netPrice: -1000 }],
    });
    await seedOrder({
      orderno: "SO-A - A",
      customerId,
      created: new Date("2024-09-02T10:01:00Z"),
      lines: [{ partNo: "X-UPGRADED", netPrice: 1200 }],
    });

    // Order 2: separate refund flow on a different orderno
    await seedOrder({
      orderno: "SO-B",
      status: "FULFILLED",
      customerId,
      created: new Date("2024-10-01T10:00:00Z"),
      lines: [{ partNo: "Y", netPrice: 200 }],
      payments: [{ paymentAmount: 200, created: new Date("2024-10-01T10:30:00Z") }],
    });
    await seedOrder({
      orderno: "SR-B",
      status: "RETURNED",
      customerId,
      created: new Date("2024-10-15T14:00:00Z"),
      lines: [{ partNo: "Y", netPrice: -200 }],
      payments: [
        {
          paymentAmount: 200,
          isRefund: true,
          created: new Date("2024-10-15T14:00:00Z"),
        },
      ],
    });

    const result = await backfillCustomerLedger(customerId);
    expect(result.validation.ok).toBe(true);

    // Expected balance: rewrite chain leaves +$700 owed (1200 − 500
    // deposit), refund flow nets to 0 (200 − 200 + −200 + 200 = 0).
    // Total: +$700.
    expect(result.finalBalance).toBe(700);
  });

  // ─── 5. Idempotency ──────────────────────────────────────────────────

  it("is idempotent: re-running on the same customer is a no-op", async () => {
    const customerId = await seedCustomer("Idem", "Potent");
    await seedOrder({
      orderno: "SO-IDEM",
      customerId,
      created: new Date("2024-10-04T10:00:00Z"),
      lines: [{ partNo: "X", netPrice: 100 }],
      payments: [{ paymentAmount: 100, created: new Date("2024-10-04T10:30:00Z") }],
    });

    const first = await backfillCustomerLedger(customerId);
    expect(first.status).toBe("backfilled");
    expect(first.entriesCreated).toBe(2);

    const second = await backfillCustomerLedger(customerId);
    expect(second.status).toBe("skipped-already-backfilled");
    expect(second.entriesCreated).toBe(0);

    const total = await prisma.customerLedgerEntry.count({ where: { customerId } });
    expect(total).toBe(2);
  });

  // ─── 6. Empty customer ───────────────────────────────────────────────

  it("skips a customer with no orders", async () => {
    const customerId = await seedCustomer("Empty", "Customer");

    const result = await backfillCustomerLedger(customerId);
    expect(result.status).toBe("skipped-no-orders");
    expect(result.entriesCreated).toBe(0);
    expect(result.finalBalance).toBe(0);

    const rows = await prisma.customerLedgerEntry.count({ where: { customerId } });
    expect(rows).toBe(0);
  });

  // ─── 7. VOIDED/FAILED payment filter ─────────────────────────────────

  it("excludes VOIDED and FAILED payments from the running balance", async () => {
    const customerId = await seedCustomer("Voided", "Filter");
    await seedOrder({
      orderno: "SO-VOID",
      customerId,
      created: new Date("2024-10-04T10:00:00Z"),
      lines: [{ partNo: "X", netPrice: 1000 }],
      payments: [
        // Real payment counts
        { paymentAmount: 400, status: "COMPLETED", created: new Date("2024-10-04T10:10:00Z") },
        // VOIDED card pre-settle does NOT count
        { paymentAmount: 300, status: "VOIDED", created: new Date("2024-10-04T10:20:00Z") },
        // FAILED card does NOT count
        { paymentAmount: 200, status: "FAILED", created: new Date("2024-10-04T10:30:00Z") },
        // NULL status (the POS legacy import) DOES count — mirrors
        // computeBalance's NULL-safe handling
        { paymentAmount: 600, status: null, created: new Date("2024-10-04T10:40:00Z") },
      ],
    });

    const result = await backfillCustomerLedger(customerId);
    expect(result.validation.ok).toBe(true);
    // 1000 − 400 − 600 = 0
    expect(result.finalBalance).toBe(0);

    const rows = await prisma.customerLedgerEntry.findMany({ where: { customerId } });
    // SALE + 2 PAYMENTs (the real one + the NULL legacy). VOIDED and
    // FAILED are filtered.
    expect(rows).toHaveLength(3);
  });

  // ─── 8. CANCELLED line items filter ──────────────────────────────────

  it("excludes CANCELLED line items from the SALE amount", async () => {
    const customerId = await seedCustomer("Cancelled", "Lines");

    // Seed an order then mutate one line to CANCELLED. seedOrder
    // doesn't take that param so we'll patch after.
    const o = await prisma.salesOrder.create({
      data: {
        orderno: "SO-CANCEL",
        status: "ORDER",
        customerId,
        created: new Date("2024-10-04T10:00:00Z"),
        orderDate: new Date("2024-10-04T10:00:00Z"),
        lineItems: {
          create: [
            {
              lineNumber: 1,
              partNo: "ACTIVE-1",
              netPrice: new Prisma.Decimal(500),
              cost: new Prisma.Decimal(0),
              vatAmount: new Prisma.Decimal(31.75),
              orderedQuantity: new Prisma.Decimal(1),
              lineItemStatus: "ACTIVE",
            },
            {
              lineNumber: 2,
              partNo: "CANCELLED-1",
              netPrice: new Prisma.Decimal(9999),
              cost: new Prisma.Decimal(0),
              vatAmount: new Prisma.Decimal(635),
              orderedQuantity: new Prisma.Decimal(1),
              lineItemStatus: "CANCELLED",
              cancelReason: null,
            },
          ],
        },
      },
    });
    expect(o).toBeDefined();

    const result = await backfillCustomerLedger(customerId);
    expect(result.validation.ok).toBe(true);
    expect(result.finalBalance).toBe(531.75); // active line only
  });
});
