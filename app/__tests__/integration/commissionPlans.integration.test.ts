// /app/__tests__/integration/commissionPlans.integration.test.ts
//
// Real-DB integration tests for per-salesperson commission plans.
// Proves the resolution chain (assigned plan -> default plan -> legacy
// CommissionTier table -> built-in defaults) through the actual payout
// engine — previewPayoutsForPeriod / commitPayoutsForPeriod — and pins
// two contracts:
//
//   - FC-restore parity: with NO CommissionPlan rows, a restored
//     legacy dataset (CommissionTier table only) computes IDENTICALLY
//     to the pre-plans engine (calculateMarginalCommission over the
//     legacy tiers).
//   - Mid-year plan switch: chain continuity carries YTD DOLLARS
//     across the switch; the new plan's brackets price subsequent
//     slices from the carried position — history is never re-priced.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { previewPayoutsForPeriod, commitPayoutsForPeriod } from "@/lib/runCommissionPayouts";
import { createPlan, resolvePlanTiersForStaff, LEGACY_PLAN_NAME } from "@/lib/commissionPlans";
import { calculateMarginalCommission, DEFAULT_COMMISSION_TIERS } from "@/lib/commissionTiers";
import type { CommissionTier } from "@/lib/commissionTiers";

const PERIOD_START = new Date("2026-05-16T00:00:00Z");
const PERIOD_END = new Date("2026-05-31T00:00:00Z");
const BEFORE_PERIOD = new Date("2026-03-15T00:00:00Z");

async function seedDesigner(opts: { displayName: string; commissionPlanId?: number | null }) {
  return prisma.staffMember.create({
    data: {
      displayName: opts.displayName,
      aliases: [],
      role: "DESIGNER",
      isActive: true,
      commissionPlanId: opts.commissionPlanId ?? null,
    },
  });
}

async function seedCustomer() {
  return prisma.customer.create({
    data: { firstName: "T", lastName: "Customer" },
  });
}

/**
 * Seed a SalesOrder + one line for a designer/date. Status defaults to
 * ORDER so the canonical revenue filter picks it up.
 */
async function seedOrderForDesigner(opts: {
  orderno: string;
  customerId: number;
  staffId: number;
  orderDate: Date;
  netPrice: number;
}) {
  return prisma.salesOrder.create({
    data: {
      orderno: opts.orderno,
      status: "ORDER",
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

/**
 * The 5-tier standard set in CommissionTier-helper shape. Same values
 * the FC seed migration writes — the parity reference for the
 * FC-restore test.
 */
const LEGACY_STANDARD_TIERS: ReadonlyArray<CommissionTier & { sortOrder: number }> = [
  { label: "Up to $750k", minYtdSales: 0, maxYtdSalesExclusive: 750_000, rate: 0.03, sortOrder: 0 },
  {
    label: "$750k – $1M",
    minYtdSales: 750_000,
    maxYtdSalesExclusive: 1_000_000,
    rate: 0.04,
    sortOrder: 1,
  },
  {
    label: "$1M – $1.5M",
    minYtdSales: 1_000_000,
    maxYtdSalesExclusive: 1_500_000,
    rate: 0.05,
    sortOrder: 2,
  },
  {
    label: "$1.5M – $2M",
    minYtdSales: 1_500_000,
    maxYtdSalesExclusive: 2_000_000,
    rate: 0.06,
    sortOrder: 3,
  },
  {
    label: "Over $2M",
    minYtdSales: 2_000_000,
    maxYtdSalesExclusive: null,
    rate: 0.07,
    sortOrder: 4,
  },
];

/** Seed the LEGACY CommissionTier table (no CommissionPlan rows). */
async function seedLegacyTierTable() {
  await prisma.commissionTier.createMany({
    data: LEGACY_STANDARD_TIERS.map((t) => ({
      label: t.label,
      minYtdSales: t.minYtdSales,
      maxYtdSalesExclusive: t.maxYtdSalesExclusive,
      rate: t.rate,
      sortOrder: t.sortOrder,
    })),
  });
}

function flatTier(label: string, rate: number) {
  return [{ label, minYtdSales: 0, maxYtdSalesExclusive: null, rate, sortOrder: 0 }];
}

beforeEach(async () => {
  await resetTestDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("per-designer plan resolution through preview + commit", () => {
  it("two designers on two different plans price identical sales differently; commit persists plan id + name", async () => {
    const customer = await seedCustomer();
    // First created plan auto-becomes the default — irrelevant here
    // because BOTH designers get explicit assignments.
    const planA = await createPlan({ name: "Plan A", tiers: flatTier("Flat 3%", 0.03) });
    const planB = await createPlan({ name: "Plan B", tiers: flatTier("Flat 10%", 0.1) });
    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: planA.id });
    const bob = await seedDesigner({ displayName: "Bob", commissionPlanId: planB.id });

    // Identical sales: $100k each, same day.
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });
    await seedOrderForDesigner({
      orderno: "BO-1",
      customerId: customer.id,
      staffId: bob.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts).toHaveLength(2);
    const al = drafts.find((d) => d.displayName === "Alice");
    const bo = drafts.find((d) => d.displayName === "Bob");

    // Same sales, different plans, different money.
    expect(al).toMatchObject({
      periodSalesAmount: 100_000,
      commissionAmount: 3_000, // 100k × 3%
      commissionPlanId: planA.id,
      commissionPlanName: "Plan A",
    });
    expect(bo).toMatchObject({
      periodSalesAmount: 100_000,
      commissionAmount: 10_000, // 100k × 10%
      commissionPlanId: planB.id,
      commissionPlanName: "Plan B",
    });

    // Commit persists both denormalized plan columns on the rows.
    const result = await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: false,
      actorEmail: "admin@example.com",
    });
    expect(result.created).toBe(2);

    const rows = await prisma.commissionPayout.findMany({
      include: { staffMember: { select: { displayName: true } } },
    });
    const aliceRow = rows.find((r) => r.staffMember.displayName === "Alice");
    const bobRow = rows.find((r) => r.staffMember.displayName === "Bob");
    expect(aliceRow?.commissionPlanId).toBe(planA.id);
    expect(aliceRow?.commissionPlanName).toBe("Plan A");
    expect(Number(aliceRow?.commissionAmount)).toBe(3_000);
    expect(bobRow?.commissionPlanId).toBe(planB.id);
    expect(bobRow?.commissionPlanName).toBe("Plan B");
    expect(Number(bobRow?.commissionAmount)).toBe(10_000);
  });

  it("unassigned designer falls to the DEFAULT plan; draft carries the default plan's id + name", async () => {
    const customer = await seedCustomer();
    // First plan created becomes the default automatically.
    const houseDefault = await createPlan({
      name: "House Default",
      tiers: flatTier("Flat 5%", 0.05),
    });
    const alice = await seedDesigner({ displayName: "Alice" }); // no assignment

    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 80_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      displayName: "Alice",
      commissionAmount: 4_000, // 80k × 5% (default plan, NOT legacy/builtin 3%)
      commissionPlanId: houseDefault.id,
      commissionPlanName: "House Default",
    });
  });
});

describe("FC-restore compatibility (the parity tripwire)", () => {
  it("with NO CommissionPlan rows, the legacy CommissionTier table computes IDENTICALLY to calculateMarginalCommission — planId null, planName Standard", async () => {
    // A restored FC backup lands tier rows in CommissionTier and has
    // zero CommissionPlan rows. The engine must price exactly like the
    // pre-plans engine did.
    await seedLegacyTierTable();
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    // Crosses $750k mid-period: $700k pre-period + $100k in-period.
    await seedOrderForDesigner({
      orderno: "AL-PRE",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: BEFORE_PERIOD,
      netPrice: 700_000,
    });
    await seedOrderForDesigner({
      orderno: "AL-IN",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft.ytdSalesAtStart).toBe(700_000);
    expect(draft.ytdSalesAtEnd).toBe(800_000);

    // The parity assertion: identical to the pre-plans engine's math
    // over the same legacy tiers.
    const reference = calculateMarginalCommission(700_000, 800_000, LEGACY_STANDARD_TIERS);
    expect(draft.commissionAmount).toBe(reference.commission);
    // Sanity-pin the actual number: $50k @ 3% + $50k @ 4% = $3,500.
    expect(draft.commissionAmount).toBe(3_500);

    expect(draft.commissionPlanId).toBeNull();
    expect(draft.commissionPlanName).toBe(LEGACY_PLAN_NAME);
    expect(draft.commissionPlanName).toBe("Standard");
  });

  it("with NO plans and NO legacy tiers, DEFAULT_COMMISSION_TIERS price the draft", async () => {
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice" });

    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
    expect(drafts).toHaveLength(1);

    const reference = calculateMarginalCommission(0, 100_000, DEFAULT_COMMISSION_TIERS);
    expect(drafts[0].commissionAmount).toBe(reference.commission);
    expect(drafts[0].commissionAmount).toBe(3_000); // 100k × 3% bottom tier
    expect(drafts[0].commissionPlanId).toBeNull();
    expect(drafts[0].commissionPlanName).toBe(LEGACY_PLAN_NAME);
  });
});

describe("mid-year plan switch semantics", () => {
  const P1_START = new Date("2026-05-01T00:00:00Z");
  const P1_END = new Date("2026-05-15T00:00:00Z");
  const P2_START = new Date("2026-05-16T00:00:00Z");
  const P2_END = new Date("2026-05-31T00:00:00Z");

  it("a locked period under plan A is never re-priced; plan B prices the next period FROM the carried YTD position", async () => {
    const customer = await seedCustomer();
    const planA = await createPlan({ name: "Plan A", tiers: flatTier("Flat 3%", 0.03) });
    // Plan B has a bracket boundary at $750k so the test distinguishes
    // "carried YTD position" (slice lands in the 10% bracket) from a
    // restart-at-zero bug (slice would land in the 2% bracket).
    const planB = await createPlan({
      name: "Plan B",
      tiers: [
        {
          label: "Up to $750k",
          minYtdSales: 0,
          maxYtdSalesExclusive: 750_000,
          rate: 0.02,
          sortOrder: 0,
        },
        {
          label: "Over $750k",
          minYtdSales: 750_000,
          maxYtdSalesExclusive: null,
          rate: 0.1,
          sortOrder: 1,
        },
      ],
    });
    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: planA.id });

    // Period 1 under plan A: $750k of sales. Lock it.
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 750_000,
    });
    const lockResult = await commitPayoutsForPeriod(P1_START, P1_END, [], {
      lockNow: true,
      actorEmail: "admin@example.com",
    });
    const lockedRow = await prisma.commissionPayout.findUnique({
      where: { id: lockResult.payoutIds[0] },
    });
    expect(Number(lockedRow!.ytdSalesAtEnd)).toBe(750_000);
    expect(Number(lockedRow!.commissionAmount)).toBe(22_500); // 750k × 3% under plan A
    expect(lockedRow!.commissionPlanId).toBe(planA.id);
    expect(lockedRow!.commissionPlanName).toBe("Plan A");

    // Mid-year switch: reassign Alice to plan B.
    await prisma.staffMember.update({
      where: { id: alice.id },
      data: { commissionPlanId: planB.id },
    });

    // Period 2: $100k of new sales.
    await seedOrderForDesigner({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 100_000,
    });

    const drafts = await previewPayoutsForPeriod(P2_START, P2_END);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];

    // Chain continuity carries DOLLARS across the switch: ytdAtStart
    // reads the LOCKED P1 ytdSalesAtEnd, not a plan-relative restart.
    expect(draft.ytdSalesAtStart).toBe(750_000);
    expect(draft.ytdSalesAtEnd).toBe(850_000);
    expect(draft.periodSalesAmount).toBe(100_000);

    // The P2 slice is priced through plan B's brackets AT the carried
    // position: all $100k sits in the over-$750k bracket → 10% →
    // $10,000. (Restart-at-zero would give $2,000; re-pricing history
    // through plan B would corrupt the locked $22,500.)
    expect(draft.commissionAmount).toBe(10_000);
    expect(draft.commissionPlanId).toBe(planB.id);
    expect(draft.commissionPlanName).toBe("Plan B");

    // And the locked P1 row is untouched.
    const stillLocked = await prisma.commissionPayout.findUnique({
      where: { id: lockResult.payoutIds[0] },
    });
    expect(Number(stillLocked!.commissionAmount)).toBe(22_500);
    expect(stillLocked!.commissionPlanId).toBe(planA.id);
  });
});

describe("resolvePlanTiersForStaff fallthrough", () => {
  it("an assigned plan with ZERO tier rows falls through to the default plan (never silently pays $0)", async () => {
    const houseDefault = await createPlan({
      name: "House Default",
      tiers: flatTier("Flat 5%", 0.05),
    });
    // createPlan refuses empty tier sets, so build the degenerate
    // empty plan directly — the guard under test is the resolver's.
    const emptyPlan = await prisma.commissionPlan.create({
      data: { name: "Empty Plan", isDefault: false, isActive: true },
    });
    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: emptyPlan.id });

    const resolved = await resolvePlanTiersForStaff([alice.id]);
    const aliceTiers = resolved.get(alice.id);
    expect(aliceTiers).toBeDefined();
    expect(aliceTiers!.planId).toBe(houseDefault.id);
    expect(aliceTiers!.planName).toBe("House Default");
    expect(aliceTiers!.tiers).toHaveLength(1);
    expect(aliceTiers!.tiers[0]).toMatchObject({ rate: 0.05, minYtdSales: 0 });
  });
});
