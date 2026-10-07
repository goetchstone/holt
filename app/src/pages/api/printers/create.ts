// /app/src/pages/api/printers/create.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }

  try {
    const { name, ipAddress, port, location, tagType, store } = req.body;

    const printer = await prisma.printer.create({
      data: {
        name,
        ipAddress,
        port: Number.parseInt(port, 10), // 🔧 FIX: convert to number
        location,
        tagType,
        store,
      },
    });

    res.status(200).json(printer);
  } catch (err) {
    logError("Error saving printer", err);
    res.status(500).json({ message: "Failed to save printer" });
  }
}

export default requirePermission("admin.settings", handler);
