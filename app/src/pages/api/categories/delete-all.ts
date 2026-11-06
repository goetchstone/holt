// /app/src/pages/api/categories/delete-all.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { auditActor, auditLog } from "@/lib/audit";
import { logError } from "@/lib/logger";
export default requirePermission(
  "admin.data",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "DELETE") {
      return res.status(405).json({ message: "Method Not Allowed" });
    }

    try {
      const deletedCount = await prisma.category.deleteMany({}); // Deletes all records
      await auditLog("BULK_DELETED", auditActor(session), {
        summary: `All ${deletedCount.count} categories deleted`,
        details: { table: "Category", deleted: deletedCount.count },
      });

      return res
        .status(200)
        .json({ message: `Successfully deleted ${deletedCount.count} categories.` });
    } catch (err) {
      logError("Error deleting all categories", err);
      return res.status(500).json({ error: "Failed to delete all categories." });
    }
  },
);
