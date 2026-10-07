// /app/src/lib/reports/serviceReport.ts
//
// Customer-service queue KPI report. Wraps the Prisma reads around the pure math
// in lib/serviceKpi.ts so the App Router page + tRPC procedure share one source
// of truth. No sales line items here, so rule 33 does not apply.

import type { PrismaClient } from "@prisma/client";
import { computeServiceKpis, type ClosedCaseSample, type ServiceKpis } from "@/lib/serviceKpi";

// Status names treated as "externally blocked" for the waiting-on breakdown.
// Matches the seeded names from the customer-service migration.
const WAITING_ON_VENDOR_NAME = "Waiting on Vendor";
const WAITING_ON_CUSTOMER_NAME = "Waiting on Customer";

export interface OldestOpenRow {
  id: number;
  caseNumber: string;
  summary: string;
  customer: { id: number; firstName: string | null; lastName: string | null } | null;
  assignedTo: { id: number; displayName: string } | null;
  status: { id: number; name: string; color: string | null };
  createdAt: Date;
  ageDays: number;
}

export interface ServiceReportResult {
  goalDays: number;
  kpis: ServiceKpis;
  oldestOpen: OldestOpenRow[];
  windowDays: number;
}

export interface ServiceReportParams {
  goalDays?: number;
}

export async function getServiceReport(
  prisma: PrismaClient,
  params: ServiceReportParams = {},
): Promise<ServiceReportResult> {
  const goalDays = params.goalDays && params.goalDays > 0 ? params.goalDays : 14;

  const openCases = await prisma.serviceCase.findMany({
    where: { status: { isClosed: false } },
    select: {
      id: true,
      caseNumber: true,
      summary: true,
      created: true,
      updated: true,
      customer: { select: { id: true, firstName: true, lastName: true } },
      assignedTo: { select: { id: true, displayName: true } },
      status: { select: { id: true, name: true, color: true } },
    },
  });

  // Closed cases in the last 90 days (resolution-time pool).
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const closedCases = await prisma.serviceCase.findMany({
    where: { status: { isClosed: true }, resolvedAt: { gte: since, not: null } },
    select: { created: true, resolvedAt: true },
  });
  const closedSamples: ClosedCaseSample[] = closedCases
    .filter((c): c is { created: Date; resolvedAt: Date } => c.resolvedAt !== null)
    .map((c) => ({ createdAt: c.created, resolvedAt: c.resolvedAt }));

  // Resolution trend (last 6 months, grouped).
  const trendSince = new Date();
  trendSince.setMonth(trendSince.getMonth() - 6);
  const trendCases = await prisma.serviceCase.findMany({
    where: { status: { isClosed: true }, resolvedAt: { gte: trendSince, not: null } },
    select: { created: true, resolvedAt: true },
  });
  const trendSamples: ClosedCaseSample[] = trendCases
    .filter((c): c is { created: Date; resolvedAt: Date } => c.resolvedAt !== null)
    .map((c) => ({ createdAt: c.created, resolvedAt: c.resolvedAt }));

  const kpis = computeServiceKpis({
    openCases: openCases.map((c) => ({
      id: c.id,
      createdAt: c.created,
      statusName: c.status.name,
    })),
    closedSamples,
    trendSamples,
    goalDays,
    externalWaitStatusNames: [WAITING_ON_VENDOR_NAME, WAITING_ON_CUSTOMER_NAME],
    now: new Date(),
  });

  const now = Date.now();
  const oldestOpen: OldestOpenRow[] = openCases
    .map((c) => ({
      id: c.id,
      caseNumber: c.caseNumber,
      summary: c.summary,
      customer: c.customer,
      assignedTo: c.assignedTo,
      status: c.status,
      createdAt: c.created,
      ageDays: Math.floor((now - c.created.getTime()) / (1000 * 60 * 60 * 24)),
    }))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, 10);

  return { goalDays, kpis, oldestOpen, windowDays: 90 };
}
