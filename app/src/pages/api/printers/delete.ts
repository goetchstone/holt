// /app/src/pages/api/printers/delete.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const { id } = req.body;
    await prisma.printer.delete({ where: { id: Number(id) } });
    res.status(200).json({ message: "Printer deleted" });
  } catch (err) {
    logError("Error deleting printer", err);
    res.status(500).json({ message: "Failed to delete printer" });
  }
}
