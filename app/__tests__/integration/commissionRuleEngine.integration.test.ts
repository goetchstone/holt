// /app/__tests__/integration/commissionRuleEngine.integration.test.ts
//
// Real-DB integration tests for the Stage 1 commission rule engine, wired
// through the actual orchestrator (previewPayoutsForPeriod / commitPayoutsForPeriod).
// Follows the seed pattern in runCommissionPayouts.integration.test.ts. Covers
// what the pure-engine unit tests (__tests__/commissionRuleEngine.test.ts)
// can't: real CommissionPlanRule/CommissionRuleTier rows resolved through
// lib/commissionRules.ts, real Product/Department scope matching, the
// MARGIN basis's shared cost-fallback cascade against real Product rows, and
// — the property that matters most for money code — that a RETROACTIVE
// catch-up spanning a LOCKED prior period NEVER writes to that locked row.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { previewPayoutsForPeriod, commitPayoutsForPeriod } from "@/lib/runCommissionPayouts";
import { replacePlanTiers, createPlan } from "@/lib/commissionPlans";

const PERIOD_1_START = new Date("2026-05-01T00:00:00Z");
const PERIOD_1_END = new Date("2026-05-15T00:00:00Z");
const PERIOD_2_START = new Date("2026-05-16T00:00:00Z");
const PERIOD_2_END = new Date("2026-05-31T00:00:00Z");
const PERIOD_3_START = new Date("2026-06-01T00:00:00Z");
const PERIOD_3_END = new Date("2026-06-15T00:00:00Z");

async function seedDesigner(opts: { displayName: string; commissionPlanId?: number }) {
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
  return prisma.customer.create({ data: { firstName: "T", lastName: "Customer" } });
}

async function seedVendorDeptCategory() {
  const vendor = await prisma.vendor.create({ data: { name: `V-${Date.now()}-${Math.random()}` } });
  const department = await prisma.department.create({
    data: { name: `Rugs-${Date.now()}-${Math.random()}` },
  });
  const category = await prisma.category.create({
    data: { name: "General", departmentId: department.id },
  });
  return { vendor, department, category };
}

async function seedProduct(opts: {
  vendorId: number;
  departmentId: number;
  categoryId: number;
  baseCost?: number;
}) {
  return prisma.product.create({
    data: {
      productNumber: `P-${Date.now()}-${Math.random()}`,
      name: "Test Product",
      vendorId: opts.vendorId,
      departmentId: opts.departmentId,
      categoryId: opts.categoryId,
      baseCost: opts.baseCost ?? null,
    },
  });
}

async function seedOrderForDesigner(opts: {
  orderno: string;
  customerId: number;
  staffId: number;
  orderDate: Date;
  netPrice: number;
  cost?: number;
  orderedQuantity?: number;
  productId?: number | null;
  status?: "ORDER" | "FULFILLED" | "RETURNED" | "CANCELLED" | "QUOTE";
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
            cost: opts.cost ?? 0,
            orderedQuantity: opts.orderedQuantity ?? 1,
            productId: opts.productId ?? null,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
}

describe("commission rule engine — real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("department-scoped rule + catch-all rule price different lines at different rates", async () => {
    const customer = await seedCustomer();
    const { vendor, department, category } = await seedVendorDeptCategory();
    const rugProduct = await seedProduct({
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    });
    const { vendor: v2, department: d2, category: c2 } = await seedVendorDeptCategory();
    const otherProduct = await seedProduct({
      vendorId: v2.id,
      departmentId: d2.id,
      categoryId: c2.id,
    });

    const plan = await prisma.commissionPlan.create({ data: { name: "Dept plan" } });
    const rugRule = await prisma.commissionPlanRule.create({
      data: {
        planId: plan.id,
        label: "Rugs 10%",
        sortOrder: 0,
        departmentId: department.id,
        basis: "REVENUE",
        accumulator: "YTD",
        tierMode: "MARGINAL",
      },
    });
    await prisma.commissionRuleTier.create({
      data: { ruleId: rugRule.id, label: "10%", minAmount: 0, maxAmountExclusive: null, rate: 0.1 },
    });
    const catchAllRule = await prisma.commissionPlanRule.create({
      data: {
        planId: plan.id,
        label: "Everything else 3%",
        sortOrder: 1,
        basis: "REVENUE",
        accumulator: "YTD",
        tierMode: "MARGINAL",
      },
    });
    await prisma.commissionRuleTier.create({
      data: {
        ruleId: catchAllRule.id,
        label: "3%",
        minAmount: 0,
        maxAmountExclusive: null,
        rate: 0.03,
      },
    });

    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: plan.id });
    await seedOrderForDesigner({
      orderno: "AL-RUG",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 10_000,
      productId: rugProduct.id,
    });
    await seedOrderForDesigner({
      orderno: "AL-OTHER",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-06T00:00:00Z"),
      netPrice: 20_000,
      productId: otherProduct.id,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END);
    expect(drafts).toHaveLength(1);
    // 10,000 * 10% + 20,000 * 3% = 1,000 + 600 = 1,600.
    expect(drafts[0].commissionAmount).toBe(1_600);
    // periodSalesAmount/ytdSalesAtStart/ytdSalesAtEnd stay REVENUE-basis
    // designer totals, independent of rule scope.
    expect(drafts[0].periodSalesAmount).toBe(30_000);
  });

  it("MARGIN basis uses the shared cost-fallback cascade (product.baseCost x qty when line cost is zero)", async () => {
    const customer = await seedCustomer();
    const { vendor, department, category } = await seedVendorDeptCategory();
    const product = await seedProduct({
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
      baseCost: 30,
    });

    const plan = await prisma.commissionPlan.create({ data: { name: "Margin plan" } });
    const rule = await prisma.commissionPlanRule.create({
      data: {
        planId: plan.id,
        label: "20% of margin",
        basis: "MARGIN",
        accumulator: "YTD",
        tierMode: "MARGINAL",
      },
    });
    await prisma.commissionRuleTier.create({
      data: { ruleId: rule.id, label: "20%", minAmount: 0, maxAmountExclusive: null, rate: 0.2 },
    });

    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: plan.id });
    // netPrice = $1,000 (10 units @ $100), li.cost = 0 (missing), product
    // baseCost = $30/unit x 10 units = $300 line cost -> margin = $700.
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 1_000,
      cost: 0,
      orderedQuantity: 10,
      productId: product.id,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END);
    expect(drafts).toHaveLength(1);
    // margin = 1000 - 300 = 700; commission = 700 * 20% = 140.
    expect(drafts[0].commissionAmount).toBe(140);
  });

  it("RETROACTIVE catch-up spanning a LOCKED prior period: the locked row is NEVER mutated", async () => {
    const customer = await seedCustomer();
    const plan = await prisma.commissionPlan.create({ data: { name: "Retro plan" } });
    const rule = await prisma.commissionPlanRule.create({
      data: {
        planId: plan.id,
        label: "Retro",
        basis: "REVENUE",
        accumulator: "YTD",
        tierMode: "RETROACTIVE",
      },
    });
    await prisma.commissionRuleTier.createMany({
      data: [
        {
          ruleId: rule.id,
          label: "Under $750k",
          minAmount: 0,
          maxAmountExclusive: 750_000,
          rate: 0.03,
          sortOrder: 0,
        },
        {
          ruleId: rule.id,
          label: "$750k+",
          minAmount: 750_000,
          maxAmountExclusive: null,
          rate: 0.04,
          sortOrder: 1,
        },
      ],
    });

    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: plan.id });

    // Period 1: $700k, under the band. Owed = 3% * 700k = $21,000. Lock it.
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 700_000,
    });
    const lockResult = await commitPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });
    expect(lockResult.created).toBe(1);
    const lockedRowBefore = await prisma.commissionPayout.findUnique({
      where: { id: lockResult.payoutIds[0] },
    });
    expect(Number(lockedRowBefore!.commissionAmount)).toBe(21_000);
    const lockedRowBeforeSnapshot = JSON.stringify(lockedRowBefore);

    // Period 2: another $200k, crossing into the $750k+ band. Total $900k
    // re-rates at 4% = $36,000 owed; $21,000 already recognized -> $15,000
    // new commission in period 2.
    await seedOrderForDesigner({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 200_000,
    });
    const period2Drafts = await previewPayoutsForPeriod(PERIOD_2_START, PERIOD_2_END);
    expect(period2Drafts).toHaveLength(1);
    expect(period2Drafts[0].commissionAmount).toBe(15_000);

    // The locked period-1 row is BYTE-IDENTICAL to before period 2 ran —
    // proof no catch-up logic ever mutates a locked payout.
    const lockedRowAfter = await prisma.commissionPayout.findUnique({
      where: { id: lockResult.payoutIds[0] },
    });
    expect(JSON.stringify(lockedRowAfter)).toBe(lockedRowBeforeSnapshot);

    // Committing (and locking) period 2 writes the $15,000 as its OWN row,
    // never touching period 1.
    const commit2 = await commitPayoutsForPeriod(PERIOD_2_START, PERIOD_2_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });
    const period2Row = await prisma.commissionPayout.findUnique({
      where: { id: commit2.payoutIds[0] },
    });
    expect(Number(period2Row!.commissionAmount)).toBe(15_000);
    const lockedRowAfterCommit = await prisma.commissionPayout.findUnique({
      where: { id: lockResult.payoutIds[0] },
    });
    expect(JSON.stringify(lockedRowAfterCommit)).toBe(lockedRowBeforeSnapshot);
  });

  it("THRESHOLD (deferred, prospective scope): never met yields zero every period; cleanly qualifying later pays only the excess", async () => {
    const customer = await seedCustomer();
    const plan = await prisma.commissionPlan.create({ data: { name: "Threshold plan" } });
    const rule = await prisma.commissionPlanRule.create({
      data: {
        planId: plan.id,
        label: "Goal",
        basis: "REVENUE",
        accumulator: "YTD",
        tierMode: "THRESHOLD",
      },
    });
    await prisma.commissionRuleTier.create({
      data: {
        ruleId: rule.id,
        label: "Above goal",
        minAmount: 300_000,
        maxAmountExclusive: null,
        rate: 0.1,
      },
    });

    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: plan.id });

    // Period 1: $100k. Below goal -> $0.
    await seedOrderForDesigner({
      orderno: "AL-P1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 100_000,
    });
    const commit1 = await commitPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });
    const row1 = await prisma.commissionPayout.findUnique({ where: { id: commit1.payoutIds[0] } });
    expect(Number(row1!.commissionAmount)).toBe(0);

    // Period 2: $150k more (250k total). Still below goal -> $0.
    await seedOrderForDesigner({
      orderno: "AL-P2",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-20T00:00:00Z"),
      netPrice: 150_000,
    });
    const commit2 = await commitPayoutsForPeriod(PERIOD_2_START, PERIOD_2_END, [], {
      lockNow: true,
      actorEmail: "admin@x.com",
    });
    const row2 = await prisma.commissionPayout.findUnique({ where: { id: commit2.payoutIds[0] } });
    expect(Number(row2!.commissionAmount)).toBe(0);

    // Period 3: $100k more (350k total) crosses the $300k goal mid-period.
    // Prospective scope: only the $50k above goal earns, at 10% = $5,000.
    await seedOrderForDesigner({
      orderno: "AL-P3",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-06-05T00:00:00Z"),
      netPrice: 100_000,
    });
    const drafts3 = await previewPayoutsForPeriod(PERIOD_3_START, PERIOD_3_END);
    expect(drafts3[0].commissionAmount).toBe(5_000);

    // Periods 1 and 2 are untouched by period 3's computation.
    const row1After = await prisma.commissionPayout.findUnique({
      where: { id: commit1.payoutIds[0] },
    });
    const row2After = await prisma.commissionPayout.findUnique({
      where: { id: commit2.payoutIds[0] },
    });
    expect(Number(row1After!.commissionAmount)).toBe(0);
    expect(Number(row2After!.commissionAmount)).toBe(0);
  });

  it("sync-on-write: editing tiers via the pre-existing tier editor (replacePlanTiers) updates the SAME rule row in place — chain continuity survives ongoing edits", async () => {
    // createPlan() already syncs the auto-managed mirror rule on creation
    // (matching real production behavior end to end) — no hand-rolled rule
    // setup needed here.
    const { id: planId } = await createPlan({
      name: "Sync test plan",
      tiers: [
        { label: "Flat 3%", minYtdSales: 0, maxYtdSalesExclusive: null, rate: 0.03, sortOrder: 0 },
      ],
    });
    const before = await prisma.commissionPlanRule.findFirst({ where: { planId } });
    expect(before).not.toBeNull();

    await replacePlanTiers(
      planId,
      [
        {
          label: "New flat 5%",
          minYtdSales: 0,
          maxYtdSalesExclusive: null,
          rate: 0.05,
          sortOrder: 0,
        },
      ],
      "admin@x.com",
    );

    const after = await prisma.commissionPlanRule.findFirst({ where: { planId } });
    expect(after).not.toBeNull();
    // Same rule ID -> ruleKey ("id:<n>") stays stable, so any carried
    // priorState from a prior locked payout keyed to this rule still
    // matches after the edit.
    expect(after!.id).toBe(before!.id);

    const tiers = await prisma.commissionRuleTier.findMany({ where: { ruleId: after!.id } });
    expect(tiers).toHaveLength(1);
    expect(Number(tiers[0].rate)).toBe(0.05);

    // And a preview computed after the edit actually uses the new rate.
    const customer = await seedCustomer();
    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: planId });
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 100_000,
    });
    const drafts = await previewPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END);
    expect(drafts[0].commissionAmount).toBe(5_000); // 100k * 5%, not 3%
  });

  it("a sale matching no rule earns zero and does not crash the payout run", async () => {
    const customer = await seedCustomer();
    const { vendor, department, category } = await seedVendorDeptCategory();
    const product = await seedProduct({
      vendorId: vendor.id,
      departmentId: department.id,
      categoryId: category.id,
    });
    // A second, real department the rule scopes to instead — the product
    // above belongs to `department`, not `otherDepartment`, so it can
    // never match this rule's scope.
    const { department: otherDepartment } = await seedVendorDeptCategory();

    const plan = await prisma.commissionPlan.create({ data: { name: "Narrow scope only" } });
    const rule = await prisma.commissionPlanRule.create({
      data: {
        planId: plan.id,
        label: "Only a different department",
        departmentId: otherDepartment.id,
        basis: "REVENUE",
        accumulator: "YTD",
        tierMode: "MARGINAL",
      },
    });
    await prisma.commissionRuleTier.create({
      data: { ruleId: rule.id, label: "5%", minAmount: 0, maxAmountExclusive: null, rate: 0.05 },
    });

    const alice = await seedDesigner({ displayName: "Alice", commissionPlanId: plan.id });
    await seedOrderForDesigner({
      orderno: "AL-1",
      customerId: customer.id,
      staffId: alice.id,
      orderDate: new Date("2026-05-05T00:00:00Z"),
      netPrice: 50_000,
      productId: product.id,
    });

    const drafts = await previewPayoutsForPeriod(PERIOD_1_START, PERIOD_1_END);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].commissionAmount).toBe(0);
  });
});
