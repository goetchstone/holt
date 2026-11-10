// /app/__tests__/integration/protectionPlanCommission.integration.test.ts
//
// Protection-plan commission plans (GAP-24, DECISIONS 56), against a real database:
// built through the real plans endpoint, assigned through the real staff routes, and
// paid through the real payout generator. next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { previewPayoutsForPeriod, commitPayoutsForPeriod } from "@/lib/runCommissionPayouts";
import { resolvePlanRulesForStaff } from "@/lib/commissionRules";
import {
  createPlan,
  deletePlan,
  replacePlanTiers,
  resolvePlanTiersForStaff,
  setDefaultPlan,
} from "@/lib/commissionPlans";
import tiersRoute from "@/pages/api/admin/reports/commission-tiers/tiers";
import staffIndexRoute from "@/pages/api/staff/index";
import staffByIdRoute from "@/pages/api/staff/[id]";

const sessionMock = getServerSession as jest.Mock;

const PERIOD_START = new Date("2026-05-16T00:00:00Z");
const PERIOD_END = new Date("2026-05-31T00:00:00Z");
const BEFORE_PERIOD = new Date("2026-03-15T00:00:00Z");
const IN_PERIOD = new Date("2026-05-20T00:00:00Z");

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(route: Route, method: string, body: object, query: object = {}) {
  const res = {
    statusCode: 200,
    body: undefined as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = { method, query, body, cookies: {} } as any;
  await route(req, res as unknown as NextApiResponse);
  return res;
}

async function signInOwner() {
  await prisma.user.create({ data: { id: "owner", email: "owner@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
  await prisma.staffMember.create({
    data: { userId: "owner", displayName: "Owner", role: "SUPER_ADMIN", roleId: role.id },
  });
  sessionMock.mockResolvedValue({ user: { id: "owner", email: "owner@example.com" } });
}

let ppCategoryId: number;
let furnitureProductId: number;
let ppProductId: number;
let customerId: number;

async function seedCatalog() {
  const department = await prisma.department.create({ data: { name: "Showroom" } });
  const furniture = await prisma.category.create({
    data: { name: "Sofas", departmentId: department.id },
  });
  const pp = await prisma.category.create({
    data: { name: "Protection Plans", departmentId: department.id },
  });
  const vendor = await prisma.vendor.create({ data: { name: "Maker" } });
  const product = (categoryId: number, n: string) =>
    prisma.product.create({
      data: {
        productNumber: n,
        name: n,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId,
      },
    });
  ppCategoryId = pp.id;
  furnitureProductId = (await product(furniture.id, "SOFA-1")).id;
  ppProductId = (await product(pp.id, "PLAN-5YR")).id;
  customerId = (await prisma.customer.create({ data: { firstName: "T", lastName: "Customer" } }))
    .id;
}

let orderSeq = 0;
async function sell(staffId: number, productId: number, netPrice: number, orderDate = IN_PERIOD) {
  await prisma.salesOrder.create({
    data: {
      orderno: `PP-${++orderSeq}`,
      status: "ORDER",
      orderDate,
      customerId,
      salesPersonId: staffId,
      lineItems: {
        create: [
          {
            lineNumber: 1,
            netPrice,
            cost: 0,
            orderedQuantity: 1,
            productId,
            lineItemStatus: "ACTIVE",
          },
        ],
      },
    },
  });
}

async function designer(name: string, data: Record<string, number | null> = {}) {
  return prisma.staffMember.create({
    data: { displayName: name, aliases: [], role: "DESIGNER", isActive: true, ...data },
  });
}

/** The main plan: 3% up to $10,000 of the year's sales, 5% after. */
async function mainPlan(name = "Standard") {
  return createPlan({
    name,
    tiers: [
      { label: "Base", minYtdSales: 0, maxYtdSalesExclusive: 10_000, rate: 0.03, sortOrder: 0 },
      { label: "Top", minYtdSales: 10_000, maxYtdSalesExclusive: null, rate: 0.05, sortOrder: 1 },
    ],
  });
}

async function protectionPlan(
  name: string,
  opts: { percent?: number; alsoCountsInMainPlan?: boolean } = {},
): Promise<number> {
  const res = await call(tiersRoute, "POST", {
    kind: "PROTECTION_PLAN",
    name,
    categoryId: ppCategoryId,
    pays: "PERCENT",
    resets: "YEAR",
    alsoCountsInMainPlan: opts.alsoCountsInMainPlan ?? false,
    brackets: [{ from: 0, amount: opts.percent ?? 0.1 }],
  });
  expect(res.statusCode).toBe(201);
  return res.body.id;
}

async function draftFor(staffId: number) {
  const drafts = await previewPayoutsForPeriod(PERIOD_START, PERIOD_END);
  return drafts.find((d) => d.staffMemberId === staffId)!;
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  await signInOwner();
  await seedCatalog();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("paying protection plans under a plan of their own", () => {
  it("the default protection-plan plan pays its category; the main plan pays the rest", async () => {
    await mainPlan();
    await protectionPlan("Protection 10%");
    const sam = await designer("Sam");
    await sell(sam.id, furnitureProductId, 8_000);
    await sell(sam.id, ppProductId, 4_000);

    const draft = await draftFor(sam.id);

    expect(draft.commissionAmount).toBe(640); // $400 for the plan + $8,000 at 3%
    expect(draft.commissionPlanName).toBe("Standard");
    expect(draft.protectionPlanName).toBe("Protection 10%");
    const byLabel = Object.fromEntries(
      draft.tierBreakdown.entries.map((e) => [e.ruleLabel, e.sliceCommission]),
    );
    expect(byLabel["Protection plans"]).toBe(400);

    await commitPayoutsForPeriod(PERIOD_START, PERIOD_END, [], {
      lockNow: true,
      actorEmail: "owner@example.com",
    });
    const payout = await prisma.commissionPayout.findFirstOrThrow({
      where: { staffMemberId: sam.id },
    });
    expect(payout.protectionPlanName).toBe("Protection 10%");
    expect(Number(payout.commissionAmount)).toBe(640);
  });

  it("with none set up, a protection plan pays under the main plan like any sale", async () => {
    await mainPlan();
    const sam = await designer("Sam");
    await sell(sam.id, furnitureProductId, 8_000);
    await sell(sam.id, ppProductId, 4_000);

    const draft = await draftFor(sam.id);

    expect(draft.protectionPlanName).toBeNull();
    expect(draft.commissionAmount).toBe(400); // $12,000: $10,000 at 3% + $2,000 at 5%
  });

  it("when the store counts them toward the main brackets, they move the position but are paid once", async () => {
    await mainPlan();
    await protectionPlan("Protection 10%", { alsoCountsInMainPlan: true });
    const sam = await designer("Sam");
    // Protection plans sold earlier in the year put this period's sofa in the 5% bracket.
    await sell(sam.id, ppProductId, 10_000, BEFORE_PERIOD);
    await sell(sam.id, furnitureProductId, 5_000);

    const draft = await draftFor(sam.id);

    expect(draft.commissionAmount).toBe(250); // the sofa at 5%; the March plans aren't in this period
  });

  it("an assigned protection-plan plan beats the default; an inactive one falls back to it", async () => {
    await mainPlan();
    await protectionPlan("Protection 10%");
    const richer = await protectionPlan("Protection 20%", { percent: 0.2 });
    const sam = await designer("Sam", { protectionCommissionPlanId: richer });
    await sell(sam.id, ppProductId, 1_000);

    expect((await draftFor(sam.id)).commissionAmount).toBe(200);

    await prisma.commissionPlan.update({ where: { id: richer }, data: { isActive: false } });
    expect((await draftFor(sam.id)).commissionAmount).toBe(100);
  });

  it("a protection-plan rule that names nothing is left out rather than claiming every sale", async () => {
    await mainPlan();
    const id = await protectionPlan("Protection 10%");
    await prisma.commissionPlanRule.updateMany({
      where: { planId: id },
      data: { categoryId: null },
    });
    const sam = await designer("Sam");
    await sell(sam.id, furnitureProductId, 1_000);

    const resolved = (await resolvePlanRulesForStaff([sam.id])).get(sam.id)!;

    expect(resolved.protectionPlanName).toBeNull();
    expect((await draftFor(sam.id)).commissionAmount).toBe(30);
  });

  it("saving the plan keeps its rule, so the year's position carries", async () => {
    await mainPlan();
    const id = await protectionPlan("Protection 10%");
    const before = await prisma.commissionPlanRule.findFirstOrThrow({ where: { planId: id } });

    const res = await call(tiersRoute, "PUT", {
      planId: id,
      protectionPlan: {
        name: "Protection plans",
        categoryId: ppCategoryId,
        pays: "PER_PLAN",
        resets: "PAY_PERIOD",
        alsoCountsInMainPlan: true,
        brackets: [{ from: 0, amount: 25 }],
      },
    });

    expect(res.statusCode).toBe(200);
    const rules = await prisma.commissionPlanRule.findMany({
      where: { planId: id },
      include: { tiers: true },
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: before.id, basis: "UNITS", accumulator: "PERIOD" });
    expect(Number(rules[0].tiers[0].perUnitAmount)).toBe(25);
    const plan = res.body.plans.find((p: { id: number }) => p.id === id);
    expect(plan.protection).toMatchObject({
      pays: "PER_PLAN",
      resets: "PAY_PERIOD",
      alsoCountsInMainPlan: true,
      categoryName: "Protection Plans",
      brackets: [{ from: 0, amount: 25 }],
    });
  });
});

describe("keeping the two kinds apart", () => {
  it("each kind has its own default, and the live calculator still finds the main one", async () => {
    const main = await mainPlan();
    const pp = await protectionPlan("Protection 10%");
    const other = await protectionPlan("Protection 20%", { percent: 0.2 });
    await setDefaultPlan(other);

    const plans = await prisma.commissionPlan.findMany({ where: { isDefault: true } });
    expect(plans.map((p) => p.id).sort((a, b) => a - b)).toEqual(
      [main.id, other].sort((a, b) => a - b),
    );
    expect(pp).not.toBe(other);

    const sam = await designer("Sam");
    expect((await resolvePlanTiersForStaff([sam.id])).get(sam.id)?.planName).toBe("Standard");
  });

  it("a protection-plan plan's rates can't be replaced through the flat tier editor", async () => {
    const id = await protectionPlan("Protection 10%");
    await expect(
      replacePlanTiers(id, [
        { label: "All", minYtdSales: 0, maxYtdSalesExclusive: null, rate: 0.5, sortOrder: 0 },
      ]),
    ).rejects.toThrow("its own form");
  });

  it("a plan can't be saved without its category", async () => {
    const res = await call(tiersRoute, "POST", {
      kind: "PROTECTION_PLAN",
      name: "No category",
      categoryId: 999_999,
      pays: "PERCENT",
      resets: "YEAR",
      alsoCountsInMainPlan: false,
      brackets: [{ from: 0, amount: 0.1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("category");
    expect(await prisma.commissionPlan.count({ where: { kind: "PROTECTION_PLAN" } })).toBe(0);
  });

  it("deleting is refused while someone is on it through the protection-plan slot", async () => {
    await protectionPlan("Protection 10%");
    const assigned = await protectionPlan("Protection 20%", { percent: 0.2 });
    await designer("Sam", { protectionCommissionPlanId: assigned });

    await expect(deletePlan(assigned)).rejects.toThrow("reassign them first");
  });

  it("the staff routes refuse a plan of the wrong kind in either slot", async () => {
    const main = await mainPlan();
    const pp = await protectionPlan("Protection 10%");
    const sam = await designer("Sam");

    const asMain = await call(
      staffByIdRoute,
      "PATCH",
      { commissionPlanId: pp },
      { id: String(sam.id) },
    );
    expect(asMain.statusCode).toBe(400);
    const asProtection = await call(
      staffByIdRoute,
      "PATCH",
      { protectionCommissionPlanId: main.id },
      { id: String(sam.id) },
    );
    expect(asProtection.statusCode).toBe(400);
    expect(asProtection.body.error).toBe("Unknown protection-plan commission plan");

    const ok = await call(
      staffByIdRoute,
      "PATCH",
      { commissionPlanId: main.id, protectionCommissionPlanId: pp },
      { id: String(sam.id) },
    );
    expect(ok.statusCode).toBe(200);
    expect(await prisma.staffMember.findUniqueOrThrow({ where: { id: sam.id } })).toMatchObject({
      commissionPlanId: main.id,
      protectionCommissionPlanId: pp,
    });
  });

  it("adding a staff member keeps the plans picked on the form", async () => {
    const main = await mainPlan();
    const pp = await protectionPlan("Protection 10%");

    const res = await call(staffIndexRoute, "POST", {
      displayName: "New Hire",
      commissionPlanId: main.id,
      protectionCommissionPlanId: pp,
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ commissionPlanId: main.id, protectionCommissionPlanId: pp });
    const wrongKind = await call(staffIndexRoute, "POST", {
      displayName: "Wrong",
      commissionPlanId: pp,
    });
    expect(wrongKind.statusCode).toBe(400);
  });
});
