// /app/src/pages/api/categories/index.ts

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { logError } from "@/lib/logger";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const fetchAll = req.query.all === "true";

      const page = Number.parseInt(req.query.page as string) || 1;
      const limit = Number.parseInt(req.query.limit as string) || 10;
      const search = (req.query.search as string)?.trim() || "";

      const skip = (page - 1) * limit;

      const where: any = search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" as const } },
              { department: { name: { contains: search, mode: "insensitive" as const } } },
            ],
          }
        : {};

      const findManyArgs: Prisma.CategoryFindManyArgs = {
        where,
        orderBy: { name: Prisma.SortOrder.asc },
        include: {
          department: true,
          labelTemplate: true,
          accountGroup: { select: { id: true, name: true } },
        },
      };

      if (!fetchAll) {
        findManyArgs.skip = skip;
        findManyArgs.take = limit;
      }

      const [categories, total] = await Promise.all([
        prisma.category.findMany(findManyArgs),
        prisma.category.count({ where }),
      ]);

      // This section uses type assertions to help TypeScript compile
      // when it's being overly strict about relations after an include.
      const mappedCategories = categories.map((cat) => ({
        ...cat,
        departmentName: (cat as any).department?.name,
        labelTemplateName: (cat as any).labelTemplate?.name,
      }));

      return res.status(200).json({ categories: mappedCategories, total });
    }

    if (req.method === "POST") {
      const { name, departmentId, trackInventory, accountGroupId, labelTemplateId } = req.body;

      const created = await prisma.category.create({
        data: {
          name,
          departmentId,
          trackInventory,
          accountGroupId: accountGroupId ? Number.parseInt(accountGroupId) : null,
          labelTemplateId: labelTemplateId || null,
        },
      });

      return res.status(201).json(created);
    }

    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  } catch (err) {
    logError("API error", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
