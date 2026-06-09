// /app/src/pages/api/types/index.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  if (req.method === "GET") {
    try {
      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const where: any = search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { category: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {};

      const [types, total] = await Promise.all([
        prisma.type.findMany({
          where,
          skip,
          take: limit,
          orderBy: { name: "asc" },
          include: { category: true }, // Include category for display and filtering
        }),
        prisma.type.count({ where }),
      ]);

      // Map category name for easier frontend display
      const mappedTypes = types.map((type) => ({
        ...type,
        categoryName: type.category?.name,
      }));

      return res.status(200).json({ types: mappedTypes, total });
    } catch (err) {
      logError("GET /types error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  if (req.method === "POST") {
    const { name, categoryId } = req.body;

    if (!name || typeof name !== "string" || !categoryId || Number.isNaN(categoryId)) {
      return res.status(400).json({ error: "Invalid input" });
    }

    try {
      const created = await prisma.type.create({
        data: {
          name,
          categoryId: Number.parseInt(categoryId),
        },
      });
      return res.status(201).json(created);
    } catch (err) {
      logError("POST /types error", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end(`Method ${req.method} Not Allowed`);
}
