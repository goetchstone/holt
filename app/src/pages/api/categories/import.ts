// /app/src/pages/api/categories/import.ts

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
      res.setHeader("Allow", ["POST"]);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    const { categories } = req.body;

    if (!Array.isArray(categories)) {
      return res.status(400).json({ error: "Invalid data format" });
    }

    try {
      const results = await Promise.all(
        categories.map(async (cat) => {
          if (!cat.name || !cat.department) {
            throw new Error(`Missing name or department: ${JSON.stringify(cat)}`);
          }

          const dept = await prisma.department.upsert({
            where: { name: cat.department },
            update: {},
            create: { name: cat.department },
          });

          const existing = await prisma.category.findFirst({
            where: {
              name: cat.name,
              departmentId: dept.id,
            },
          });

          let accountGroupId: number | null = null;
          if (cat.accountGroup) {
            const group = await prisma.accountGroup.upsert({
              where: { name: cat.accountGroup },
              update: {},
              create: { name: cat.accountGroup },
            });
            accountGroupId = group.id;
          }

          const data = {
            name: cat.name,
            departmentId: dept.id,
            trackInventory: cat.trackInventory?.toString().toLowerCase() === "false" ? false : true,
            accountGroupId,
            labelTemplateId: cat.labelTemplateId ? Number.parseInt(cat.labelTemplateId) : null,
          };

          if (existing) {
            return prisma.category.update({
              where: { id: existing.id },
              data,
            });
          } else {
            return prisma.category.create({ data });
          }
        }),
      );

      return res.status(200).json({ success: true, count: results.length });
    } catch (err) {
      logError("Category import failed", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);
