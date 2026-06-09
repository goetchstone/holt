// /app/src/pages/api/printers/create.ts

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
