// /app/__tests__/integration/commissionDrift.integration.test.ts
//
// Real-DB tests for `computeLockedPayoutDrift`. Drift detection is
// the safety net for the lock-it-in design — when returns / rewrites
// / cancellations / reassignments land AFTER a payout is locked
// with an order date INSIDE the locked period, the locked row's
// frozen ytdSalesAtEnd no longer matches a live recompute. The
// helper here is what powers the admin "Payout Drift" surface.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { commitPayoutsForPeriod } from "@/lib/runCommissionPayouts";
import { computeLockedPayoutDrift } from "@/lib/commissionDrift";

const P1_START = new Date("2026-05-01T00:00:00Z");
const P1_END = new Date("2026-05-15T00:00:00Z");

async function seedDesigner(name: string) {
  return prisma.staffMember.create({
    data: { displayName: name, role: "DESIGNER", isActive: true, aliases: [] },
  });
}

async function seedCustomer() {
  return prisma.customer.create({ data: { firstName: "T", lastName: "C" } });
}

async function seedOrder(opts: {
  orderno: string;
  customerId: number;
  staffId: number;
  orderDate: Date;
  netPrice: number;
  status?: "ORDER" | "FULFILLED" | "RETURNED" | "CANCELLED";
}) {
  return prisma.salesOrder.create({
    data: {
      orderno: opts.orderno,
      status: opts.status ?? "ORDER",
      orderDate: opts.orderDate,
      customerId: opts.customerId,
      salesPersonId: opts.staffId,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            netPrice: opts.netPrice,
            cost: 0,
            orderedQuantity: 1,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
}

async function seedDefaultTiers() {
  await prisma.commissionTier.createMany({
    data: [
      {
        label: "Up to $750k",
        minYtdSales: 0,
        maxYtdSalesExclusive: 750_000,
        rate: 0.03,
        sortOrder: 0,
      },
      {
        label: "$750k – $1M",
        minYtdSales: 750_000,
        maxYtdSalesExclusive: 1_000_000,
        rate: 0.04,
        sortOrder: 1,
      },
    ],
  });
}

describe("computeLockedPayoutDrift (real DB)", () => {
  beforeEach(async () => {
    await resetTestDb();
    await seedDefaultTiers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns empty when no locked payouts exist", async () => {
    const rows = await computeLockedPayoutDrift();
    expect(rows).toEqual([]);
  });

  it("returns empty when locked payouts match live data (no drift)", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner("Alice");
    await seedOrder({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 500_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    const rows = await computeLockedPayoutDrift();
    expect(rows).toEqual([]);
  });

  it("flags a locked payout when an SR-SAMPLE return lands AFTER lock with date INSIDE the period", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner("Alice");
    await seedOrder({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 500_000,
    });
    const locked = await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    // Now a return lands, dated 5/03 (inside period 1) — the case
    // the lock-it-in design has to handle.
    await seedOrder({
      orderno: "AL-SR-SAMPLE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-03T00:00:00Z"),
      netPrice: -75_000,
      status: "RETURNED",
    });

    const rows = await computeLockedPayoutDrift();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payoutId: locked.payoutIds[0],
      displayName: "Alice",
      lockedYtdAtEnd: 500_000,
      liveYtdAtEnd: 425_000, // 500k - 75k
      drift: -75_000,
    });
    expect(rows[0].lockedCommissionAmount).toBe(500_000 * 0.03);
  });

  it("flags a locked payout when a CANCELLATION lands inside the period", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner("Alice");
    const o1 = await seedOrder({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 400_000,
    });
    await seedOrder({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-10T00:00:00Z"),
      netPrice: 100_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    // Order o1 gets cancelled after the lock.
    await prisma.salesOrder.update({
      where: { id: o1.id },
      data: { status: "CANCELLED" },
    });

    const rows = await computeLockedPayoutDrift();
    expect(rows).toHaveLength(1);
    expect(rows[0].drift).toBe(-400_000);
    expect(rows[0].lockedYtdAtEnd).toBe(500_000);
    expect(rows[0].liveYtdAtEnd).toBe(100_000);
  });

  it("flags drift in BOTH directions (sale backdated into the period adds positive drift)", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner("Alice");
    await seedOrder({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 500_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    // A quote-to-order promotion lands with a backdated 5/10 date —
    // the order existed as QUOTE during the period and only flipped
    // to ORDER after the lock.
    await seedOrder({
      orderno: "AL-BACK",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-10T00:00:00Z"),
      netPrice: 60_000,
    });

    const rows = await computeLockedPayoutDrift();
    expect(rows).toHaveLength(1);
    expect(rows[0].drift).toBe(60_000);
    expect(rows[0].lockedYtdAtEnd).toBe(500_000);
    expect(rows[0].liveYtdAtEnd).toBe(560_000);
  });

  it("staffMemberId filter narrows to one designer", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner("Alice");
    const bob = await seedDesigner("Bob");
    for (const [name, staffId] of [
      ["AL", alice.id],
      ["BO", bob.id],
    ] as const) {
      await seedOrder({
        orderno: `${name}-P1`,
        customerId: customer.id,
        staffId,
        orderDate: new Date("2026-05-05T00:00:00Z"),
        netPrice: 100_000,
      });
    }
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });
    // Both designers get a late return.
    await seedOrder({
      orderno: "AL-SR-SAMPLE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-03T00:00:00Z"),
      netPrice: -10_000,
      status: "RETURNED",
    });
    await seedOrder({
      orderno: "BO-SR-SAMPLE",
      customerId: customer.id,
      staffId: bob.id,
      orderDate: new Date("2026-05-03T00:00:00Z"),
      netPrice: -20_000,
      status: "RETURNED",
    });

    const aliceOnly = await computeLockedPayoutDrift({ staffMemberId: alice.id });
    expect(aliceOnly).toHaveLength(1);
    expect(aliceOnly[0].displayName).toBe("Alice");
    expect(aliceOnly[0].drift).toBe(-10_000);
  });

  it("includeClean=true returns rows with zero drift too", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner("Alice");
    await seedOrder({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 250_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });

    const clean = await computeLockedPayoutDrift({ includeClean: true });
    expect(clean).toHaveLength(1);
    expect(clean[0].drift).toBe(0);
  });

  it("ignores DRAFT (unlocked) payouts even when their data drifted", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner("Alice");
    await seedOrder({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 300_000,
    });
    await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: false, // DRAFT
      actorEmail: "admin@x.com",
    });
    await seedOrder({
      orderno: "AL-SR-SAMPLE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-03T00:00:00Z"),
      netPrice: -50_000,
      status: "RETURNED",
    });

    const rows = await computeLockedPayoutDrift();
    // Drafts re-compute on next preview/commit; they never "drift"
    // because there's no frozen value to compare against.
    expect(rows).toEqual([]);
  });
});
