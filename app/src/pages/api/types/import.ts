// /app/src/pages/api/types/import.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } },
};

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method Not Allowed" });
    }

    const { types } = req.body;

    if (!Array.isArray(types)) {
      return res.status(400).json({ message: "Invalid format" });
    }

    try {
      const created = [];

      for (const row of types) {
        const name = row.name?.trim();
        const categoryName = row.category?.trim();

        if (!name || !categoryName) continue;

        const category = await prisma.category.findFirst({
          where: { name: categoryName },
        });

        if (!category) continue;

        const existing = await prisma.type.findFirst({
          where: {
            name,
            categoryId: category.id,
          },
        });

        if (!existing) {
          const type = await prisma.type.create({
            data: {
              name,
              categoryId: category.id,
            },
          });
          created.push(type.name);
        }
      }

      return res.status(200).json({ types: created });
    } catch (err) {
      logError("Import error", err);
      return res.status(500).json({ message: "Failed to import types" });
    }
  },
);
