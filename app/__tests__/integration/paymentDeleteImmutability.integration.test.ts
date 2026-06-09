// /app/__tests__/integration/paymentDeleteImmutability.integration.test.ts
//
// Phase 0.6.4 backfill — B6 payment-immutability trigger behavior.
// Replaces the source-text tripwire that lived at
// __tests__/paymentDeleteImmutability.test.ts (deleted in this PR).
//
// What this verifies (that a source-text tripwire CANNOT verify):
//   - Postgres actually fires the trigger when a DELETE is attempted.
//   - The trigger raises an exception (not just a NOTICE) so the
//     transaction rolls back.
//   - Terminal-state rows (COMPLETED / REFUNDED / VOIDED) are blocked.
//   - Non-terminal rows (PENDING / FAILED) and NULL-status rows
//     (legacy data) remain deletable.
//   - The exception message includes the row id and status so
//     operators can trace which payment a stuck DELETE is about.
//
// Why a real-DB test is required:
//   The trigger is defined in plain SQL (CREATE TRIGGER ... EXECUTE
//   FUNCTION ...). A typo in the function body, a missing GRANT, or
//   an enum-value drift on Payment.status would all compile fine and
//   pass the source-text scan, but silently allow the DELETE. Only a
//   round trip through Postgres proves the trigger does its job.
//
// Phase 0 BLOCKER B6 from the SOR plan (2026-04-28). UPDATE protection
// is deliberately deferred (B6 Option C) — the trigger is BEFORE
// DELETE only. This test therefore does NOT assert UPDATE is blocked;
// it only asserts the DELETE behavior we shipped.
//
// Why beforeAll re-applies the migration SQL:
//   The Phase 0.6 test harness uses `prisma db push` for speed (the
//   first historical migration isn't replayable from scratch), so
//   raw-SQL migrations like this trigger don't land automatically on
//   the test DB. We compensate by reading the migration file and
//   replaying it once per suite. That makes the test a literal
//   integration check of the file we ship — if the SQL doesn't parse,
//   the suite fails before any scenario runs.

import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../prisma/migrations/20260428_payment_delete_immutability_trigger/migration.sql",
);

async function seedOrder() {
  return prisma.salesOrder.create({
    data: {
      orderno: `B6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "ORDER",
      orderDate: new Date("2026-04-30"),
    },
  });
}

async function seedPayment(opts: {
  status: "PENDING" | "COMPLETED" | "REFUNDED" | "VOIDED" | "FAILED" | null;
  amount?: number;
}) {
  const order = await seedOrder();
  return prisma.payment.create({
    data: {
      salesOrderId: order.id,
      paymentDate: new Date("2026-04-30"),
      paymentType: "card",
      paymentAmount: opts.amount ?? 100,
      status: opts.status,
    },
  });
}

describe("Payment DELETE immutability trigger (real DB)", () => {
  beforeAll(async () => {
    // Send the migration as one block so Postgres can parse the
    // dollar-quoted ($$...$$) function body as a single statement.
    // `prisma.$executeRawUnsafe` doesn't support multi-statement SQL
    // (it splits on the first semicolon), so use a pg.Client directly.
    const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── Allowed deletes ──

  it("allows DELETE on a PENDING payment", async () => {
    const payment = await seedPayment({ status: "PENDING" });
    await expect(prisma.payment.delete({ where: { id: payment.id } })).resolves.toBeDefined();
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after).toBeNull();
  });

  it("allows DELETE on a FAILED payment", async () => {
    const payment = await seedPayment({ status: "FAILED" });
    await expect(prisma.payment.delete({ where: { id: payment.id } })).resolves.toBeDefined();
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after).toBeNull();
  });

  it("allows DELETE on a NULL-status (legacy import) payment", async () => {
    // 44K legacy Payment rows have status=NULL. The trigger uses
    // `OLD.status IN (...)` which is unknown/false against NULL, so
    // NULL rows fall through to RETURN OLD and the delete succeeds.
    const payment = await seedPayment({ status: null });
    await expect(prisma.payment.delete({ where: { id: payment.id } })).resolves.toBeDefined();
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after).toBeNull();
  });

  // ── Blocked deletes (terminal states) ──

  it("rejects DELETE on a COMPLETED payment", async () => {
    const payment = await seedPayment({ status: "COMPLETED" });
    await expect(prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(
      /Cannot DELETE Payment/,
    );

    // Row still exists — trigger blocked the delete, didn't just throw
    // after-the-fact.
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after).not.toBeNull();
    expect(after?.status).toBe("COMPLETED");
  });

  it("rejects DELETE on a REFUNDED payment", async () => {
    const payment = await seedPayment({ status: "REFUNDED" });
    await expect(prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(
      /Cannot DELETE Payment/,
    );
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after).not.toBeNull();
    expect(after?.status).toBe("REFUNDED");
  });

  it("rejects DELETE on a VOIDED payment", async () => {
    const payment = await seedPayment({ status: "VOIDED" });
    await expect(prisma.payment.delete({ where: { id: payment.id } })).rejects.toThrow(
      /Cannot DELETE Payment/,
    );
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after).not.toBeNull();
    expect(after?.status).toBe("VOIDED");
  });

  // ── Exception message shape ──

  it("exception message includes the row id and status", async () => {
    const payment = await seedPayment({ status: "COMPLETED" });
    let caught: Error | null = null;
    try {
      await prisma.payment.delete({ where: { id: payment.id } });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // Message format from migration:
    //   'Cannot DELETE Payment id=% with status=% -- ...'
    expect(caught?.message).toMatch(new RegExp(`id=${payment.id}`));
    expect(caught?.message).toMatch(/status=COMPLETED/);
  });

  // ── Transaction rollback ──

  it("rolls back the surrounding transaction when a sibling delete trips the trigger", async () => {
    // Critical invariant: the trigger raises an EXCEPTION (not a
    // NOTICE), so the WHOLE transaction aborts. A sibling DELETE on a
    // PENDING payment in the same $transaction must NOT persist.
    //
    // If this test ever flips green-to-red because the PENDING row
    // disappeared, the trigger has been downgraded to a non-aborting
    // RAISE — that's a regression because the audit-trail-loss
    // protection is now per-row, not per-transaction.
    const allowed = await seedPayment({ status: "PENDING", amount: 50 });
    const blocked = await seedPayment({ status: "COMPLETED", amount: 75 });

    await expect(
      prisma.$transaction([
        prisma.payment.delete({ where: { id: allowed.id } }),
        prisma.payment.delete({ where: { id: blocked.id } }),
      ]),
    ).rejects.toThrow(/Cannot DELETE Payment/);

    const allowedAfter = await prisma.payment.findUnique({
      where: { id: allowed.id },
    });
    const blockedAfter = await prisma.payment.findUnique({
      where: { id: blocked.id },
    });
    expect(allowedAfter).not.toBeNull();
    expect(blockedAfter).not.toBeNull();
  });

  // ── UPDATE remains allowed (B6 Option C — trigger is DELETE-only) ──

  it("allows UPDATE of status from COMPLETED -> REFUNDED (legitimate state transition)", async () => {
    // The B6 trigger is BEFORE DELETE only. UPDATE protection was
    // deliberately deferred per the SOR plan (Option C). Refund flow
    // creates a NEW Payment row with isRefund=true and updates the
    // original's status COMPLETED -> REFUNDED — that update MUST stay
    // legal so refund accounting works.
    //
    // This test pins the design: if a future PR adds an UPDATE
    // trigger that blocks status transitions, this test fails and the
    // refund flow stops working until the trigger is widened to allow
    // the documented transition.
    const payment = await seedPayment({ status: "COMPLETED", amount: 100 });
    await expect(
      prisma.payment.update({
        where: { id: payment.id },
        data: { status: "REFUNDED" },
      }),
    ).resolves.toBeDefined();
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(after?.status).toBe("REFUNDED");
  });

  it("allows UPDATE of paymentAmount on a COMPLETED row (no UPDATE protection by design)", async () => {
    // Documents the gap: today, a hand-edit / rogue script could change
    // the amount on a COMPLETED payment without tripping any guard.
    // The accounting integrity argument is that COMPLETED payments are
    // referenced by JEs, so changing the amount creates JE drift — but
    // that's caught by the daily reconciliation cron (C1), not by an
    // UPDATE trigger.
    //
    // If we later add UPDATE protection for amount + status (Option B),
    // this test fails and gets removed; that's the intended evolution.
    const payment = await seedPayment({ status: "COMPLETED", amount: 100 });
    await expect(
      prisma.payment.update({
        where: { id: payment.id },
        data: { paymentAmount: 999 },
      }),
    ).resolves.toBeDefined();
    const after = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(Number(after?.paymentAmount)).toBe(999);
  });

  // ── deleteMany behavior (cascade-from-order pattern) ──

  it("rejects deleteMany when ANY row in the result set is in a terminal state", async () => {
    // The two existing call sites (sales/orders/[id].ts cascade and
    // POS/delete-payments.ts wipe) both go through deleteMany.
    // The trigger fires per-row, so deleteMany aborts on the first
    // terminal-state row it hits — which means the POS admin
    // wipe is now blocked when ANY COMPLETED payment exists, exactly
    // the audit-protection we want.
    const order = await seedOrder();
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 100,
        status: "PENDING",
      },
    });
    await prisma.payment.create({
      data: {
        salesOrderId: order.id,
        paymentDate: new Date("2026-04-30"),
        paymentType: "card",
        paymentAmount: 100,
        status: "COMPLETED",
      },
    });

    await expect(prisma.payment.deleteMany({ where: { salesOrderId: order.id } })).rejects.toThrow(
      /Cannot DELETE Payment/,
    );

    // Both rows still exist — deleteMany is atomic.
    const remaining = await prisma.payment.count({
      where: { salesOrderId: order.id },
    });
    expect(remaining).toBe(2);
  });
});
