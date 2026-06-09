// /app/src/pages/api/tills/[id]/summary.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { calculateTillExpected } from "@/lib/paymentService";
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
      select: {
        openingCash: true,
        expectedCash: true,
        actualCash: true,
        variance: true,
        _count: { select: { payments: true } },
        counts: {
          select: {
            denomination: true,
            quantity: true,
            amount: true,
            isOpening: true,
          },
        },
      },
    });
    if (!till) return res.status(404).json({ error: "Till not found" });

    const expected = await calculateTillExpected(tillId);

    const openingCounts = till.counts
      .filter((c) => c.isOpening)
      .map((c) => ({ ...c, amount: Number(c.amount) }));
    const closingCounts = till.counts
      .filter((c) => !c.isOpening)
      .map((c) => ({ ...c, amount: Number(c.amount) }));

    return res.status(200).json({
      ...expected,
      openingCash: Number(till.openingCash),
      actualCash: till.actualCash ? Number(till.actualCash) : null,
      variance: till.variance ? Number(till.variance) : null,
      paymentCount: till._count.payments,
      openingCounts,
      closingCounts,
    });
  } catch (err) {
    logError("GET /tills/[id]/summary error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
