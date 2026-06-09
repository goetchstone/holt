// /app/src/pages/api/import/inventory-snapshot.ts

import { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { getErrorMessage } from "@/lib/toastError";
export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { records } = req.body;
    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ error: "Invalid records data." });
    }

    let createdCount = 0;
    const errors: { data: any; message: string }[] = [];

    for (const record of records) {
      const stockIdStr = record.Stockid || record.stockid;
      const stockLevelStr =
        record.Stocklevel || record.stocklevel || record["On Hand"] || record["on hand"];

      if (
        !stockIdStr ||
        String(stockIdStr).trim() === "" ||
        Number.isNaN(Number.parseInt(String(stockIdStr)))
      ) {
        continue;
      }

      const externalId = Number.parseInt(String(stockIdStr).trim(), 10);
      const quantity = Number.parseFloat(String(stockLevelStr).trim());

      if (Number.isNaN(externalId) || Number.isNaN(quantity)) {
        errors.push({
          data: record,
          message: `Invalid number format for Stockid or Stocklevel.`,
        });
        continue;
      }

      try {
        await prisma.inventorySnapshot.create({
          data: {
            externalId,
            stockLocation: (record.Stocklocation || record.stocklocation || "").trim(),
            quantity,
          },
        });
        createdCount++;
      } catch (error: unknown) {
        errors.push({
          data: record,
          message: `Database error: ${getErrorMessage(error, "unknown error")}`,
        });
      }
    }

    res.status(200).json({
      createdCount,
      errors,
      errorCount: errors.length,
    });
  },
);

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};
