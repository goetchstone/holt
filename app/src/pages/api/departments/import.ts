// /app/src/pages/api/departments/import.ts

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

    const { departments } = req.body;

    if (!Array.isArray(departments)) {
      return res.status(400).json({ message: "Invalid format" });
    }

    try {
      const created = await Promise.all(
        departments.map(async (row: { name: string }) => {
          if (!row.name?.trim()) return null;
          return await prisma.department.upsert({
            where: { name: row.name.trim() },
            update: {},
            create: { name: row.name.trim() },
          });
        }),
      );

      const departmentNames = created.filter(Boolean).map((d) => d!.name);
      return res.status(200).json({ departments: departmentNames });
    } catch (err) {
      logError("Import error", err);
      return res.status(500).json({ message: "Failed to import departments" });
    }
  },
);
