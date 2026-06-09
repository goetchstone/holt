// /app/src/pages/api/consignment/import/consignment-items.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { safeString, safeFloat, safeDate } from "@/lib/importHelpers";
import { calculateRugPricing, mapConsignmentStatusRow } from "@/lib/consignment";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { rows } = req.body as { rows: Record<string, unknown>[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const userEmail = session.user.email;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const vendor = await tx.vendor.upsert({
          where: { name: "Marjan International" },
          update: {},
          create: { name: "Marjan International", code: "MJ", pricingModel: "FLAT" },
        });

        const dept = await tx.department.upsert({
          where: { name: "Rugs" },
          update: {},
          create: { name: "Rugs" },
        });
        const cat = await tx.category.upsert({
          where: { name_departmentId: { name: "Area Rugs", departmentId: dept.id } },
          update: {},
          create: { name: "Area Rugs", departmentId: dept.id },
        });

        let imported = 0;
        let skipped = 0;
        const errors: string[] = [];

        for (const row of rows) {
          const barcode = safeString(row.barcode);
          if (!barcode) {
            skipped++;
            continue;
          }

          try {
            const cost = safeFloat(row.cost);
            const { anchorPrice, retailPrice } = calculateRugPricing(cost);
            const status = mapConsignmentStatusRow(row);
            const quality = safeString(row.quality);
            const size = safeString(row.size);
            const productName = [quality, size].filter(Boolean).join(" ") || barcode;

            const existingProduct = await tx.product.findFirst({
              where: { productNumber: barcode, vendorId: vendor.id },
              select: { id: true },
            });

            const product = existingProduct
              ? await tx.product.update({
                  where: { id: existingProduct.id },
                  data: {
                    name: productName,
                    baseCost: cost,
                    baseRetail: retailPrice,
                    updatedBy: userEmail,
                  },
                  select: { id: true },
                })
              : await tx.product.create({
                  data: {
                    productNumber: barcode,
                    name: productName,
                    vendorId: vendor.id,
                    departmentId: dept.id,
                    categoryId: cat.id,
                    baseCost: cost,
                    baseRetail: retailPrice,
                    createdBy: userEmail,
                  },
                  select: { id: true },
                });

            await tx.consignmentItem.upsert({
              where: { barcode },
              update: {
                quality,
                size,
                cost,
                anchorPrice,
                retailPrice,
                sellingPrice: safeFloat(row.retail) || undefined,
                wasPrice: safeFloat(row.was_Price) || undefined,
                status,
                year: row.year ? Number.parseInt(String(row.year), 10) || undefined : undefined,
                customerNumber: safeString(row.customer_number),
                saleDate: safeDate(row.sales_Date),
                saleCustomerName: safeString(row.sales_last_name),
                saleTransactionId: safeString(row.sales_transaction),
                fmRecordId: row.id_kp_consignment ? String(row.id_kp_consignment) : undefined,
                productId: product?.id,
                updatedBy: userEmail,
              },
              create: {
                vendorId: vendor.id,
                productId: product?.id,
                barcode,
                quality,
                size,
                cost,
                anchorPrice,
                retailPrice,
                sellingPrice: safeFloat(row.retail) || undefined,
                wasPrice: safeFloat(row.was_Price) || undefined,
                status,
                year: row.year ? Number.parseInt(String(row.year), 10) || undefined : undefined,
                customerNumber: safeString(row.customer_number),
                saleDate: safeDate(row.sales_Date),
                saleCustomerName: safeString(row.sales_last_name),
                saleTransactionId: safeString(row.sales_transaction),
                fmRecordId: row.id_kp_consignment ? String(row.id_kp_consignment) : undefined,
                createdBy: userEmail,
              },
            });

            imported++;
          } catch (rowErr) {
            const msg = rowErr instanceof Error ? rowErr.message : "Unknown error";
            errors.push(`Row ${barcode}: ${msg}`);
          }
        }

        return { imported, skipped, errors };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      return res.status(500).json({ error: message });
    }
  },
);
