// /app/src/pages/api/tickets/index.ts
//
// Helpdesk tickets collection.
//   POST (public) -- open a ticket from the public /support form. Rate-limited;
//                    the first message is stored as a non-internal TicketMessage.
//   GET  (staff)  -- back-office queue with status/assignee filters + search.
// Method dispatch at the top mirrors pages/api/bookings/index.ts: GET runs
// through requireAuthWithRole, POST through the public rate limiter.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { rateLimit } from "@/lib/rateLimit";
import { enqueueAndSend } from "@/lib/email/queue";
import { ticketReceivedEmail } from "@/lib/email/templates";
import { buildSearchFilter } from "@/lib/buildSearchFilter";
import { parseTicketCreateInput } from "@/lib/tickets/requestBody";
import { generateTicketNumber } from "@/lib/tickets/numbering";
import { generateTicketToken } from "@/lib/tickets/token";
import { TICKET_STATUS_VALUES, isOpenTicketStatus } from "@/lib/tickets/ticketContract";
import type { TicketStatusValue } from "@/lib/tickets/ticketContract";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

const STAFF_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER"];
const OPEN_STATUSES = TICKET_STATUS_VALUES.filter((s) => isOpenTicketStatus(s));
const limiter = rateLimit({ windowMs: 60_000, maxRequests: 5 });

const listTickets = requireAuthWithRole(
  STAFF_ROLES,
  async (req: NextApiRequest, res: NextApiResponse) => {
    const filters: Prisma.TicketWhereInput = { organizationId: DEFAULT_ORG_ID };

    const status = typeof req.query.status === "string" ? req.query.status : "";
    if (status === "open") {
      filters.status = { in: OPEN_STATUSES };
    } else if (TICKET_STATUS_VALUES.includes(status as TicketStatusValue)) {
      filters.status = status as TicketStatusValue;
    }

    const assigned = typeof req.query.assignedToId === "string" ? req.query.assignedToId : "";
    if (assigned === "unassigned") {
      filters.assignedToId = null;
    } else if (assigned && Number.isFinite(Number(assigned))) {
      filters.assignedToId = Number(assigned);
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const searchFilter = q
      ? buildSearchFilter(q, ["ticketNumber", "subject", "submitterName", "submitterEmail"])
      : null;
    const where: Prisma.TicketWhereInput = searchFilter
      ? { AND: [filters, searchFilter] }
      : filters;

    const tickets = await prisma.ticket.findMany({
      where,
      orderBy: { created: "desc" },
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        priority: true,
        submitterName: true,
        submitterEmail: true,
        created: true,
        updated: true,
        assignedTo: { select: { id: true, displayName: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { messages: true } },
      },
    });
    return res.status(200).json({ tickets });
  },
);

const createTicket = limiter(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    const input = parseTicketCreateInput(req.body);
    const [ticketNumber, publicToken] = [await generateTicketNumber(), generateTicketToken()];

    const ticket = await prisma.ticket.create({
      data: {
        organizationId: DEFAULT_ORG_ID,
        ticketNumber,
        publicToken,
        submitterName: input.submitterName,
        submitterEmail: input.submitterEmail,
        subject: input.subject,
        priority: input.priority ?? "MEDIUM",
        status: "OPEN",
        createdBy: input.submitterEmail,
        messages: {
          create: {
            authorName: input.submitterName,
            body: input.body,
            isInternal: false,
          },
        },
      },
      select: { ticketNumber: true, publicToken: true },
    });

    // Best-effort "we got your request" email with the status link.
    const settings = await getAppSettings();
    const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "");
    const received = ticketReceivedEmail({
      appName: settings.appName,
      submitterName: input.submitterName,
      ticketNumber: ticket.ticketNumber,
      subject: input.subject,
      statusUrl: `${base}/support/${ticket.publicToken}`,
    });
    enqueueAndSend({
      to: input.submitterEmail,
      subject: received.subject,
      html: received.html,
      templateKey: "ticket-received",
      createdBy: input.submitterEmail,
    });

    return res.status(201).json({ ticket });
  } catch (err: unknown) {
    logError("Ticket create failed", err);
    return res.status(400).json({ error: getErrorMessage(err, "Could not submit your request") });
  }
});

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") return listTickets(req, res);
  if (req.method === "POST") return createTicket(req, res);
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: "Method not allowed" });
}
