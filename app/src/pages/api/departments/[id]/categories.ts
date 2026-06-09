// /app/src/pages/api/departments/[id]/categories.ts

import { prisma } from "@/lib/prisma";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  const departmentId = Number.parseInt(req.query.id as string);

  if (Number.isNaN(departmentId)) {
    return res.status(400).json({ error: "Invalid department ID" });
  }

  try {
    const categories = await prisma.category.findMany({
      where: { departmentId },
      orderBy: { name: "asc" },
    });

    return res.status(200).json(categories);
  } catch (error) {
    logError("Error fetching categories", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
