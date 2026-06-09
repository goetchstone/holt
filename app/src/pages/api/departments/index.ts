// /app/src/pages/api/departments/index.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { Prisma } from "@prisma/client"; // Import Prisma for SortOrder
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorCode } from "@/lib/errorCode";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const fetchAll = req.query.all === "true"; // NEW: Check for 'all' parameter

      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const where = search
        ? {
            name: { contains: search, mode: "insensitive" as const },
          }
        : {};

      const findManyArgs: Prisma.DepartmentFindManyArgs = {
        // Add type annotation
        where,
        orderBy: { name: Prisma.SortOrder.asc }, // Use Prisma.SortOrder.asc
        select: { id: true, name: true }, // Keep select for efficiency
      };

      // Apply skip and take only if not fetching all
      if (!fetchAll) {
        findManyArgs.skip = skip;
        findManyArgs.take = limit;
      }

      const [departments, total] = await Promise.all([
        prisma.department.findMany(findManyArgs), // Use findManyArgs
        prisma.department.count({ where }),
      ]);

      return res.status(200).json({ departments, total });
    } catch (err) {
      logError("GET /departments error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
    const { name } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Invalid name" });
    }

    try {
      const created = await prisma.department.create({
        data: { name },
      });
      return res.status(201).json(created);
    } catch (err: unknown) {
      if (getErrorCode(err) === "P2002") {
        return res.status(409).json({ error: `Department with name '${name}' already exists.` });
      }
      logError("POST /departments error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
