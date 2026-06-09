// /app/src/pages/api/inventory/clear-snapshot.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
export default requireAuthWithRole(["ADMIN"], async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    await prisma.inventorySnapshot.deleteMany({});
    return res.status(200).json({ message: "Inventory snapshot cleared successfully." });
  } catch (error: unknown) {
    logError("Failed to clear inventory snapshot", error);
    return res
      .status(500)
      .json({ error: `Failed to clear data: ${getErrorMessage(error, "unknown error")}` });
  }
});
