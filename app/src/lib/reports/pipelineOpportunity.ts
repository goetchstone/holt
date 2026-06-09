// /app/src/lib/reports/pipelineOpportunity.ts
//
// Pipeline opportunity report: each salesperson's open quotes + orders,
// conversion rate, and average quote age (list), plus the per-salesperson quote
// drilldown with line items + recent interactions (detail). Extracted verbatim
// from the Pages API (pipeline-opportunity.ts + pipeline-detail.ts) so the App
// Router page + tRPC procedures share one source of truth. The reassign + the
// interaction-logging mutations stay REST and are unaffected.
//
// Load-bearing invariants copied as-is:
//   - netPrice is the LINE TOTAL, not a unit price — never multiplied by qty.
//   - Cancelled lines are excluded (rule 33): the list SQL filters
//     `li."lineItemStatus" != 'CANCELLED'`; the detail filters
//     `lineItemStatus: { not: "CANCELLED" }`.
//   - The detail computes a lead score from Windfall life-event signals. Both
//     endpoints are MANAGER/ADMIN only, so lead tier + score ride along on every
//     quote row. The legacy handler had no role-conditional wealth omission, so
//     none is added here; wealthTier is a scoring input only, never a column.

import type { PrismaClient } from "@prisma/client";
import { calculateLeadScore, type LeadTier } from "@/lib/leadScore";

export interface PipelineRow {
  salesperson: string;
  staffId: number | null;
  isActive: boolean;
  openQuotes: number;
  openQuoteValue: number;
  convertedOrders: number;
  convertedValue: number;
  conversionPct: number;
  avgQuoteAgeDays: number;
}

export interface PipelineStaffOption {
  id: number;
  displayName: string;
}

export interface PipelineOpportunityResult {
  rows: PipelineRow[];
  totals: {
    totalPipeline: number;
    totalQuotes: number;
    totalConverted: number;
    avgConversion: number;
  };
  activeSalespeople: PipelineStaffOption[];
}

export interface PipelineOpportunityParams {
  includeInactive?: boolean;
  includeArchived?: boolean;
}

interface SpAggregate {
  staffId: number | null;
  isActive: boolean;
  quotes: number;
  quoteVal: number;
  orders: number;
  orderVal: number;
  fulfilled: number;
  avgAge: number;
}

interface PipelineRawRow {
  salesperson: string;
  staffId: number | null;
  isActive: boolean;
  status: string;
  order_count: bigint;
  total_value: number;
  avg_age_days: number;
}

/**
 * Fold the per-status raw rows (one row per salesperson × status) into a single
 * aggregate per salesperson.
 */
function foldRowsBySalesperson(rows: PipelineRawRow[]): Map<string, SpAggregate> {
  const spMap = new Map<string, SpAggregate>();
  for (const r of rows) {
    const sp = r.salesperson;
    let entry = spMap.get(sp);
    if (!entry) {
      entry = {
        staffId: r.staffId,
        isActive: r.isActive,
        quotes: 0,
        quoteVal: 0,
        orders: 0,
        orderVal: 0,
        fulfilled: 0,
        avgAge: 0,
      };
      spMap.set(sp, entry);
    }
    const count = Number(r.order_count);
    if (r.status === "QUOTE") {
      entry.quotes = count;
      entry.quoteVal = r.total_value;
      entry.avgAge = r.avg_age_days;
    } else if (r.status === "ORDER") {
      entry.orders = count;
      entry.orderVal = r.total_value;
    } else if (r.status === "FULFILLED") {
      entry.fulfilled = count;
    }
  }
  return spMap;
}

/**
 * Materialize the salesperson aggregates into report rows, dropping anyone with
 * no quotes/orders/fulfilled and sorting by open-quote value desc.
 */
function buildPipelineRows(spMap: Map<string, SpAggregate>): PipelineRow[] {
  const pipeline: PipelineRow[] = [];
  for (const [sp, d] of spMap) {
    if (d.quotes === 0 && d.orders === 0 && d.fulfilled === 0) continue;
    const totalOps = d.quotes + d.orders + d.fulfilled;
    const converted = d.orders + d.fulfilled;
    pipeline.push({
      salesperson: sp,
      staffId: d.staffId,
      isActive: d.isActive,
      openQuotes: d.quotes,
      openQuoteValue: Math.round(d.quoteVal),
      convertedOrders: converted,
      convertedValue: Math.round(d.orderVal),
      conversionPct: totalOps > 0 ? Math.round((converted / totalOps) * 1000) / 10 : 0,
      avgQuoteAgeDays: Math.round(d.avgAge),
    });
  }
  pipeline.sort((a, b) => b.openQuoteValue - a.openQuoteValue);
  return pipeline;
}

export async function getPipelineOpportunity(
  prisma: PrismaClient,
  params: PipelineOpportunityParams,
): Promise<PipelineOpportunityResult> {
  const includeInactive = params.includeInactive ?? false;
  const includeArchived = params.includeArchived ?? false;

  // Build filter clauses conditionally
  const activeClause = includeInactive ? "" : `AND sm."isActive" = true`;
  const archivedClause = includeArchived ? "" : `AND so."pipelineArchivedAt" IS NULL`;

  const rows = await prisma.$queryRawUnsafe<PipelineRawRow[]>(`
    SELECT
      COALESCE(so.salesperson, 'Unassigned') AS salesperson,
      sm.id AS "staffId",
      COALESCE(sm."isActive", false) AS "isActive",
      so.status,
      COUNT(DISTINCT so.id)::bigint AS order_count,
      -- netPrice is already the LINE TOTAL; do not multiply by orderedQuantity
      COALESCE(SUM(li."netPrice")::float, 0) AS total_value,
      COALESCE(AVG(EXTRACT(DAY FROM NOW() - COALESCE(so."quoteDate", so."orderDate")))::float, 0) AS avg_age_days
    FROM "SalesOrder" so
    JOIN "OrderLineItem" li ON li."salesOrderId" = so.id
    LEFT JOIN "StaffMember" sm ON sm."displayName" = so.salesperson
    WHERE so.status IN ('QUOTE', 'ORDER', 'FULFILLED')
      AND li."lineItemStatus" != 'CANCELLED'
      AND COALESCE(so."quoteDate", so."orderDate") >= NOW() - INTERVAL '12 months'
      ${activeClause}
      ${archivedClause}
    GROUP BY so.salesperson, sm.id, sm."isActive", so.status
  `);

  const spMap = foldRowsBySalesperson(rows);
  const pipeline = buildPipelineRows(spMap);

  const totals = {
    totalPipeline: pipeline.reduce((s, r) => s + r.openQuoteValue, 0),
    totalQuotes: pipeline.reduce((s, r) => s + r.openQuotes, 0),
    totalConverted: pipeline.reduce((s, r) => s + r.convertedOrders, 0),
    avgConversion:
      pipeline.length > 0
        ? Math.round((pipeline.reduce((s, r) => s + r.conversionPct, 0) / pipeline.length) * 10) /
          10
        : 0,
  };

  // Get active salesperson list for reassignment dropdown
  const activeSalespeople = await prisma.staffMember.findMany({
    where: { isActive: true, role: { in: ["DESIGNER", "MANAGER", "ADMIN"] } },
    select: { id: true, displayName: true },
    orderBy: { displayName: "asc" },
  });

  return { rows: pipeline, totals, activeSalespeople };
}

// ----------------------------------------------------------------------------
// Drilldown (formerly pipeline-detail.ts)
// ----------------------------------------------------------------------------

export interface PipelineLineItem {
  id: number;
  productName: string | null;
  partNo: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface PipelineQuoteRow {
  id: number;
  orderno: string;
  customerId: number | null;
  customerName: string;
  // Lead tier (HOT/WARM/COOL/NEW) for the associated customer. Safe for
  // MANAGER/ADMIN (this report is MANAGER/ADMIN only).
  leadTier: LeadTier | null;
  leadScore: number | null;
  quoteDate: string | null;
  ageDays: number;
  quoteValue: number;
  lineItemCount: number;
  lineItems: PipelineLineItem[];
  lastInteraction: string | null;
  lastNote: string | null;
  lastNoteBy: string | null;
  lastNoteDate: string | null;
}

export interface PipelineDetailResult {
  rows: PipelineQuoteRow[];
  salesperson: string;
}

export interface PipelineDetailParams {
  salesperson: string;
  includeArchived?: boolean;
}

export async function getPipelineDetail(
  prisma: PrismaClient,
  params: PipelineDetailParams,
): Promise<PipelineDetailResult> {
  const { salesperson } = params;
  if (!salesperson) {
    return { rows: [], salesperson: "" };
  }
  const includeArchived = params.includeArchived ?? false;

  const quotes = await prisma.salesOrder.findMany({
    where: {
      status: "QUOTE",
      salesperson,
      ...(includeArchived ? {} : { pipelineArchivedAt: null }),
    },
    select: {
      id: true,
      orderno: true,
      quoteDate: true,
      orderDate: true,
      customerId: true,
      customer: {
        select: {
          firstName: true,
          lastName: true,
          lifetimeSpend: true,
          lifetimeOrderCount: true,
          customerLevel: true,
          peakCustomerLevel: true,
          departmentCount: true,
          lastOrderDate: true,
          windfallEnrichment: {
            select: {
              wealthTier: true,
              recentMover: true,
              recentMortgage: true,
              recentlyDivorced: true,
              moneyInMotion: true,
              liquidityTrigger: true,
            },
          },
        },
      },
      lineItems: {
        where: { lineItemStatus: { not: "CANCELLED" } },
        select: {
          id: true,
          productName: true,
          partNo: true,
          orderedQuantity: true,
          netPrice: true,
        },
      },
      interactions: {
        select: {
          startedAt: true,
          source: true,
          notes: true,
          staffMember: { select: { displayName: true } },
        },
        orderBy: { startedAt: "desc" },
        take: 3,
      },
    },
    orderBy: [{ quoteDate: "desc" }, { orderDate: "desc" }],
  });

  const now = new Date();
  const rows: PipelineQuoteRow[] = quotes.map((q) => {
    const date = q.quoteDate ?? q.orderDate;
    const ageDays = date
      ? Math.floor((now.getTime() - new Date(date).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    // netPrice is the LINE TOTAL, not unit price — do not multiply by quantity.
    // See paymentService.ts computeBalance for the invariant.
    const quoteValue = q.lineItems.reduce((s, li) => s + Number(li.netPrice), 0);

    const customerName = q.customer
      ? [q.customer.firstName, q.customer.lastName].filter(Boolean).join(" ")
      : "Unknown";

    // Lead score is safe to compute/return here: this report is MANAGER/ADMIN
    // only, so both tier and score can ride along on every quote row. The
    // wealth tier feeds the score as an input exactly as the legacy handler did
    // (no role-conditional scoring); it is never surfaced as a column.
    let leadTier: LeadTier | null = null;
    let leadScore: number | null = null;
    if (q.customer) {
      const wf = q.customer.windfallEnrichment;
      const breakdown = calculateLeadScore({
        lifetimeSpend: Number(q.customer.lifetimeSpend ?? 0),
        lifetimeOrderCount: q.customer.lifetimeOrderCount,
        customerLevel: q.customer.customerLevel,
        peakCustomerLevel: q.customer.peakCustomerLevel,
        departmentCount: q.customer.departmentCount,
        lastOrderDate: q.customer.lastOrderDate,
        wealthTier: wf?.wealthTier,
        recentMover: wf?.recentMover,
        recentMortgage: wf?.recentMortgage,
        recentlyDivorced: wf?.recentlyDivorced,
        moneyInMotion: wf?.moneyInMotion,
        liquidityTrigger: wf?.liquidityTrigger,
      });
      leadTier = breakdown.tier;
      leadScore = breakdown.score;
    }

    const lastInteraction = q.interactions[0]?.startedAt
      ? q.interactions[0].startedAt.toISOString().slice(0, 10)
      : null;

    // Find the most recent note (any source with notes text)
    const noteInteraction = q.interactions.find((i) => i.notes);

    return {
      id: q.id,
      orderno: q.orderno,
      customerId: q.customerId,
      customerName,
      leadTier,
      leadScore,
      quoteDate: date ? date.toISOString().slice(0, 10) : null,
      ageDays,
      quoteValue: Math.round(quoteValue),
      lineItemCount: q.lineItems.length,
      lineItems: q.lineItems.map((li) => {
        const qty = Number(li.orderedQuantity) || 1;
        const lineTotal = Number(li.netPrice);
        const unitPrice = qty > 0 ? lineTotal / qty : lineTotal;
        return {
          id: li.id,
          productName: li.productName,
          partNo: li.partNo,
          quantity: qty,
          unitPrice: Math.round(unitPrice * 100) / 100,
          lineTotal: Math.round(lineTotal * 100) / 100,
        };
      }),
      lastInteraction,
      lastNote: noteInteraction?.notes ?? null,
      lastNoteBy: noteInteraction?.staffMember?.displayName ?? null,
      lastNoteDate: noteInteraction?.startedAt
        ? noteInteraction.startedAt.toISOString().slice(0, 10)
        : null,
    };
  });

  return { rows, salesperson };
}
