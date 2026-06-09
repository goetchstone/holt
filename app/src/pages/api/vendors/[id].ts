// /app/src/pages/api/vendors/[id].ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const vendorId = Number.parseInt(req.query.id as string);

  if (req.method === "PATCH") {
    try {
      const updated = await prisma.vendor.update({
        where: { id: vendorId },
        data: req.body,
      });
      return res.status(200).json(updated);
    } catch (err) {
      logError("Failed to update vendor", err);
      return res.status(500).json({ error: "Failed to update vendor" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
