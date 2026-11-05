// /app/src/pages/api/sales/pipeline/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { getAppSettings, getBusinessTimeZone } from "@/lib/appSettings";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { calculateLeadScore, leadScoreInputFromCustomer, type LeadTier } from "@/lib/leadScore";
import { detectPossibleDuplicates } from "@/lib/duplicateQuotes";
import {
  fetchClientBackground,
  fetchClientNotesByCustomer,
  type ClientNoteRow,
} from "@/lib/pipelineClientQuery";
import {
  callablePhone,
  isCashSaleCustomer,
  mailableEmail,
  summarizeQuoteLines,
  type ClientBackground,
  type PipelineClientHistory,
} from "@/lib/pipelineClient";
import {
  findQuoteOwnerId,
  isQuoteInStaffPipeline,
  isQuoteOwned,
  type PipelineStaff,
} from "@/lib/clientOwnership";
import { getFollowUpState, needsAttention, type FollowUpState } from "@/lib/pipelineFollowUp";
import {
  toClientProfileView,
  type ClientProfileChoices,
  type ClientProfileView,
} from "@/lib/clientProfile";
import { isNoteSource, NOTE_SOURCES } from "@/lib/interactionSources";
import { pipelineSearchWhere, staffPipelineWhere } from "@/lib/pipelineSearch";
import {
  businessDayKey,
  daysBetween as daysBetweenKeys,
  dbDateToDayKey,
} from "@/lib/reports/businessDay";

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
    phone: string | null;
    email: string | null;
    isCashSale: boolean;
    history: PipelineClientHistory | null; // null for a Cash Sale placeholder
    profile: ClientProfileView | null;
  } | null;
  salesperson: string | null;
  storeLocation: string | null;
  lineItemSummary: string;
  totalAmount: number;
  lastInteractionAt: string | null;
  daysSinceCreated: number;
  daysSinceContact: number | null;
  followUpState: FollowUpState;
  // Nothing priced on it yet.
  isPlaceholderQuote: boolean;
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

export type PipelineScope = "mine" | "all" | "staff" | "search";

export interface PipelineResponse {
  quotes: PipelineQuote[];
  leads: PipelineLead[];
  staffSummaries: StaffSummary[];
  myStaffId: number | null;
  canViewAll: boolean;
  scope: PipelineScope;
  viewingStaff: { id: number; displayName: string } | null;
  showingArchived: boolean;
  today: string; // YYYY-MM-DD, the store's day
  profileChoices: ClientProfileChoices;
  // Open quotes in nobody's pipeline. Only sent on the All Staff page.
  unassigned?: { clientCount: number; quoteCount: number; totalValue: number };
}

// Whole days between two instants, on the store's calendar. Comparing timestamps instead
// would be off by one around midnight.
function daysSince(date: Date | string | null, now: Date, timeZone: string): number {
  if (!date) return 0;
  const from = typeof date === "string" ? new Date(date) : date;
  return Math.max(
    0,
    daysBetweenKeys(businessDayKey(from, timeZone), businessDayKey(now, timeZone)),
  );
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
      phone: true,
      email: true,
      lifetimeSpend: true,
      lifetimeOrderCount: true,
      customerLevel: true,
      peakCustomerLevel: true,
      departmentCount: true,
      lastOrderDate: true,
      primaryDesignerId: true,
      clientProfile: true,
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

type RawQuote = Prisma.SalesOrderGetPayload<{ select: typeof QUOTE_SELECT }>;

interface QuoteMapContext {
  now: Date;
  today: string;
  timeZone: string;
  visibility: RoleVisibility;
  notesByCustomer: Map<number, ClientNoteRow[]>;
  backgroundByCustomer: Map<number, ClientBackground>;
}

function mapCustomer(
  customer: NonNullable<RawQuote["customer"]>,
  context: QuoteMapContext,
): PipelineQuote["customer"] {
  const wf = customer.windfallEnrichment;
  const score = calculateLeadScore(leadScoreInputFromCustomer(customer));
  const isCashSale = isCashSaleCustomer(customer);
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    ...(context.visibility.canSeeWealth ? { wealthTier: wf?.wealthTier ?? null } : {}),
    leadTier: score.tier,
    ...(context.visibility.canSeeScore ? { leadScore: score.score } : {}),
    phone: isCashSale ? null : callablePhone(customer.phone),
    email: isCashSale ? null : mailableEmail(customer.email),
    isCashSale,
    history: isCashSale
      ? null
      : {
          lifetimeSpend: Number(customer.lifetimeSpend ?? 0),
          orderCount: customer.lifetimeOrderCount ?? 0,
          lastOrderDate: customer.lastOrderDate?.toISOString() ?? null,
          lastPurchase: null,
          brands: [],
          locations: [],
          ...context.backgroundByCustomer.get(customer.id),
        },
    profile:
      !isCashSale && customer.clientProfile ? toClientProfileView(customer.clientProfile) : null,
  };
}

function mapQuote(
  q: RawQuote,
  possibleDuplicateOf: { id: number; orderno: string }[],
  context: QuoteMapContext,
): PipelineQuote {
  const { now, today, timeZone, notesByCustomer } = context;
  const totalAmount = q.lineItems.reduce((s, li) => s + Number(li.netPrice), 0);
  const lines = summarizeQuoteLines(q.lineItems);
  // A client note written on one quote shows on all of that client's quotes. A note is
  // something we know, not a time we reached them, so it doesn't move days-since-contact.
  const quoteInteractionIds = new Set(q.interactions.map((i) => i.id));
  const clientNotes = q.customer ? (notesByCustomer.get(q.customer.id) ?? []) : [];
  const entries = [
    ...q.interactions,
    ...clientNotes.filter((note) => !quoteInteractionIds.has(note.id)),
  ].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  const lastContactAt = entries.find((i) => !isNoteSource(i.source))?.startedAt ?? null;
  const refDate = q.quoteDate ?? q.orderDate;
  const daysSinceCreated = refDate ? daysSince(refDate, now, timeZone) : 0;
  const daysSinceContact = lastContactAt ? daysSince(lastContactAt, now, timeZone) : null;
  const customer = q.customer ? mapCustomer(q.customer, context) : null;
  return {
    id: q.id,
    orderno: q.orderno,
    orderDate: q.orderDate?.toISOString() ?? null,
    quoteDate: q.quoteDate?.toISOString() ?? null,
    customer,
    salesperson: q.salesperson ?? null,
    storeLocation: q.storeLocation ?? null,
    lineItemSummary: lines.summary,
    totalAmount: Math.round(totalAmount * 100) / 100,
    lastInteractionAt: lastContactAt?.toISOString() ?? null,
    daysSinceCreated,
    daysSinceContact,
    followUpState: getFollowUpState({
      nextFollowUpDate: customer?.profile?.nextFollowUpDate ?? null,
      lastContactDate: lastContactAt ? businessDayKey(lastContactAt, timeZone) : null,
      daysSinceContact,
      daysSinceCreated,
      today,
    }),
    isPlaceholderQuote: lines.isPlaceholder,
    pipelineArchivedAt: q.pipelineArchivedAt?.toISOString() ?? null,
    pipelineNote: q.pipelineNote ?? null,
    archiveReason: q.archiveReason ?? null,
    replacedByOrderId: q.replacedByOrderId ?? null,
    replacedByOrderno: q.replacedByOrder?.orderno ?? null,
    possibleDuplicateOf,
    interactions: entries.map((i) => ({
      id: i.id,
      source: i.source,
      notes: i.notes,
      startedAt: i.startedAt.toISOString(),
      staffName: i.staffMember.displayName,
    })),
  };
}

/** staffPipelineWhere also matches an assigned client's other quotes, so this drops the
 *  ones an active salesperson has. */
async function keepStaffQuotes(rawQuotes: RawQuote[], staff: PipelineStaff): Promise<RawQuote[]> {
  const activeStaff = await prisma.staffMember.findMany({
    where: { isActive: true },
    select: { id: true, displayName: true },
  });
  return rawQuotes.filter((quote) => isQuoteInStaffPipeline(quote, staff, activeStaff));
}

async function mapQuotes(
  rawQuotes: RawQuote[],
  base: Pick<QuoteMapContext, "now" | "today" | "timeZone" | "visibility">,
): Promise<PipelineQuote[]> {
  const customers = rawQuotes.flatMap((q) => (q.customer ? [q.customer] : []));
  // A Cash Sale customer holds unrelated people's orders, so it has no history.
  const clientIds = [...new Set(customers.filter((c) => !isCashSaleCustomer(c)).map((c) => c.id))];
  const [notesByCustomer, backgroundByCustomer] = await Promise.all([
    fetchClientNotesByCustomer(clientIds),
    fetchClientBackground(clientIds),
  ]);
  const dupMap = detectPossibleDuplicates(rawQuotes);
  const context = { ...base, notesByCustomer, backgroundByCustomer };
  return rawQuotes.map((q) => mapQuote(q, dupMap.get(q.id) ?? [], context));
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PipelineResponse | { error: string }>,
  session: Session,
) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

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
  const [timeZone, settings] = await Promise.all([getBusinessTimeZone(), getAppSettings()]);
  const today = businessDayKey(now, timeZone);
  const profileChoices = settings.clientProfileChoices;
  const quoteMapBase = { now, today, timeZone, visibility };
  const openLeadStatuses = ["NEW", "ASSIGNED", "CONTACTED"] as const;

  // Archived filter applied to all quote queries
  const archiveFilter = showingArchived
    ? { pipelineArchivedAt: { not: null as null } }
    : { pipelineArchivedAt: null };

  // ── search: open quotes by name or notes. Takes precedence over scope: a manager
  // searches every open quote; a salesperson searches only their own.
  const searchTerm = typeof req.query.search === "string" ? req.query.search.trim() : "";
  if (searchTerm) {
    const rawQuotes = await prisma.salesOrder.findMany({
      where: pipelineSearchWhere(searchTerm, {
        canViewAll,
        staffId: staff.id,
        staffName: staff.displayName,
        includeArchived: showingArchived,
      }),
      orderBy: { orderDate: "desc" },
      take: 200,
      select: QUOTE_SELECT,
    });
    const visibleQuotes = canViewAll ? rawQuotes : await keepStaffQuotes(rawQuotes, staff);
    return res.status(200).json({
      quotes: await mapQuotes(visibleQuotes, quoteMapBase),
      leads: [],
      staffSummaries: [],
      myStaffId: staff.id,
      canViewAll,
      scope: "search",
      viewingStaff: null,
      showingArchived,
      today,
      profileChoices,
    });
  }

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
          // Same rule as the cards: a note is not contact.
          interactions: {
            where: { source: { notIn: [...NOTE_SOURCES] } },
            select: { startedAt: true },
            orderBy: { startedAt: "desc" },
            take: 1,
          },
          customerId: true,
          customer: {
            select: {
              firstName: true,
              lastName: true,
              primaryDesignerId: true,
              clientProfile: { select: { nextFollowUpDate: true } },
            },
          },
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

    const unassignedClientIds = new Set<number>();
    let unassignedQuoteCount = 0;
    let unassignedValue = 0;

    for (const q of allQuotesRaw) {
      const total = q.lineItems.reduce((sum, li) => sum + Number(li.netPrice), 0);

      // In nobody's pipeline. Cash Sale isn't a client a manager can assign.
      if (!isQuoteOwned(q, allActiveStaff)) {
        if (q.customerId !== null && q.customer && !isCashSaleCustomer(q.customer)) {
          unassignedClientIds.add(q.customerId);
          unassignedQuoteCount++;
          unassignedValue += total;
        }
        continue;
      }

      const staffId = findQuoteOwnerId(q, allActiveStaff);
      if (!staffId) continue;

      const refDate = q.quoteDate ?? q.orderDate;
      const daysSinceCreated = refDate ? daysSince(refDate, now, timeZone) : 0;
      const lastInteraction = q.interactions[0]?.startedAt ?? null;
      const daysSinceContact = lastInteraction ? daysSince(lastInteraction, now, timeZone) : null;
      const followUpState = getFollowUpState({
        nextFollowUpDate: dbDateToDayKey(q.customer?.clientProfile?.nextFollowUpDate),
        lastContactDate: lastInteraction ? businessDayKey(lastInteraction, timeZone) : null,
        daysSinceContact,
        daysSinceCreated,
        today,
      });

      if (!staffMetrics.has(staffId)) {
        staffMetrics.set(staffId, { quoteCount: 0, totalValue: 0, overdueCount: 0 });
      }
      const m = staffMetrics.get(staffId)!;
      m.quoteCount++;
      m.totalValue += total;
      if (needsAttention(followUpState)) m.overdueCount++;
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
      today,
      profileChoices,
      unassigned: {
        clientCount: unassignedClientIds.size,
        quoteCount: unassignedQuoteCount,
        totalValue: Math.round(unassignedValue * 100) / 100,
      },
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
        where: { status: "QUOTE", ...archiveFilter, OR: staffPipelineWhere(targetStaff) },
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

    return res.status(200).json({
      quotes: await mapQuotes(await keepStaffQuotes(rawQuotes, targetStaff), quoteMapBase),
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
        daysSinceCreated: daysSince(l.created, now, timeZone),
        salesOrderId: l.salesOrderId,
      })),
      staffSummaries: [],
      myStaffId: staff?.id ?? null,
      canViewAll,
      scope: "staff",
      viewingStaff: { id: targetStaff.id, displayName: targetStaff.displayName },
      showingArchived,
      today,
      profileChoices,
    });
  }

  // ── scope=mine (default) ─────────────────────────────────────────────────

  const quoteWhere = { status: "QUOTE" as const, ...archiveFilter, OR: staffPipelineWhere(staff) };

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

  return res.status(200).json({
    quotes: await mapQuotes(await keepStaffQuotes(rawQuotes, staff), quoteMapBase),
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
      daysSinceCreated: daysSince(l.created, now, timeZone),
      salesOrderId: l.salesOrderId,
    })),
    staffSummaries: [],
    myStaffId: staff?.id ?? null,
    canViewAll,
    scope: "mine",
    viewingStaff: staff ? { id: staff.id, displayName: staff.displayName } : null,
    showingArchived,
    today,
    profileChoices,
  });
}

// Same permission as ./[id].ts, which archives and restores the quotes this
// board lists: the pipeline is a designer/manager concern. It matches the Sales
// hub's own Pipeline card (ADMIN/MANAGER/DESIGNER), which is the only link to
// this board. The per-scope and per-field visibility checks inside the handler
// (canViewAll, wealth, lead score) are unchanged and still narrow further.
export default requirePermission("sales.lead", handler);
