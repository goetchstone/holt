// /app/src/pages/api/categories/delete-all.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "DELETE") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  try {
    const deletedCount = await prisma.category.deleteMany({}); // Deletes all records

    return res
      .status(200)
      .json({ message: `Successfully deleted ${deletedCount.count} categories.` });
  } catch (err) {
    logError("Error deleting all categories", err);
    return res.status(500).json({ error: "Failed to delete all categories." });
  }
});
