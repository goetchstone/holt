// /app/src/pages/api/printers/delete.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
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

export default requireAuthWithRole(["ADMIN"], handler);
