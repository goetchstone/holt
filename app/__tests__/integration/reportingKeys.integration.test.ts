// /app/__tests__/integration/reportingKeys.integration.test.ts
//
// The reports that were on hardcoded role lists (the 2026-11 role-list sweep)
// now follow permission keys a store sets per role in Roles, on the page and on
// the data alike:
//
//   - "View management reports" (reporting.management): the 17 store-wide
//     reports that were MANAGER/ADMIN.
//   - "View financial reports" (reporting.financial): the four that were
//     ADMIN-only.
//   - "See customer lists" (marketing.lists): the Customer Report and
//     Opportunities, which were ADMIN/MARKETING.
//   - "See wealth data" (customer.wealth): Wealth Insights, and the wealth-based
//     Opportunities lists and wealth column.
//   - Sales by Salesperson shows every salesperson to a holder of "See every
//     salesperson's numbers" or "See customer lists", in the screen, the
//     drill-down and the CSV alike; Marketing does not gain the other three
//     salesperson reports.
//   - Monthly Sales Percentages' route takes its screen's key, Change settings.
//
// Each block proves the key decides, not the staff enum: the custom roles here
// carry an enum the old lists would have read the other way. Real router, real
// routes, real pages, real gates, real database; the session readers
// (next-auth, next/headers) and redirect are the only mocks, besides the pages'
// client views, which helpers/pageWithoutClientViews.ts stubs so they never load.

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
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { OPPORTUNITY_TILES } from "@/lib/opportunityTiles";
import { appRouter } from "@/server/trpc/routers/_app";
import { createCallerFactory } from "@/server/trpc/trpc";
import type { TrpcContext } from "@/server/trpc/context";
import salesExportRoute from "@/pages/api/reports/sales-by-salesperson/export";
import monthlyPercentagesRoute from "@/pages/api/reports/monthly-percentages";
import { pageWithoutClientViews, type ServerPage } from "../helpers/pageWithoutClientViews";

let StaleQuotesPage: ServerPage;
let SalesBySalespersonPage: ServerPage;
let MonthlyPerformancePage: ServerPage;
beforeAll(async () => {
  StaleQuotesPage = await pageWithoutClientViews("@/app/(dashboard)/app/reports/stale-quotes/page");
  SalesBySalespersonPage = await pageWithoutClientViews(
    "@/app/(dashboard)/app/reports/sales-by-salesperson/page",
  );
  MonthlyPerformancePage = await pageWithoutClientViews(
    "@/app/(dashboard)/app/reports/monthly-performance/page",
  );
});

const RANGE = { startDate: "2026-09-01", endDate: "2026-09-30" };
const WEALTH_TILES = OPPORTUNITY_TILES.filter((t) => t.usesWealthData).map((t) => t.id);

/** The reports router as a signed-in caller. The context carries no role: every
 *  gate reads the caller's staff row. */
function reportsAs(userId: string) {
  const ctx: TrpcContext = {
    userId,
    userEmail: `${userId}@example.com`,
    impersonate: null,
    headers: new Headers(),
  };
  return createCallerFactory(appRouter)(ctx).reports;
}

/** Sign the server pages in as this staff member. */
function signInToPages(userId: string) {
  (getToken as jest.Mock).mockResolvedValue({ id: userId });
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  (headers as jest.Mock).mockResolvedValue(new Headers());
}

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

/** Call a Pages Router route as this staff member; the body is text or JSON. */
async function callRoute(route: Route, userId: string, query: Record<string, string>) {
  (getServerSession as jest.Mock).mockResolvedValue({
    user: { id: userId, email: `${userId}@example.com` },
  });
  let status = 200;
  let body = "";
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = JSON.stringify(payload);
      return this;
    },
    send(payload: string) {
      body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  await route({ method: "GET", query, body: {}, cookies: {} } as unknown as NextApiRequest, res);
  return { status, body };
}

async function makeUser(userId: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
}

async function makeStaff(userId: string, roleKey: string, enumRole = roleKey) {
  await makeUser(userId);
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: { userId, displayName: userId, role: enumRole as never, roleId: role.id },
  });
}

/** A role of the store's own, holding exactly these keys. */
async function customRole(key: string, permissions: string[]) {
  await prisma.role.create({
    data: {
      key,
      name: key,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
}

let anaId: number;
let kimId: number;

beforeAll(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({ data: { name: "Test Co", slug: "test-co" } });

  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");
  await makeStaff("mia", "MANAGER");
  await makeStaff("gus", "GENERAL_MANAGER");
  await makeStaff("max", "MARKETING");
  await makeStaff("reg", "REGISTER");
  anaId = (await makeStaff("ana", "DESIGNER")).id;

  // Roles of the store's own. Each carries an enum the old role lists read the
  // other way: DESIGNER, which no list here admitted, or MANAGER, which the
  // management lists and Sales by Salesperson's list did.
  await customRole("MGMT_ONLY", ["reporting.management"]);
  await customRole("FINANCE_ONLY", ["reporting.financial"]);
  await customRole("LISTS_ONLY", ["reporting.read", "marketing.lists"]);
  await customRole("ANALYST", ["reporting.read"]);
  invalidateRoleGrantCache();
  await makeStaff("moe", "MGMT_ONLY", "DESIGNER");
  await makeStaff("fay", "FINANCE_ONLY", "DESIGNER");
  await makeStaff("lou", "LISTS_ONLY", "DESIGNER");
  kimId = (await makeStaff("kim", "ANALYST", "MANAGER")).id;

  // One sale by ana, for Sales by Salesperson to show or to withhold.
  await prisma.salesOrder.create({
    data: {
      orderno: "SO-ANA-1",
      status: "ORDER",
      orderDate: new Date("2026-09-15T15:00:00Z"),
      salesPersonId: anaId,
      salesperson: "ana",
      lineItems: {
        create: [
          {
            lineNumber: 1,
            productName: "Heron Sideboard",
            orderedQuantity: 1,
            netPrice: 777,
            cost: 300,
            vatRate: 0,
            vatAmount: 0,
          },
        ],
      },
    },
  });

  // One customer on a wealth-based Opportunities list (big wallets) and on a
  // plain one (one department), with a wealth tier to show or to leave out.
  await prisma.customer.create({
    data: {
      firstName: "Wren",
      lastName: "Hale",
      lifetimeSpend: 900,
      lifetimeOrderCount: 1,
      departmentCount: 1,
      windfallEnrichment: { create: { wealthTier: "HIGH" } },
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("the management reports follow View management reports", () => {
  it("a Manager and a store role holding only the key are let in", async () => {
    await expect(reportsAs("mia").unmappedPayments({})).resolves.toBeDefined();
    await expect(reportsAs("moe").unmappedPayments({})).resolves.toBeDefined();
  });

  it("General Manager and Designer, which the MANAGER/ADMIN lists refused, are refused", async () => {
    for (const who of ["gus", "ana"]) {
      await expect(reportsAs(who).unmappedPayments({})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("the department filter opens to either page's key: View reports or View management reports", async () => {
    await expect(reportsAs("moe").departments()).resolves.toEqual([]);
    await expect(reportsAs("ana").departments()).resolves.toEqual([]);
    await expect(reportsAs("reg").departments()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the financial reports follow View financial reports", () => {
  it("the Administrator and a store role holding the key are let in; a Manager is not", async () => {
    await expect(reportsAs("admin").staleQuotes({})).resolves.toBeDefined();
    await expect(reportsAs("fay").staleQuotes({})).resolves.toBeDefined();
    for (const who of ["mia", "gus"]) {
      await expect(reportsAs(who).staleQuotes({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("the page agrees with its data", async () => {
    signInToPages("mia");
    await expect(StaleQuotesPage()).rejects.toThrow("REDIRECT /app");
    signInToPages("fay");
    await expect(StaleQuotesPage()).resolves.toBeDefined();
  });
});

describe("the customer lists follow See customer lists", () => {
  it("Marketing and a store role holding the key get the Customer Report; a Manager does not", async () => {
    await expect(reportsAs("max").customers({})).resolves.toBeDefined();
    await expect(reportsAs("lou").customers({})).resolves.toBeDefined();
    for (const who of ["mia", "gus"]) {
      await expect(reportsAs(who).customers({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("the Opportunities tile counts take the page's key: a Manager's API-only access ends", async () => {
    await expect(reportsAs("max").opportunityTiles()).resolves.toBeDefined();
    await expect(reportsAs("mia").opportunityTiles()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("wealth data follows See wealth data", () => {
  it("Wealth Insights opens to Marketing, not to a holder of customer lists alone", async () => {
    await expect(reportsAs("max").wealthInsights({})).resolves.toBeDefined();
    for (const who of ["lou", "mia"]) {
      await expect(reportsAs(who).wealthInsights({})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("a holder gets every tile, the wealth-based lists, and the wealth tier on each row", async () => {
    const reports = reportsAs("max");
    const { tiles } = await reports.opportunityTiles();
    expect(tiles.find((t) => t.id === "big-wallets")?.count).toBe(1);

    const wallets = await reports.opportunityDrill({ tileId: "big-wallets" });
    expect(wallets.rows.map((r) => r.wealthTier)).toEqual(["HIGH"]);
    const plain = await reports.opportunityDrill({ tileId: "single-department" });
    expect(plain.rows.map((r) => r.wealthTier)).toEqual(["HIGH"]);
  });

  it("without it the wealth-based tiles are left out of the counts, refused as lists, and no row carries a tier", async () => {
    const reports = reportsAs("lou");
    const { tiles } = await reports.opportunityTiles();
    const ids = tiles.map((t) => t.id);
    expect(ids).toContain("single-department");
    expect(ids.filter((id) => WEALTH_TILES.includes(id))).toEqual([]);

    for (const tileId of WEALTH_TILES) {
      await expect(reports.opportunityDrill({ tileId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    const plain = await reports.opportunityDrill({ tileId: "single-department" });
    expect(plain.rows).toHaveLength(1);
    expect("wealthTier" in plain.rows[0]).toBe(false);
  });
});

describe("Sales by Salesperson: every salesperson for either key, one's own numbers otherwise", () => {
  it("a Manager (See every salesperson's numbers) and Marketing (See customer lists) get who they ask for", async () => {
    for (const who of ["mia", "max", "admin"]) {
      const data = await reportsAs(who).salesBySalesperson({ ...RANGE, salesPersonIds: [anaId] });
      expect({ who, filters: data.appliedFilters }).toMatchObject({
        who,
        filters: { salesPersonIds: [anaId], designerLockedTo: null },
      });
      expect(data.total.retail).toBe(777);
    }
  });

  it("View reports and neither key: locked to one's own record, whatever ids are sent, staff enum MANAGER or not", async () => {
    const data = await reportsAs("kim").salesBySalesperson({ ...RANGE, salesPersonIds: [anaId] });
    expect(data.appliedFilters).toMatchObject({ salesPersonIds: [kimId], designerLockedTo: "kim" });
    expect(data.total.retail).toBe(0);
    // General Manager holds View reports but neither key (View marketing does not count).
    const gm = await reportsAs("gus").salesBySalesperson({ ...RANGE, salesPersonIds: [anaId] });
    expect(gm.appliedFilters.designerLockedTo).toBe("gus");
  });

  it("the drill-down scopes exactly as the summary does", async () => {
    const groupKey = `sp-${anaId}`;
    const holder = await reportsAs("max").salesBySalespersonItems({ ...RANGE, groupKey });
    expect(holder.map((i) => i.orderno)).toEqual(["SO-ANA-1"]);
    await expect(reportsAs("kim").salesBySalespersonItems({ ...RANGE, groupKey })).resolves.toEqual(
      [],
    );
  });

  it("the CSV export scopes exactly as the screen does", async () => {
    const query = { ...RANGE, groupBy: "salesperson", level: "group", salesPersonIds: `${anaId}` };
    const holder = await callRoute(salesExportRoute, "max", query);
    expect(holder.status).toBe(200);
    expect(holder.body).toMatch(/777\.00/);

    const locked = await callRoute(salesExportRoute, "kim", query);
    expect(locked.status).toBe(200);
    expect(locked.body).not.toMatch(/777\.00/);
  });

  it("the page hands its view the same answer for the picker", async () => {
    signInToPages("max");
    expect((await SalesBySalespersonPage()).props.canSeeAllSalespeople).toBe(true);
    signInToPages("kim");
    expect((await SalesBySalespersonPage()).props.canSeeAllSalespeople).toBe(false);
  });

  it("Marketing does not gain the three single-salesperson reports", async () => {
    const own = await reportsAs("max").monthlyPerformance({ salesperson: "ana" });
    expect(own.salesperson).toBe("max");
    signInToPages("max");
    expect((await MonthlyPerformancePage()).props.canSeeAllSalespeople).toBe(false);
    signInToPages("mia");
    expect((await MonthlyPerformancePage()).props.canSeeAllSalespeople).toBe(true);
  });
});

describe("Monthly Sales Percentages' route takes its screen's key, Change settings", () => {
  it("the Administrator reads it; a Manager, who had it by API only, does not", async () => {
    expect((await callRoute(monthlyPercentagesRoute, "admin", {})).status).toBe(200);
    expect((await callRoute(monthlyPercentagesRoute, "mia", {})).status).toBe(403);
  });
});
