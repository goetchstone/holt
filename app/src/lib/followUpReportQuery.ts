// /app/src/lib/followUpReportQuery.ts
//
// Server-only reads behind the Follow-Ups report and the morning email (GAP-36).

import { getBusinessTimeZone } from "@/lib/appSettings";
import { findFollowUpOwnerId, findQuoteOwnerId } from "@/lib/clientOwnership";
import { CONTACT_WINDOW_DAYS, type FollowUpRow, type RecentContacts } from "@/lib/followUpReport";
import { CONTACT_SOURCES } from "@/lib/interactionSources";
import { callablePhone, isCashSaleCustomer, mailableEmail } from "@/lib/pipelineClient";
import { COUNTED_QUOTE_LINE, fetchLastContactByCustomer } from "@/lib/pipelineClientQuery";
import { getClientFollowUp, getFollowUpState, needsAttention } from "@/lib/pipelineFollowUp";
import { prisma } from "@/lib/prisma";
import { businessDayKey, daysBetween, dbDateToDayKey } from "@/lib/reports/businessDay";

function fullName(customer: { firstName: string | null; lastName: string | null }): string {
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "No name";
}

/** Every client with a follow-up date on file, and who it belongs to. The value is their
 *  open quotes' counted lines (rules 31, 33). The Cash Sale customer isn't a client. */
export async function loadFollowUpRows(now: Date): Promise<FollowUpRow[]> {
  const timeZone = await getBusinessTimeZone();
  const today = businessDayKey(now, timeZone);
  const profiles = await prisma.clientProfile.findMany({
    where: { nextFollowUpDate: { not: null } },
    select: {
      customerId: true,
      nextFollowUpDate: true,
      closeLikelihood: true,
      projectTimeline: true,
      budgetRange: true,
      updatedBy: true,
      customer: {
        select: {
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          lifetimeSpend: true,
          primaryDesignerId: true,
        },
      },
    },
  });
  const customerIds = profiles.map((profile) => profile.customerId);

  const [staff, lastContacts, lastOrders, openQuotes, lastNotes] = await Promise.all([
    prisma.staffMember.findMany({
      where: { isActive: true },
      select: { id: true, displayName: true, aliases: true, email: true },
    }),
    fetchLastContactByCustomer(customerIds),
    prisma.salesOrder.findMany({
      where: { customerId: { in: customerIds }, status: { in: ["QUOTE", "ORDER", "FULFILLED"] } },
      orderBy: [{ customerId: "asc" }, { orderDate: { sort: "desc", nulls: "last" } }],
      distinct: ["customerId"],
      select: {
        customerId: true,
        salesperson: true,
        salesPersonId: true,
        splitWithId: true,
        storeLocation: true,
      },
    }),
    prisma.salesOrder.findMany({
      where: { customerId: { in: customerIds }, status: "QUOTE", pipelineArchivedAt: null },
      select: {
        customerId: true,
        lineItems: { where: COUNTED_QUOTE_LINE, select: { netPrice: true } },
      },
    }),
    prisma.customerInteraction.findMany({
      where: { customerId: { in: customerIds }, notes: { not: null } },
      orderBy: [{ customerId: "asc" }, { startedAt: "desc" }],
      distinct: ["customerId"],
      select: { customerId: true, notes: true },
    }),
  ]);

  const lastOrderByClient = new Map(lastOrders.map((order) => [order.customerId, order]));
  const lastNoteByClient = new Map(lastNotes.map((note) => [note.customerId, note.notes]));
  const staffNames = new Map(staff.map((member) => [member.id, member.displayName]));
  const quoteTotals = new Map<number, { count: number; value: number }>();
  for (const quote of openQuotes) {
    if (quote.customerId === null) continue;
    const totals = quoteTotals.get(quote.customerId) ?? { count: 0, value: 0 };
    totals.count += 1;
    totals.value += quote.lineItems.reduce((sum, line) => sum + Number(line.netPrice), 0);
    quoteTotals.set(quote.customerId, totals);
  }

  return profiles
    .filter((profile) => !isCashSaleCustomer(profile.customer))
    .map((profile): FollowUpRow => {
      const lastOrder = lastOrderByClient.get(profile.customerId);
      const lastContact = lastContacts.get(profile.customerId) ?? null;
      const lastContactDate = lastContact ? businessDayKey(lastContact, timeZone) : null;
      const nextFollowUpDate = dbDateToDayKey(profile.nextFollowUpDate) as string;
      const ownerId = findFollowUpOwnerId(
        { ...profile.customer, setByEmail: profile.updatedBy },
        lastOrder ?? null,
        staff,
      );
      const totals = quoteTotals.get(profile.customerId);
      return {
        customerId: profile.customerId,
        clientName: fullName(profile.customer),
        ownerId,
        owner: (ownerId && staffNames.get(ownerId)) || lastOrder?.salesperson || "No owner",
        store: lastOrder?.storeLocation ?? "",
        nextFollowUpDate,
        status: getClientFollowUp(nextFollowUpDate, lastContactDate, today) ?? "done",
        lastContact: lastContactDate,
        lastNote: lastNoteByClient.get(profile.customerId) ?? null,
        phone: callablePhone(profile.customer.phone),
        email: mailableEmail(profile.customer.email),
        openQuotes: totals?.count ?? 0,
        openQuoteValue: Math.round((totals?.value ?? 0) * 100) / 100,
        lifetimeSpend: Number(profile.customer.lifetimeSpend ?? 0),
        closeLikelihood: profile.closeLikelihood,
        projectTimeline: profile.projectTimeline,
        budgetRange: profile.budgetRange,
      };
    });
}

/** Contacts logged per salesperson over the window. "About the client" means logged with no
 *  quote, such as a call from My Clients. Notes aren't contacts. */
export async function loadRecentContacts(now: Date): Promise<RecentContacts[]> {
  const since = new Date(now.getTime() - CONTACT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const contacted = { startedAt: { gte: since }, source: { in: [...CONTACT_SOURCES] } };
  const [all, aboutClient] = await Promise.all([
    prisma.customerInteraction.groupBy({
      by: ["staffMemberId"],
      where: contacted,
      _count: { _all: true },
    }),
    prisma.customerInteraction.groupBy({
      by: ["staffMemberId"],
      where: { ...contacted, salesOrderId: null, customerId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const staff = await prisma.staffMember.findMany({
    where: { id: { in: all.map((row) => row.staffMemberId) } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(staff.map((member) => [member.id, member.displayName]));
  const aboutClientById = new Map(aboutClient.map((row) => [row.staffMemberId, row._count._all]));
  return all.flatMap((row) => {
    const owner = nameById.get(row.staffMemberId);
    if (!owner) return [];
    return [
      {
        owner,
        contactsLogged: row._count._all,
        aboutClientNotQuote: aboutClientById.get(row.staffMemberId) ?? 0,
      },
    ];
  });
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a || !b) return a ?? b;
  return a > b ? a : b;
}

/** Each salesperson's open quotes needing attention, by the same rules as their pipeline. */
export async function countQuotesWaitingByStaff(now: Date): Promise<Map<number, number>> {
  const timeZone = await getBusinessTimeZone();
  const today = businessDayKey(now, timeZone);
  const [activeStaff, quotes] = await Promise.all([
    prisma.staffMember.findMany({
      where: { isActive: true },
      select: { id: true, displayName: true, aliases: true },
    }),
    prisma.salesOrder.findMany({
      where: { status: "QUOTE", pipelineArchivedAt: null },
      select: {
        customerId: true,
        salesPersonId: true,
        salesperson: true,
        quoteDate: true,
        orderDate: true,
        customer: {
          select: {
            primaryDesignerId: true,
            clientProfile: { select: { nextFollowUpDate: true } },
          },
        },
        interactions: {
          where: { source: { in: [...CONTACT_SOURCES] } },
          orderBy: { startedAt: "desc" },
          take: 1,
          select: { startedAt: true },
        },
      },
    }),
  ]);
  const customerIds = quotes.flatMap((quote) => (quote.customerId ? [quote.customerId] : []));
  const clientWide = await fetchLastContactByCustomer(customerIds, { clientWideOnly: true });
  const daysAgo = (date: Date) => daysBetween(businessDayKey(date, timeZone), today);

  const waiting = new Map<number, number>();
  for (const quote of quotes) {
    const ownerId = findQuoteOwnerId(quote, activeStaff);
    if (ownerId === null) continue;
    const lastContact = laterOf(
      quote.interactions[0]?.startedAt ?? null,
      clientWide.get(quote.customerId ?? -1) ?? null,
    );
    const created = quote.quoteDate ?? quote.orderDate;
    const state = getFollowUpState({
      nextFollowUpDate: dbDateToDayKey(quote.customer?.clientProfile?.nextFollowUpDate),
      lastContactDate: lastContact ? businessDayKey(lastContact, timeZone) : null,
      daysSinceContact: lastContact ? daysAgo(lastContact) : null,
      daysSinceCreated: created ? daysAgo(created) : 0,
      today,
    });
    if (needsAttention(state)) waiting.set(ownerId, (waiting.get(ownerId) ?? 0) + 1);
  }
  return waiting;
}
