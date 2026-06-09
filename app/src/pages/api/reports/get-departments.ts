// /app/src/pages/api/reports/get-departments.ts
//
// Returns distinct department names. Previously queried a SalesData model
// that no longer exists. Now queries the Department model directly.

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

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
