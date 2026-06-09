// /app/src/pages/api/tickets/[id]/messages.ts
//
// Add a staff message to a ticket. A message is either a public reply
// (isInternal false -- visible on the customer's token view) or an internal
// note (isInternal true -- staff-only). The author is resolved from the session
// to the StaffMember so the thread shows who replied.

import type { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID, getAppSettings } from "@/lib/appSettings";
import { parseTicketMessageInput } from "@/lib/tickets/requestBody";
import { enqueueAndSend } from "@/lib/email/queue";
import { ticketReplyEmail } from "@/lib/email/templates";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export default requireAuthWithRole(
  ["SUPER_ADMIN", "ADMIN", "MANAGER"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method not allowed" });
    }

    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid ticket id" });

    try {
      const input = parseTicketMessageInput(req.body);
      const ticket = await prisma.ticket.findFirst({
        where: { id, organizationId: DEFAULT_ORG_ID },
        select: {
          id: true,
          submitterEmail: true,
          submitterName: true,
          ticketNumber: true,
          publicToken: true,
        },
      });
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });

      const userId = (session.user as { id?: string }).id;
      const staff = userId
        ? await prisma.staffMember.findFirst({
            where: { userId },
            select: { id: true, displayName: true },
          })
        : null;

      const message = await prisma.ticketMessage.create({
        data: {
          ticketId: id,
          authorStaffId: staff?.id ?? null,
          authorName: staff?.displayName ?? session.user?.name ?? null,
          body: input.body,
          isInternal: input.isInternal ?? false,
        },
      });

      // Touch the ticket so the queue's "last activity" reflects the reply.
      await prisma.ticket.update({
        where: { id },
        data: { updatedBy: session.user?.email ?? null },
      });

      // Email the submitter on a public reply (never on an internal note).
      if (!message.isInternal && ticket.submitterEmail) {
        const settings = await getAppSettings();
        const base = (process.env.NEXTAUTH_URL ?? "").replace(/\/+$/, "");
        const reply = ticketReplyEmail({
          appName: settings.appName,
          submitterName: ticket.submitterName,
          ticketNumber: ticket.ticketNumber,
          subject: "",
          statusUrl: `${base}/support/${ticket.publicToken}`,
          messageBody: input.body,
        });
        enqueueAndSend({
          to: ticket.submitterEmail,
          subject: reply.subject,
          html: reply.html,
          templateKey: "ticket-reply",
          createdBy: session.user?.email ?? null,
        });
      }

      return res.status(201).json({ message });
    } catch (err: unknown) {
      logError("Ticket message create failed", err);
      return res.status(400).json({ error: getErrorMessage(err, "Could not add message") });
    }
  },
);
