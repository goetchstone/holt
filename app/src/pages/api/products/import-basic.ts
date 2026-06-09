// /app/src/pages/api/products/import-basic.ts

import { prisma } from "@/lib/prisma";
import { NextApiRequest, NextApiResponse } from "next";
import { backfillLineItemProductLinks } from "@/lib/orderLineItemLinker";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
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

    try {
      for (const record of records) {
        const vendor = await prisma.vendor.findUnique({
          where: { name: record.vendorName },
        });
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

        // Parse numbers
        const cost = Number.parseFloat(record.cost || "0") || 0;
        let retailPrice = Number.parseFloat(record.retailPrice || "0") || 0;
        const autoMarkup = String(record.autoMarkup || "FALSE").toUpperCase() === "TRUE";

        // Optional auto markup
        if (
          (!record.retailPrice || record.retailPrice === "") &&
          autoMarkup &&
          vendor.defaultMarkup
        ) {
          retailPrice = cost * (1 + Number(vendor.defaultMarkup) / 100);
        }

        const productData = {
          name: record.name,
          description: record.description || "",
          season: record.season || "",
          baseCost: cost,
          baseRetail: retailPrice,
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
        });

        let product;
        if (existingProduct) {
          product = await prisma.product.update({
            where: { id: existingProduct.id },
            data: productData,
          });
        } else {
          product = await prisma.product.create({
            data: {
              ...productData,
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
      });
    } catch (error: unknown) {
      logError("Unexpected error", error);
      res.status(500).json({ error: getErrorMessage(error, "Internal server error") });
    }
  },
);
