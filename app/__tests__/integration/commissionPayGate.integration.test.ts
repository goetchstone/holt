// /app/__tests__/integration/commissionPayGate.integration.test.ts
//
// "See and run commission and pay" (staff.commission-pay). Commission payouts,
// commission plans and the pay-period statement were reachable by the enum
// SUPER_ADMIN alone, while three pages admitted an Administrator and the staff
// page fetched the plans API for everyone: the screen rendered and every data
// call was refused. Now one owner-tier key gates the pages, the REST handlers
// and the tRPC procedures alike, and the staff screen's plan assignment needs
// it on the write as well as the read. Real routes, real permission gate, real
// database; the only mock is the session.

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
import { OWNER_ONLY_PERMISSIONS } from "@/lib/auth/permissionCatalog";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";
import payoutsIndex from "@/pages/api/admin/reports/commission-payouts/index";
import payoutById from "@/pages/api/admin/reports/commission-payouts/[id]";
import payoutsDrift from "@/pages/api/admin/reports/commission-payouts/drift";
import tiersCalculator from "@/pages/api/admin/reports/commission-tiers";
import plansRoute from "@/pages/api/admin/reports/commission-tiers/tiers";
import reopenRoute from "@/pages/api/admin/reports/pay-period-confirmations/reopen";
import resolveIssueRoute from "@/pages/api/admin/reports/pay-period-confirmations/resolve-issue";
import confirmRoute from "@/pages/api/reports/pay-period-sales/confirm";
import reportIssueRoute from "@/pages/api/reports/pay-period-sales/report-issue";
import staffIndex from "@/pages/api/staff/index";
import staffById from "@/pages/api/staff/[id]";

const KEY = "staff.commission-pay";
const sessionMock = getServerSession as jest.Mock;

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

async function call(
  route: Route,
  userId: string,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: object; body?: object } = {},
) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(value: unknown) {
      out.body = value;
      return this;
    },
    send(value: unknown) {
      out.body = value;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
  };
  await route(
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return out;
}

function reportsAs(userId: string) {
  const ctx: TrpcContext = {
    userId,
    userEmail: `${userId}@example.com`,
    impersonate: null,
    headers: new Headers(),
  };
  return createCallerFactory(appRouter)(ctx).reports;
}

async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { userId, displayName: userId, role: roleKey as any, roleId: role.id },
  });
}

/** Staff on a role of the store's own (which carries the DESIGNER enum). */
async function makeCustomStaff(userId: string, permissions: string[]) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${userId.toUpperCase()}`,
      name: userId,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  invalidateRoleGrantCache();
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
}

async function grants(roleKey: string): Promise<string[]> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { key: roleKey },
    select: { permissions: { select: { permission: true } } },
  });
  return role.permissions.map((p) => p.permission);
}

async function refused(call: Promise<unknown>): Promise<boolean> {
  try {
    await call;
    return false;
  } catch (err) {
    return (err as { code?: string }).code === "FORBIDDEN";
  }
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await syncBuiltInRoles({ prisma });
  // A built-in Administrator exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
  await makeStaff("owner", "SUPER_ADMIN");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the built-in grants", () => {
  it("keep staff.commission-pay (and impersonation) off Administrator; the Owner holds it by wildcard", async () => {
    const admin = await grants("ADMIN");
    for (const key of OWNER_ONLY_PERMISSIONS) expect(admin).not.toContain(key);
    expect(OWNER_ONLY_PERMISSIONS).toContain(KEY);
    // The wildcard role stores no rows; the gate tests below show it passes.
    expect(await grants("SUPER_ADMIN")).toEqual([]);
  });
});

describe("the pay-period tRPC procedures", () => {
  it("refuse a built-in Administrator", async () => {
    expect(await refused(reportsAs("admin").payPeriodSales({}))).toBe(true);
    expect(await refused(reportsAs("admin").payPeriodConfirmations({}))).toBe(true);
  });

  it("refuse a role of the store's own that lacks the key, whatever its other grants", async () => {
    await makeCustomStaff("pat", ["reporting.read", "admin.settings", "staff.commission"]);
    expect(await refused(reportsAs("pat").payPeriodSales({}))).toBe(true);
    expect(await refused(reportsAs("pat").payPeriodConfirmations({}))).toBe(true);
  });

  it("admit a role of the store's own that holds the key", async () => {
    await makeCustomStaff("hal", [KEY]);
    expect(await refused(reportsAs("hal").payPeriodSales({}))).toBe(false);
    expect(await refused(reportsAs("hal").payPeriodConfirmations({}))).toBe(false);
  });

  it("admit the Owner", async () => {
    expect(await refused(reportsAs("owner").payPeriodSales({}))).toBe(false);
    expect(await refused(reportsAs("owner").payPeriodConfirmations({}))).toBe(false);
  });
});

describe("every commission and pay-period REST handler", () => {
  const routes: [string, Route, { method: string; query?: object }][] = [
    ["commission-payouts", payoutsIndex, { method: "GET" }],
    ["commission-payouts/[id]", payoutById, { method: "GET", query: { id: "1" } }],
    ["commission-payouts/drift", payoutsDrift, { method: "GET" }],
    ["commission-tiers", tiersCalculator, { method: "GET" }],
    ["commission-tiers/tiers", plansRoute, { method: "GET" }],
    ["pay-period-confirmations/reopen", reopenRoute, { method: "POST" }],
    ["pay-period-confirmations/resolve-issue", resolveIssueRoute, { method: "POST" }],
    ["pay-period-sales/confirm", confirmRoute, { method: "POST" }],
    ["pay-period-sales/report-issue", reportIssueRoute, { method: "POST" }],
  ];

  it.each(routes)("%s refuses a built-in Administrator with 403", async (_n, route, opts) => {
    expect((await call(route, "admin", opts)).status).toBe(403);
  });

  it.each(routes)("%s lets a holder of the key past the gate", async (_n, route, opts) => {
    await makeCustomStaff("hal", [KEY]);
    // Past the gate the handler answers its own way (200, or a 400/404 for the
    // empty request); only a 403 would mean the gate refused.
    expect((await call(route, "hal", opts)).status).not.toBe(403);
  });

  it.each(routes)("%s lets the Owner past the gate", async (_n, route, opts) => {
    expect((await call(route, "owner", opts)).status).not.toBe(403);
  });
});

describe("assigning a commission plan on the staff screen needs the key on the write too", () => {
  async function plan(name: string) {
    return prisma.commissionPlan.create({ data: { name, kind: "MAIN" } });
  }

  it("refuses an Administrator who changes a member's plan, with a message that says why", async () => {
    const a = await plan("A");
    const ana = await makeStaff("ana", "DESIGNER");
    const res = await call(staffById, "admin", {
      method: "PATCH",
      query: { id: String(ana.id) },
      body: { commissionPlanId: a.id },
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/commission and pay/);
    expect(
      (await prisma.staffMember.findUniqueOrThrow({ where: { id: ana.id } })).commissionPlanId,
    ).toBeNull();
  });

  it("lets an Administrator save the form with the plan the member already has", async () => {
    const a = await plan("A");
    const ana = await makeStaff("ana", "DESIGNER");
    await prisma.staffMember.update({ where: { id: ana.id }, data: { commissionPlanId: a.id } });
    const res = await call(staffById, "admin", {
      method: "PATCH",
      query: { id: String(ana.id) },
      body: { displayName: "Ana B", commissionPlanId: a.id, protectionCommissionPlanId: null },
    });
    expect(res.status).toBe(200);
    expect(
      (await prisma.staffMember.findUniqueOrThrow({ where: { id: ana.id } })).displayName,
    ).toBe("Ana B");
  });

  it("refuses an Administrator who clears a plan", async () => {
    const a = await plan("A");
    const ana = await makeStaff("ana", "DESIGNER");
    await prisma.staffMember.update({ where: { id: ana.id }, data: { commissionPlanId: a.id } });
    const res = await call(staffById, "admin", {
      method: "PATCH",
      query: { id: String(ana.id) },
      body: { commissionPlanId: null },
    });
    expect(res.status).toBe(403);
  });

  it("lets the Owner change it", async () => {
    const a = await plan("A");
    const ana = await makeStaff("ana", "DESIGNER");
    const res = await call(staffById, "owner", {
      method: "PATCH",
      query: { id: String(ana.id) },
      body: { commissionPlanId: a.id },
    });
    expect(res.status).toBe(200);
    expect(
      (await prisma.staffMember.findUniqueOrThrow({ where: { id: ana.id } })).commissionPlanId,
    ).toBe(a.id);
  });

  it("lets a staff.manage role that also holds the key change it", async () => {
    await makeCustomStaff("hal", ["staff.manage", KEY]);
    const a = await plan("A");
    const ana = await makeStaff("ana", "DESIGNER");
    const res = await call(staffById, "hal", {
      method: "PATCH",
      query: { id: String(ana.id) },
      body: { commissionPlanId: a.id },
    });
    expect(res.status).toBe(200);
  });

  it("refuses an Administrator who creates a member with a plan, but not one without", async () => {
    const a = await plan("A");
    const withPlan = await call(staffIndex, "admin", {
      method: "POST",
      body: { displayName: "New One", commissionPlanId: a.id },
    });
    expect(withPlan.status).toBe(403);
    expect(await prisma.staffMember.count({ where: { displayName: "New One" } })).toBe(0);

    const without = await call(staffIndex, "admin", {
      method: "POST",
      body: { displayName: "New Two", commissionPlanId: null },
    });
    expect(without.status).toBe(201);
  });
});
