// /app/src/pages/api/accounting/journal-entries/index.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { status, startDate, endDate } = req.query;

  const where: Record<string, unknown> = {};
  if (status && typeof status === "string") {
    where.status = status;
  }
  if (startDate || endDate) {
    const dateFilter: Record<string, Date> = {};
    if (startDate && typeof startDate === "string") {
      dateFilter.gte = new Date(startDate);
    }
    if (endDate && typeof endDate === "string") {
      dateFilter.lte = new Date(endDate);
    }
    where.journalDate = dateFilter;
  }

  try {
    const entries = await prisma.journalEntry.findMany({
      where,
      orderBy: { journalDate: "desc" },
      include: {
        _count: { select: { lines: true } },
      },
    });

    const result = entries.map((e) => ({
      id: e.id,
      journalNumber: e.journalNumber,
      journalDate: e.journalDate,
      journalType: e.journalType,
      status: e.status,
      storeLocation: e.storeLocation,
      totalDebits: Number(e.totalDebits),
      totalCredits: Number(e.totalCredits),
      lineCount: e._count.lines,
      notes: e.notes,
    }));

    return res.status(200).json(result);
  } catch (err) {
    logError("GET /accounting/journal-entries error", err);
    return res.status(500).json({ error: "Failed to fetch journal entries" });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
