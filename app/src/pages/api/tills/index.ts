// /app/src/pages/api/tills/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const page = Number.parseInt(req.query.page as string) || 1;
    const limit = Number.parseInt(req.query.limit as string) || 20;
    const registerId = req.query.registerId
      ? Number.parseInt(req.query.registerId as string)
      : undefined;
    const storeLocationId = req.query.storeLocationId
      ? Number.parseInt(req.query.storeLocationId as string)
      : undefined;
    const status = req.query.status as string | undefined;
    const dateFrom = req.query.dateFrom as string | undefined;
    const dateTo = req.query.dateTo as string | undefined;

    const where: Record<string, unknown> = {};
    if (registerId) where.registerId = registerId;
    if (storeLocationId) where.register = { storeLocationId };
    if (status) where.status = status;
    if (dateFrom || dateTo) {
      where.openedAt = {};
      if (dateFrom) (where.openedAt as Record<string, unknown>).gte = new Date(dateFrom);
      if (dateTo) (where.openedAt as Record<string, unknown>).lte = new Date(dateTo);
    }

    const [tills, total] = await Promise.all([
      prisma.till.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { openedAt: "desc" },
        include: {
          register: {
            include: { storeLocation: { select: { name: true, code: true } } },
          },
          openedBy: { select: { displayName: true } },
          closedBy: { select: { displayName: true } },
          _count: { select: { payments: true } },
        },
      }),
      prisma.till.count({ where }),
    ]);

    return res.status(200).json({
      tills: tills.map((t) => ({
        ...t,
        openingCash: Number(t.openingCash),
        expectedCash: t.expectedCash ? Number(t.expectedCash) : null,
        actualCash: t.actualCash ? Number(t.actualCash) : null,
        variance: t.variance ? Number(t.variance) : null,
      })),
      total,
    });
  } catch (err) {
    logError("GET /tills error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
