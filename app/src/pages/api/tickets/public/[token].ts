// /app/src/pages/api/tickets/public/[token].ts
//
// No-login public ticket view, keyed by the ticket's stable publicToken.
//   GET  -- status + the public (non-internal) message thread.
//   POST -- the customer adds a reply; a reply on a WAITING/RESOLVED ticket
//           reopens it so it returns to the staff queue.
// Internal notes never leave the building here -- the query filters them out.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { parseTicketMessageInput } from "@/lib/tickets/requestBody";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

const limiter = rateLimit({ windowMs: 60_000, maxRequests: 5 });

async function handleGet(token: string, res: NextApiResponse) {
  const ticket = await prisma.ticket.findFirst({
    where: { publicToken: token },
    select: {
      ticketNumber: true,
      subject: true,
      status: true,
      priority: true,
      submitterName: true,
      created: true,
      messages: {
        where: { isInternal: false },
        orderBy: { created: "asc" },
        select: { id: true, body: true, created: true, authorStaffId: true, authorName: true },
      },
      attachments: {
        orderBy: { created: "asc" },
        select: { id: true, filename: true, url: true, uploadedBy: true, created: true },
      },
    },
  });
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });

  // Present staff replies as "Support" and never expose internal staff identity.
  const messages = ticket.messages.map((m) => ({
    id: m.id,
    body: m.body,
    created: m.created,
    author: m.authorStaffId ? "Support" : (m.authorName ?? "You"),
    fromStaff: m.authorStaffId != null,
  }));

  return res.status(200).json({
    ticket: {
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      submitterName: ticket.submitterName,
      created: ticket.created,
      messages,
      attachments: ticket.attachments,
    },
  });
}

const handlePost = limiter(async (req: NextApiRequest, res: NextApiResponse) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  try {
    const input = parseTicketMessageInput(req.body);
    const ticket = await prisma.ticket.findFirst({
      where: { publicToken: token },
      select: { id: true, status: true, submitterName: true },
    });
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });

    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorName: ticket.submitterName ?? "Customer",
        body: input.body,
        isInternal: false, // public reply is never an internal note
      },
    });

    // A customer reply on a parked ticket pulls it back into the queue.
    const reopen = ticket.status === "WAITING_ON_CUSTOMER" || ticket.status === "RESOLVED";
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: reopen
        ? { status: "OPEN", resolvedAt: null, updatedBy: "customer" }
        : { updatedBy: "customer" },
    });

    return res.status(201).json({ ok: true });
  } catch (err: unknown) {
    logError("Public ticket reply failed", err);
    return res.status(400).json({ error: getErrorMessage(err, "Could not send your reply") });
  }
});

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token) return res.status(400).json({ error: "Missing token" });
  if (req.method === "GET") return handleGet(token, res);
  if (req.method === "POST") return handlePost(req, res);
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: "Method not allowed" });
}
