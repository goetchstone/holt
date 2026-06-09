// /app/src/pages/api/sales/pipeline/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../../auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { calculateLeadScore, type LeadTier } from "@/lib/leadScore";
import { detectPossibleDuplicates } from "@/lib/duplicateQuotes";

export interface PipelineQuote {
  id: number;
  orderno: string;
  orderDate: string | null;
  quoteDate: string | null;
  customer: {
    id: number;
    firstName: string | null;
    lastName: string | null;
    // wealthTier is only included for ADMIN/MARKETING, omitted for others
    wealthTier?: string | null;
    leadTier: LeadTier | null;
    // leadScore only included for ADMIN/MANAGER/MARKETING
    leadScore?: number | null;
  } | null;
  salesperson: string | null;
  storeLocation: string | null;
  lineItemSummary: string;
  totalAmount: number;
  lastInteractionAt: string | null;
  daysSinceCreated: number;
  daysSinceContact: number | null;
  pipelineArchivedAt: string | null;
  pipelineNote: string | null;
  archiveReason: string | null;
  replacedByOrderId: number | null;
  replacedByOrderno: string | null;
  // Other QUOTE-status orders on the same customer that look like duplicates
  // (50%+ part-number overlap OR total within 10%). Empty array when none.
  possibleDuplicateOf: { id: number; orderno: string }[];
  interactions: {
    id: number;
    source: string;
    notes: string | null;
    startedAt: string;
    staffName: string;
  }[];
}

export interface PipelineLead {
  id: number;
  source: string;
  status: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  assignedAt: string | null;
  daysSinceCreated: number;
  salesOrderId: number | null;
}

export interface StaffSummary {
  id: number;
  displayName: string;
  storeLocation: string | null;
  quoteCount: number;
  totalValue: number;
  overdueCount: number;
  leadCount: number;
}

export type PipelineScope = "mine" | "all" | "staff";

export interface PipelineResponse {
  quotes: PipelineQuote[];
  leads: PipelineLead[];
  staffSummaries: StaffSummary[];
  myStaffId: number | null;
  canViewAll: boolean;
  scope: PipelineScope;
  viewingStaff: { id: number; displayName: string } | null;
  showingArchived: boolean;
}

// Compare calendar dates in Eastern time (CT store timezone) to avoid
// off-by-one errors from UTC midnight boundary.
function daysBetween(date: Date | string | null, now: Date): number {
  if (!date) return 0;
  const d = typeof date === "string" ? new Date(date) : date;
  // Extract year/month/day in Eastern timezone for both dates
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const toMidnight = (dt: Date) => {
    const parts = fmt.formatToParts(dt);
    const y = Number(parts.find((p) => p.type === "year")!.value);
    const m = Number(parts.find((p) => p.type === "month")!.value) - 1;
    const day = Number(parts.find((p) => p.type === "day")!.value);
    return new Date(y, m, day).getTime();
  };
  return Math.max(0, Math.floor((toMidnight(now) - toMidnight(d)) / (1000 * 60 * 60 * 24)));
}

const QUOTE_SELECT = {
  id: true,
  orderno: true,
  orderDate: true,
  quoteDate: true,
  salesPersonId: true,
  salesperson: true,
  storeLocation: true,
  pipelineArchivedAt: true,
  pipelineNote: true,
  archiveReason: true,
  replacedByOrderId: true,
  replacedByOrder: { select: { id: true, orderno: true } },
  customer: {
    select: {
      id: true,
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
    select: { productName: true, partNo: true, netPrice: true },
    where: { netPrice: { gt: 0 } },
    orderBy: { netPrice: "desc" as const },
  },
  interactions: {
    select: {
      id: true,
      source: true,
      notes: true,
      startedAt: true,
      staffMember: { select: { displayName: true } },
    },
    orderBy: { startedAt: "desc" as const },
    take: 5,
  },
} as const;

type RoleVisibility = {
  canSeeWealth: boolean;
  canSeeScore: boolean;
};

function mapQuote(
  q: {
    id: number;
    orderno: string;
    orderDate: Date | null;
    quoteDate: Date | null;
    salesperson: string | null;
    storeLocation: string | null;
    pipelineArchivedAt: Date | null;
    pipelineNote: string | null;
    archiveReason: string | null;
    replacedByOrderId: number | null;
    replacedByOrder: { id: number; orderno: string } | null;
    customer: {
      id: number;
      firstName: string | null;
      lastName: string | null;
      lifetimeSpend: unknown;
      lifetimeOrderCount: number | null;
      customerLevel: number | null;
      peakCustomerLevel: number | null;
      departmentCount: number | null;
      lastOrderDate: Date | null;
      windfallEnrichment: {
        wealthTier: string | null;
        recentMover: boolean;
        recentMortgage: boolean;
        recentlyDivorced: boolean;
        moneyInMotion: boolean;
        liquidityTrigger: boolean;
      } | null;
    } | null;
    lineItems: { productName: string | null; partNo: string | null; netPrice: unknown }[];
    interactions: {
      id: number;
      source: string;
      notes: string | null;
      startedAt: Date;
      staffMember: { displayName: string };
    }[];
  },
  now: Date,
  visibility: RoleVisibility,
  possibleDuplicateOf: { id: number; orderno: string }[],
): PipelineQuote {
  const totalAmount = q.lineItems.reduce((s, li) => s + Number(li.netPrice), 0);
  const productNames = q.lineItems
    .slice(0, 3)
    .map((li) => li.productName)
    .filter(Boolean)
    .join(", ");
  const lineItemSummary =
    productNames + (q.lineItems.length > 3 ? ` +${q.lineItems.length - 3} more` : "");
  const lastInteraction = q.interactions[0]?.startedAt ?? null;
  const refDate = q.quoteDate ?? q.orderDate;
  return {
    id: q.id,
    orderno: q.orderno,
    orderDate: q.orderDate?.toISOString() ?? null,
    quoteDate: q.quoteDate?.toISOString() ?? null,
    customer: q.customer
      ? (() => {
          const wf = q.customer.windfallEnrichment;
          const score = calculateLeadScore({
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
          return {
            id: q.customer.id,
            firstName: q.customer.firstName,
            lastName: q.customer.lastName,
            ...(visibility.canSeeWealth
              ? { wealthTier: q.customer.windfallEnrichment?.wealthTier ?? null }
              : {}),
            leadTier: score.tier,
            ...(visibility.canSeeScore ? { leadScore: score.score } : {}),
          };
        })()
      : null,
    salesperson: q.salesperson ?? null,
    storeLocation: q.storeLocation ?? null,
    lineItemSummary: lineItemSummary || "No items",
    totalAmount: Math.round(totalAmount * 100) / 100,
    lastInteractionAt: lastInteraction?.toISOString() ?? null,
    daysSinceCreated: refDate ? daysBetween(refDate, now) : 0,
    daysSinceContact: lastInteraction ? daysBetween(lastInteraction, now) : null,
    pipelineArchivedAt: q.pipelineArchivedAt?.toISOString() ?? null,
    pipelineNote: q.pipelineNote ?? null,
    archiveReason: q.archiveReason ?? null,
    replacedByOrderId: q.replacedByOrderId ?? null,
    replacedByOrderno: q.replacedByOrder?.orderno ?? null,
    possibleDuplicateOf,
    interactions: q.interactions.map((i) => ({
      id: i.id,
      source: i.source,
      notes: i.notes,
      startedAt: i.startedAt.toISOString(),
      staffName: i.staffMember.displayName,
    })),
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PipelineResponse | { error: string }>,
) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  const staff = await prisma.staffMember.findUnique({
    where: { email: session.user.email },
    select: { id: true, displayName: true, role: true, defaultStore: true },
  });

  // Deny when no StaffMember record exists. The earlier `|| !staff`
  // branch was a bootstrap escape hatch that let any Google account
  // without a staff record view the entire pipeline including wealth,
  // lead contacts, and customer financials.
  if (!staff) {
    return res.status(403).json({ error: "Staff record required" });
  }

  const canViewAll =
    staff.role === "MANAGER" || staff.role === "ADMIN" || staff.role === "SUPER_ADMIN";
  // Wealth data is restricted to ADMIN/MARKETING. Score visibility is broader
  // (ADMIN/MANAGER/MARKETING) since the score itself doesn't expose wealth.
  const visibility = {
    canSeeWealth:
      staff?.role === "ADMIN" || staff?.role === "SUPER_ADMIN" || staff?.role === "MARKETING",
    canSeeScore:
      staff?.role === "ADMIN" ||
      staff?.role === "SUPER_ADMIN" ||
      staff?.role === "MANAGER" ||
      staff?.role === "MARKETING",
  };
  const rawScope = req.query.scope as string | undefined;
  const showingArchived = req.query.archived === "true";
  const now = new Date();
  const openLeadStatuses = ["NEW", "ASSIGNED", "CONTACTED"] as const;

  // Archived filter applied to all quote queries
  const archiveFilter = showingArchived
    ? { pipelineArchivedAt: { not: null as null } }
    : { pipelineArchivedAt: null };

  // ── scope=all: per-staff summary metrics (active quotes only) ────────────

  if (rawScope === "all" && canViewAll) {
    const [allActiveStaff, allQuotesRaw, allLeadsRaw] = await Promise.all([
      prisma.staffMember.findMany({
        where: { isActive: true },
        select: {
          id: true,
          displayName: true,
          defaultStore: true,
          activeStoreLocation: { select: { name: true } },
        },
        orderBy: { displayName: "asc" },
      }),
      prisma.salesOrder.findMany({
        where: { status: "QUOTE", pipelineArchivedAt: null },
        select: {
          salesPersonId: true,
          salesperson: true,
          lineItems: { select: { netPrice: true }, where: { netPrice: { gt: 0 } } },
          interactions: { select: { startedAt: true }, orderBy: { startedAt: "desc" }, take: 1 },
          quoteDate: true,
          orderDate: true,
        },
      }),
      prisma.lead.findMany({
        where: { status: { in: [...openLeadStatuses] } },
        select: { assignedToId: true },
      }),
    ]);

    const staffMetrics = new Map<
      number,
      { quoteCount: number; totalValue: number; overdueCount: number }
    >();

    for (const q of allQuotesRaw) {
      let staffId = q.salesPersonId;
      if (!staffId && q.salesperson) {
        const lower = q.salesperson.toLowerCase();
        for (const s of allActiveStaff) {
          if (lower.includes(s.displayName.toLowerCase())) {
            staffId = s.id;
            break;
          }
        }
      }
      if (!staffId) continue;

      const total = q.lineItems.reduce((sum, li) => sum + Number(li.netPrice), 0);
      const refDate = q.quoteDate ?? q.orderDate;
      const daysSinceCreated = refDate ? daysBetween(refDate, now) : 0;
      const lastInteraction = q.interactions[0]?.startedAt ?? null;
      const daysSinceContact = lastInteraction ? daysBetween(lastInteraction, now) : null;
      const urgencyDays = daysSinceContact ?? daysSinceCreated;

      if (!staffMetrics.has(staffId)) {
        staffMetrics.set(staffId, { quoteCount: 0, totalValue: 0, overdueCount: 0 });
      }
      const m = staffMetrics.get(staffId)!;
      m.quoteCount++;
      m.totalValue += total;
      if (urgencyDays > 7) m.overdueCount++;
    }

    const staffLeadCounts = new Map<number, number>();
    for (const l of allLeadsRaw) {
      if (l.assignedToId) {
        staffLeadCounts.set(l.assignedToId, (staffLeadCounts.get(l.assignedToId) ?? 0) + 1);
      }
    }

    const staffSummaries: StaffSummary[] = allActiveStaff
      .filter((s) => staffMetrics.has(s.id) || staffLeadCounts.has(s.id))
      .map((s) => {
        const m = staffMetrics.get(s.id);
        return {
          id: s.id,
          displayName: s.displayName,
          storeLocation: s.activeStoreLocation?.name ?? s.defaultStore ?? null,
          quoteCount: m?.quoteCount ?? 0,
          totalValue: Math.round((m?.totalValue ?? 0) * 100) / 100,
          overdueCount: m?.overdueCount ?? 0,
          leadCount: staffLeadCounts.get(s.id) ?? 0,
        };
      })
      .sort((a, b) => b.totalValue - a.totalValue);

    return res.status(200).json({
      quotes: [],
      leads: [],
      staffSummaries,
      myStaffId: staff?.id ?? null,
      canViewAll,
      scope: "all",
      viewingStaff: null,
      showingArchived: false,
    });
  }

  // ── scope=staff: a specific designer's pipeline (manager only) ───────────

  const rawStaffId = Number.parseInt(req.query.staffId as string, 10);
  if (rawScope === "staff" && canViewAll && !Number.isNaN(rawStaffId)) {
    const targetStaff = await prisma.staffMember.findUnique({
      where: { id: rawStaffId },
      select: { id: true, displayName: true },
    });
    if (!targetStaff) return res.status(404).json({ error: "Staff member not found" });

    const [rawQuotes, rawLeads] = await Promise.all([
      prisma.salesOrder.findMany({
        where: {
          status: "QUOTE",
          ...archiveFilter,
          OR: [
            { salesPersonId: targetStaff.id },
            { salesperson: { contains: targetStaff.displayName, mode: "insensitive" } },
          ],
        },
        orderBy: { orderDate: "desc" },
        take: 200,
        select: QUOTE_SELECT,
      }),
      prisma.lead.findMany({
        where: { status: { in: [...openLeadStatuses] }, assignedToId: targetStaff.id },
        orderBy: { created: "desc" },
        take: 100,
        select: {
          id: true,
          source: true,
          status: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          notes: true,
          assignedAt: true,
          created: true,
          salesOrderId: true,
        },
      }),
    ]);

    const dupMap = detectPossibleDuplicates(rawQuotes);
    return res.status(200).json({
      quotes: rawQuotes.map((q) => mapQuote(q, now, visibility, dupMap.get(q.id) ?? [])),
      leads: rawLeads.map((l) => ({
        id: l.id,
        source: l.source,
        status: l.status,
        firstName: l.firstName,
        lastName: l.lastName,
        email: l.email,
        phone: l.phone,
        notes: l.notes,
        assignedAt: l.assignedAt?.toISOString() ?? null,
        daysSinceCreated: daysBetween(l.created, now),
        salesOrderId: l.salesOrderId,
      })),
      staffSummaries: [],
      myStaffId: staff?.id ?? null,
      canViewAll,
      scope: "staff",
      viewingStaff: { id: targetStaff.id, displayName: targetStaff.displayName },
      showingArchived,
    });
  }

  // ── scope=mine (default) ─────────────────────────────────────────────────

  const quoteWhere = !staff
    ? { status: "QUOTE" as const, ...archiveFilter }
    : {
        status: "QUOTE" as const,
        ...archiveFilter,
        OR: [
          { salesPersonId: staff.id },
          { salesperson: { contains: staff.displayName, mode: "insensitive" as const } },
        ],
      };

  const leadWhere = !staff
    ? { status: { in: [...openLeadStatuses] } }
    : { status: { in: [...openLeadStatuses] }, assignedToId: staff.id };

  const [rawQuotes, rawLeads] = await Promise.all([
    prisma.salesOrder.findMany({
      where: quoteWhere,
      orderBy: { orderDate: "desc" },
      take: 200,
      select: QUOTE_SELECT,
    }),
    showingArchived
      ? Promise.resolve([])
      : prisma.lead.findMany({
          where: leadWhere,
          orderBy: { created: "desc" },
          take: 100,
          select: {
            id: true,
            source: true,
            status: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            notes: true,
            assignedAt: true,
            created: true,
            salesOrderId: true,
          },
        }),
  ]);

  const dupMap = detectPossibleDuplicates(rawQuotes);
  return res.status(200).json({
    quotes: rawQuotes.map((q) => mapQuote(q, now, visibility, dupMap.get(q.id) ?? [])),
    leads: rawLeads.map((l) => ({
      id: l.id,
      source: l.source,
      status: l.status,
      firstName: l.firstName,
      lastName: l.lastName,
      email: l.email,
      phone: l.phone,
      notes: l.notes,
      assignedAt: l.assignedAt?.toISOString() ?? null,
      daysSinceCreated: daysBetween(l.created, now),
      salesOrderId: l.salesOrderId,
    })),
    staffSummaries: [],
    myStaffId: staff?.id ?? null,
    canViewAll,
    scope: "mine",
    viewingStaff: staff ? { id: staff.id, displayName: staff.displayName } : null,
    showingArchived,
  });
}
