// /app/src/pages/api/consignment/import/sales-lines.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getPrimaryConsignmentVendorId } from "@/lib/consignmentVendor";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { safeString, safeFloat } from "@/lib/importHelpers";
import { calculateRugPricing } from "@/lib/consignment";

import { requirePermission } from "@/lib/auth/requireAuth";
export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

export default requirePermission(
  "purchasing.write",
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const userEmail = session.user.email;
    const { rows } = req.body as { rows: Record<string, unknown>[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // The consigning vendor, by flag. These routes used to UPSERT a vendor
        // named "Marjan International" when they could not find one -- which is
        // exactly how a catalog ends up with "Marjan", "Marjan Intl" and
        // "MARJANINT" as three separate suppliers. A missing configuration is
        // now an error, not a new row.
        const consignmentVendorId = await getPrimaryConsignmentVendorId(tx);
        if (!consignmentVendorId) {
          throw new Error(
            "No consignment vendor configured. Set isConsignment on the vendor before importing.",
          );
        }
        const vendor = { id: consignmentVendorId };

        let imported = 0;
        let skipped = 0;
        let itemsCreated = 0;
        let itemsUpdated = 0;

        for (const row of rows) {
          const saleTransactionId = safeString(row.kf_sale_transaction_id);
          const rugBarcode = safeString(row.kf_rug_barcode);
          if (!saleTransactionId || !rugBarcode) {
            skipped++;
            continue;
          }

          const sale = await tx.consignmentSale.findUnique({
            where: { transactionId: saleTransactionId },
          });

          if (!sale) {
            skipped++;
            continue;
          }

          // Upsert the sale line
          const existingLine = await tx.consignmentSaleLine.findFirst({
            where: { consignmentSaleId: sale.id, rugBarcode },
          });
          if (!existingLine) {
            await tx.consignmentSaleLine.create({
              data: {
                consignmentSaleId: sale.id,
                rugBarcode,
                cost: safeFloat(row.cost) || undefined,
                transactionId: safeString(row.transaction_id),
              },
            });
          }

          // Link to actual the POS SalesOrder by matching transaction ID to order number
          const salesOrder = await tx.salesOrder.findUnique({
            where: { orderno: saleTransactionId },
          });
          const salesOrderId = salesOrder?.id ?? null;

          // Update or create the ConsignmentItem
          const existingItem = await tx.consignmentItem.findUnique({
            where: { barcode: rugBarcode },
          });

          if (existingItem) {
            await tx.consignmentItem.update({
              where: { barcode: rugBarcode },
              data: {
                saleTransactionId,
                salesOrderId,
                status: "SOLD",
                saleDate: sale.saleDate,
                saleCustomerName: sale.customerLastName,
              },
            });
            itemsUpdated++;
          } else if (vendor) {
            // Item was from a previous batch -- create it as SOLD
            const cost = safeFloat(row.cost);
            const { anchorPrice, retailPrice } = calculateRugPricing(cost);
            await tx.consignmentItem.create({
              data: {
                vendorId: vendor.id,
                barcode: rugBarcode,
                cost,
                anchorPrice,
                retailPrice,
                status: "SOLD",
                saleTransactionId,
                salesOrderId,
                saleDate: sale.saleDate,
                saleCustomerName: sale.customerLastName,
                createdBy: userEmail,
              },
            });
            itemsCreated++;
          }

          imported++;
        }

        return { imported, skipped, itemsCreated, itemsUpdated };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      return res.status(500).json({ error: message });
    }
  },
);
