// /app/__tests__/integration/pendingPaymentLifecycle.integration.test.ts
//
// Real-DB coverage for the pending-payment lifecycle functions added
// alongside the PENDING-balance fix (paymentService.ts):
//
//   - findActivePendingPayment: the double-charge protection that replaced
//     "PENDING counts as paid" — looks for an open checkout on an order
//     before a new one is allowed to start.
//   - voidPendingPayment: deliberately ends a PENDING row's life (the
//     manual void endpoint, and the `force` replace-and-retry path in the
//     payment-creation routes).
//   - expirePendingPayment / sweepStalePendingPayments: the two mechanisms
//     that give PENDING a terminal state without a human — the webhook's
//     checkout.session.expired handling (immediate) and the age-based
//     sweeper (backstop for missed webhooks and providers with no expiry
//     event, e.g. Square).
//
// Why real-DB: every one of these does a Prisma query keyed on
// status/paymentDate/salesOrderId together — exactly the kind of WHERE-
// clause behaviour a mocked client would let slip through unnoticed (see
// balanceAging.integration.test.ts's header for the same argument about the
// sibling VOIDED bug).

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  PENDING_SESSION_LIFETIME_MS,
  findActivePendingPayment,
  voidPendingPayment,
  expirePendingPayment,
  sweepStalePendingPayments,
} from "@/lib/paymentService";

async function seedOrder(orderno: string): Promise<{ id: number }> {
  return prisma.salesOrder.create({
    data: {
      orderno,
      status: "ORDER",
      orderDate: new Date("2026-07-01"),
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

async function seedPayment(
  orderId: number,
  opts: { amount: number; status: string; ageMs?: number },
): Promise<{ id: number }> {
  const paymentDate = new Date(Date.now() - (opts.ageMs ?? 0));
  return prisma.payment.create({
    data: {
      salesOrderId: orderId,
      paymentDate,
      paymentType: "Card",
      paymentAmount: opts.amount,
      status: opts.status as any,
      method: "CARD",
      processorType: "STRIPE",
      processorTxnId: `cs_test_${orderId}_${opts.status}_${opts.ageMs ?? 0}`,
    },
  });
}

describe("pending payment lifecycle (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── findActivePendingPayment ─────────────────────────────────────────

  describe("findActivePendingPayment", () => {
    it("returns null when the order has no PENDING payment", async () => {
      const order = await seedOrder("PEND-NONE-01");
      expect(await findActivePendingPayment(order.id)).toBeNull();
    });

    it("finds a fresh PENDING payment and reports its amount and age", async () => {
      const order = await seedOrder("PEND-FRESH-01");
      const payment = await seedPayment(order.id, { amount: 400, status: "PENDING" });

      const found = await findActivePendingPayment(order.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(payment.id);
      expect(found!.amount).toBe(400);
      expect(found!.ageMinutes).toBeLessThan(2);
    });

    it("does NOT treat a PENDING row older than the session lifetime as active — it's abandoned, not open", async () => {
      const order = await seedOrder("PEND-STALE-01");
      await seedPayment(order.id, {
        amount: 400,
        status: "PENDING",
        ageMs: PENDING_SESSION_LIFETIME_MS + 60_000, // 24h + 1 minute
      });

      expect(await findActivePendingPayment(order.id)).toBeNull();
    });

    it("ignores COMPLETED, VOIDED, and FAILED rows", async () => {
      const order = await seedOrder("PEND-OTHERSTATUS-01");
      await seedPayment(order.id, { amount: 400, status: "COMPLETED" });
      await seedPayment(order.id, { amount: 100, status: "VOIDED" });
      await seedPayment(order.id, { amount: 50, status: "FAILED" });

      expect(await findActivePendingPayment(order.id)).toBeNull();
    });

    it("scopes to the order — a PENDING row on a different order never blocks this one", async () => {
      const orderA = await seedOrder("PEND-SCOPE-A-01");
      const orderB = await seedOrder("PEND-SCOPE-B-01");
      await seedPayment(orderB.id, { amount: 400, status: "PENDING" });

      expect(await findActivePendingPayment(orderA.id)).toBeNull();
    });
  });

  // ── voidPendingPayment ───────────────────────────────────────────────

  describe("voidPendingPayment", () => {
    it("voids a PENDING payment and records who did it", async () => {
      const order = await seedOrder("VOID-OK-01");
      const payment = await seedPayment(order.id, { amount: 400, status: "PENDING" });

      const voided = await voidPendingPayment(payment.id, {
        voidedBy: "manager@example.com",
        reason: "Customer says the link never arrived",
      });

      expect(voided.status).toBe("VOIDED");
      expect(voided.updatedBy).toBe("manager@example.com");
      expect(voided.processorData).toEqual({
        voidReason: "Customer says the link never arrived",
      });

      // A voided row no longer blocks a new checkout — proves the `force`
      // replace-and-retry path in the payment-creation routes actually works
      // end to end at the service layer.
      expect(await findActivePendingPayment(order.id)).toBeNull();
    });

    it("refuses to void a COMPLETED payment — that path is processRefund, not this", async () => {
      const order = await seedOrder("VOID-COMPLETED-01");
      const payment = await seedPayment(order.id, { amount: 400, status: "COMPLETED" });

      await expect(voidPendingPayment(payment.id)).rejects.toThrow(/expected PENDING/);

      const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(unchanged.status).toBe("COMPLETED");
    });

    it("refuses to void an already-VOIDED payment", async () => {
      const order = await seedOrder("VOID-TWICE-01");
      const payment = await seedPayment(order.id, { amount: 400, status: "VOIDED" });

      await expect(voidPendingPayment(payment.id)).rejects.toThrow(/expected PENDING/);
    });
  });

  // ── expirePendingPayment ─────────────────────────────────────────────

  describe("expirePendingPayment", () => {
    it("flips a PENDING payment to FAILED", async () => {
      const order = await seedOrder("EXPIRE-OK-01");
      const payment = await seedPayment(order.id, { amount: 400, status: "PENDING" });

      const expired = await expirePendingPayment(payment.id);
      expect(expired).not.toBeNull();
      expect(expired!.status).toBe("FAILED");
    });

    it("is a no-op (returns null) for a payment that's already COMPLETED — a real race with the webhook", async () => {
      const order = await seedOrder("EXPIRE-RACE-01");
      const payment = await seedPayment(order.id, { amount: 400, status: "COMPLETED" });

      const result = await expirePendingPayment(payment.id);
      expect(result).toBeNull();

      const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(unchanged.status).toBe("COMPLETED");
    });

    it("returns null for a nonexistent payment id rather than throwing", async () => {
      expect(await expirePendingPayment(999_999_999)).toBeNull();
    });
  });

  // ── sweepStalePendingPayments ────────────────────────────────────────

  describe("sweepStalePendingPayments", () => {
    it("marks PENDING rows older than the session lifetime FAILED and reports them", async () => {
      const order = await seedOrder("SWEEP-STALE-01");
      const stale = await seedPayment(order.id, {
        amount: 250,
        status: "PENDING",
        ageMs: PENDING_SESSION_LIFETIME_MS + 3_600_000, // 25h old
      });

      const result = await sweepStalePendingPayments();

      expect(result.swept).toBe(1);
      expect(result.totalAmount).toBe(250);
      expect(result.payments[0].id).toBe(stale.id);
      expect(result.payments[0].salesOrderId).toBe(order.id);

      const updated = await prisma.payment.findUniqueOrThrow({ where: { id: stale.id } });
      expect(updated.status).toBe("FAILED");
    });

    it("does NOT touch a PENDING row still within the session lifetime — it may genuinely be open", async () => {
      const order = await seedOrder("SWEEP-FRESH-01");
      const fresh = await seedPayment(order.id, {
        amount: 250,
        status: "PENDING",
        ageMs: 60_000, // 1 minute old
      });

      const result = await sweepStalePendingPayments();

      expect(result.swept).toBe(0);
      const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: fresh.id } });
      expect(unchanged.status).toBe("PENDING");
    });

    it("does NOT touch stale COMPLETED/VOIDED/FAILED rows — only PENDING is eligible", async () => {
      const order = await seedOrder("SWEEP-OTHERSTATUS-01");
      const old = PENDING_SESSION_LIFETIME_MS + 3_600_000;
      await seedPayment(order.id, { amount: 100, status: "COMPLETED", ageMs: old });
      await seedPayment(order.id, { amount: 100, status: "VOIDED", ageMs: old });
      await seedPayment(order.id, { amount: 100, status: "FAILED", ageMs: old });

      const result = await sweepStalePendingPayments();
      expect(result.swept).toBe(0);
    });

    it("sweeps across multiple orders in one run", async () => {
      const orderA = await seedOrder("SWEEP-MULTI-A-01");
      const orderB = await seedOrder("SWEEP-MULTI-B-01");
      const old = PENDING_SESSION_LIFETIME_MS + 3_600_000;
      await seedPayment(orderA.id, { amount: 100, status: "PENDING", ageMs: old });
      await seedPayment(orderB.id, { amount: 200, status: "PENDING", ageMs: old });

      const result = await sweepStalePendingPayments();
      expect(result.swept).toBe(2);
      expect(result.totalAmount).toBe(300);
    });
  });
});
