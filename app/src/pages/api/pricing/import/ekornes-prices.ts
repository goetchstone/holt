// /app/src/pages/api/pricing/import/ekornes-prices.ts
//
// Imports Ekornes (Stressless) MRP-based pricing. Creates VendorStyles,
// Collections, grade dimension + tiers, StyleGradePrice rows, and
// a Wood Finish option group for configurator selection.
// Retail = MRP from the PDF. Cost = round(MRP x vendor.costMultiplier).

import { getErrorMessage } from "@/lib/toastError";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { ParsedEkornesProduct, ParsedEkornesFabric } from "@/lib/pricing/ekornesParser";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

// Grade tiers for Ekornes -- individual material grades.
// The parser expands combined PDF columns (e.g. "Batick & Fabrics") into
// separate tiers so each material has its own price point.
const GRADE_TIERS = [
  { code: "Batick", name: "Batick", sort: 0 },
  { code: "Fabric", name: "Fabric", sort: 1 },
  { code: "Paloma", name: "Paloma", sort: 2 },
  { code: "Dinamica", name: "Dinamica", sort: 3 },
  { code: "Velaro", name: "Velaro", sort: 4 },
  { code: "Noblesse", name: "Noblesse", sort: 5 },
  { code: "MAP", name: "Admiral MAP", sort: 6 },
  { code: "FLAT", name: "Single Price", sort: 7 },
];

// Standard Ekornes base wood finishes (from PDF page 4). No price difference.
const WOOD_FINISH_OPTIONS = [
  { name: "Black", code: "05", sort: 0 },
  { name: "Brown", code: "03", sort: 1 },
  { name: "Grey", code: "08", sort: 2 },
  { name: "Oak", code: "04", sort: 3 },
  { name: "Smoked Oak", code: "13", sort: 4 },
  { name: "Teak", code: "02", sort: 5 },
  { name: "Walnut", code: "06", sort: 6 },
  { name: "Wenge", code: "11", sort: 7 },
];

function safeDecimal(val: number | null): number | null {
  if (val == null || !isFinite(val)) return null;
  return Math.round(val * 100) / 100;
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { vendorId, priceListName, effectiveDate, products } = req.body as {
      vendorId: number;
      priceListName: string;
      effectiveDate: string;
      products: {
        products: ParsedEkornesProduct[];
        collections: string[];
        gradeTiers: string[];
        fabrics: ParsedEkornesFabric[];
      };
    };

    if (!vendorId || !priceListName || !products) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { products: ekProducts, collections: collectionNames, fabrics: ekFabrics } = products;
    if (!ekProducts || ekProducts.length === 0) {
      return res.status(400).json({ error: "No products to import" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      const costMultiplier = vendor.costMultiplier ? Number(vendor.costMultiplier) : 0.58;

      const result = await prisma.$transaction(async (tx) => {
        // 1. PriceList
        const priceList = await tx.priceList.upsert({
          where: { vendorId_name: { vendorId, name: priceListName } },
          create: {
            vendorId,
            name: priceListName,
            effectiveDate: new Date(effectiveDate),
            priceType: "RETAIL",
            isActive: true,
          },
          update: {
            effectiveDate: new Date(effectiveDate),
            isActive: true,
          },
        });

        // 2. VendorPriceDimension + tiers
        const dimension = await tx.vendorPriceDimension.upsert({
          where: { vendorId_name: { vendorId, name: "Material Grade" } },
          create: {
            vendorId,
            name: "Material Grade",
            dimensionType: "FABRIC_GRADE",
          },
          update: {},
        });

        const tierMap: Record<string, number> = {};
        for (const tier of GRADE_TIERS) {
          const t = await tx.priceDimensionTier.upsert({
            where: { dimensionId_code: { dimensionId: dimension.id, code: tier.code } },
            create: {
              dimensionId: dimension.id,
              code: tier.code,
              name: tier.name,
              sortOrder: tier.sort,
            },
            update: { sortOrder: tier.sort },
          });
          tierMap[tier.code] = t.id;
        }

        // 3. Collections
        const collectionMap: Record<string, number> = {};
        for (const name of collectionNames) {
          const collection = await tx.collection.upsert({
            where: { vendorId_name: { vendorId, name } },
            create: { vendorId, name },
            update: {},
          });
          collectionMap[name] = collection.id;
        }

        // 4. Wood Finish option group (no surcharge -- purely a configuration choice)
        const finishGroup = await tx.vendorOptionGroup.upsert({
          where: { vendorId_name: { vendorId, name: "Wood Finish" } },
          create: { vendorId, name: "Wood Finish", description: "Base wood stain finish" },
          update: {},
        });
        for (const finish of WOOD_FINISH_OPTIONS) {
          await tx.vendorOption.upsert({
            where: { groupId_name: { groupId: finishGroup.id, name: finish.name } },
            create: {
              groupId: finishGroup.id,
              name: finish.name,
              code: finish.code,
              surchargeType: "FLAT",
              defaultSurcharge: 0,
              sortOrder: finish.sort,
            },
            update: { sortOrder: finish.sort, code: finish.code },
          });
        }

        // 5. Fabric & leather catalog
        let fabricCount = 0;
        if (ekFabrics && ekFabrics.length > 0) {
          for (const fab of ekFabrics) {
            const tierId = tierMap[fab.grade];
            if (!tierId) continue;

            await tx.fabricCatalog.upsert({
              where: {
                vendorId_fabricName_colorName: {
                  vendorId,
                  fabricName: fab.fabricName,
                  colorName: fab.colorName,
                },
              },
              create: {
                vendorId,
                tierId,
                fabricName: fab.fabricName,
                fabricCode: fab.colorCode,
                colorName: fab.colorName,
                colorCode: fab.colorCode.split(" ")[1] || null,
              },
              update: {
                tierId,
                fabricCode: fab.colorCode,
                colorCode: fab.colorCode.split(" ")[1] || null,
              },
            });
            fabricCount++;
          }
        }

        // 6. Mark existing styles as discontinued
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        // 7. Import products
        for (const item of ekProducts) {
          try {
            if (!item.materialNumber) {
              skippedCount++;
              continue;
            }

            // Use the first grade price as the base retail/cost
            const firstPrice = item.gradePrices[0];
            const baseRetail = safeDecimal(firstPrice?.mrp ?? null);
            const baseCost = safeDecimal(baseRetail != null ? baseRetail * costMultiplier : null);

            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: item.materialNumber, vendorId },
              },
              create: {
                styleNumber: item.materialNumber,
                name: item.description || item.materialNumber,
                vendorId,
                collectionId: collectionMap[item.collection] || null,
                baseCost,
                baseRetail,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: item.description || item.materialNumber,
                collectionId: collectionMap[item.collection] || undefined,
                baseCost: baseCost ?? undefined,
                baseRetail: baseRetail ?? undefined,
                isDiscontinued: false,
              },
            });

            // Upsert grade prices (MRP = retail, cost = MRP x multiplier)
            for (const gp of item.gradePrices) {
              const tierId = tierMap[gp.grade];
              if (!tierId) continue;

              const retail = safeDecimal(gp.mrp);
              const cost = safeDecimal(gp.mrp * costMultiplier);
              if (retail == null) continue;

              await tx.styleGradePrice.upsert({
                where: {
                  vendorStyleId_tierId: { vendorStyleId: vendorStyle.id, tierId },
                },
                create: { vendorStyleId: vendorStyle.id, tierId, retail, cost },
                update: { retail, cost },
              });
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`${item.materialNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        return {
          importedCount,
          skippedCount,
          fabricCount,
          errors,
          priceListId: priceList.id,
        };
      }, TX_TIMEOUT.LONG);

      // Update vendor pricing model
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { pricingModel: "GRADE_BASED" },
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error: unknown) {
      logError("Ekornes import error", error);
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);
