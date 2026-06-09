// /app/src/pages/api/leads/[id].ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const userEmail = session.user.email;
  const id = Number.parseInt(req.query.id as string);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid lead id" });
  }

  if (req.method === "GET") {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id },
        include: {
          customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              primaryDesignerId: true,
            },
          },
          assignedTo: {
            select: { id: true, displayName: true },
          },
          salesOrder: {
            select: { id: true, orderno: true, status: true },
          },
        },
      });

      if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
      }

      return res.json(lead);
    } catch (err) {
      logError("Failed to fetch lead", err);
      return res.status(500).json({ error: "Failed to fetch lead" });
    }
  }

  if (req.method === "PUT") {
    try {
      const existing = await prisma.lead.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: "Lead not found" });
      }

      const {
        assignedToId,
        status,
        notes,
        salesOrderId,
        firstName,
        lastName,
        email,
        phone,
        pinned,
      } = req.body;

      const data: Record<string, unknown> = {
        updatedBy: userEmail,
        // Bump lastActionAt on ANY meaningful edit so the 30-day aging
        // timer restarts. This is the canonical "someone did something
        // with this lead" signal used by the housekeeping job.
        lastActionAt: new Date(),
      };

      if (assignedToId !== undefined) {
        data.assignedToId = assignedToId;
        if (assignedToId && !existing.assignedAt) {
          data.assignedAt = new Date();
        }
        // Auto-advance to ASSIGNED when assigning from NEW
        if (assignedToId && existing.status === "NEW") {
          data.status = "ASSIGNED";
        }
      }

      if (status !== undefined) data.status = status;
      if (notes !== undefined) data.notes = notes;
      if (salesOrderId !== undefined) data.salesOrderId = salesOrderId;
      if (firstName !== undefined) data.firstName = firstName;
      if (lastName !== undefined) data.lastName = lastName;
      if (email !== undefined) data.email = email;
      if (phone !== undefined) data.phone = phone;
      if (pinned !== undefined && typeof pinned === "boolean") data.pinned = pinned;

      // Auto-convert when linking a sales order
      if (salesOrderId && existing.status !== "CONVERTED") {
        data.status = "CONVERTED";
      }

      const updated = await prisma.lead.update({
        where: { id },
        data,
        include: {
          customer: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          assignedTo: {
            select: { id: true, displayName: true },
          },
          salesOrder: {
            select: { id: true, orderno: true, status: true },
          },
        },
      });

      return res.json(updated);
    } catch (err) {
      logError("Failed to update lead", err);
      return res.status(500).json({ error: "Failed to update lead" });
    }
  }

  if (req.method === "DELETE") {
    const role = (session as any)?.role;
    if (role !== "MANAGER" && role !== "ADMIN") {
      return res.status(403).json({ error: "Only managers can delete leads" });
    }

    try {
      const existing = await prisma.lead.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: "Lead not found" });
      }

      await prisma.lead.delete({ where: { id } });
      return res.json({ success: true });
    } catch (err) {
      logError("Failed to delete lead", err);
      return res.status(500).json({ error: "Failed to delete lead" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}
