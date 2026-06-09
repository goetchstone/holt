// /app/src/pages/api/tills/[id].ts

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

  const tillId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(tillId)) return res.status(400).json({ error: "Invalid till ID" });

  try {
    const till = await prisma.till.findUnique({
      where: { id: tillId },
      include: {
        register: {
          include: { storeLocation: { select: { name: true, code: true } } },
        },
        openedBy: { select: { displayName: true } },
        closedBy: { select: { displayName: true } },
        counts: { orderBy: { denomination: "asc" } },
        payments: {
          orderBy: { paymentDate: "desc" },
          select: {
            id: true,
            paymentDate: true,
            paymentType: true,
            method: true,
            paymentAmount: true,
            status: true,
            isRefund: true,
            staffMember: { select: { displayName: true } },
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
