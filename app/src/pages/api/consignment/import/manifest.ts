// /app/src/pages/api/consignment/import/manifest.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/prisma";
import { safeString, safeFloat } from "@/lib/importHelpers";
import { calculateRugPricing } from "@/lib/consignment";
import { backfillLineItemProductLinks } from "@/lib/orderLineItemLinker";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export const config = { api: { bodyParser: { sizeLimit: "20mb" } } };

interface ManifestRow {
  rugNumber?: string;
  customerNumber?: string;
  baleNumber?: string;
  quality?: string;
  size?: string;
  cost?: number | string;
}

const MARJAN_NAME_VARIANTS = [
  "Marjan International",
  "Marjan International Corp",
  "Marjan",
  "MARJANINT",
  "Marjan Int",
  "Marjan Intl",
];

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// TxClient is used by findOrCreateMarjan and findOrCreateRugsDepartment
async function findOrCreateMarjan(tx: TxClient) {
  // Search by name variants first
  const byName = await tx.vendor.findFirst({
    where: { name: { in: MARJAN_NAME_VARIANTS, mode: "insensitive" } },
  });
  if (byName) return byName;

  // Fall back to code match (handles name changes)
  const byCode = await tx.vendor.findFirst({ where: { code: "MJ" } });
  if (byCode) return byCode;

  return tx.vendor.create({
    data: { name: "Marjan International", code: "MJ", pricingModel: "FLAT" },
  });
}

async function findOrCreateRugsDepartment(tx: TxClient) {
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
  return { departmentId: dept.id, categoryId: cat.id };
}

interface RowError {
  row: number;
  rugNumber: string | null;
  error: string;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const body = req.body as {
      manifestRef?: string;
      manifestReference?: string;
      storeLocationId?: number;
      rows?: ManifestRow[];
      items?: ManifestRow[];
    };
    const manifestRef = body.manifestRef || body.manifestReference;
    const storeLocationId = body.storeLocationId ?? null;
    const rows = body.rows || body.items;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "No rows provided" });
    }

    const userEmail = session.user.email;

    try {
      // Set up vendor, department, and receipt outside the per-row loop so they
      // are not rolled back if an individual row fails.
      const vendor = await prisma.$transaction((tx) => findOrCreateMarjan(tx));
      const { departmentId, categoryId } = await prisma.$transaction((tx) =>
        findOrCreateRugsDepartment(tx),
      );

      const receipt = await prisma.consignmentReceipt.create({
        data: {
          vendorId: vendor.id,
          manifestRef: safeString(manifestRef),
          createdBy: userEmail,
        },
      });

      const items: {
        id: number;
        barcode: string;
        quality: string | null;
        size: string | null;
        cost: number;
        retailPrice: number;
      }[] = [];
      const errors: RowError[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rugNumber = safeString(row.rugNumber);
        const barcode = rugNumber || `MJ-IMPORT-${i + 1}`;

        try {
          const cost = safeFloat(row.cost);
          const { anchorPrice, retailPrice } = calculateRugPricing(cost);
          const quality = safeString(row.quality) || "";
          const size = safeString(row.size) || "";
          const productName = [quality, size].filter(Boolean).join(" ") || barcode;

          // Each row runs in its own transaction so a DB error on one row cannot
          // abort the PostgreSQL transaction state for subsequent rows.
          const item = await prisma.$transaction(async (tx) => {
            const existing = await tx.product.findFirst({
              where: { productNumber: barcode, vendorId: vendor.id },
            });

            const product = existing
              ? await tx.product.update({
                  where: { id: existing.id },
                  data: {
                    name: productName,
                    baseCost: cost,
                    baseRetail: retailPrice,
                    // Backfill department/category for items imported before these fields existed
                    departmentId,
                    categoryId,
                    updatedBy: userEmail,
                  },
                })
              : await tx.product.create({
                  data: {
                    productNumber: barcode,
                    name: productName,
                    vendorId: vendor.id,
                    departmentId,
                    categoryId,
                    baseCost: cost,
                    baseRetail: retailPrice,
                    createdBy: userEmail,
                  },
                });

            const existingItem = await tx.consignmentItem.findUnique({
              where: { barcode },
            });

            return existingItem
              ? await tx.consignmentItem.update({
                  where: { barcode },
                  data: {
                    vendorId: vendor.id,
                    productId: product.id,
                    rugNumber,
                    customerNumber: safeString(row.customerNumber),
                    baleNumber: safeString(row.baleNumber),
                    quality: safeString(row.quality),
                    size: safeString(row.size),
                    cost,
                    anchorPrice,
                    retailPrice,
                    consignmentReceiptId: receipt.id,
                    ...(storeLocationId !== null ? { storeLocationId } : {}),
                    updatedBy: userEmail,
                  },
                })
              : await tx.consignmentItem.create({
                  data: {
                    vendorId: vendor.id,
                    productId: product.id,
                    barcode,
                    rugNumber,
                    customerNumber: safeString(row.customerNumber),
                    baleNumber: safeString(row.baleNumber),
                    quality: safeString(row.quality),
                    size: safeString(row.size),
                    cost,
                    anchorPrice,
                    retailPrice,
                    consignmentReceiptId: receipt.id,
                    ...(storeLocationId !== null ? { storeLocationId } : {}),
                    receivedDate: new Date(),
                    createdBy: userEmail,
                  },
                });
          });

          items.push({
            id: item.id,
            barcode: item.barcode,
            quality: item.quality,
            size: item.size,
            cost: Number(item.cost),
            retailPrice: Number(item.retailPrice),
          });
        } catch (rowErr) {
          const msg = rowErr instanceof Error ? rowErr.message : "Unknown error";
          errors.push({ row: i + 1, rugNumber: rugNumber || null, error: msg });
        }
      }

      await prisma.consignmentReceipt.update({
        where: { id: receipt.id },
        data: { itemCount: items.length },
      });

      // Retroactively link any OrderLineItem rows with NULL productId to the
      // products just created/updated. Scoped to the imported barcodes (which
      // are the productNumbers for Marjan rugs) so this is cheap.
      const importedPartNos = items.map((i) => i.barcode).filter((b): b is string => !!b);
      const relink =
        importedPartNos.length > 0
          ? await backfillLineItemProductLinks({ partNos: importedPartNos })
          : { updated: 0, remainingUnlinked: 0, partNosProcessed: 0 };

      return res.status(200).json({
        receiptId: receipt.id,
        imported: items.length,
        items,
        errors,
        lineItemsRelinked: relink.updated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      return res.status(500).json({ error: message });
    }
  },
);
