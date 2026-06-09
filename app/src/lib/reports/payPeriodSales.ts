// /app/src/lib/reports/payPeriodSales.ts
//
// Pay-period sales read-model: the per-designer statement (sales for a
// bi-weekly pay period — order detail, period total, YTD-through-period) and
// the manager confirmation-status grid. Extracted verbatim from the two Pages
// GET handlers so the App Router page + tRPC procedures share one source of
// truth; the confirm / report-issue / reopen / resolve-issue mutations stay
// REST and are unaffected.
//
// The pay-period attribution LOCK (PayPeriodConfirmation) is load-bearing for
// commission correctness — this module is a pure READ extraction. All matching
// + split rules reuse `sumDesignerSales` (the commission engine's summer) so the
// designer's number cannot diverge from the payout math; the detail rows apply
// the same 0.5× split multiplier so they sum to the period total. Cancelled
// lines are excluded via `buildLineItemWhere` (rule 33) and RETURNED is in the
// status filter so negative return lines net out rewrite chains.
//
// The designer-vs-manager authorization (who may see whose statement) lives in
// the tRPC procedure; the whole surface is tabled to SUPER_ADMIN, so the lib
// takes a resolved `staffMemberId` and never decides visibility itself.

import type { PrismaClient } from "@prisma/client";
import { sumDesignerSales } from "@/lib/commissionSales";
import { buildLineItemWhere, customerLabel } from "@/lib/salesBySalesperson";
import {
  payPeriodForDate,
  payPeriodFromStart,
  formatPeriodDate,
  formatPeriodLabel,
  type PayPeriod,
} from "@/lib/payPeriod";
import { isPeriodConfirmable } from "@/lib/payPeriodLock";
import {
  getOpenIssueSummary,
  listPeriodConfirmationStatus,
  type PeriodConfirmationStatusRow,
} from "@/lib/payPeriodConfirmationService";

export interface PayPeriodStatementOrderRow {
  orderId: number;
  orderNumber: string;
  orderDate: string;
  customer: string;
  storeLocation: string | null;
  isSplit: boolean;
  /** Net credited to THIS designer (line sum × split multiplier). */
  creditedNet: number;
}

export interface PayPeriodStatement {
  period: { start: string; end: string; label: string };
  designer: { id: number; displayName: string } | null;
  needsSelection: boolean;
  periodTotal: number;
  ytdTotal: number;
  orders: PayPeriodStatementOrderRow[];
  confirmation?: { confirmed: boolean; confirmedAt: Date | null; confirmable: boolean };
  issue?: { open: boolean; note: string | null; reportedAt: Date | null };
}

export interface PayPeriodSalesParams {
  /** YYYY-MM-DD; defaults to the period containing today. */
  periodStart?: string;
  /** The resolved designer to view; omitted = "pick a designer" empty state. */
  staffMemberId?: number;
}

export interface PayPeriodConfirmationsParams {
  /** YYYY-MM-DD; required (mirrors the legacy 400 when missing/malformed). */
  periodStart?: string;
}

export interface PayPeriodConfirmations {
  period: { start: string | undefined; label: string };
  rows: PeriodConfirmationStatusRow[];
  readyForReview: boolean;
}

/** Thrown when the manager-grid periodStart param is missing or malformed. */
export class PayPeriodInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPeriodInputError";
  }
}

function parseStartParam(raw: string | undefined): PayPeriod {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return payPeriodFromStart(d);
  }
  // Default: the period containing today.
  return payPeriodForDate(new Date());
}

/**
 * Per-designer pay-period statement. Without a resolved `staffMemberId`, returns
 * the "pick a designer" empty state (the SUPER_ADMIN picker is the only path
 * since this surface is tabled).
 */
export async function getPayPeriodSales(
  prisma: PrismaClient,
  params: PayPeriodSalesParams,
): Promise<PayPeriodStatement> {
  const requestedId =
    params.staffMemberId && Number.isFinite(params.staffMemberId)
      ? params.staffMemberId
      : undefined;

  let staff: { id: number; displayName: string; aliases: string[] } | null = null;
  if (requestedId) {
    staff = await prisma.staffMember.findUnique({
      where: { id: requestedId },
      select: { id: true, displayName: true, aliases: true },
    });
  }

  const period = parseStartParam(params.periodStart);
  const periodMeta = {
    start: formatPeriodDate(period.start),
    end: formatPeriodDate(period.end),
    label: formatPeriodLabel(period),
  };

  if (!staff) {
    // No designer picked yet — "pick a designer" state.
    return {
      period: periodMeta,
      designer: null,
      needsSelection: true,
      periodTotal: 0,
      ytdTotal: 0,
      orders: [],
    };
  }

  const matchNames = [staff.displayName, ...(staff.aliases ?? [])];
  const yearStart = new Date(Date.UTC(period.start.getUTCFullYear(), 0, 1));

  // Period + YTD totals via the SAME summer the commission engine uses —
  // designer's number can't diverge from the payout math.
  const [periodTotal, ytdTotal, detailOrders] = await Promise.all([
    sumDesignerSales(staff.id, matchNames, period.start, period.endExclusive),
    sumDesignerSales(staff.id, matchNames, yearStart, period.endExclusive),
    prisma.salesOrder.findMany({
      where: {
        orderDate: { gte: period.start, lt: period.endExclusive },
        status: { in: ["ORDER", "FULFILLED", "RETURNED"] },
        OR: [
          ...matchNames.map((name) => ({
            salesperson: { equals: name, mode: "insensitive" as const },
          })),
          { salesPersonId: staff.id },
          { splitWithId: staff.id },
        ],
      },
      select: {
        id: true,
        orderno: true,
        orderDate: true,
        storeLocation: true,
        splitWithId: true,
        customer: {
          select: { firstName: true, lastName: true, tradeCompanyName: true },
        },
        lineItems: {
          where: buildLineItemWhere([], false),
          select: { netPrice: true },
        },
      },
      orderBy: { orderDate: "asc" },
    }),
  ]);

  const orders: PayPeriodStatementOrderRow[] = detailOrders
    .map((o) => {
      const multiplier = o.splitWithId ? 0.5 : 1;
      const net = o.lineItems.reduce((sum, li) => sum + Number(li.netPrice), 0) * multiplier;
      return {
        orderId: o.id,
        orderNumber: o.orderno,
        orderDate: o.orderDate ? formatPeriodDate(o.orderDate) : "",
        customer: customerLabel(o.customer),
        storeLocation: o.storeLocation,
        isSplit: o.splitWithId !== null,
        creditedNet: Math.round(net * 100) / 100,
      };
    })
    // Orders whose only line items are cancelled net to 0 credited — drop them
    // so the statement doesn't list empty rows.
    .filter((o) => o.creditedNet !== 0);

  // Confirmation state for this designer + period (drives the "Confirm these
  // numbers" button + confirmed badge).
  const confRow = await prisma.payPeriodConfirmation.findUnique({
    where: {
      staffMemberId_periodStart_periodEnd: {
        staffMemberId: staff.id,
        periodStart: period.start,
        periodEnd: period.end,
      },
    },
    select: { confirmedAt: true, confirmedBy: true, reopenedAt: true },
  });
  const confirmed = confRow !== null && confRow.reopenedAt === null;
  const confirmable = isPeriodConfirmable(period.end, new Date()).ok;

  // Open issue this designer flagged for the period (drives the "issue pending
  // review" badge vs the Report-an-issue button).
  const issueSummary = await getOpenIssueSummary(staff.id, period);

  return {
    period: periodMeta,
    designer: { id: staff.id, displayName: staff.displayName },
    needsSelection: false,
    periodTotal: Math.round(periodTotal * 100) / 100,
    ytdTotal: Math.round(ytdTotal * 100) / 100,
    orders,
    confirmation: {
      confirmed,
      confirmedAt: confirmed ? (confRow?.confirmedAt ?? null) : null,
      confirmable,
    },
    issue: {
      open: issueSummary.openCount > 0,
      note: issueSummary.note,
      reportedAt: issueSummary.reportedAt,
    },
  };
}

/**
 * Manager confirmation-status grid for a period: per-designer status + the
 * "ready for review" signal (all active designers confirmed, no open issues).
 * Throws PayPeriodInputError if periodStart is missing/malformed (the legacy
 * handler answered 400).
 */
export async function getPayPeriodConfirmations(
  params: PayPeriodConfirmationsParams,
): Promise<PayPeriodConfirmations> {
  const raw = params.periodStart;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new PayPeriodInputError("periodStart (YYYY-MM-DD) is required");
  }
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new PayPeriodInputError("periodStart (YYYY-MM-DD) is required");
  }
  const period = payPeriodFromStart(d);

  const { rows, readyForReview } = await listPeriodConfirmationStatus(period);
  return {
    period: { start: raw, label: formatPeriodLabel(period) },
    rows,
    readyForReview,
  };
}
