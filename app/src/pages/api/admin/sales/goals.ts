// /app/src/pages/api/admin/sales/goals.ts
//
// CRUD endpoint for sales goals. Managers can view and set yearly goals
// per salesperson.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_BONUS_RATE } from "@/lib/goalsConfig";

async function handler(req: NextApiRequest, res: NextApiResponse, session: Session) {
  if (req.method === "GET") {
    const fiscalYear = Number.parseInt(
      (req.query.year as string) || String(new Date().getFullYear()),
      10,
    );
    const goals = await prisma.salesGoal.findMany({
      where: { fiscalYear },
      include: { staffMember: { select: { id: true, displayName: true, role: true } } },
      orderBy: { staffMember: { displayName: "asc" } },
    });
    return res.status(200).json({ goals });
  }

  if (req.method === "PUT") {
    const { staffMemberId, fiscalYear, yearlyGoal, bonusRate, monthlyWeights } = req.body;

    if (!staffMemberId || !fiscalYear || yearlyGoal === undefined) {
      return res
        .status(400)
        .json({ error: "staffMemberId, fiscalYear, and yearlyGoal are required" });
    }

    const goal = await prisma.salesGoal.upsert({
      where: {
        staffMemberId_fiscalYear: { staffMemberId, fiscalYear },
      },
      update: {
        yearlyGoal,
        ...(bonusRate !== undefined ? { bonusRate } : {}),
        ...(monthlyWeights !== undefined ? { monthlyWeights } : {}),
        updatedBy: session.user.email,
      },
      create: {
        staffMemberId,
        fiscalYear,
        yearlyGoal,
        bonusRate: bonusRate ?? DEFAULT_BONUS_RATE,
        monthlyWeights: monthlyWeights ?? null,
        createdBy: session.user.email,
      },
    });

    return res.status(200).json(goal);
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default requirePermission("staff.commission", handler);
