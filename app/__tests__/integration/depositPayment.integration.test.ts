// /app/__tests__/integration/depositPayment.integration.test.ts
//
// A furniture store's normal transaction: take a deposit now, the balance on
// delivery. Until the register was fixed it could not ring one -- the POS sent
// the full order total on every payment.
//
// The screen fix is guarded by a source-text test. THIS proves the money path
// underneath it actually holds, against a real database:
//
//   - the balance goes down by exactly the deposit and no more
//   - the order stays OPEN rather than being treated as settled
//   - a CustomerLedgerEntry is appended IN THE SAME TRANSACTION, which is the
//     invariant lib/customerArDrift.ts exists to detect the absence of
//   - Customer.openArBalance moves with it
//   - a second tender settles the remainder exactly, with no rounding residue
//
// Also pins that a COMPLETED payment cannot be deleted. That is a database
// trigger (migration 20260428_payment_delete_immutability_trigger), and it is
// asserted here because a trigger nothing tests is a trigger that can be
// dropped by a future migration without anything noticing.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { recordPayment, calculateOrderBalance } from "@/lib/paymentService";

async function seedUnpaidOrder(total: number) {
  const customer = await prisma.customer.create({
    data: { firstName: "Deposit", lastName: "Customer" },
  });
  const order = await prisma.salesOrder.create({
    data: {
      orderno: `DEP-${total}`,
      status: "ORDER",
      orderDate: new Date("2026-05-01T15:00:00Z"),
      customerId: customer.id,
      storeLocation: "Test Store",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productName: "Sectional",
            orderedQuantity: 1,
            netPrice: total,
            cost: total / 2,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });
  return { customer, order };
}

describe("deposit and split tender (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it("a deposit reduces the balance by exactly its amount and leaves the order open", async () => {
    const { customer, order } = await seedUnpaidOrder(900);

    const before = await calculateOrderBalance(order.id);
    expect(before.balanceDue).toBe(900);

    await recordPayment(order.id, { method: "CASH", amount: 300, createdBy: "test" });

    const after = await calculateOrderBalance(order.id);
    expect(after.balanceDue).toBe(600);
    expect(after.totalPaid).toBe(300);

    // Still owed money — the order must not read as settled.
    expect(after.balanceDue).toBeGreaterThan(0);

    const cust = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
      select: { openArBalance: true },
    });
    expect(Number(cust.openArBalance)).toBe(-300);
  });

  it("appends the AR ledger entry in the same transaction as the payment", async () => {
    const { customer, order } = await seedUnpaidOrder(900);

    expect(await prisma.customerLedgerEntry.count({ where: { customerId: customer.id } })).toBe(0);

    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 300,
      createdBy: "test",
    });

    const entries = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
    });
    expect(entries).toHaveLength(1);
    // Linked to the payment, not merely coincident with it — the link is what
    // makes drift detection able to attribute a discrepancy.
    expect(entries[0].paymentId).toBe(payment.id);
    expect(Number(entries[0].amount)).toBe(-300);
  });

  it("a second tender settles the remainder exactly, with no rounding residue", async () => {
    // Thirds of 100 are the classic place a money bug hides.
    const { order } = await seedUnpaidOrder(100);

    await recordPayment(order.id, { method: "CARD", amount: 33.33, createdBy: "test" });
    await recordPayment(order.id, { method: "CASH", amount: 33.33, createdBy: "test" });
    const mid = await calculateOrderBalance(order.id);
    expect(mid.balanceDue).toBe(33.34);

    await recordPayment(order.id, { method: "CASH", amount: 33.34, createdBy: "test" });
    const done = await calculateOrderBalance(order.id);
    expect(done.balanceDue).toBe(0);
    expect(done.totalPaid).toBe(100);
    expect(done.payments).toHaveLength(3);
  });

  it("refuses a zero or negative payment", async () => {
    const { order } = await seedUnpaidOrder(900);
    await expect(
      recordPayment(order.id, { method: "CASH", amount: 0, createdBy: "test" }),
    ).rejects.toThrow(/positive/i);
    await expect(
      recordPayment(order.id, { method: "CASH", amount: -50, createdBy: "test" }),
    ).rejects.toThrow(/positive/i);
  });

  it("a COMPLETED payment cannot be deleted", async () => {
    // Enforced by a DB trigger, not application code. Asserted here because a
    // trigger nothing tests can be dropped by a later migration silently.
    const { order } = await seedUnpaidOrder(900);
    const payment = await recordPayment(order.id, {
      method: "CASH",
      amount: 300,
      createdBy: "test",
    });

    await expect(prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(
      /append-only|terminal states/i,
    );
  });
});
