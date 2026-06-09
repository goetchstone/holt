// /app/src/pages/api/consignment/import/sales.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { safeString, safeFloat, safeDate } from "@/lib/importHelpers";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { rows } = req.body as { rows: Record<string, unknown>[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        let imported = 0;
        let skipped = 0;

        for (const row of rows) {
          const transactionId = safeString(row.transaction_id);
          if (!transactionId) {
            skipped++;
            continue;
          }

          await tx.consignmentSale.upsert({
            where: { transactionId },
            update: {
              customerLastName: safeString(row.customer_last_name),
              saleDate: safeDate(row.date_of_sale),
              totalCost: safeFloat(row.total_cost) || undefined,
              fmSaleId: safeString(row.id_kp_sales),
            },
            create: {
              transactionId,
              customerLastName: safeString(row.customer_last_name),
              saleDate: safeDate(row.date_of_sale),
              totalCost: safeFloat(row.total_cost) || undefined,
              fmSaleId: safeString(row.id_kp_sales),
            },
          });

          imported++;
        }

        return { imported, skipped };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      return res.status(500).json({ error: message });
    }
  },
);
