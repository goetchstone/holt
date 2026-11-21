// /app/__tests__/reportingGates.test.ts
//
// PLACEHOLDER TEST — Grade: B (real gates, resolver and catalog; mocked SQL).
// Prisma answers only the caller's staff row (a built-in role with no linked
// Role, or one store role) and the Role table, plus the few reads the
// Opportunities lists make, so each decision is the one a deployment makes for
// its unedited built-in roles. Upgrade path: reportingKeys.integration.test.ts
// pins the same keys against a real database.
//
// Who may open the reports that were on role lists until the 2026-11 sweep, now
// that their pages, procedures and routes gate on permission keys. Every
// built-in role is put through each one's real gate (requirePage,
// permissionProcedure, requirePermission). A procedure is called with an input
// it cannot accept, so its resolver never runs: input is checked after the
// gate, and a caller the gate admits gets BAD_REQUEST where one it refuses gets
// FORBIDDEN. A page that refuses redirects home. A REST route's handler is
// swapped for a stub answering 299.
//
// Each expected list is the old role list's audience (a list naming ADMIN also
// admitted SUPER_ADMIN), with any difference stated beside it.

jest.mock("@/lib/prisma", () => ({
  prisma: {
    staffMember: { findFirst: jest.fn(), count: jest.fn() },
    role: { findMany: jest.fn() },
    cacheGeneration: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
    customer: { count: jest.fn(), findMany: jest.fn() },
    campaignTarget: { findFirst: jest.fn(), findMany: jest.fn() },
    productPairing: { findMany: jest.fn() },
  },
}));
jest.mock("next-auth", () => ({ getServerSession: jest.fn() }));
jest.mock("next-auth/next", () => ({ getServerSession: jest.fn() }));
jest.mock("next-auth/jwt", () => ({ getToken: jest.fn() }));
jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));
jest.mock("@/pages/api/auth/[...nextauth]", () => ({ authOptions: {} }));
jest.mock("@/lib/logger", () => ({
  ...jest.requireActual("@/lib/logger"),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logError: jest.fn(),
}));
jest.mock("@/lib/auth/requireAuth", () => {
  const actual = jest.requireActual("@/lib/auth/requireAuth");
  // The real gate, in front of a stub instead of the route's own handler.
  const admitted = async (_req: unknown, res: { status: (code: number) => { end: () => void } }) =>
    res.status(299).end();
  return {
    ...actual,
    requirePermission: (permission: unknown, _handler: unknown, options: unknown) =>
      actual.requirePermission(permission, admitted, options),
  };
});

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { BUILT_IN_ROLES } from "@/lib/auth/permissionCatalog";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { OPPORTUNITY_TILES } from "@/lib/opportunityTiles";
import { createCallerFactory } from "@/server/trpc/trpc";
import { reportsRouter } from "@/server/trpc/routers/reports";
import salesExport from "@/pages/api/reports/sales-by-salesperson/export";
import monthlyPercentages from "@/pages/api/reports/monthly-percentages";
import AgedStockPage from "@/app/(dashboard)/app/reports/aged-stock/page";
import BalanceAgingPage from "@/app/(dashboard)/app/reports/balance-aging/page";
import BuyersPage from "@/app/(dashboard)/app/reports/buyers/page";
import ComparativeSalesPage from "@/app/(dashboard)/app/reports/comparative-sales/page";
import ConsignmentReportPage from "@/app/(dashboard)/app/reports/consignment-report/page";
import CrossSellPage from "@/app/(dashboard)/app/reports/cross-sell/page";
import CustomersPage from "@/app/(dashboard)/app/reports/customers/page";
import DormantCustomersPage from "@/app/(dashboard)/app/reports/dormant-customers/page";
import GrossMarginPage from "@/app/(dashboard)/app/reports/gross-margin/page";
import InventoryHealthPage from "@/app/(dashboard)/app/reports/inventory-health/page";
import InventoryValuePage from "@/app/(dashboard)/app/reports/inventory-value/page";
import OpportunitiesPage from "@/app/(dashboard)/app/reports/opportunities/page";
import PipelineOpportunityPage from "@/app/(dashboard)/app/reports/pipeline-opportunity/page";
import PoGapsPage from "@/app/(dashboard)/app/reports/po-gaps/page";
import PoSellThruPage from "@/app/(dashboard)/app/reports/po-sell-thru/page";
import ReturnsPage from "@/app/(dashboard)/app/reports/returns/page";
import SalesExplorerPage from "@/app/(dashboard)/app/reports/sales-explorer/page";
import ServicePage from "@/app/(dashboard)/app/reports/service/page";
import StaleQuotesPage from "@/app/(dashboard)/app/reports/stale-quotes/page";
import TopSellersPage from "@/app/(dashboard)/app/reports/top-sellers/page";
import TrafficPage from "@/app/(dashboard)/app/reports/traffic/page";
import UnclassifiedReturnsPage from "@/app/(dashboard)/app/reports/unclassified-returns/page";
import UnmappedPaymentsPage from "@/app/(dashboard)/app/reports/unmapped-payments/page";
import WealthInsightsPage from "@/app/(dashboard)/app/reports/wealth-insights/page";
import DesignerDashboardPage from "@/app/(dashboard)/app/reports/designer-dashboard/page";
import MonthlyPerformancePage from "@/app/(dashboard)/app/reports/monthly-performance/page";
import SalespersonDetailPage from "@/app/(dashboard)/app/reports/salesperson-detail/page";
import SalesBySalespersonPage from "@/app/(dashboard)/app/reports/sales-by-salesperson/page";

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
const callReports = createCallerFactory(reportsRouter);
type Reports = ReturnType<typeof callReports>;
type Call = (reports: Reports) => Promise<unknown>;
type Page = () => Promise<unknown>;

const ROLES = BUILT_IN_ROLES.map((r) => r.key);
const only = (...roles: string[]) => [...roles].sort();

// The old lists. A list naming ADMIN also admitted SUPER_ADMIN.
const ADMIN_ONLY = ["SUPER_ADMIN", "ADMIN"];
const MANAGER_ADMIN = [...ADMIN_ONLY, "MANAGER"];
const ADMIN_MARKETING = [...ADMIN_ONLY, "MARKETING"];
const REPORT_ROLES = [...MANAGER_ADMIN, "DESIGNER", "MARKETING"];
// "View reports": REPORT_ROLES and the operating roles that open the report pages.
const VIEW_REPORTS = [...REPORT_ROLES, "GENERAL_MANAGER", "DEPARTMENT_HEAD", "BUYER", "HR"];

const WEALTH_TILES = OPPORTUNITY_TILES.filter((t) => t.usesWealthData).map((t) => t.id);
// An input no procedure accepts: input is checked after the gate, so an admitted
// caller gets BAD_REQUEST and the resolver never reads the (mocked) database.
const INVALID = 42 as never;

beforeEach(() => {
  invalidateRoleGrantCache();
  (prisma.role.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.cacheGeneration.findMany as jest.Mock).mockResolvedValue([]);
  // A privileged staff member exists, so the bootstrap safeguard never waives a refusal.
  (prisma.staffMember.count as jest.Mock).mockResolvedValue(1);
  (prisma.user.findUnique as jest.Mock).mockImplementation(async ({ where }) => ({ id: where.id }));
  // The reads the Opportunities tile counts make (they take no input to refuse).
  (prisma.customer.count as jest.Mock).mockResolvedValue(3);
  (prisma.campaignTarget.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.productPairing.findMany as jest.Mock).mockResolvedValue([]);
  (cookies as jest.Mock).mockResolvedValue({ getAll: () => [], get: () => undefined });
  (headers as jest.Mock).mockResolvedValue(new Headers());
});

/** Sign every surface in (pages, procedures, routes) as a staff member. */
function signIn(userId: string, staff: { role: string; roleId: number | null }) {
  (getServerSession as jest.Mock).mockResolvedValue({ user: { id: userId } });
  (getToken as jest.Mock).mockResolvedValue({ id: userId });
  (prisma.staffMember.findFirst as jest.Mock).mockResolvedValue(staff);
}

const signInAs = (role: string) => signIn(`user-${role}`, { role, roleId: null });

/** A staff member on a role of the store's own, holding exactly these keys,
 *  with the staff enum the old lists read set to `enumRole`. */
function signInOnStoreRole(enumRole: string, ...keys: string[]) {
  (prisma.role.findMany as jest.Mock).mockResolvedValue([
    {
      id: 99,
      key: "STORE_ROLE",
      rank: 0,
      grantsAllPermissions: false,
      permissions: keys.map((permission) => ({ permission })),
    },
  ]);
  invalidateRoleGrantCache();
  signIn("user-store-role", { role: enumRole, roleId: 99 });
}

function reportsFor(userId: string): Reports {
  return callReports({
    userId,
    userEmail: null,
    impersonate: null,
    headers: new Headers(),
  });
}

/** "FORBIDDEN" when the gate refuses; otherwise what got past it. */
async function outcomeOf(call: Call, userId: string): Promise<string> {
  return call(reportsFor(userId)).then(
    () => "OK",
    (err: { code?: string }) => err.code ?? "ERROR",
  );
}

// What a caller past the gate gets: BAD_REQUEST for INVALID, or, from a
// procedure that takes no input, its answer or the mocked database's failure.
const PAST_THE_GATE = new Set(["BAD_REQUEST", "OK", "INTERNAL_SERVER_ERROR"]);

/** The built-in roles a procedure's gate lets through. */
async function admittedByProcedure(call: Call): Promise<string[]> {
  const admitted: string[] = [];
  for (const role of ROLES) {
    signInAs(role);
    const outcome = await outcomeOf(call, `user-${role}`);
    if (PAST_THE_GATE.has(outcome)) admitted.push(role);
    else if (outcome !== "FORBIDDEN") throw new Error(`${role}: ${outcome}, not a gate's answer`);
  }
  return admitted.sort();
}

/** True when the page let the viewer in; false when it sent them home. */
async function pageOpens(page: Page): Promise<boolean> {
  try {
    await page();
    return true;
  } catch (err) {
    const message = (err as Error).message;
    if (message === "REDIRECT /app") return false;
    if (message.startsWith("REDIRECT")) throw err;
    // Past the gate: the page went on to read the mocked database.
    return true;
  }
}

async function admittedByPage(page: Page): Promise<string[]> {
  const admitted: string[] = [];
  for (const role of ROLES) {
    signInAs(role);
    if (await pageOpens(page)) admitted.push(role);
  }
  return admitted.sort();
}

async function statusOf(route: Route, method: string): Promise<number> {
  let status = 0;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json: () => res,
    end: () => res,
    send: () => res,
    setHeader: () => res,
  };
  const req = { method, query: {}, body: {}, cookies: {}, headers: {} };
  await route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return status;
}

async function admittedByRoute(route: Route, method: string): Promise<string[]> {
  const admitted: string[] = [];
  for (const role of ROLES) {
    signInAs(role);
    const status = await statusOf(route, method);
    if (status === 299) admitted.push(role);
    else if (status !== 403)
      throw new Error(`${role} ${method}: answered ${status}, not 299 or 403`);
  }
  return admitted.sort();
}

/** The scope a salesperson page hands its view, for one viewer. */
async function picksAnyone(page: Page): Promise<boolean> {
  const element = (await page()) as { props: { canSeeAllSalespeople: boolean } };
  return element.props.canSeeAllSalespeople;
}

async function pickersOf(page: Page): Promise<string[]> {
  const pickers: string[] = [];
  for (const role of VIEW_REPORTS) {
    signInAs(role);
    if (await picksAnyone(page)) pickers.push(role);
  }
  return pickers.sort();
}

describe("the reports procedures", () => {
  const procedures: Array<[string, string[], Call]> = [
    // View reports. REPORT_ROLES refused the operating roles, who open the
    // pages these serve (Daily Sales, Top & Bottom Sellers' filter) on it.
    ["factSalesDay", VIEW_REPORTS, (r) => r.factSalesDay()],
    ["salesDaily", VIEW_REPORTS, (r) => r.salesDaily(INVALID)],
    ["departments", VIEW_REPORTS, (r) => r.departments()],
    // View financial reports: exactly ADMIN_ONLY.
    ["balanceAging", ADMIN_ONLY, (r) => r.balanceAging(INVALID)],
    ["staleQuotes", ADMIN_ONLY, (r) => r.staleQuotes(INVALID)],
    // View management reports: exactly MANAGER_ADMIN and PIPELINE_ROLES.
    ["dormantCustomers", MANAGER_ADMIN, (r) => r.dormantCustomers(INVALID)],
    ["crossSell", MANAGER_ADMIN, (r) => r.crossSell(INVALID)],
    ["comparativeSales", MANAGER_ADMIN, (r) => r.comparativeSales(INVALID)],
    ["grossMargin", MANAGER_ADMIN, (r) => r.grossMargin(INVALID)],
    ["inventoryHealth", MANAGER_ADMIN, (r) => r.inventoryHealth(INVALID)],
    ["agedStock", MANAGER_ADMIN, (r) => r.agedStock(INVALID)],
    ["inventoryValue", MANAGER_ADMIN, (r) => r.inventoryValue(INVALID)],
    ["poSellThru", MANAGER_ADMIN, (r) => r.poSellThru(INVALID)],
    ["topSellers", MANAGER_ADMIN, (r) => r.topSellers(INVALID)],
    ["returnsAnalysis", MANAGER_ADMIN, (r) => r.returnsAnalysis(INVALID)],
    ["unclassifiedReturns", MANAGER_ADMIN, (r) => r.unclassifiedReturns(INVALID)],
    ["unmappedPayments", MANAGER_ADMIN, (r) => r.unmappedPayments(INVALID)],
    ["salesExplorer", MANAGER_ADMIN, (r) => r.salesExplorer(INVALID)],
    ["salesExplorerItems", MANAGER_ADMIN, (r) => r.salesExplorerItems(INVALID)],
    ["service", MANAGER_ADMIN, (r) => r.service(INVALID)],
    ["traffic", MANAGER_ADMIN, (r) => r.traffic(INVALID)],
    ["pipelineOpportunity", MANAGER_ADMIN, (r) => r.pipelineOpportunity(INVALID)],
    ["pipelineDetail", MANAGER_ADMIN, (r) => r.pipelineDetail(INVALID)],
    ["buyersSummary", MANAGER_ADMIN, (r) => r.buyersSummary(INVALID)],
    ["buyersPositions", MANAGER_ADMIN, (r) => r.buyersPositions(INVALID)],
    // See customer lists and See wealth data: exactly ADMIN_MARKETING. The
    // tile counts' OPP_TILE_ROLES also let MANAGER in, by API only (the page
    // refused them); that ends.
    ["customers", ADMIN_MARKETING, (r) => r.customers(INVALID)],
    ["opportunityTiles", ADMIN_MARKETING, (r) => r.opportunityTiles()],
    ["opportunityDrill", ADMIN_MARKETING, (r) => r.opportunityDrill(INVALID)],
    ["wealthInsights", ADMIN_MARKETING, (r) => r.wealthInsights(INVALID)],
    // Sales by Salesperson was already on View reports; its scope is below.
    ["salesBySalesperson", VIEW_REPORTS, (r) => r.salesBySalesperson(INVALID)],
    ["salesBySalespersonItems", VIEW_REPORTS, (r) => r.salesBySalespersonItems(INVALID)],
  ];

  it.each(procedures)("reports.%s admits its old audience", async (_, expected, call) => {
    expect(await admittedByProcedure(call)).toEqual(only(...expected));
  });
});

describe("the report pages", () => {
  const pages: Array<[string, string[], Page]> = [
    ["aged-stock", MANAGER_ADMIN, AgedStockPage],
    ["buyers", MANAGER_ADMIN, BuyersPage],
    ["comparative-sales", MANAGER_ADMIN, ComparativeSalesPage],
    ["cross-sell", MANAGER_ADMIN, CrossSellPage],
    ["dormant-customers", MANAGER_ADMIN, DormantCustomersPage],
    ["gross-margin", MANAGER_ADMIN, GrossMarginPage],
    ["inventory-health", MANAGER_ADMIN, InventoryHealthPage],
    ["inventory-value", MANAGER_ADMIN, InventoryValuePage],
    ["pipeline-opportunity", MANAGER_ADMIN, PipelineOpportunityPage],
    ["po-sell-thru", MANAGER_ADMIN, PoSellThruPage],
    ["returns", MANAGER_ADMIN, ReturnsPage],
    ["sales-explorer", MANAGER_ADMIN, SalesExplorerPage],
    ["service", MANAGER_ADMIN, ServicePage],
    ["top-sellers", MANAGER_ADMIN, TopSellersPage],
    ["traffic", MANAGER_ADMIN, TrafficPage],
    ["unclassified-returns", MANAGER_ADMIN, UnclassifiedReturnsPage],
    ["unmapped-payments", MANAGER_ADMIN, UnmappedPaymentsPage],
    ["balance-aging", ADMIN_ONLY, BalanceAgingPage],
    ["consignment-report", ADMIN_ONLY, ConsignmentReportPage],
    ["po-gaps", ADMIN_ONLY, PoGapsPage],
    ["stale-quotes", ADMIN_ONLY, StaleQuotesPage],
    ["customers", ADMIN_MARKETING, CustomersPage],
    ["opportunities", ADMIN_MARKETING, OpportunitiesPage],
    ["wealth-insights", ADMIN_MARKETING, WealthInsightsPage],
    // Already on View reports; their scope is below.
    ["designer-dashboard", VIEW_REPORTS, DesignerDashboardPage],
    ["monthly-performance", VIEW_REPORTS, MonthlyPerformancePage],
    ["salesperson-detail", VIEW_REPORTS, SalespersonDetailPage],
    ["sales-by-salesperson", VIEW_REPORTS, SalesBySalespersonPage],
  ];

  it.each(pages)("/app/reports/%s admits its old audience", async (_, expected, page) => {
    expect(await admittedByPage(page)).toEqual(only(...expected));
  });
});

describe("who picks any salesperson", () => {
  it("Sales by Salesperson: the old PRIVILEGED_ROLES, Marketing included", async () => {
    expect(await pickersOf(SalesBySalespersonPage)).toEqual(only(...MANAGER_ADMIN, "MARKETING"));
  });

  it.each([
    ["designer-dashboard", DesignerDashboardPage],
    ["monthly-performance", MonthlyPerformancePage],
    ["salesperson-detail", SalespersonDetailPage],
  ] as Array<[string, Page]>)(
    "%s: the old isManager roles; Marketing does not gain it",
    async (_, page) => {
      expect(await pickersOf(page)).toEqual(only(...MANAGER_ADMIN));
    },
  );
});

describe("the REST routes", () => {
  it("GET sales-by-salesperson/export keeps View reports", async () => {
    expect(await admittedByRoute(salesExport as Route, "GET")).toEqual(only(...VIEW_REPORTS));
  });

  it.each(["GET", "PUT"])(
    "%s monthly-percentages drops Manager, who had it by API only: its screen is Change settings",
    async (method) => {
      expect(await admittedByRoute(monthlyPercentages as Route, method)).toEqual(
        only(...ADMIN_ONLY),
      );
    },
  );
});

describe("a store's own role is decided by the keys it holds, not the staff enum", () => {
  it("View management reports alone opens those reports and the department filter, and nothing financial", async () => {
    signInOnStoreRole("DESIGNER", "reporting.management");
    const user = "user-store-role";
    expect(await outcomeOf((r) => r.unmappedPayments(INVALID), user)).not.toBe("FORBIDDEN");
    expect(await outcomeOf((r) => r.departments(), user)).not.toBe("FORBIDDEN");
    expect(await outcomeOf((r) => r.staleQuotes(INVALID), user)).toBe("FORBIDDEN");
    expect(await outcomeOf((r) => r.customers(INVALID), user)).toBe("FORBIDDEN");
    expect(await pageOpens(GrossMarginPage)).toBe(true);
    expect(await pageOpens(StaleQuotesPage)).toBe(false);
  });

  it("the staff enum MANAGER on a role without the key opens nothing it used to", async () => {
    signInOnStoreRole("MANAGER", "reporting.read");
    const user = "user-store-role";
    expect(await outcomeOf((r) => r.unmappedPayments(INVALID), user)).toBe("FORBIDDEN");
    expect(await pageOpens(GrossMarginPage)).toBe(false);
    expect(await picksAnyone(SalesBySalespersonPage)).toBe(false);
    expect(await picksAnyone(MonthlyPerformancePage)).toBe(false);
  });

  it("See customer lists picks anyone on Sales by Salesperson only", async () => {
    signInOnStoreRole("DESIGNER", "reporting.read", "marketing.lists");
    expect(await picksAnyone(SalesBySalespersonPage)).toBe(true);
    expect(await picksAnyone(MonthlyPerformancePage)).toBe(false);
  });
});

describe("the Opportunities lists follow See wealth data", () => {
  const user = "user-store-role";
  beforeEach(() => {
    (prisma.campaignTarget.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.customer.findMany as jest.Mock).mockResolvedValue([
      {
        id: 1,
        firstName: "Wren",
        lastName: "Hale",
        email: null,
        phone: null,
        lifetimeSpend: 900,
        lifetimeOrderCount: 1,
        lastOrderDate: null,
        customerLevel: null,
        peakCustomerLevel: null,
        departmentCount: 1,
        customerGroup: null,
        primaryDesigner: null,
        windfallEnrichment: {
          wealthTier: "HIGH",
          recentMover: false,
          recentMortgage: false,
          recentlyDivorced: false,
          moneyInMotion: false,
          liquidityTrigger: false,
        },
      },
    ]);
  });

  it("without it: the wealth-based tiles are left out of the counts and refused as lists, and no row carries a tier", async () => {
    signInOnStoreRole("DESIGNER", "marketing.lists");
    const { tiles } = await reportsFor(user).opportunityTiles();
    const ids = tiles.map((t) => t.id);
    expect(ids).toContain("single-department");
    expect(ids.filter((id) => WEALTH_TILES.includes(id))).toEqual([]);
    for (const tileId of WEALTH_TILES) {
      expect({
        tileId,
        outcome: await outcomeOf((r) => r.opportunityDrill({ tileId }), user),
      }).toEqual({ tileId, outcome: "NOT_FOUND" });
    }
    const plain = await reportsFor(user).opportunityDrill({ tileId: "single-department" });
    expect(plain.rows).toHaveLength(1);
    expect("wealthTier" in plain.rows[0]).toBe(false);
  });

  it("with it: every tile, the wealth-based lists, and the tier on each row", async () => {
    signInOnStoreRole("DESIGNER", "marketing.lists", "customer.wealth");
    const { tiles } = await reportsFor(user).opportunityTiles();
    expect(tiles.map((t) => t.id)).toEqual(expect.arrayContaining(WEALTH_TILES));
    const wallets = await reportsFor(user).opportunityDrill({ tileId: "big-wallets" });
    expect(wallets.rows.map((r) => r.wealthTier)).toEqual(["HIGH"]);
  });

  it("See wealth data alone opens Wealth Insights, not the lists", async () => {
    signInOnStoreRole("DESIGNER", "customer.wealth");
    expect(await outcomeOf((r) => r.wealthInsights(INVALID), user)).not.toBe("FORBIDDEN");
    expect(await outcomeOf((r) => r.opportunityTiles(), user)).toBe("FORBIDDEN");
  });
});
