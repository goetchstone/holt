// /app/src/pages/api/tills/[id]/close.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { calculateTillExpected } from "@/lib/paymentService";
import { logError } from "@/lib/logger";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const tillId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(tillId)) return res.status(400).json({ error: "Invalid till ID" });

  try {
    const till = await prisma.till.findUnique({ where: { id: tillId } });
    if (!till) return res.status(404).json({ error: "Till not found" });
    if (till.status !== "OPEN") {
      return res.status(400).json({ error: `Till is already ${till.status}` });
    }

    const staff = await prisma.staffMember.findFirst({
      where: { email: session.user?.email },
    });
    if (!staff) return res.status(403).json({ error: "Staff member not found" });

    const { counts, actualCash, notes } = req.body;

    if (actualCash === undefined) {
      return res.status(400).json({ error: "actualCash is required" });
    }

    const expected = await calculateTillExpected(tillId);
    const parsedActual = round2(Number.parseFloat(actualCash));
    const variance = round2(parsedActual - expected.expectedCash);

    const updated = await prisma.$transaction(async (tx) => {
      // Remove existing closing counts if re-closing. Opening counts are
      // preserved -- they belong to the open-till moment, not the close.
      await tx.tillCount.deleteMany({ where: { tillId, isOpening: false } });

      // Create denomination counts
      if (Array.isArray(counts) && counts.length > 0) {
        await tx.tillCount.createMany({
          data: counts.map((c: { denomination: string; quantity: number; amount: number }) => ({
            tillId,
            denomination: c.denomination,
            quantity: c.quantity,
            amount: round2(c.amount),
            isOpening: false,
          })),
        });
      }

      return tx.till.update({
        where: { id: tillId },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedById: staff.id,
          expectedCash: expected.expectedCash,
          actualCash: parsedActual,
          variance,
          notes: notes || null,
          updatedBy: session.user?.email || null,
        },
        include: {
          register: {
            include: { storeLocation: { select: { name: true } } },
          },
          openedBy: { select: { displayName: true } },
          closedBy: { select: { displayName: true } },
          counts: true,
        },
      });
    });

    return res.status(200).json({
      ...updated,
      openingCash: Number(updated.openingCash),
      expectedCash: Number(updated.expectedCash),
      actualCash: Number(updated.actualCash),
      variance: Number(updated.variance),
      counts: updated.counts.map((c) => ({ ...c, amount: Number(c.amount) })),
      summary: expected,
    });
  } catch (err) {
    logError("POST /tills/[id]/close error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
