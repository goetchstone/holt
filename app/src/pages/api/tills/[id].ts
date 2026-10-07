// /app/src/pages/api/tills/[id].ts
//
// One till's detail for /app/sales/till/[id]. Gated on the page's own key
// (sales.read, "View orders"), so whoever the owner lets open the page can
// load it and nobody else can. Selects exactly what TillDetailView renders.

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const tillId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(tillId)) return res.status(400).json({ error: "Invalid till ID" });

  try {
    const till = await prisma.till.findUnique({
      where: { id: tillId },
      select: {
        id: true,
        status: true,
        openedAt: true,
        closedAt: true,
        openingCash: true,
        expectedCash: true,
        actualCash: true,
        variance: true,
        notes: true,
        register: { select: { name: true, storeLocation: { select: { name: true } } } },
        openedBy: { select: { displayName: true } },
        closedBy: { select: { displayName: true } },
        counts: {
          orderBy: { denomination: "asc" },
          select: { denomination: true, quantity: true, amount: true, isOpening: true },
        },
        payments: {
          orderBy: { paymentDate: "desc" },
          select: {
            id: true,
            paymentDate: true,
            method: true,
            paymentAmount: true,
            isRefund: true,
            salesOrder: { select: { orderno: true } },
          },
        },
      },
    });

    if (!till) return res.status(404).json({ error: "Till not found" });

    return res.status(200).json({
      ...till,
      openingCash: Number(till.openingCash),
      expectedCash: till.expectedCash ? Number(till.expectedCash) : null,
      actualCash: till.actualCash ? Number(till.actualCash) : null,
      variance: till.variance ? Number(till.variance) : null,
      counts: till.counts.map((c) => ({ ...c, amount: Number(c.amount) })),
      payments: till.payments.map((p) => ({
        ...p,
        paymentAmount: Number(p.paymentAmount),
      })),
    });
  } catch (err) {
    logError("GET /tills/[id] error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export default requirePermission("sales.read", handler);
