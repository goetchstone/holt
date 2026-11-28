// /app/__tests__/integration/salesLeadsPermissionKeys.integration.test.ts
//
// The sales and leads screens and routes that decided access by a role name or
// a role list now decide it by permission key (the 2026-11 role-list sweep).
// Each test pins one decision against the real resolver and the built-in roles'
// default grants:
//   - the Owner, whom MANAGER/ADMIN name checks refused, is admitted;
//   - wealth and the exact lead score go out only to See wealth data and View
//     marketing, and each response says what it sent;
//   - a key starts on exactly the roles its list admitted, and a store's own
//     role can be granted it;
//   - each page hands its view what the viewer's keys allow, from the same
//     answer as the route behind each control.
// Bulk archiving, deleting a quote, return refunds and trade accounts are pinned
// beside their other tests (quoteHolds, cancelOrder, returnMoney, taxExemption).
//
// Real routes, pages and database; the session readers are the only mocks, and
// the pages' client views are stubbed (helpers/pageWithoutClientViews.ts): only
// the props a page hands them are under test.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import needsAttentionRoute from "@/pages/api/leads/needs-attention";
import leadsRoute from "@/pages/api/leads/index";
import leadRoute from "@/pages/api/leads/[id]";
import customerRoute from "@/pages/api/customers/[id]/index";
import addressesRoute from "@/pages/api/customers/[id]/addresses";
import recalculateLevelsRoute from "@/pages/api/customers/recalculate-levels";
import proposalsRoute from "@/pages/api/proposals/index";
import tillCloseRoute from "@/pages/api/tills/[id]/close";
import tillReconcileRoute from "@/pages/api/tills/[id]/reconcile";
import timeEntriesRoute from "@/pages/api/time-entries/index";
import backfillRoute from "@/pages/api/mailchimp/backfill-customer-links";
import { pageWithoutClientViews, type ServerPage } from "../helpers/pageWithoutClientViews";

let LeadsPage: ServerPage;
let TillDetailPage: ServerPage;
let OrderDetailPage: ServerPage;
let CustomersListPage: ServerPage;
beforeAll(async () => {
  LeadsPage = await pageWithoutClientViews("@/app/(dashboard)/app/leads/page");
  TillDetailPage = await pageWithoutClientViews("@/app/(dashboard)/app/sales/till/[id]/page");
  OrderDetailPage = await pageWithoutClientViews("@/app/(dashboard)/app/sales/orders/[id]/page");
  CustomersListPage = await pageWithoutClientViews("@/app/(dashboard)/app/sales/customers/page");
});

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Both session readers: getServerSession for routes, getToken for pages. */
function signIn(who: string) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: who, email: `${who}@example.com` },
  });
  (getToken as jest.Mock).mockResolvedValue({ id: who });
  (headers as jest.Mock).mockResolvedValue(new Headers());
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
}

async function call(
  route: Route,
  {
    method = "GET",
    query = {},
    body = {},
  }: { method?: string; query?: Record<string, string>; body?: object } = {},
) {
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      payload = value;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
  await route(
    { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return { status, body: payload as Body };
}

/** A staff member on a built-in role, signed in. */
async function staff(who: string, roleKey: string) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  const member = await prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName: who,
      role: roleKey as never,
      roleId: role.id,
    },
  });
  signIn(who);
  return member;
}

/** A staff member on a store's own role holding only `permissions`, signed in. */
async function customStaff(who: string, permissions: string[]) {
  await prisma.user.create({ data: { id: who, email: `${who}@example.com` } });
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${who.toUpperCase()}`,
      name: who,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  // The grant table is cached; a role written straight to the database must
  // invalidate it, or the staff row's DESIGNER grants answer instead.
  invalidateRoleGrantCache();
  await prisma.staffMember.create({
    data: {
      userId: who,
      email: `${who}@example.com`,
      displayName: who,
      role: "DESIGNER",
      roleId: role.id,
    },
  });
  signIn(who);
}

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  // Permissions are bypassed while no privileged staff exists (the bootstrap
  // safeguard), so without one every refusal below would pass.
  await staff("owner", "SUPER_ADMIN");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the Owner, whom the MANAGER/ADMIN name checks refused", () => {
  it("gets the Leads board's needs-attention counts, which a designer does not", async () => {
    signIn("owner");
    expect(await call(needsAttentionRoute)).toEqual({
      status: 200,
      body: { newToAssign: 0, goingStale: 0, hotNoContact: 0 },
    });
    await staff("pat", "DESIGNER");
    expect((await call(needsAttentionRoute)).status).toBe(403);
  });

  it("may delete a lead, which working leads without Run marketing may not", async () => {
    const lead = await prisma.lead.create({ data: { source: "WALK_IN", firstName: "Wren" } });
    const remove = () => call(leadRoute, { method: "DELETE", query: { id: String(lead.id) } });

    await staff("pat", "DESIGNER");
    const refused = await remove();
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("Run marketing");
    expect(await prisma.lead.count()).toBe(1);

    signIn("owner");
    expect(await remove()).toEqual({ status: 200, body: { success: true } });
    expect(await prisma.lead.count()).toBe(0);
  });
});

describe("wealth and the exact lead score go only to the keys that cover them", () => {
  async function wealthyCustomer() {
    const customer = await prisma.customer.create({
      data: { firstName: "Ada", lastName: "Lane" },
    });
    await prisma.windfallEnrichment.create({
      data: { customerId: customer.id, wealthTier: "ULTRA", netWorth: 90000000 },
    });
    return customer;
  }

  it.each([
    ["MARKETING", true, true],
    ["MANAGER", false, true],
    ["GENERAL_MANAGER", false, true],
    ["DESIGNER", false, false],
  ])("the customer record for %s: wealth %s, exact score %s", async (role, wealth, score) => {
    const customer = await wealthyCustomer();
    await staff("viewer", role);
    const { status, body } = await call(customerRoute, { query: { id: String(customer.id) } });
    expect(status).toBe(200);
    expect({ wealthVisible: body.wealthVisible, scoreVisible: body.scoreVisible }).toEqual({
      wealthVisible: wealth,
      scoreVisible: score,
    });
    expect(body.windfallEnrichment?.wealthTier).toBe(wealth ? "ULTRA" : undefined);
  });

  it.each([
    ["ADMIN", true, true],
    ["MANAGER", false, true],
    ["DESIGNER", false, false],
  ])("the Leads board for %s: wealth %s, exact score %s", async (role, wealth, score) => {
    const customer = await wealthyCustomer();
    await prisma.lead.create({
      data: { source: "WALK_IN", customerId: customer.id, firstName: "Ada" },
    });
    await staff("viewer", role);
    const { status, body } = await call(leadsRoute);
    expect(status).toBe(200);
    expect({ wealthVisible: body.wealthVisible, scoreVisible: body.scoreVisible }).toEqual({
      wealthVisible: wealth,
      scoreVisible: score,
    });
    const [lead] = body.data;
    expect({ wealthTier: lead.wealthTier, scored: "leadScore" in lead }).toEqual({
      wealthTier: wealth ? "ULTRA" : undefined,
      scored: score,
    });
  });
});

describe("a key starts on exactly the roles its list admitted", () => {
  it("B2B proposals are a Manager's, and a store's own role's when granted; not a General Manager's", async () => {
    await staff("mo", "MANAGER");
    expect((await call(proposalsRoute)).status).toBe(200);
    await staff("gm", "GENERAL_MANAGER");
    expect((await call(proposalsRoute)).status).toBe(403);
    await staff("pat", "DESIGNER");
    expect((await call(proposalsRoute)).status).toBe(403);
    await customStaff("bea", ["sales.proposal"]);
    expect((await call(proposalsRoute)).status).toBe(200);
  });

  it("addresses are their own key: Warehouse and a granted role may, the register and Edit customers may not", async () => {
    const customer = await prisma.customer.create({ data: { firstName: "Ada", lastName: "Lane" } });
    // An address with no fields is refused after the gate (400), so nothing is written.
    const add = () =>
      call(addressesRoute, { method: "POST", query: { id: String(customer.id) }, body: {} });
    await staff("reg", "REGISTER");
    expect((await add()).status).toBe(403);
    await staff("wes", "WAREHOUSE");
    expect((await add()).status).toBe(400);
    await customStaff("cy", ["customer.address"]);
    expect((await add()).status).toBe(400);
    await customStaff("ed", ["customer.write"]);
    expect((await add()).status).toBe(403);
    expect(await prisma.customerAddress.count()).toBe(0);
  });

  it("the store-wide level recalculation is Run marketing", async () => {
    // A GET is refused after the gate (405), so the job never runs.
    await staff("pat", "DESIGNER");
    expect((await call(recalculateLevelsRoute)).status).toBe(403);
    await staff("mo", "MANAGER");
    expect((await call(recalculateLevelsRoute)).status).toBe(405);
    await staff("mia", "MARKETING");
    expect((await call(recalculateLevelsRoute)).status).toBe(405);
  });

  it("the Mailchimp re-link is an automation: Run scheduled jobs, which a Manager doesn't hold", async () => {
    // A GET is refused after the gate (405), so nothing is re-linked.
    await staff("mo", "MANAGER");
    expect((await call(backfillRoute)).status).toBe(403);
    signIn("owner");
    expect((await call(backfillRoute)).status).toBe(405);
  });

  it("closing a till is Open and close tills; reconciling one is Adjust till counts", async () => {
    // A till that isn't there answers 404 to anyone the gate lets through.
    const close = () => call(tillCloseRoute, { method: "POST", query: { id: "999999" } });
    const reconcile = () => call(tillReconcileRoute, { method: "POST", query: { id: "999999" } });
    await staff("reg", "REGISTER");
    expect((await close()).status).toBe(404);
    expect((await reconcile()).status).toBe(403);
    await staff("gm", "GENERAL_MANAGER");
    expect((await close()).status).toBe(404);
    expect((await reconcile()).status).toBe(404);
    await staff("pat", "DESIGNER");
    expect((await close()).status).toBe(403);
  });

  it("Manage time sees the whole team's time; everyone else only their own", async () => {
    const pat = await staff("pat", "DESIGNER");
    const hana = await staff("hana", "HR");
    for (const member of [pat, hana]) {
      await prisma.timeEntry.create({
        data: {
          organizationId: DEFAULT_ORG_ID,
          staffMemberId: member.id,
          description: `${member.displayName}'s hour`,
          minutes: 60,
          date: new Date("2026-11-02T00:00:00Z"),
        },
      });
    }
    const whoseTime = async () =>
      (await call(timeEntriesRoute, { query: { all: "true" } })).body.entries
        .map((entry: Body) => entry.staffMember.displayName)
        .sort();
    signIn("hana");
    expect(await whoseTime()).toEqual(["hana", "pat"]);
    signIn("pat");
    expect(await whoseTime()).toEqual(["pat"]);
  });
});

describe("each page hands its view what the viewer's keys allow", () => {
  it.each([
    ["DESIGNER", false, false],
    ["MANAGER", true, true],
    ["GENERAL_MANAGER", true, true],
  ])(
    "the Leads board tells %s: needs-attention %s, pin, assign and delete %s",
    async (role, attention, manage) => {
      await staff("viewer", role);
      const element = await LeadsPage();
      expect(element.props).toEqual({ canSeeAttention: attention, canManageLeads: manage });
    },
  );

  it("the Leads board gives the Owner everything", async () => {
    signIn("owner");
    expect((await LeadsPage()).props).toEqual({ canSeeAttention: true, canManageLeads: true });
  });

  it.each([
    ["REGISTER", false],
    ["MANAGER", true],
  ])("a till tells %s: reconcile %s", async (role, canReconcile) => {
    await staff("viewer", role);
    const element = await TillDetailPage({ params: Promise.resolve({ id: "7" }) });
    expect(element.props).toEqual({ id: "7", canReconcile });
  });

  it("an order offers the register only what its routes let it do", async () => {
    await staff("reg", "REGISTER");
    const element = await OrderDetailPage({ params: Promise.resolve({ id: "7" }) });
    expect(element.props).toEqual({
      id: "7",
      canUndoHandover: false,
      canReassign: false,
      canVoidPayment: false,
      canSendPaymentLink: true,
      // Takes payments and operates the register: an earlier order's balance
      // can be taken there (orderToPay.integration.test.ts has the other cases).
      canTakeAtRegister: true,
      canPortalLink: true,
      canDeleteQuote: false,
    });
  });

  it("an order offers a manager every control", async () => {
    await staff("mo", "MANAGER");
    const element = await OrderDetailPage({ params: Promise.resolve({ id: "7" }) });
    expect(element.props).toEqual({
      id: "7",
      canUndoHandover: true,
      canReassign: true,
      canVoidPayment: true,
      canSendPaymentLink: true,
      canTakeAtRegister: true,
      canPortalLink: true,
      canDeleteQuote: true,
    });
  });

  it.each([
    ["DESIGNER", false],
    ["MANAGER", true],
  ])("the customers list tells %s: recalculate levels %s", async (role, can) => {
    await staff("viewer", role);
    expect((await CustomersListPage()).props).toEqual({ canRecalculateLevels: can });
  });

  it("sends home a viewer without the page's own key", async () => {
    await staff("mia", "MARKETING");
    await expect(CustomersListPage()).rejects.toThrow("REDIRECT /app");
  });
});
