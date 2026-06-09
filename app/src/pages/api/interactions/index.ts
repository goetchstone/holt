// /app/src/pages/api/interactions/index.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const userEmail = session.user.email;

  if (req.method === "GET") {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 25;
    const skip = (page - 1) * limit;

    const where: Prisma.CustomerInteractionWhereInput = {};

    if (req.query.staffMemberId) {
      where.staffMemberId = Number.parseInt(req.query.staffMemberId as string);
    }
    if (req.query.customerId) {
      where.customerId = Number.parseInt(req.query.customerId as string);
    }
    if (req.query.storeLocation) {
      where.storeLocation = req.query.storeLocation as string;
    }
    if (req.query.isActive !== undefined) {
      where.isActive = req.query.isActive === "true";
    }
    if (req.query.source) {
      where.source = req.query.source as string;
    }

    try {
      const [interactions, total] = await Promise.all([
        prisma.customerInteraction.findMany({
          where,
          skip,
          take: limit,
          orderBy: { startedAt: "desc" },
          include: {
            staffMember: { select: { id: true, displayName: true } },
            customer: { select: { id: true, firstName: true, lastName: true } },
            salesOrder: { select: { id: true, orderno: true } },
          },
        }),
        prisma.customerInteraction.count({ where }),
      ]);

      return res.json({
        data: interactions,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err: unknown) {
      logError("Failed to fetch interactions", err);
      return res.status(500).json({ error: "Failed to fetch interactions" });
    }
  }

  if (req.method === "POST") {
    const { staffMemberId, storeLocation, source, customerId, notes } = req.body;

    if (!staffMemberId || !storeLocation) {
      return res.status(400).json({ error: "staffMemberId and storeLocation are required" });
    }

    try {
      const interaction = await prisma.customerInteraction.create({
        data: {
          staffMemberId,
          storeLocation,
          source: source || "WALK_IN",
          customerId: customerId || null,
          notes: notes || null,
          isActive: true,
          createdBy: userEmail,
        },
        include: {
          staffMember: { select: { id: true, displayName: true } },
          customer: { select: { id: true, firstName: true, lastName: true } },
        },
      });

      return res.status(201).json(interaction);
    } catch (err: unknown) {
      logError("Failed to create interaction", err);
      return res.status(500).json({ error: "Failed to create interaction" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}
