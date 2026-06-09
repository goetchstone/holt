// /app/src/pages/api/registers/[id]/tills/open.ts

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

interface CountEntry {
  denomination: string;
  quantity: number;
  amount: number;
}

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

  const registerId = Number.parseInt(req.query.id as string);
  if (Number.isNaN(registerId)) return res.status(400).json({ error: "Invalid register ID" });

  try {
    const register = await prisma.register.findUnique({ where: { id: registerId } });
    if (!register) return res.status(404).json({ error: "Register not found" });
    if (!register.isActive) return res.status(400).json({ error: "Register is inactive" });

    const openTill = await prisma.till.findFirst({
      where: { registerId, status: "OPEN" },
    });
    if (openTill) {
      return res.status(409).json({ error: "A till is already open on this register" });
    }

    const staff = await prisma.staffMember.findFirst({
      where: { email: session.user?.email },
    });
    if (!staff) return res.status(403).json({ error: "Staff member not found" });

    const { openingCash = 0, counts } = req.body as {
      openingCash?: number | string;
      counts?: CountEntry[];
    };

    // If the register staff counted denominations on open, the total trumps
    // the raw openingCash field (keeps the two in sync).
    const countsArray = Array.isArray(counts) ? counts : [];
    const countedTotal = countsArray.reduce(
      (sum, c) => sum + (Number.isFinite(c.amount) ? c.amount : 0),
      0,
    );
    const cashAmount =
      countsArray.length > 0
        ? round2(countedTotal)
        : round2(Number.parseFloat(String(openingCash)) || 0);

    const till = await prisma.$transaction(async (tx) => {
      const created = await tx.till.create({
        data: {
          registerId,
          status: "OPEN",
          openedById: staff.id,
          openingCash: cashAmount,
          createdBy: session.user?.email || null,
        },
        include: {
          register: {
            include: { storeLocation: { select: { name: true } } },
          },
          openedBy: { select: { displayName: true } },
        },
      });

      if (countsArray.length > 0) {
        await tx.tillCount.createMany({
          data: countsArray.map((c) => ({
            tillId: created.id,
            denomination: c.denomination,
            quantity: c.quantity,
            amount: round2(c.amount),
            isOpening: true,
          })),
        });
      }

      return created;
    });

    return res.status(201).json({
      ...till,
      openingCash: Number(till.openingCash),
    });
  } catch (err) {
    logError("POST /registers/[registerId]/tills/open error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
