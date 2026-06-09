// /app/src/pages/api/accounting/journal-entries/generate.ts

import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { generateSalesJournal } from "@/lib/journalEntry";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { date, storeLocation } = req.body;

  if (!date) {
    return res.status(400).json({ error: "Date is required" });
  }

  const targetDate = new Date(date);
  if (Number.isNaN(targetDate.getTime())) {
    return res.status(400).json({ error: "Invalid date format" });
  }

  try {
    const result = await generateSalesJournal(
      targetDate,
      session.user?.email || undefined,
      storeLocation || undefined,
    );
    return res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate journal";
    return res.status(400).json({ error: message });
  }
}

export default requireAuthWithRole(["MANAGER", "ADMIN"], handler);
