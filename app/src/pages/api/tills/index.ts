// /app/src/pages/api/tills/index.ts
//
// The till list behind two screens: the Till screen (/app/sales/till,
// sales.read) and the Till Reconciliation report (reporting.read). Either key
// admits the caller, so granting a role either screen in Roles grants its data.
// The POS does not read this list; it finds its register's open till through
// GET /api/registers/[id] (pos.operate), so "Operate register" alone does not
// open every till's history. Selects what those two screens render.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
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
        select: {
          id: true,
          registerId: true,
          status: true,
          openedAt: true,
          closedAt: true,
          openingCash: true,
          expectedCash: true,
          actualCash: true,
          variance: true,
          register: {
            select: { name: true, storeLocation: { select: { name: true, code: true } } },
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

export default requirePermission({ anyOf: ["sales.read", "reporting.read"] }, handler);
