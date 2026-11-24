// /app/src/pages/api/tickets/[id].ts
//
// Single ticket (staff), on "View service" (service.read), the key of the
// ticket page. GET returns the full thread incl. internal notes; PATCH applies
// a triage change (status/priority/assignee/subject) with a validated status
// transition and resolvedAt bookkeeping, and also needs "Work service"
// (service.write), like replying and attaching a file.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { parseTicketUpdateInput } from "@/lib/tickets/requestBody";
import { isValidTicketTransition, isResolvedTicketStatus } from "@/lib/tickets/ticketContract";
import type { TicketStatusValue } from "@/lib/tickets/ticketContract";
import { getErrorMessage } from "@/lib/toastError";
import { logError } from "@/lib/logger";

export default requirePermission(
  "service.read",
  async (req: NextApiRequest, res: NextApiResponse, session, access) => {
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid ticket id" });

    if (req.method === "GET") {
      const ticket = await prisma.ticket.findFirst({
        where: { id, organizationId: DEFAULT_ORG_ID },
        include: {
          assignedTo: { select: { id: true, displayName: true } },
          customer: { select: { id: true, firstName: true, lastName: true, email: true } },
          messages: {
            orderBy: { created: "asc" },
            include: { authorStaff: { select: { id: true, displayName: true } } },
          },
          attachments: { orderBy: { created: "asc" } },
        },
      });
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      return res.status(200).json({ ticket });
    }

    if (req.method === "PATCH") {
      // Answered by the gate's `also`, from the same staff read as the gate.
      if (!access.holds["service.write"]) {
        return res
          .status(403)
          .json({ error: "Updating a ticket needs the Work service permission." });
      }
      try {
        const input = parseTicketUpdateInput(req.body);
        const existing = await prisma.ticket.findFirst({
          where: { id, organizationId: DEFAULT_ORG_ID },
          select: { status: true },
        });
        if (!existing) return res.status(404).json({ error: "Ticket not found" });

        if (
          input.status &&
          !isValidTicketTransition(existing.status as TicketStatusValue, input.status)
        ) {
          return res
            .status(400)
            .json({ error: `Cannot move a ${existing.status} ticket to ${input.status}` });
        }

        const data: Prisma.TicketUpdateInput = { updatedBy: session.user?.email ?? null };
        if (input.status) {
          data.status = input.status;
          data.resolvedAt = isResolvedTicketStatus(input.status) ? new Date() : null;
        }
        if (input.priority) data.priority = input.priority;
        if (input.subject) data.subject = input.subject;
        if ("assignedToId" in input) {
          data.assignedTo =
            input.assignedToId == null
              ? { disconnect: true }
              : { connect: { id: input.assignedToId } };
        }

        const ticket = await prisma.ticket.update({ where: { id }, data });
        return res.status(200).json({ ticket });
      } catch (err: unknown) {
        logError("Ticket update failed", err);
        return res.status(400).json({ error: getErrorMessage(err, "Could not update ticket") });
      }
    }

    res.setHeader("Allow", ["GET", "PATCH"]);
    return res.status(405).json({ error: "Method not allowed" });
  },
  { also: ["service.write"] },
);
