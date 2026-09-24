// /app/src/pages/api/printers/list.ts

import { requirePermission } from "@/lib/auth/requireAuth";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const printers = await prisma.printer.findMany();
    res.status(200).json(printers);
  } catch (err) {
    logError("Error listing printers", err);
    res.status(500).json({ message: "Failed to load printers" });
  }
}

export default requirePermission("admin.settings", handler);
