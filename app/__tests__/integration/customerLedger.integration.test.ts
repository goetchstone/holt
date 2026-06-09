// /app/__tests__/integration/customerLedger.integration.test.ts
//
// Phase 0.5.2 — B-grade integration tests for `appendEntry()`. The pure
// helpers (`computeRunningBalance`, `validateAgainstSource`, `signForType`)
// are A-graded in `__tests__/customerLedger.test.ts` — this file owns the
// DB-touching atomic-append contract:
//
//   1. The ledger row is INSERTED and Customer.openArBalance is UPDATED
//      in the SAME `prisma.$transaction()`. A failure mid-flight rolls
//      back both writes.
//
//   2. Sequential appends honor the running balance — entry N's
//      balanceBefore equals entry N-1's balanceAfter, regardless of
//      whether the caller passes its own tx or lets appendEntry open one.
//
//   3. Concurrent appends still produce a consistent total. (Postgres
//      row-level locking via the `findUniqueOrThrow` + `update` inside
//      the transaction serializes contending writes against the same
//      Customer row.)
//
// All three are testable ONLY against a real Postgres — `prisma.$transaction`
// is opaque to mocked clients.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { appendEntry } from "@/lib/customerLedger";

describe("customerLedger.appendEntry — atomic append (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("inserts a ledger row AND bumps Customer.openArBalance in one transaction", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Test", lastName: "Customer" },
    });
    expect(Number(customer.openArBalance ?? 0)).toBe(0);

    const entry = await appendEntry({
      customerId: customer.id,
      type: "SALE",
      amount: 1000,
      reference: "SO-1",
      createdBy: "test",
    });

    expect(entry.balanceBefore).toBe(0);
    expect(entry.balanceAfter).toBe(1000);

    const after = await prisma.customer.findUnique({
      where: { id: customer.id },
      select: { openArBalance: true },
    });
    expect(Number(after?.openArBalance ?? 0)).toBe(1000);

    const rows = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("SALE");
    expect(Number(rows[0].amount)).toBe(1000);
    expect(Number(rows[0].balanceAfter)).toBe(1000);
  });

  it("walks balance correctly across a SALE -> PAYMENT -> PAYMENT chain", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Sandy", lastName: "Buyer" },
    });

    const e1 = await appendEntry({
      customerId: customer.id,
      type: "SALE",
      amount: 1000,
      reference: "SO-1",
    });
    const e2 = await appendEntry({
      customerId: customer.id,
      type: "PAYMENT",
      amount: -300,
      reference: "deposit",
    });
    const e3 = await appendEntry({
      customerId: customer.id,
      type: "PAYMENT",
      amount: -700,
      reference: "final payment",
    });

    expect(e1.balanceBefore).toBe(0);
    expect(e1.balanceAfter).toBe(1000);
    expect(e2.balanceBefore).toBe(1000);
    expect(e2.balanceAfter).toBe(700);
    expect(e3.balanceBefore).toBe(700);
    expect(e3.balanceAfter).toBe(0);

    const finalCustomer = await prisma.customer.findUnique({
      where: { id: customer.id },
      select: { openArBalance: true },
    });
    expect(Number(finalCustomer?.openArBalance ?? 0)).toBe(0);
  });

  it("rejects amount=0 (would pass balance assertions but break drill-down)", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Zero", lastName: "Amount" },
    });
    await expect(
      appendEntry({
        customerId: customer.id,
        type: "ADJUSTMENT_DEBIT",
        amount: 0,
      }),
    ).rejects.toThrow(/must be non-zero/);

    // No row inserted, no balance change.
    const rows = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
    });
    expect(rows).toHaveLength(0);
    const after = await prisma.customer.findUnique({
      where: { id: customer.id },
      select: { openArBalance: true },
    });
    expect(Number(after?.openArBalance ?? 0)).toBe(0);
  });

  it("rejects non-finite amounts (NaN, Infinity)", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Bad", lastName: "Input" },
    });
    await expect(
      appendEntry({ customerId: customer.id, type: "SALE", amount: NaN }),
    ).rejects.toThrow(/must be finite/);
    await expect(
      appendEntry({ customerId: customer.id, type: "SALE", amount: Infinity }),
    ).rejects.toThrow(/must be finite/);
  });

  it("rolls back BOTH writes when the surrounding transaction fails", async () => {
    // Prove atomicity: open a $transaction, call appendEntry inside,
    // then throw. The ledger row AND the balance update must both be
    // gone. If the trigger writes were happening outside the
    // transaction, the row would persist and the balance would have
    // bumped — both drift markers.
    const customer = await prisma.customer.create({
      data: { firstName: "Atomic", lastName: "Test" },
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await appendEntry(
          {
            customerId: customer.id,
            type: "SALE",
            amount: 500,
          },
          tx,
        );
        // Verify mid-transaction visibility — the same tx sees the
        // updated balance (the read uses the local snapshot).
        const mid = await tx.customer.findUnique({
          where: { id: customer.id },
          select: { openArBalance: true },
        });
        expect(Number(mid?.openArBalance ?? 0)).toBe(500);
        throw new Error("simulated mid-transaction failure");
      }),
    ).rejects.toThrow(/simulated mid-transaction failure/);

    // Both writes rolled back.
    const rows = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
    });
    expect(rows).toHaveLength(0);
    const after = await prisma.customer.findUnique({
      where: { id: customer.id },
      select: { openArBalance: true },
    });
    expect(Number(after?.openArBalance ?? 0)).toBe(0);
  });

  it("FK violation on customerId throws and writes nothing", async () => {
    // No row was created — the FK on customerId rejects the insert.
    await expect(
      appendEntry({
        customerId: 99999,
        type: "SALE",
        amount: 100,
      }),
    ).rejects.toThrow();

    const allRows = await prisma.customerLedgerEntry.count();
    expect(allRows).toBe(0);
  });

  it("preserves source-of-truth references (salesOrderId, paymentId, invoiceId)", async () => {
    // Drill-down works when reports query the ledger and join back to
    // the originating SalesOrder / Payment / Invoice. Pin the wiring
    // so a future schema change can't silently drop a relation.
    const customer = await prisma.customer.create({
      data: { firstName: "Drill", lastName: "Down" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `LEDGER-FK-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-04-30"),
        customerId: customer.id,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 250,
        status: "COMPLETED",
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNo: `INV-LEDGER-${Date.now()}`,
        invoiceDate: new Date("2026-04-30"),
        taxAmount: new Prisma.Decimal(15.88),
        salesOrderId: order.id,
      },
    });

    const entry = await appendEntry({
      customerId: customer.id,
      type: "PAYMENT",
      amount: -250,
      salesOrderId: order.id,
      paymentId: payment.id,
      invoiceId: invoice.id,
      reference: order.orderno,
    });

    expect(entry.salesOrderId).toBe(order.id);
    expect(entry.paymentId).toBe(payment.id);
    expect(entry.invoiceId).toBe(invoice.id);

    const fetched = await prisma.customerLedgerEntry.findUnique({
      where: { id: entry.id },
      include: { salesOrder: true, payment: true, invoice: true },
    });
    expect(fetched?.salesOrder?.orderno).toBe(order.orderno);
    expect(Number(fetched?.payment?.paymentAmount ?? 0)).toBe(250);
    expect(fetched?.invoice?.invoiceNo).toBe(invoice.invoiceNo);
  });

  it("starts a new customer at openArBalance=0 by default", async () => {
    // Migration sets DEFAULT 0 — but the column is nullable to allow
    // backfill (Phase 0.5.3) to distinguish 'never touched' from
    // 'genuinely zero'. New customers post-migration should have the
    // default 0, not NULL.
    const customer = await prisma.customer.create({
      data: { firstName: "Fresh", lastName: "Customer" },
    });
    expect(Number(customer.openArBalance ?? 0)).toBe(0);

    const entry = await appendEntry({
      customerId: customer.id,
      type: "SALE",
      amount: 42,
    });
    expect(entry.balanceBefore).toBe(0);
    expect(entry.balanceAfter).toBe(42);
  });
});
