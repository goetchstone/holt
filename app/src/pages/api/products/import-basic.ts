// /app/src/pages/api/products/import-basic.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { backfillLineItemProductLinks } from "@/lib/orderLineItemLinker";

import { requirePermission } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { vendorIdByName } from "@/lib/vendors/vendorByName";
import { getAppSettings } from "@/lib/appSettings";
import { resolveMarkup } from "@/lib/pricing/markup";
import { roundRetail } from "@/lib/pricing/rounding";
import {
  countKept,
  emptyKeptCounts,
  lockRetailRow,
  recordImportPriceChanges,
  retailFieldsForImport,
} from "@/lib/pricing/retailWriter";

/** Changing an existing product's retail needs this as well as "Edit catalog" (DECISIONS 58). */
const PRICING = "catalog.pricing";

/** A number from a cell, or null when the cell is blank or unreadable. */
function cellNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}

export default requirePermission(
  "catalog.write",
  async (req: NextApiRequest, res: NextApiResponse, session, access) => {
    if (req.method !== "POST") return res.status(405).end();

    const { records } = req.body;

    if (!records || !Array.isArray(records)) {
      return res.status(400).json({ error: "Missing or invalid records." });
    }

    // Collect the partNos and UPCs imported so we can retroactively link any
    // existing NULL-productId OrderLineItem rows after the import completes.
    // Both are needed — a line item might reference the product by partNo OR
    // by barcode (UPC).
    const importedPartNos = new Set<string>();
    const importedUpcs = new Set<string>();
    const kept = emptyKeptCounts();
    const actor = session.user?.email ?? null;
    const mayChangePrice = access.holds[PRICING];

    try {
      const { pricing } = await getAppSettings();
      for (const record of records) {
        const vendor = await vendorNamed(record.vendorName);
        if (!vendor) throw new Error(`Vendor not found: ${record.vendorName}`);

        const department = await prisma.department.findUnique({
          where: { name: record.departmentName },
        });
        if (!department) throw new Error(`Department not found: ${record.departmentName}`);

        const category = await prisma.category.findUnique({
          where: {
            name_departmentId: {
              name: record.categoryName,
              departmentId: department.id,
            },
          },
        });
        if (!category) throw new Error(`Category not found: ${record.categoryName}`);

        const type = await prisma.type.findUnique({
          where: {
            name_categoryId: {
              name: record.typeName,
              categoryId: category.id,
            },
          },
        });
        if (!type) throw new Error(`Type not found: ${record.typeName}`);

        // Parse numbers. A blank retail cell is no price, not a price of 0.
        const cost = Number.parseFloat(record.cost || "0") || 0;
        let retailPrice = cellNumber(record.retailPrice);
        const autoMarkup = String(record.autoMarkup || "FALSE").toUpperCase() === "TRUE";

        // Optional auto markup: cost times the markup that applies (vendor,
        // category or store, lib/pricing/markup.ts), rounded by the store's
        // rule. A markup is a multiplier -- 2.2 prices a $100 item at $220.
        if (retailPrice === null && autoMarkup && cost > 0) {
          const markup = resolveMarkup({
            vendorMarkup: vendor.defaultMarkup,
            categoryMarkup: category.defaultMarkup,
            storeMarkup: pricing.defaultMarkup,
            precedence: pricing.markupPrecedence,
          });
          // Rounding can take a small price to 0, which the register reads as no price.
          const rounded = markup && roundRetail(cost * markup.multiplier, pricing.retailRounding);
          if (rounded) retailPrice = rounded;
        }

        const productData = {
          name: record.name,
          description: record.description || "",
          season: record.season || "",
          baseCost: cost,
          departmentId: department.id,
          categoryId: category.id,
          typeId: type.id,
          length: record["dimensions.length"]
            ? Number.parseFloat(record["dimensions.length"])
            : null,
          depth: record["dimensions.depth"] ? Number.parseFloat(record["dimensions.depth"]) : null,
          height: record["dimensions.height"]
            ? Number.parseFloat(record["dimensions.height"])
            : null,
        };

        // CORRECTED: Replaced the failing `upsert` with a find-then-update-or-create logic
        const existingProduct = await prisma.product.findFirst({
          where: {
            productNumber: record.productNumber,
            vendorId: vendor.id,
          },
          select: { id: true },
        });

        let product;
        if (existingProduct) {
          // An existing product keeps a locked price, its own price when the
          // file has none, and its price when the importer may not change
          // prices -- decided from its row as it stands, locked in this
          // transaction (lib/pricing/retailWriter.ts).
          product = await prisma.$transaction(async (tx) => {
            const current = await lockRetailRow(tx, existingProduct.id);
            const retail = retailFieldsForImport(current, retailPrice, { mayChangePrice });
            countKept(kept, retail.kept);
            const updated = await tx.product.update({
              where: { id: existingProduct.id },
              data: { ...productData, ...retail.data },
            });
            await recordImportPriceChanges(tx, retail.change ? [retail.change] : [], {
              source: "IMPORT",
              actor,
            });
            return updated;
          });
        } else {
          product = await prisma.product.create({
            data: {
              ...productData,
              baseRetail: retailPrice,
              productNumber: record.productNumber,
              vendorId: vendor.id,
            },
          });
        }

        // Handle UPC / Barcode
        if (record.upc && record.upc.trim() !== "") {
          await prisma.upc.upsert({
            where: { upc: record.upc },
            update: {
              productId: product.id,
            },
            create: {
              upc: record.upc,
              product: { connect: { id: product.id } },
              sortOrder: 0,
            },
          });
        }

        if (record.productNumber) importedPartNos.add(record.productNumber);
        if (record.upc && String(record.upc).trim()) {
          importedUpcs.add(String(record.upc).trim());
        }
      }

      // Auto-relink any historical OrderLineItem rows that had no product link
      // but whose partNo OR barcode matches something we just imported. Scoped
      // to the imported identifiers so this is cheap even on large order tables.
      const relink = await backfillLineItemProductLinks({
        partNos: [...importedPartNos, ...importedUpcs],
      });

      res.status(200).json({
        success: true,
        productsImported: records.length,
        lineItemsRelinked: relink.updated,
        ...kept,
      });
    } catch (error: unknown) {
      logError("Unexpected error", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
  { also: [PRICING] },
);

/** The vendor a name means; an earlier name (a vendor merged away) finds the vendor it went to. */
async function vendorNamed(name: string) {
  const id = await vendorIdByName(prisma, name);
  return id === null ? null : prisma.vendor.findUnique({ where: { id } });
}
