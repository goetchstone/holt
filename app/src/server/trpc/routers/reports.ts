// /app/src/server/trpc/routers/reports.ts
//
// Reports domain router. Read-only queries gated to the roles that can see the
// Reports nav (mirrors DEFAULT_NAV_PERMISSIONS.Reports). Each procedure defers
// to a lib/reports/* function so the data logic stays framework-agnostic and
// shared with any legacy REST shim during the migration.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { roleProcedure, protectedProcedure } from "../trpc";
import { router } from "../trpc";
import { getOpenOrdersReport } from "@/lib/reports/openOrders";
import { getFactSalesDay } from "@/lib/reports/factSalesDay";
import { getGrossMargin } from "@/lib/reports/grossMargin";
import { getInventoryHealth } from "@/lib/reports/inventoryHealth";
import { getPoSellThru } from "@/lib/reports/poSellThru";
import { getTopSellers } from "@/lib/reports/topSellers";
import { getReturnsAnalysis } from "@/lib/reports/returnsAnalysis";
import { getSalesDaily } from "@/lib/reports/salesDaily";
import { getBalanceAging } from "@/lib/reports/balanceAging";
import { getStaleQuotes } from "@/lib/reports/staleQuotes";
import { getDormantCustomers } from "@/lib/reports/dormantCustomers";
import { getCrossSell } from "@/lib/reports/crossSell";
import { getTaxSummary } from "@/lib/reports/taxSummary";
import { getComparativeSales } from "@/lib/reports/comparativeSales";
import { getSalesPerformance } from "@/lib/reports/salesPerformance";
import { getMonthlyPerformance } from "@/lib/reports/monthlyPerformance";
import { getSalespersonDetail } from "@/lib/reports/salespersonDetail";
import {
  getSalesBySalesperson,
  getSalesBySalespersonItems,
} from "@/lib/reports/salesBySalespersonReport";
import { getDetailedSales, getDetailedSalesItems } from "@/lib/reports/detailedSales";
import {
  computeSalesExplorerCells,
  computeSalesExplorerStoreOrderCounts,
  getSalesExplorerItems,
} from "@/lib/reports/salesExplorerQuery";
import {
  buildSalesExplorerTree,
  SALES_EXPLORER_PIVOTS,
  resolveNodeFilters,
  type SalesExplorerPivot,
  type StorePeriodMeta,
  type StoreTrafficRow,
} from "@/lib/reports/salesExplorerPivot";
import { visitorsByStoreLocation } from "@/lib/storeTraffic";
import { getDesignerDashboard } from "@/lib/reports/designerDashboard";
import { getServiceReport } from "@/lib/reports/serviceReport";
import { getCustomersReport } from "@/lib/reports/customersReport";
import { getTrafficReport, TrafficReportInputError } from "@/lib/reports/trafficReport";
import { getWealthInsights } from "@/lib/reports/wealthInsights";
import { getCommissionPayouts } from "@/lib/reports/commissionPayouts";
import {
  getPayPeriodSales,
  getPayPeriodConfirmations,
  PayPeriodInputError,
} from "@/lib/reports/payPeriodSales";
import {
  getOpportunityTiles,
  getOpportunityDrill,
  OpportunityTileNotFound,
} from "@/lib/reports/opportunities";
import { getPipelineOpportunity, getPipelineDetail } from "@/lib/reports/pipelineOpportunity";
import {
  getBuyersSummary,
  getBuyersPositions,
  BuyersSummaryInputError,
  BuyersPositionsNotFound,
} from "@/lib/reports/buyersReport";
import { TRPCError } from "@trpc/server";

const REPORT_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER", "MARKETING"];
// These expose per-order financials — ADMIN only (narrowed 2026-05-05).
const ADMIN_ONLY = ["ADMIN"];
// Customer-intelligence reports: management view, not designer-facing.
const MANAGER_ADMIN = ["SUPER_ADMIN", "ADMIN", "MANAGER"];
// Pipeline opportunity (list + drilldown): mirrors the legacy
// requireAuthWithRole(["MANAGER", "ADMIN"]) gate on both Pages endpoints.
const PIPELINE_ROLES = ["MANAGER", "ADMIN"];
// Commission + pay-period surfaces: tabled to SUPER_ADMIN until adopted.
const SUPER_ADMIN_ONLY = ["SUPER_ADMIN"];
// Opportunities hub: counts visible to managers; drilldown (with wealth) is
// MARKETING/ADMIN only.
const OPP_TILE_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER", "MARKETING"];
const OPP_DRILL_ROLES = ["SUPER_ADMIN", "ADMIN", "MARKETING"];
const WEALTH_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "MARKETING"]);

const staleQuotesInput = z
  .object({
    minAge: z.number().optional(),
    minValue: z.number().optional(),
    salesperson: z.string().nullish(),
  })
  .nullish();

const dormantCustomersInput = z
  .object({
    minSpend: z.number().optional(),
    minMonths: z.number().optional(),
    maxMonths: z.number().optional(),
  })
  .nullish();

const comparativeSalesInput = z.object({
  p1Start: z.string(),
  p1End: z.string(),
  p2Start: z.string(),
  p2End: z.string(),
  departmentId: z.number().nullish(),
});

// Gross margin: required date range (the UI always commits before enabling the
// query) + the pivot. Dates are required so there is no server-side magic default.
const grossMarginInput = z.object({
  startDate: z.string(),
  endDate: z.string(),
  pivot: z.enum(["department", "vendor"]).optional(),
});

// Inventory health: point-in-time snapshot, so no date range. pivot + the
// stale-stock window. .nullish() so the bare no-args payload reaches the lib,
// which applies DEFAULT_STALE_DAYS.
const inventoryHealthInput = z
  .object({
    pivot: z.enum(["department", "vendor"]).optional(),
    staleDays: z.number().optional(),
  })
  .nullish();

// Top & bottom sellers: required date range + metric + limit + optional dept
// filter (names). Dates required (the UI commits before enabling the query).
const topSellersInput = z.object({
  startDate: z.string(),
  endDate: z.string(),
  metric: z.enum(["revenue", "units", "margin"]).optional(),
  limit: z.number().optional(),
  departments: z.array(z.string()).optional(),
});

// Returns analysis: required date range + pivot.
const returnsInput = z.object({
  startDate: z.string(),
  endDate: z.string(),
  pivot: z.enum(["department", "vendor"]).optional(),
});

const taxSummaryInput = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .nullish();

// Same date-range shape as tax summary.
const salesPerformanceInput = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .nullish();

const monthlyPerformanceInput = z
  .object({
    salesperson: z.string().nullish(),
    year: z.number().optional(),
  })
  .nullish();

const salespersonDetailInput = z
  .object({
    salesperson: z.string().nullish(),
    year: z.number().optional(),
  })
  .nullish();

const designerDashboardInput = z
  .object({
    salesperson: z.string().nullish(),
    asOf: z.string().nullish(),
  })
  .nullish();

const groupByEnum = z.enum(["salesperson", "department", "customer"]);

const salesBySalespersonInput = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    groupBy: groupByEnum.optional(),
    salesPersonIds: z.array(z.number()).optional(),
    departmentNames: z.array(z.string()).optional(),
    includeDeliveryFreight: z.boolean().optional(),
  })
  .nullish();

const salesBySalespersonItemsInput = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  groupBy: groupByEnum.optional(),
  salesPersonIds: z.array(z.number()).optional(),
  departmentNames: z.array(z.string()).optional(),
  includeDeliveryFreight: z.boolean().optional(),
  groupKey: z.string(),
});

const detailedSalesInput = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    departments: z.array(z.string()).optional(),
    stores: z.array(z.string()).optional(),
    vendors: z.array(z.string()).optional(),
  })
  .nullish();

const detailedSalesItemsInput = z
  .object({
    store: z.string().nullish(),
    department: z.string().nullish(),
    category: z.string().nullish(),
    vendor: z.string().nullish(),
    type: z.string().nullish(),
    startDate: z.string().nullish(),
    endDate: z.string().nullish(),
  })
  .nullish();

// Sales Explorer: two-period, four-dimension (store/dept/category/vendor)
// pivot with product-level drilldown. Same MANAGER_ADMIN gate as Comparative
// Sales / Gross Margin — exposes cost, so management-level only.
const salesExplorerCellsInput = z.object({
  p1Start: z.string(),
  p1End: z.string(),
  p2Start: z.string(),
  p2End: z.string(),
  pivot: z.enum(SALES_EXPLORER_PIVOTS).optional(),
  stores: z.array(z.string()).optional(),
  departments: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  vendors: z.array(z.string()).optional(),
});

const salesExplorerItemsInput = z.object({
  pivot: z.enum(SALES_EXPLORER_PIVOTS),
  nodeId: z.string(),
  period: z.union([z.literal(1), z.literal(2)]),
  p1Start: z.string(),
  p1End: z.string(),
  p2Start: z.string(),
  p2End: z.string(),
});

const MANAGER_ROLES = new Set(["MANAGER", "ADMIN", "SUPER_ADMIN"]);

const serviceInput = z.object({ goalDays: z.number().optional() }).nullish();

// Customer directory: ADMIN + MARKETING (contact list + spend).
const ADMIN_MARKETING = ["SUPER_ADMIN", "ADMIN", "MARKETING"];
const customersInput = z
  .object({
    search: z.string().nullish(),
    hasPhone: z.boolean().optional(),
    minOrders: z.number().optional(),
    groups: z.array(z.string()).optional(),
    page: z.number().optional(),
    limit: z.number().optional(),
  })
  .nullish();

const crossSellInput = z
  .object({
    target: z.string().nullish(),
    minSpend: z.number().optional(),
  })
  .nullish();

const salesDailyInput = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    departments: z.array(z.string()).optional(),
  })
  .nullish();

// .nullish() so undefined OR null (the canonical "no args" tRPC payload) both
// pass — a bare z.object() rejects null with "expected object, received null".
const balanceAgingInput = z
  .object({
    salesperson: z.string().nullish(),
    minBalance: z.number().optional(),
    ageBucket: z.string().nullish(),
  })
  .nullish();

// Both flags optional; .nullish() so undefined OR null (the no-args payload)
// both pass.
const pipelineOpportunityInput = z
  .object({
    includeInactive: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
  })
  .nullish();

// salesperson is required for the drilldown; includeArchived mirrors the list.
const pipelineDetailInput = z.object({
  salesperson: z.string(),
  includeArchived: z.boolean().optional(),
});

// Buyers Report summary: date range + pivot + optional store + frame rollup.
// .nullish() so the bare no-args payload passes (the lib defaults the range).
const buyersSummaryInput = z
  .object({
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    pivot: z.enum(["department", "vendor"]).optional(),
    storeId: z.number().nullish(),
    rollupFrames: z.boolean().optional(),
  })
  .nullish();

// Per-product location drilldown for the Buyers Report; productId required.
const buyersPositionsInput = z.object({ productId: z.number() });

// Pay-period statement: optional period + the picked designer. .nullish() so the
// bare no-args payload passes.
const payPeriodSalesInput = z
  .object({
    periodStart: z.string().optional(),
    staffMemberId: z.number().optional(),
  })
  .nullish();

// Manager confirmation-status grid for a period. .nullish() so a bare payload
// reaches the lib, which throws BAD_REQUEST when periodStart is missing.
const payPeriodConfirmationsInput = z
  .object({
    periodStart: z.string().optional(),
  })
  .nullish();

export const reportsRouter = router({
  openOrders: roleProcedure(REPORT_ROLES).query(() => getOpenOrdersReport(prisma)),
  factSalesDay: roleProcedure(REPORT_ROLES).query(() => getFactSalesDay(prisma)),
  salesDaily: roleProcedure(REPORT_ROLES)
    .input(salesDailyInput)
    .query(({ input }) => getSalesDaily(prisma, input ?? {})),
  // Department names for the sales-daily filter dropdown.
  departments: roleProcedure(REPORT_ROLES).query(() =>
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ),
  balanceAging: roleProcedure(ADMIN_ONLY)
    .input(balanceAgingInput)
    .query(({ input }) => getBalanceAging(prisma, input ?? {})),
  staleQuotes: roleProcedure(ADMIN_ONLY)
    .input(staleQuotesInput)
    .query(({ input }) => getStaleQuotes(prisma, input ?? {})),
  dormantCustomers: roleProcedure(MANAGER_ADMIN)
    .input(dormantCustomersInput)
    .query(({ input }) => getDormantCustomers(prisma, input ?? {})),
  crossSell: roleProcedure(MANAGER_ADMIN)
    .input(crossSellInput)
    .query(({ input }) => getCrossSell(prisma, input ?? {})),
  // Tax summary is visible to any signed-in user (matches the legacy page,
  // which gated on session presence only).
  taxSummary: protectedProcedure
    .input(taxSummaryInput)
    .query(({ input }) => getTaxSummary(prisma, input ?? {})),
  comparativeSales: roleProcedure(MANAGER_ADMIN)
    .input(comparativeSalesInput)
    .query(({ input }) => getComparativeSales(prisma, input)),
  // Gross margin (revenue - cost) by department or vendor. Exposes cost, so it's
  // management-level (MANAGER_ADMIN), same gate as comparative sales.
  grossMargin: roleProcedure(MANAGER_ADMIN)
    .input(grossMarginInput)
    .query(({ input }) => getGrossMargin(prisma, input)),
  // Inventory health (on-hand valuation + dead stock) by department or vendor.
  // Exposes cost valuation, so management-level (MANAGER_ADMIN).
  inventoryHealth: roleProcedure(MANAGER_ADMIN)
    .input(inventoryHealthInput)
    .query(({ input }) => getInventoryHealth(prisma, input ?? {})),
  // PO sell-through: pick real POs by number, see how much of what they
  // delivered has sold since each line's receive date. Exposes cost/margin,
  // so management-level (MANAGER_ADMIN).
  poSellThru: roleProcedure(MANAGER_ADMIN)
    .input(z.object({ poNumbers: z.array(z.string().min(1)).min(1).max(50) }))
    .query(({ input }) => getPoSellThru(prisma, input)),
  // Top & bottom sellers by units/revenue/margin. Exposes cost/margin, so
  // management-level (MANAGER_ADMIN).
  topSellers: roleProcedure(MANAGER_ADMIN)
    .input(topSellersInput)
    .query(({ input }) => getTopSellers(prisma, input)),
  // Returns analysis (return rate + top returned products). MANAGER_ADMIN.
  returnsAnalysis: roleProcedure(MANAGER_ADMIN)
    .input(returnsInput)
    .query(({ input }) => getReturnsAnalysis(prisma, input)),
  // Visible to any signed-in user (matches the legacy session-only gate).
  salesPerformance: protectedProcedure
    .input(salesPerformanceInput)
    .query(({ input }) => getSalesPerformance(prisma, input ?? {})),
  // Managers may request any salesperson; everyone else is scoped to their own
  // staff record (resolved from the session, never the client input).
  monthlyPerformance: protectedProcedure
    .input(monthlyPerformanceInput)
    .query(async ({ input, ctx }) => {
      const isManager = MANAGER_ROLES.has(ctx.tokenRole ?? "");
      let salesperson = "";
      if (isManager) {
        salesperson = input?.salesperson ?? "";
      } else if (ctx.userId) {
        const self = await prisma.staffMember.findFirst({
          where: { userId: ctx.userId },
          select: { displayName: true },
        });
        salesperson = self?.displayName ?? "";
      }
      if (!salesperson) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "salesperson is required" });
      }
      return getMonthlyPerformance(prisma, { salesperson, year: input?.year });
    }),
  // Same role model as monthlyPerformance: managers may request any salesperson;
  // everyone else is scoped to their own staff record (resolved from the
  // session, never the client input).
  salespersonDetail: protectedProcedure
    .input(salespersonDetailInput)
    .query(async ({ input, ctx }) => {
      const isManager = MANAGER_ROLES.has(ctx.tokenRole ?? "");
      let salesperson = "";
      if (isManager) {
        salesperson = input?.salesperson ?? "";
      } else if (ctx.userId) {
        const self = await prisma.staffMember.findFirst({
          where: { userId: ctx.userId },
          select: { displayName: true },
        });
        salesperson = self?.displayName ?? "";
      }
      if (!salesperson) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "salesperson is required" });
      }
      return getSalespersonDetail(prisma, { salesperson, year: input?.year });
    }),
  // Sales by salesperson / department / customer. Visible to any signed-in user
  // (matches the legacy session-only gate); the report lib resolves the
  // role-scoped salesperson filter from the session role + userId — privileged
  // roles see all and may filter, everyone else is locked to their own record.
  salesBySalesperson: protectedProcedure.input(salesBySalespersonInput).query(({ input, ctx }) =>
    getSalesBySalesperson(prisma, {
      ...(input ?? {}),
      auth: { role: ctx.tokenRole ?? undefined, userId: ctx.userId ?? undefined },
    }),
  ),
  // Drilldown for a single sales-by-salesperson group cell. Same role model as
  // the summary above; groupKey is required.
  salesBySalespersonItems: protectedProcedure
    .input(salesBySalespersonItemsInput)
    .query(({ input, ctx }) =>
      getSalesBySalespersonItems(prisma, {
        ...input,
        auth: { role: ctx.tokenRole ?? undefined, userId: ctx.userId ?? undefined },
      }),
    ),
  // Detailed Sales (sales-by-department) breakdown. Visible to any signed-in
  // user (matches the legacy session-only gate).
  detailedSales: protectedProcedure
    .input(detailedSalesInput)
    .query(({ input }) => getDetailedSales(prisma, input ?? {})),
  // Drilldown line items for a single Detailed Sales cell. Same gate as the
  // summary above.
  detailedSalesItems: protectedProcedure
    .input(detailedSalesItemsInput)
    .query(({ input }) => getDetailedSalesItems(prisma, input ?? {})),
  // Sales Explorer: two-period comparative pivot by Store / Department /
  // Category / Vendor with variance + margin at every node, plus a
  // Store-Traffic panel (Axper door counts) when pivoting by Store.
  // MANAGER_ADMIN — exposes cost, same gate as Comparative Sales / Gross
  // Margin. See lib/reports/salesExplorerQuery.ts for the invariant-bearing
  // aggregation and lib/reports/salesExplorerPivot.ts for the pure tree build.
  salesExplorer: roleProcedure(MANAGER_ADMIN)
    .input(salesExplorerCellsInput)
    .query(async ({ input }) => {
      const pivot: SalesExplorerPivot = input.pivot ?? "department";
      const filters = {
        stores: input.stores ?? [],
        departments: input.departments ?? [],
        categories: input.categories ?? [],
        vendors: input.vendors ?? [],
      };
      const range1 = { startDate: input.p1Start, endDate: input.p1End };
      const range2 = { startDate: input.p2Start, endDate: input.p2End };

      // Traffic + order-count queries take Date bounds (exclusive upper),
      // matching comparativeSales.ts.
      const from1 = new Date(input.p1Start);
      const to1 = new Date(input.p1End);
      to1.setDate(to1.getDate() + 1);
      const from2 = new Date(input.p2Start);
      const to2 = new Date(input.p2End);
      to2.setDate(to2.getDate() + 1);

      const [cellsP1, cellsP2, oc1, oc2, vis1, vis2, deptOpts, catOpts, vendorOpts, storeOpts] =
        await Promise.all([
          computeSalesExplorerCells(prisma, range1, filters),
          computeSalesExplorerCells(prisma, range2, filters),
          computeSalesExplorerStoreOrderCounts(prisma, range1, filters),
          computeSalesExplorerStoreOrderCounts(prisma, range2, filters),
          visitorsByStoreLocation(from1, to1),
          visitorsByStoreLocation(from2, to2),
          prisma.department.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
          // Category.name is unique only per-department (schema.prisma:
          // @@unique([name, departmentId])) — fetch all and dedupe in JS below
          // since the Category pivot rolls a name up across every department
          // it appears in by design.
          prisma.category.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
          prisma.vendor.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
          prisma.salesOrder.findMany({
            where: { storeLocation: { not: null } },
            distinct: ["storeLocation"],
            select: { storeLocation: true },
            orderBy: { storeLocation: "asc" },
          }),
        ]);

      const storeNames = new Set<string>([
        ...Object.keys(oc1),
        ...Object.keys(oc2),
        ...Object.keys(vis1),
        ...Object.keys(vis2),
      ]);
      storeNames.delete("Unknown");

      const storeMeta: Record<string, StorePeriodMeta> = {};
      const storeTraffic: StoreTrafficRow[] = [];
      for (const store of [...storeNames].sort((a, b) => a.localeCompare(b))) {
        const meta: StorePeriodMeta = {
          orderCount1: oc1[store] ?? 0,
          orderCount2: oc2[store] ?? 0,
          visitors1: vis1[store] ?? 0,
          visitors2: vis2[store] ?? 0,
        };
        storeMeta[store] = meta;
        storeTraffic.push({
          store,
          visitors1: meta.visitors1,
          visitors2: meta.visitors2,
          orderCount1: meta.orderCount1,
          orderCount2: meta.orderCount2,
          conversion1: meta.visitors1 > 0 ? meta.orderCount1 / meta.visitors1 : null,
          conversion2: meta.visitors2 > 0 ? meta.orderCount2 / meta.visitors2 : null,
        });
      }

      const { tree, totals } = buildSalesExplorerTree(cellsP1, cellsP2, pivot, storeMeta);

      // Conversion is store-wide traffic vs (possibly) filtered sales — only
      // apples-to-apples in the Store pivot with no dept/category/vendor filter.
      const filterNarrowed =
        filters.departments.length > 0 ||
        filters.categories.length > 0 ||
        filters.vendors.length > 0;
      const trafficDecoupled = pivot !== "store" || filterNarrowed;

      return {
        pivot,
        period1Label: `${input.p1Start} to ${input.p1End}`,
        period2Label: `${input.p2Start} to ${input.p2End}`,
        tree,
        totals,
        storeTraffic,
        trafficDecoupled,
        options: {
          stores: storeOpts.map((s) => s.storeLocation).filter((n): n is string => Boolean(n)),
          departments: deptOpts.map((d) => d.name),
          categories: [...new Set(catOpts.map((c) => c.name))].sort((a, b) => a.localeCompare(b)),
          vendors: vendorOpts.map((v) => v.name),
        },
      };
    }),
  // Product-level drilldown for one Sales Explorer node in one period. The
  // node's store/department/category/vendor filters are re-derived
  // server-side from (pivot, nodeId) via the same pure resolveNodeFilters the
  // client uses — the server never trusts a client-supplied filter object.
  salesExplorerItems: roleProcedure(MANAGER_ADMIN)
    .input(salesExplorerItemsInput)
    .query(({ input }) => {
      const filters = resolveNodeFilters(input.pivot, input.nodeId);
      const { startDate, endDate } =
        input.period === 1
          ? { startDate: input.p1Start, endDate: input.p1End }
          : { startDate: input.p2Start, endDate: input.p2End };
      return getSalesExplorerItems(prisma, { ...filters, startDate, endDate });
    }),
  // Same role model as monthlyPerformance/salespersonDetail: managers may request
  // any salesperson; everyone else is scoped to their own staff record (resolved
  // from the session, never the client input).
  designerDashboard: protectedProcedure
    .input(designerDashboardInput)
    .query(async ({ input, ctx }) => {
      const isManager = MANAGER_ROLES.has(ctx.tokenRole ?? "");
      let salesperson = "";
      if (isManager) {
        salesperson = input?.salesperson ?? "";
      } else if (ctx.userId) {
        const self = await prisma.staffMember.findFirst({
          where: { userId: ctx.userId },
          select: { displayName: true },
        });
        salesperson = self?.displayName ?? "";
      }
      if (!salesperson) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "salesperson is required" });
      }
      return getDesignerDashboard(prisma, { salesperson, asOf: input?.asOf ?? undefined });
    }),
  service: roleProcedure(MANAGER_ADMIN)
    .input(serviceInput)
    .query(({ input }) => getServiceReport(prisma, input ?? {})),
  customers: roleProcedure(ADMIN_MARKETING)
    .input(customersInput)
    .query(({ input }) => getCustomersReport(prisma, input ?? {})),
  traffic: roleProcedure(MANAGER_ADMIN)
    .input(
      z.object({
        dateFrom: z.string(),
        dateTo: z.string(),
        stores: z.array(z.string()).nullish(),
      }),
    )
    .query(async ({ input }) => {
      try {
        return await getTrafficReport(prisma, input);
      } catch (err) {
        if (err instanceof TrafficReportInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  wealthInsights: roleProcedure(ADMIN_MARKETING)
    .input(
      z
        .object({
          signal: z.string().nullish(),
          tier: z.string().nullish(),
          level: z.string().nullish(),
          groups: z.array(z.string()).optional(),
        })
        .nullish(),
    )
    .query(({ input }) => getWealthInsights(prisma, input ?? {})),
  commissionPayouts: roleProcedure(SUPER_ADMIN_ONLY)
    .input(z.object({ staffMemberId: z.number().optional() }).nullish())
    .query(({ input }) => getCommissionPayouts({ staffMemberId: input?.staffMemberId })),
  // Per-designer pay-period sales statement. Tabled to SUPER_ADMIN — the picker
  // is the only path, so the designer is resolved from the client's
  // staffMemberId. Confirm / report-issue stay REST mutations.
  payPeriodSales: roleProcedure(SUPER_ADMIN_ONLY)
    .input(payPeriodSalesInput)
    .query(({ input }) =>
      getPayPeriodSales(prisma, {
        periodStart: input?.periodStart,
        staffMemberId: input?.staffMemberId,
      }),
    ),
  // Manager confirmation-status grid for a period. Same SUPER_ADMIN gate; the
  // reopen / resolve-issue actions stay REST mutations.
  payPeriodConfirmations: roleProcedure(SUPER_ADMIN_ONLY)
    .input(payPeriodConfirmationsInput)
    .query(async ({ input }) => {
      try {
        return await getPayPeriodConfirmations({ periodStart: input?.periodStart });
      } catch (err) {
        if (err instanceof PayPeriodInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  opportunityTiles: roleProcedure(OPP_TILE_ROLES).query(() => getOpportunityTiles(prisma)),
  opportunityDrill: roleProcedure(OPP_DRILL_ROLES)
    .input(z.object({ tileId: z.string(), dedup: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      try {
        return await getOpportunityDrill(prisma, {
          tileId: input.tileId,
          dedup: input.dedup,
          canSeeWealth: WEALTH_ROLES.has(ctx.tokenRole ?? ""),
        });
      } catch (err) {
        if (err instanceof OpportunityTileNotFound) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),
  // Pipeline opportunity: open quotes + conversion by salesperson. MANAGER/ADMIN
  // (mirrors the legacy requireAuthWithRole gate). The reassign action stays a
  // REST POST.
  pipelineOpportunity: roleProcedure(PIPELINE_ROLES)
    .input(pipelineOpportunityInput)
    .query(({ input }) => getPipelineOpportunity(prisma, input ?? {})),
  // Per-salesperson quote drilldown for the report above. Same gate; salesperson
  // is required.
  pipelineDetail: roleProcedure(PIPELINE_ROLES)
    .input(pipelineDetailInput)
    .query(({ input }) => getPipelineDetail(prisma, input)),
  // Buyers Report: on-hand + on-order + sold-in-range merchant pivot.
  // MANAGER/ADMIN (mirrors the legacy requireAuthWithRole gate). The CSV
  // export stays a client-side blob; no REST shim needed.
  buyersSummary: roleProcedure(PIPELINE_ROLES)
    .input(buyersSummaryInput)
    .query(async ({ input }) => {
      try {
        return await getBuyersSummary(prisma, input ?? {});
      } catch (err) {
        if (err instanceof BuyersSummaryInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  // Per-product location breakdown for the Buyers Report leaf drilldown. Same
  // gate; productId is required.
  buyersPositions: roleProcedure(PIPELINE_ROLES)
    .input(buyersPositionsInput)
    .query(async ({ input }) => {
      try {
        return await getBuyersPositions(prisma, input.productId);
      } catch (err) {
        if (err instanceof BuyersPositionsNotFound) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),
});
