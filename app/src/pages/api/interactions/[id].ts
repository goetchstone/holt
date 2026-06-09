// /app/src/pages/api/interactions/[id].ts

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
    return res.status(400).json({ error: "Invalid interaction id" });
  }

  if (req.method === "GET") {
    try {
      const interaction = await prisma.customerInteraction.findUnique({
        where: { id },
        include: {
          staffMember: { select: { id: true, displayName: true, role: true } },
          customer: {
            include: { addresses: true },
          },
          salesOrder: {
            include: {
              lineItems: true,
            },
          },
        },
      });

      if (!interaction) {
        return res.status(404).json({ error: "Interaction not found" });
      }

      // Convert Decimal fields on salesOrder and lineItems
      const result = {
        ...interaction,
        salesOrder: interaction.salesOrder
          ? {
              ...interaction.salesOrder,
              totalTax: interaction.salesOrder.totalTax
                ? Number(interaction.salesOrder.totalTax)
                : null,
              totalPaid: interaction.salesOrder.totalPaid
                ? Number(interaction.salesOrder.totalPaid)
                : null,
              lineItems: interaction.salesOrder.lineItems.map((li) => ({
                ...li,
                netPrice: li.netPrice ? Number(li.netPrice) : null,
                cost: li.cost ? Number(li.cost) : null,
                vatAmount: li.vatAmount ? Number(li.vatAmount) : null,
              })),
            }
          : null,
      };

      return res.json(result);
    } catch (err: unknown) {
      logError("Failed to fetch interaction", err);
      return res.status(500).json({ error: "Failed to fetch interaction" });
    }
  }

  if (req.method === "PUT") {
    try {
      const existing = await prisma.customerInteraction.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: "Interaction not found" });
      }

      const data: Record<string, unknown> = { ...req.body, updatedBy: userEmail };

      // Auto-set endedAt when outcome is provided and endedAt was not already set
      if (data.outcome && !existing.endedAt && !data.endedAt) {
        data.endedAt = new Date();
      }

      // Auto-set endedAt when isActive transitions to false
      if (data.isActive === false && existing.isActive && !existing.endedAt && !data.endedAt) {
        data.endedAt = new Date();
      }

      const updated = await prisma.customerInteraction.update({
        where: { id },
        data,
        include: {
          staffMember: { select: { id: true, displayName: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
          salesOrder: { select: { id: true, orderno: true } },
        },
      });

      return res.json(updated);
    } catch (err: unknown) {
      logError("Failed to update interaction", err);
      return res.status(500).json({ error: "Failed to update interaction" });
    }
  }

  if (req.method === "DELETE") {
    try {
      const existing = await prisma.customerInteraction.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ error: "Interaction not found" });
      }

      if (existing.salesOrderId) {
        return res.status(400).json({
          error: "Cannot delete interaction with a linked sales order",
        });
      }

      await prisma.customerInteraction.delete({ where: { id } });
      return res.status(204).end();
    } catch (err: unknown) {
      logError("Failed to delete interaction", err);
      return res.status(500).json({ error: "Failed to delete interaction" });
    }
  }

  res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}
