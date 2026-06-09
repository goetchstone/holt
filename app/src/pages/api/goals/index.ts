// /app/src/pages/api/goals/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const { year } = req.query;
      const goals = await prisma.salesGoals.findMany({
        where: year ? { year: Number(year) } : undefined,
        orderBy: [{ year: "desc" }, { goalType: "asc" }, { entityName: "asc" }],
      });
      return res.status(200).json(goals);
    }

    if (req.method === "POST") {
      const { year = new Date().getFullYear(), goalType, entityName, annualGoal } = req.body;

      if (!goalType || !entityName || annualGoal == null) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const newGoal = await prisma.salesGoals.create({
        data: {
          year: Number(year),
          goalType,
          entityName,
          annualGoal: Number.parseFloat(annualGoal),
        },
      });
      return res.status(201).json(newGoal);
    }

    if (req.method === "PUT") {
      const { id, annualGoal } = req.body;
      if (!id || annualGoal == null) {
        return res.status(400).json({ error: "Missing required fields for update" });
      }
      const updated = await prisma.salesGoals.update({
        where: { id: Number(id) },
        data: { annualGoal: Number.parseFloat(annualGoal) },
      });
      return res.status(200).json(updated);
    }

    res.setHeader("Allow", ["GET", "POST", "PUT"]);
    res.status(405).end();
  } catch (e: unknown) {
    logError("Goals API error", e);
    if (getErrorCode(e) === "P2002") {
      return res
        .status(409)
        .json({ error: "A goal for this year, type, and name already exists." });
    }
    res.status(500).json({ error: "An unexpected error occurred." });
  }
}
