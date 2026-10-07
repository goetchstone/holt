// /app/src/pages/api/reports/get-departments.ts
//
// Returns distinct department names. Previously queried a SalesData model
// that no longer exists. Now queries the Department model directly.

import { requirePermission } from "@/lib/auth/requireAuth";
import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const departments = await prisma.department.findMany({
      select: { name: true },
      orderBy: { name: "asc" },
    });

    const departmentNames = departments.map((d) => d.name);
    res.status(200).json(departmentNames);
  } catch (error) {
    logError("Error fetching departments", error);
    res.status(500).json({ error: "Failed to fetch departments." });
  }
}

export default requirePermission("catalog.write", handler);
