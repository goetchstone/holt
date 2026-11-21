// /app/src/server/trpc/routers/reports.ts
//
// Reports domain router. Read-only queries, each gated on the permission key
// of the report page that calls it (lib/auth/pagePermissions.ts), so a page
// and its data cannot disagree about who may see them: "View reports" for the
// everyday reports, "View management reports" and "View financial reports" for
// the store-wide ones, "See customer lists" and "See wealth data" for the
// customer lists. Each procedure defers to a lib/reports/* function so the
// data logic stays framework-agnostic and shared with any legacy REST shim
// during the migration.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { permissionProcedure } from "../trpc";
import { canViewCost, WITH_COST } from "@/lib/auth/costVisibility";
import { canViewWealth, WITH_WEALTH } from "@/lib/auth/wealthVisibility";
import {
  canSeeAllSalespeople,
  salesBySalespersonSeesEveryone,
  salespersonForCaller,
  WITH_ALL_SALESPEOPLE,
  WITH_SALES_BY_SALESPERSON_EVERYONE,
} from "@/lib/reports/salespersonScope";
import { router } from "../trpc";
import { getFactSalesDay } from "@/lib/reports/factSalesDay";
import { getGrossMargin, grossMarginForCaller } from "@/lib/reports/grossMargin";
import {
  getInventoryHealth,
  INVENTORY_PIVOTS,
  inventoryHealthForCaller,
} from "@/lib/reports/inventoryHealth";
import { agedStockForCaller, getAgedStock } from "@/lib/reports/agedStock";
import { summarizeFollowUps } from "@/lib/followUpReport";
import { loadFollowUpRows, loadRecentContacts } from "@/lib/followUpReportQuery";
import {
  getInventoryValue,
  InventoryValueInputError,
  inventoryValueForCaller,
} from "@/lib/reports/inventoryValue";
import {
  getTransfersReport,
  TransfersReportInputError,
  transfersReportForCaller,
} from "@/lib/reports/transfersReport";
import { TRANSFER_VIEWS, type TransferView } from "@/lib/reports/transfersReportShared";
import { getPoSellThru, poSellThruForCaller } from "@/lib/reports/poSellThru";
import { getTopSellers, topSellersForCaller, topSellersMetricFor } from "@/lib/reports/topSellers";
import { getReturnsAnalysis } from "@/lib/reports/returnsAnalysis";
import { getUnclassifiedReturns } from "@/lib/reports/unclassifiedReturns";
import { getUnmappedPayments } from "@/lib/reports/unmappedPayments";
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
  salesByGroupForCaller,
  salesItemsForCaller,
} from "@/lib/reports/salesBySalespersonReport";
import { getDetailedSales, getDetailedSalesItems } from "@/lib/reports/detailedSales";
import {
  computeSalesExplorerCells,
  computeSalesExplorerStoreOrderCounts,
  getSalesExplorerItems,
} from "@/lib/reports/salesExplorerQuery";
import {
  buildSalesExplorerTree,
  salesExplorerTreeForCaller,
  SALES_EXPLORER_PIVOTS,
  resolveNodeFilters,
  type SalesExplorerPivot,
  type StorePeriodMeta,
  type StoreTrafficRow,
} from "@/lib/reports/salesExplorerPivot";
import { visitorsByStoreLocation } from "@/lib/storeTraffic";
import { designerDashboardForCaller, getDesignerDashboard } from "@/lib/reports/designerDashboard";
import { getServiceReport } from "@/lib/reports/serviceReport";
import { getCustomersReport } from "@/lib/reports/customersReport";
import { getTrafficReport, TrafficReportInputError } from "@/lib/reports/trafficReport";
import { getWealthInsights } from "@/lib/reports/wealthInsights";
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
  buyersSummaryForCaller,
  getBuyersPositions,
  BuyersSummaryInputError,
  BuyersPositionsNotFound,
} from "@/lib/reports/buyersReport";
import { TRPCError } from "@trpc/server";

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

// Aged stock: point-in-time, by department or vendor.
const agedStockInput = z.object({ pivot: z.enum(INVENTORY_PIVOTS).optional() }).nullish();

// Inventory value: a past day (today when absent), a pivot, one store or all.
const inventoryValueInput = z
  .object({
    asOf: z.string().optional(),
    pivot: z.enum(INVENTORY_PIVOTS).optional(),
    storeLocationId: z.number().int().positive().nullish(),
  })
  .nullish();

// Transfers: a period, which of TRANSFER_VIEWS, one store or all.
const transfersReportInput = z.object({
  startDate: z.string(),
  endDate: z.string(),
  view: z.enum(Object.keys(TRANSFER_VIEWS) as [TransferView, ...TransferView[]]).optional(),
  storeLocationId: z.number().int().positive().nullish(),
});

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

// Unclassified Returns (B3 exception report): required date range + optional
// store filter. Dates required (like Gross Margin / Top Sellers) so the UI
// commits a bounded window before running against a large table of historical returns.
// Dates OPTIONAL and defaulted to all-time, unlike every other exception
// report here. The question is "how much money is missing from the ledger",
// which a bounded window answers wrongly by construction — a tender that
// stopped being used last year is still absent from last year's books.
const unmappedPaymentsInput = z
  .object({ startDate: z.string().nullish(), endDate: z.string().nullish() })
  .nullish();

const unclassifiedReturnsInput = z.object({
  startDate: z.string(),
  endDate: z.string(),
  store: z.string().nullish(),
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
// pivot with product-level drilldown. "View management reports", like
// Comparative Sales / Gross Margin; its cost and margin need "View cost" too.
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

/** The salesperson a caller may ask for: anyone for a holder of "See every
 *  salesperson's numbers", otherwise their own staff record from the session. */
async function salespersonFor(
  ctx: { userId: string; holds: Readonly<Record<string, boolean>> },
  requested: string | null | undefined,
): Promise<string> {
  const seesEveryone = canSeeAllSalespeople(ctx);
  const self = seesEveryone
    ? null
    : await prisma.staffMember.findFirst({
        where: { userId: ctx.userId },
        select: { displayName: true },
      });
  const salesperson = salespersonForCaller({
    seesEveryone,
    requested,
    selfDisplayName: self?.displayName,
  });
  if (!salesperson) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "salesperson is required" });
  }
  return salesperson;
}

const serviceInput = z.object({ goalDays: z.number().optional() }).nullish();

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
  // "View reports", the key of the Daily Sales Summary page (which reads the
  // lib itself; nothing calls this procedure).
  factSalesDay: permissionProcedure("reporting.read").query(() => getFactSalesDay(prisma)),
  // "View reports", the key of the Daily Sales Report page.
  salesDaily: permissionProcedure("reporting.read")
    .input(salesDailyInput)
    .query(({ input }) => getSalesDaily(prisma, input ?? {})),
  // Department names for the filter dropdowns on Daily Sales ("View reports")
  // and Top & Bottom Sellers ("View management reports"): either page's key.
  departments: permissionProcedure({ anyOf: ["reporting.read", "reporting.management"] }).query(
    () =>
      prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ),
  // "View financial reports": per-order balances (narrowed to ADMIN on
  // 2026-05-05). The Balance Due Aging page reads the lib itself.
  balanceAging: permissionProcedure("reporting.financial")
    .input(balanceAgingInput)
    .query(({ input }) => getBalanceAging(prisma, input ?? {})),
  staleQuotes: permissionProcedure("reporting.financial")
    .input(staleQuotesInput)
    .query(({ input }) => getStaleQuotes(prisma, input ?? {})),
  // Customer lists with contact details and spend: "View management reports".
  dormantCustomers: permissionProcedure("reporting.management")
    .input(dormantCustomersInput)
    .query(({ input }) => getDormantCustomers(prisma, input ?? {})),
  crossSell: permissionProcedure("reporting.management")
    .input(crossSellInput)
    .query(({ input }) => getCrossSell(prisma, input ?? {})),
  // "View reports", the key of the Tax Summary page.
  taxSummary: permissionProcedure("reporting.read")
    .input(taxSummaryInput)
    .query(({ input }) => getTaxSummary(prisma, input ?? {})),
  comparativeSales: permissionProcedure("reporting.management")
    .input(comparativeSalesInput)
    .query(({ input }) => getComparativeSales(prisma, input)),
  // Gross margin (revenue - cost) by department or vendor. "View management
  // reports", the same gate as comparative sales; cost and margin only with
  // "View cost" (revenue and units, ordered by revenue, without it).
  grossMargin: permissionProcedure("reporting.management", WITH_COST)
    .input(grossMarginInput)
    .query(async ({ input, ctx }) =>
      grossMarginForCaller(await getGrossMargin(prisma, input), canViewCost({ holds: ctx.holds })),
    ),
  // Inventory health (on-hand valuation + dead stock) by department or vendor.
  // "View management reports"; cost value, dead-stock cost, dead % and
  // uncosted units only with "View cost" (units and retail value, ordered by
  // retail value, without it).
  inventoryHealth: permissionProcedure("reporting.management", WITH_COST)
    .input(inventoryHealthInput)
    .query(async ({ input, ctx }) =>
      inventoryHealthForCaller(
        await getInventoryHealth(prisma, input ?? {}),
        canViewCost({ holds: ctx.holds }),
      ),
    ),
  // Aged stock (GAP-17): how long uncommitted stock has been here, from the
  // journal. The same gate as Inventory Health; cost only with "View cost".
  // Every client's follow-up date, who it belongs to, and contacts logged per salesperson.
  followUps: permissionProcedure("sales.clients.manage").query(async () => {
    const now = new Date();
    const [rows, contacts] = await Promise.all([loadFollowUpRows(now), loadRecentContacts(now)]);
    return { rows, summary: summarizeFollowUps(rows, contacts) };
  }),

  agedStock: permissionProcedure("reporting.management", WITH_COST)
    .input(agedStockInput)
    .query(async ({ input, ctx }) =>
      agedStockForCaller(
        await getAgedStock(prisma, input ?? {}),
        canViewCost({ holds: ctx.holds }),
      ),
    ),
  // Inventory value as of a past day (GAP-17): quantities from the journal at
  // today's cost. The same gate as Inventory Health; cost only with "View cost".
  inventoryValue: permissionProcedure("reporting.management", WITH_COST)
    .input(inventoryValueInput)
    .query(async ({ input, ctx }) => {
      try {
        return inventoryValueForCaller(
          await getInventoryValue(prisma, input ?? {}),
          canViewCost({ holds: ctx.holds }),
        );
      } catch (err) {
        if (err instanceof InventoryValueInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  // Transfers (GAP-17): what moved in a period and what is still on its way.
  // Cost only with "View cost".
  transfersReport: permissionProcedure("reporting.read", WITH_COST)
    .input(transfersReportInput)
    .query(async ({ input, ctx }) => {
      try {
        return transfersReportForCaller(
          await getTransfersReport(prisma, input),
          canViewCost({ holds: ctx.holds }),
        );
      } catch (err) {
        if (err instanceof TransfersReportInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  // PO sell-through: pick real POs by number, see how much of what they
  // delivered has sold since each line's receive date. "View management
  // reports"; cost and margin only with "View cost" (frames carry only
  // FRAME_PUBLIC_FIELDS and the realized retail ratio without it).
  poSellThru: permissionProcedure("reporting.management", WITH_COST)
    .input(z.object({ poNumbers: z.array(z.string().min(1)).min(1).max(50) }))
    .query(async ({ input, ctx }) =>
      poSellThruForCaller(await getPoSellThru(prisma, input), canViewCost({ holds: ctx.holds })),
    ),
  // Top & bottom sellers by units/revenue/margin. "View management reports";
  // cost, margin and the margin ranking only with "View cost" (a margin
  // ranking is answered by revenue without it, and `metric` says so).
  topSellers: permissionProcedure("reporting.management", WITH_COST)
    .input(topSellersInput)
    .query(async ({ input, ctx }) => {
      const showCost = canViewCost({ holds: ctx.holds });
      return topSellersForCaller(
        await getTopSellers(prisma, {
          ...input,
          metric: topSellersMetricFor(input.metric, showCost),
        }),
        showCost,
      );
    }),
  // Returns analysis (return rate + top returned products). "View management
  // reports".
  returnsAnalysis: permissionProcedure("reporting.management")
    .input(returnsInput)
    .query(({ input }) => getReturnsAnalysis(prisma, input)),
  // Unclassified Returns (B3 exception report): return-shaped lines booked
  // on the default-restock assumption because no Return record classifies
  // them. Financial exception list — same gate as Gross Margin / Returns
  // Analysis ("View management reports").
  unclassifiedReturns: permissionProcedure("reporting.management")
    .input(unclassifiedReturnsInput)
    .query(({ input }) => getUnclassifiedReturns(prisma, input)),
  // Unmapped Payments: tender strings with no POS_PAYMENTS GL mapping, so
  // generateSalesJournal drops them from the journal with only a warning.
  // The same gate as the other exception lists ("View management reports").
  unmappedPayments: permissionProcedure("reporting.management")
    .input(unmappedPaymentsInput)
    .query(({ input }) =>
      getUnmappedPayments(prisma, {
        startDate: input?.startDate ?? undefined,
        endDate: input?.endDate ?? undefined,
      }),
    ),
  // "View reports", the key of the Sales Performance page.
  salesPerformance: permissionProcedure("reporting.read")
    .input(salesPerformanceInput)
    .query(({ input }) => getSalesPerformance(prisma, input ?? {})),
  // "View reports", the page's key. Holders of "See every salesperson's numbers"
  // may request any salesperson; everyone else is scoped to their own staff
  // record (resolved from the session, never the client input).
  monthlyPerformance: permissionProcedure("reporting.read", WITH_ALL_SALESPEOPLE)
    .input(monthlyPerformanceInput)
    .query(async ({ input, ctx }) => {
      const salesperson = await salespersonFor(ctx, input?.salesperson);
      return getMonthlyPerformance(prisma, { salesperson, year: input?.year });
    }),
  // Same scoping as monthlyPerformance: a holder may request any salesperson;
  // everyone else is scoped to their own staff record (resolved from the
  // session, never the client input).
  salespersonDetail: permissionProcedure("reporting.read", WITH_ALL_SALESPEOPLE)
    .input(salespersonDetailInput)
    .query(async ({ input, ctx }) => {
      const salesperson = await salespersonFor(ctx, input?.salesperson);
      return getSalespersonDetail(prisma, { salesperson, year: input?.year });
    }),
  // Sales by salesperson / department / customer. "View reports", the page's
  // key, with two answers beside it from the same staff read: "View cost" (cost
  // and margin only for a holder, SEC-14), and whether the caller may see every
  // salesperson ("See every salesperson's numbers" or "See customer lists",
  // salesBySalespersonSeesEveryone). Such a caller sees everyone and may
  // filter; anyone else is locked to their own record, whatever ids they send.
  salesBySalesperson: permissionProcedure("reporting.read", {
    also: [...WITH_COST.also!, ...WITH_SALES_BY_SALESPERSON_EVERYONE.also!],
  })
    .input(salesBySalespersonInput)
    .query(async ({ input, ctx }) =>
      salesByGroupForCaller(
        await getSalesBySalesperson(prisma, {
          ...(input ?? {}),
          auth: { seesEveryone: salesBySalespersonSeesEveryone(ctx), userId: ctx.userId },
        }),
        canViewCost({ holds: ctx.holds }),
      ),
    ),
  // Drilldown for a single sales-by-salesperson group cell. The same gate and
  // the same scope as the summary above (rule 42); groupKey is required.
  salesBySalespersonItems: permissionProcedure("reporting.read", {
    also: [...WITH_COST.also!, ...WITH_SALES_BY_SALESPERSON_EVERYONE.also!],
  })
    .input(salesBySalespersonItemsInput)
    .query(async ({ input, ctx }) =>
      salesItemsForCaller(
        await getSalesBySalespersonItems(prisma, {
          ...input,
          auth: { seesEveryone: salesBySalespersonSeesEveryone(ctx), userId: ctx.userId },
        }),
        canViewCost({ holds: ctx.holds }),
      ),
    ),
  // Detailed Sales (sales-by-department) breakdown. "View reports": the key of
  // the page and of its export route (api/reports/detailed-sales/export).
  detailedSales: permissionProcedure("reporting.read")
    .input(detailedSalesInput)
    .query(({ input }) => getDetailedSales(prisma, input ?? {})),
  // Drilldown line items for a single Detailed Sales cell. Same gate as the
  // summary above.
  detailedSalesItems: permissionProcedure("reporting.read")
    .input(detailedSalesItemsInput)
    .query(({ input }) => getDetailedSalesItems(prisma, input ?? {})),
  // Sales Explorer: two-period comparative pivot by Store / Department /
  // Category / Vendor with variance + margin at every node, plus a
  // Store-Traffic panel (Axper door counts) when pivoting by Store.
  // "View management reports", the same gate as Comparative Sales / Gross
  // Margin; cost and margin only with "View cost". See
  // lib/reports/salesExplorerQuery.ts for the invariant-bearing aggregation and
  // lib/reports/salesExplorerPivot.ts for the pure tree build.
  salesExplorer: permissionProcedure("reporting.management", WITH_COST)
    .input(salesExplorerCellsInput)
    .query(async ({ input, ctx }) => {
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

      const { tree, totals, costVisible } = salesExplorerTreeForCaller(
        buildSalesExplorerTree(cellsP1, cellsP2, pivot, storeMeta),
        canViewCost({ holds: ctx.holds }),
      );

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
        costVisible,
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
  salesExplorerItems: permissionProcedure("reporting.management")
    .input(salesExplorerItemsInput)
    .query(({ input }) => {
      const filters = resolveNodeFilters(input.pivot, input.nodeId);
      const { startDate, endDate } =
        input.period === 1
          ? { startDate: input.p1Start, endDate: input.p1End }
          : { startDate: input.p2Start, endDate: input.p2End };
      return getSalesExplorerItems(prisma, { ...filters, startDate, endDate });
    }),
  // Same scoping as monthlyPerformance/salespersonDetail: a holder may request
  // any salesperson; everyone else is scoped to their own staff record (resolved
  // from the session, never the client input).
  // "View reports", the page's key; the average margin only with "View cost".
  designerDashboard: permissionProcedure("reporting.read", {
    also: [...WITH_COST.also!, ...WITH_ALL_SALESPEOPLE.also!],
  })
    .input(designerDashboardInput)
    .query(async ({ input, ctx }) => {
      const salesperson = await salespersonFor(ctx, input?.salesperson);
      return designerDashboardForCaller(
        await getDesignerDashboard(prisma, { salesperson, asOf: input?.asOf ?? undefined }),
        canViewCost({ holds: ctx.holds }),
      );
    }),
  // Service KPIs: "View management reports".
  service: permissionProcedure("reporting.management")
    .input(serviceInput)
    .query(({ input }) => getServiceReport(prisma, input ?? {})),
  // Customer Report (every customer's contact details and spend): "See
  // customer lists".
  customers: permissionProcedure("marketing.lists")
    .input(customersInput)
    .query(({ input }) => getCustomersReport(prisma, input ?? {})),
  // Store Traffic: "View management reports" (its CSV route is Export data).
  traffic: permissionProcedure("reporting.management")
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
  // Wealth Insights: wealth is the whole answer, so "See wealth data" is the
  // gate itself (lib/auth/wealthVisibility.ts).
  wealthInsights: permissionProcedure("customer.wealth")
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
  // Per-designer pay-period sales statement. Owner tier (staff.commission-pay) —
  // the picker is the only path, so the designer is resolved from the client's
  // staffMemberId. Confirm / report-issue stay REST mutations.
  payPeriodSales: permissionProcedure("staff.commission-pay")
    .input(payPeriodSalesInput)
    .query(({ input }) =>
      getPayPeriodSales(prisma, {
        periodStart: input?.periodStart,
        staffMemberId: input?.staffMemberId,
      }),
    ),
  // Manager confirmation-status grid for a period. Same gate; the
  // reopen / resolve-issue actions stay REST mutations.
  payPeriodConfirmations: permissionProcedure("staff.commission-pay")
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
  // Opportunities: "See customer lists", the page's key, for the tile counts
  // and the lists alike. "See wealth data" is answered beside it: without it
  // the tiles built from wealth data are left out of the counts and refused as
  // lists, and no row carries a wealth tier (lib/opportunityTiles.ts,
  // tileOpenTo).
  opportunityTiles: permissionProcedure("marketing.lists", WITH_WEALTH).query(({ ctx }) =>
    getOpportunityTiles(prisma, { canSeeWealth: canViewWealth({ holds: ctx.holds }) }),
  ),
  opportunityDrill: permissionProcedure("marketing.lists", WITH_WEALTH)
    .input(z.object({ tileId: z.string(), dedup: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      try {
        return await getOpportunityDrill(prisma, {
          tileId: input.tileId,
          dedup: input.dedup,
          canSeeWealth: canViewWealth({ holds: ctx.holds }),
        });
      } catch (err) {
        if (err instanceof OpportunityTileNotFound) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),
  // Pipeline opportunity: open quotes + conversion by salesperson. "View
  // management reports", the page's key. The reassign action stays a REST POST
  // (sales.reassign).
  pipelineOpportunity: permissionProcedure("reporting.management")
    .input(pipelineOpportunityInput)
    .query(({ input }) => getPipelineOpportunity(prisma, input ?? {})),
  // Per-salesperson quote drilldown for the report above. Same gate; salesperson
  // is required.
  pipelineDetail: permissionProcedure("reporting.management")
    .input(pipelineDetailInput)
    .query(({ input }) => getPipelineDetail(prisma, input)),
  // Buyers Report: on-hand + on-order + sold-in-range merchant pivot. "View
  // management reports", the page's key; sold cost and margin only with "View
  // cost". The CSV export stays a client-side blob, built from this response,
  // so it carries no cost either; no REST shim needed.
  buyersSummary: permissionProcedure("reporting.management", WITH_COST)
    .input(buyersSummaryInput)
    .query(async ({ input, ctx }) => {
      try {
        return buyersSummaryForCaller(
          await getBuyersSummary(prisma, input ?? {}),
          canViewCost({ holds: ctx.holds }),
        );
      } catch (err) {
        if (err instanceof BuyersSummaryInputError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),
  // Per-product location breakdown for the Buyers Report leaf drilldown. Same
  // gate; productId is required.
  buyersPositions: permissionProcedure("reporting.management")
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
