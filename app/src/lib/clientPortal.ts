// /app/src/lib/clientPortal.ts
//
// Data assembly for the consultancy client portal (feature flag
// `clientPortal`): everything one customer sees in their no-login hub —
// upcoming/recent appointments (bookings matched by their email), authored
// invoices with open balances, and helpdesk tickets (linked by customerId or
// submitter email) with their existing status-page tokens. Read-only; the
// only portal mutation is the Stripe pay-link POST, which reuses the billing
// service.

import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";

export interface ClientPortalData {
  customerName: string;
  appointments: {
    id: number;
    serviceName: string | null;
    startsAt: string;
    endsAt: string;
    status: string;
  }[];
  invoices: {
    id: number;
    invoiceNo: string;
    invoiceDate: string;
    dueDate: string | null;
    status: string;
    total: number;
    openBalance: number;
  }[];
  tickets: {
    ticketNumber: string;
    subject: string;
    status: string;
    created: string;
    statusToken: string;
  }[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function getClientPortalData(customerId: number): Promise<ClientPortalData | null> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!customer) return null;

  const email = customer.email?.trim() || null;

  const [bookings, invoices, tickets] = await Promise.all([
    email
      ? prisma.booking.findMany({
          where: {
            organizationId: DEFAULT_ORG_ID,
            customerEmail: { equals: email, mode: "insensitive" },
            status: { not: "CANCELLED" },
          },
          orderBy: { startsAt: "desc" },
          take: 20,
          select: {
            id: true,
            serviceType: true,
            startsAt: true,
            endsAt: true,
            status: true,
            service: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    prisma.invoice.findMany({
      where: {
        organizationId: DEFAULT_ORG_ID,
        customerId,
        status: { in: ["ISSUED", "PAID"] },
      },
      orderBy: { id: "desc" },
      take: 50,
      select: {
        id: true,
        invoiceNo: true,
        invoiceDate: true,
        dueDate: true,
        status: true,
        total: true,
        applications: { select: { amountApplied: true } },
      },
    }),
    prisma.ticket.findMany({
      where: {
        organizationId: DEFAULT_ORG_ID,
        OR: [
          { customerId },
          ...(email ? [{ submitterEmail: { equals: email, mode: "insensitive" as const } }] : []),
        ],
      },
      orderBy: { id: "desc" },
      take: 20,
      select: {
        ticketNumber: true,
        subject: true,
        status: true,
        created: true,
        publicToken: true,
      },
    }),
  ]);

  return {
    customerName: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "Client",
    appointments: bookings.map((b) => ({
      id: b.id,
      serviceName: b.service?.name ?? b.serviceType,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      status: String(b.status),
    })),
    invoices: invoices.map((inv) => {
      const total = inv.total === null ? 0 : Number(inv.total);
      let applied = 0;
      for (const a of inv.applications) applied += Number(a.amountApplied);
      return {
        id: inv.id,
        invoiceNo: inv.invoiceNo,
        invoiceDate: inv.invoiceDate.toISOString(),
        dueDate: inv.dueDate?.toISOString() ?? null,
        status: String(inv.status),
        total,
        openBalance: round2(total - applied),
      };
    }),
    tickets: tickets.map((t) => ({
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      status: String(t.status),
      created: t.created.toISOString(),
      statusToken: t.publicToken,
    })),
  };
}
