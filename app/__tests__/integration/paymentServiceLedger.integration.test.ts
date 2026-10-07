// /app/__tests__/integration/paymentServiceLedger.integration.test.ts
//
// Phase 0.5.4 — paymentService ↔ customerLedger wiring (real DB).
//
// What this verifies (and a mocked-Prisma test CANNOT):
//
//   1. `recordPayment` writes a `CustomerLedgerEntry` row AND bumps
//      `Customer.openArBalance` in the SAME `$transaction` as the
//      Payment row — all three commit atomically.
//
//   2. `processRefund` writes a REFUND_ISSUED entry with positive amount
//      (per `signForType`) so the balance walks back UP to its pre-
//      payment value, mirroring `computeBalance`'s "refunds SUBTRACT
//      from totalPaid" rule.
//
//   3. Walk-in / unlinked sales (no customer on input AND no customer
//      on the order) record the Payment but skip the ledger — the
//      ledger is per-customer; nothing to ledger.
//
//   4. The reference/paymentId/salesOrderId trinity is preserved so the
//      ledger drill-down works end-to-end.
//
// Why real-DB:
//   `prisma.$transaction` is opaque to mocked clients; mocked-Prisma
//   tests would let a code path that "calls appendEntry but the
//   Payment row never lands" pass green. Only Postgres proves the
//   atomic commit.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { recordPayment, processRefund } from "@/lib/paymentService";

describe("paymentService — recordPayment + processRefund ledger wiring (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── recordPayment ────────────────────────────────────────────────────

  it("recordPayment writes a PAYMENT ledger entry with the NEGATIVE amount and bumps openArBalance", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Pay", lastName: "Wired", openArBalance: 500 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `PAY-LEDGER-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });

    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 175,
      customerId: customer.id,
      createdBy: "test",
    });

    expect(payment.status).toBe("COMPLETED");
    expect(Number(payment.paymentAmount)).toBe(175);

    const entries = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id, paymentId: payment.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("PAYMENT");
    expect(Number(entries[0].amount)).toBe(-175);
    expect(Number(entries[0].balanceBefore)).toBe(500);
    expect(Number(entries[0].balanceAfter)).toBe(325);
    expect(entries[0].salesOrderId).toBe(order.id);
    expect(entries[0].reference).toBe(order.orderno);

    const after = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: { openArBalance: true },
    });
    expect(Number(after.openArBalance ?? 0)).toBe(325);
  });

  it("recordPayment falls back to SalesOrder.customerId when input.customerId is missing", async () => {
    // Cash-at-counter case: the cashier doesn't always re-enter the
    // customer on the payment input; the order already has one.
    const customer = await prisma.customer.create({
      data: { firstName: "Order", lastName: "Customer", openArBalance: 1000 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `ORDER-CUST-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });

    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 250,
      createdBy: "test",
      // NOTE: no customerId — the wiring must resolve from the order.
    });

    const entries = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id, paymentId: payment.id },
    });
    expect(entries).toHaveLength(1);
    expect(Number(entries[0].amount)).toBe(-250);
    expect(Number(entries[0].balanceAfter)).toBe(750);
  });

  it("recordPayment skips the ledger for a true walk-in (no customer on input or order)", async () => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `WALKIN-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        // customerId omitted — true walk-in cash sale.
      },
    });

    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 60,
      createdBy: "test",
    });

    expect(payment.status).toBe("COMPLETED");

    // No ledger entry, no customer to bump. The whole point of the
    // skip is that walk-ins don't drift any ledger.
    const allEntries = await prisma.customerLedgerEntry.findMany({
      where: { paymentId: payment.id },
    });
    expect(allEntries).toHaveLength(0);
  });

  it("recordPayment that throws after Payment.create rolls back the Payment row too", async () => {
    // Force the ledger write to fail by deleting the customer after
    // the order was created but before we attempt the payment. The
    // appendEntry call inside the tx then throws on findUniqueOrThrow,
    // which must roll back the whole transaction (so the Payment row
    // also disappears).
    const customer = await prisma.customer.create({
      data: { firstName: "Will", lastName: "Vanish" },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `ROLLBACK-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });

    // Delete the customer outside the recordPayment tx — keeps the FK
    // pointer dangling so appendEntry's findUniqueOrThrow on Customer
    // raises P2025.
    await prisma.customer.delete({ where: { id: customer.id } });

    await expect(
      recordPayment(order.id, {
        method: "CASH",
        amount: 100,
        customerId: customer.id,
        createdBy: "test",
      }),
    ).rejects.toThrow();

    const payments = await prisma.payment.findMany({
      where: { salesOrderId: order.id },
    });
    expect(payments).toHaveLength(0); // Payment row was rolled back
  });

  // ── processRefund ────────────────────────────────────────────────────

  it("processRefund writes a REFUND_ISSUED entry with POSITIVE amount and walks balance back up", async () => {
    const customer = await prisma.customer.create({
      data: { firstName: "Refund", lastName: "Walker", openArBalance: 500 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `REFUND-LEDGER-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });

    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 200,
      customerId: customer.id,
      createdBy: "test",
    });

    // After the payment: balance went 500 → 300
    let cust = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(Number(cust.openArBalance ?? 0)).toBe(300);

    const refund = await processRefund(payment.id, {
      amount: 75,
      reason: "Customer changed mind",
      createdBy: "test",
    });

    expect(refund.isRefund).toBe(true);
    expect(refund.originalPaymentId).toBe(payment.id);

    const refundEntries = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id, paymentId: refund.id },
    });
    expect(refundEntries).toHaveLength(1);
    expect(refundEntries[0].type).toBe("REFUND_ISSUED");
    expect(Number(refundEntries[0].amount)).toBe(75); // POSITIVE
    expect(Number(refundEntries[0].balanceBefore)).toBe(300);
    expect(Number(refundEntries[0].balanceAfter)).toBe(375);
    expect(refundEntries[0].notes).toBe("Customer changed mind");

    cust = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(Number(cust.openArBalance ?? 0)).toBe(375);
  });

  it("processRefund records ledger via the original payment's customerId when present", async () => {
    // Even if the payment had a customerId set directly (not from the
    // order — e.g. store-credit flow), the refund follows the same id.
    const customer = await prisma.customer.create({
      data: { firstName: "Direct", lastName: "Refund", openArBalance: 0 },
    });
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `DIRECT-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
        customerId: customer.id,
      },
    });

    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 400,
      customerId: customer.id,
      createdBy: "test",
    });

    const refund = await processRefund(payment.id, {
      amount: 400,
      reason: "Full refund",
      createdBy: "test",
    });

    // Full refund → original transitions to REFUNDED
    const updated = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(updated.status).toBe("REFUNDED");

    // Two ledger entries: PAYMENT then REFUND_ISSUED, net to 0
    const allEntries = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
      orderBy: { id: "asc" },
    });
    expect(allEntries).toHaveLength(2);
    expect(allEntries[0].type).toBe("PAYMENT");
    expect(Number(allEntries[0].amount)).toBe(-400);
    expect(allEntries[1].type).toBe("REFUND_ISSUED");
    expect(Number(allEntries[1].amount)).toBe(400);
    expect(Number(allEntries[1].balanceAfter)).toBe(0);

    expect(refund.id).toBeTruthy();
  });

  it("processRefund skips ledger when neither Payment nor SalesOrder has a customer", async () => {
    const order = await prisma.salesOrder.create({
      data: {
        orderno: `WALKIN-REFUND-${Date.now()}`,
        status: "ORDER",
        orderDate: new Date("2026-05-12"),
      },
    });
    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 80,
      createdBy: "test",
    });

    const refund = await processRefund(payment.id, {
      amount: 80,
      reason: "Customer changed mind",
      createdBy: "test",
    });

    expect(refund.isRefund).toBe(true);
    const ledgerForOrder = await prisma.customerLedgerEntry.findMany({
      where: {
        OR: [{ paymentId: payment.id }, { paymentId: refund.id }],
      },
    });
    expect(ledgerForOrder).toHaveLength(0); // walk-in stays out of the ledger
  });
});
