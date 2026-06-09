// /app/src/pages/api/pricing/import/jensen-prices.ts
//
// Imports Jensen Leisure retail-first grade-based pricing.
// PDF prices are retail; wholesale cost = retail * vendor.costMultiplier.
//
// Creates/updates: PriceList, Collections, VendorPriceDimension (Fabric Grade),
// PriceDimensionTier (C/D/E/U), VendorStyle (cushioned + frame-only + cushion-only),
// StyleGradePrice (with both cost and retail).

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { ParsedJLProduct, ParsedJLCollection } from "@/lib/pricing/jensenLeisureParser";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

const GRADE_TIERS = [
  { code: "C", name: "Grade C", sort: 0 },
  { code: "D", name: "Grade D", sort: 1 },
  { code: "E", name: "Grade E", sort: 2 },
  { code: "U", name: "Grade U", sort: 3 },
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
    const {
      vendorId,
      priceListName,
      effectiveDate,
      products: data,
    } = req.body as {
      vendorId: number;
      priceListName: string;
      effectiveDate: string;
      products: {
        products: ParsedJLProduct[];
        collections: ParsedJLCollection[];
      };
    };

    if (!vendorId || !priceListName || !data?.products) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { products, collections } = data;
    if (products.length === 0) {
      return res.status(400).json({ error: "No products to import" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      const costMultiplier = vendor.costMultiplier ? Number(vendor.costMultiplier) : 0.44;

      const department = await prisma.department.upsert({
        where: { name: "Outdoor" },
        create: { name: "Outdoor" },
        update: {},
      });

      const category = await prisma.category.upsert({
        where: {
          name_departmentId: { name: "Outdoor Furniture", departmentId: department.id },
        },
        create: { name: "Outdoor Furniture", departmentId: department.id },
        update: {},
      });

      const result = await prisma.$transaction(async (tx) => {
        // 1. PriceList
        const priceList = await tx.priceList.upsert({
          where: {
            vendorId_name: { vendorId, name: priceListName },
          },
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
          where: { vendorId_name: { vendorId, name: "Fabric Grade" } },
          create: {
            vendorId,
            name: "Fabric Grade",
            dimensionType: "FABRIC_GRADE",
          },
          update: {},
        });

        const tierMap: Record<string, number> = {};
        for (const tier of GRADE_TIERS) {
          const t = await tx.priceDimensionTier.upsert({
            where: {
              dimensionId_code: { dimensionId: dimension.id, code: tier.code },
            },
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
        for (const col of collections) {
          const collection = await tx.collection.upsert({
            where: { vendorId_name: { vendorId, name: col.name } },
            create: { vendorId, name: col.name },
            update: {},
          });
          collectionMap[col.name] = collection.id;
        }

        // 4. Mark existing styles as discontinued
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        // 5. Import products
        for (const item of products) {
          try {
            if (!item.itemNumber) {
              skippedCount++;
              continue;
            }

            // baseRetail: lowest grade (C) for graded items, or frame price for frame-only
            const gradeC = item.gradePrices.find((gp) => gp.grade === "C");
            const rawRetail =
              gradeC?.retail ?? item.gradePrices[0]?.retail ?? item.framePrice ?? null;
            const baseRetail = safeDecimal(rawRetail);
            const baseCost = safeDecimal(baseRetail != null ? baseRetail * costMultiplier : null);
            const frameRetail = safeDecimal(item.framePrice);

            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: item.itemNumber, vendorId },
              },
              create: {
                styleNumber: item.itemNumber,
                name: item.description || item.itemNumber,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                collectionId: collectionMap[item.collection] || null,
                baseCost,
                baseRetail,
                framePrice: frameRetail,
                comYardage: item.comYardage,
                finish: item.materialType,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: item.description || item.itemNumber,
                collectionId: collectionMap[item.collection] || undefined,
                baseCost: baseCost ?? undefined,
                baseRetail: baseRetail ?? undefined,
                framePrice: frameRetail ?? undefined,
                comYardage: item.comYardage ?? undefined,
                finish: item.materialType || undefined,
                isDiscontinued: false,
              },
            });

            // StyleGradePrice rows (both cost and retail)
            for (const gp of item.gradePrices) {
              const tierId = tierMap[gp.grade];
              if (!tierId) continue;

              const retail = safeDecimal(gp.retail);
              const cost = safeDecimal(gp.retail * costMultiplier);
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
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${item.itemNumber}: ${msg}`);
            skippedCount++;
          }
        }

        return {
          importedCount,
          skippedCount,
          errors,
          priceListId: priceList.id,
        };
      }, TX_TIMEOUT.LONG);

      await prisma.vendor.update({
        where: { id: vendorId },
        data: { pricingModel: "FRAME_PLUS_CUSHION" },
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("Jensen import error", msg);
      return res.status(500).json({
        error: "Import failed",
        details: msg,
      });
    }
  },
);
