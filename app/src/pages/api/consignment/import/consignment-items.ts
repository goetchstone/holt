// /app/src/pages/api/consignment/import/consignment-items.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { getPrimaryConsignmentVendorId } from "@/lib/consignmentVendor";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { safeString, safeFloat, safeDate } from "@/lib/importHelpers";
import { calculateRugPricing, mapConsignmentStatusRow } from "@/lib/consignment";
import {
  countKept,
  emptyKeptCounts,
  lockRetailRow,
  recordImportPriceChanges,
  retailFieldsForImport,
} from "@/lib/pricing/retailWriter";

import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

/** Changing an existing product's retail needs this as well (DECISIONS 58). */
const PRICING = "catalog.pricing";

export default requirePermission(
  "purchasing.write",
  async (req: NextApiRequest, res: NextApiResponse, session, access) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { rows } = req.body as { rows: Record<string, unknown>[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const userEmail = session.user.email;
    const mayChangePrice = access.holds[PRICING];

    try {
      const result = await prisma.$transaction(async (tx) => {
        // The consigning vendor, by flag. These routes used to UPSERT a
        // hardcoded consignor by name when they could not find one -- which is
        // exactly how a catalog ends up with several spellings of one supplier
        // as separate vendors. A missing configuration is now an error,
        // not a new row.
        const consignmentVendorId = await getPrimaryConsignmentVendorId(tx);
        if (!consignmentVendorId) {
          throw new Error(
            "No consignment vendor configured. Set isConsignment on the vendor before importing.",
          );
        }
        const vendor = { id: consignmentVendorId };

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
        const kept = emptyKeptCounts();

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
            // A locked price, no cost to price from, or an importer who may not
            // change prices keeps the product's own retail -- decided from its
            // row locked FOR UPDATE (lib/pricing/retailWriter.ts).
            const retail = existingProduct
              ? retailFieldsForImport(await lockRetailRow(tx, existingProduct.id), retailPrice, {
                  mayChangePrice,
                })
              : null;
            if (retail) countKept(kept, retail.kept);

            const product = existingProduct
              ? await tx.product.update({
                  where: { id: existingProduct.id },
                  data: {
                    name: productName,
                    baseCost: cost,
                    ...retail!.data,
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
            await recordImportPriceChanges(tx, retail?.change ? [retail.change] : [], {
              source: "CONSIGNMENT_IMPORT",
              actor: userEmail,
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

        return { imported, skipped, errors, ...kept };
      }, TX_TIMEOUT.LONG);

      return res.status(200).json(result);
    } catch (err) {
      logError("Consignment items import failed", err);
      return res.status(500).json({ error: "Import failed" });
    }
  },
  { also: [PRICING] },
);
