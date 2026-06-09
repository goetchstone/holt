// /app/src/pages/api/pricing/import/retail-grade-prices.ts
//
// Imports retail-first grade-based pricing (Brown Jordan and future vendors
// where the PDF provides retail prices and cost is derived via multiplier).
//
// Creates/updates: PriceList, Collections, VendorPriceDimension (Fabric Grade),
// PriceDimensionTier (COM, A-H), VendorStyle (seating + tables),
// StyleGradePrice (with both cost and retail), FabricCatalog.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
import type {
  ParsedBJSeating,
  ParsedBJTable,
  ParsedBJFabric,
  ParsedBJFinish,
} from "@/lib/pricing/brownJordanParser";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

// Grade tiers for BJ. COM is sort 0, then A-H as 1-8, N/A for ungraded
// fabrics (cover fabric, strap colors) that belong in the catalog but aren't
// part of the grade-based pricing tiers.
const GRADE_TIERS = [
  { code: "COM", name: "COM", sort: 0 },
  { code: "A", name: "Grade A", sort: 1 },
  { code: "B", name: "Grade B", sort: 2 },
  { code: "C", name: "Grade C", sort: 3 },
  { code: "D", name: "Grade D", sort: 4 },
  { code: "E", name: "Grade E", sort: 5 },
  { code: "F", name: "Grade F", sort: 6 },
  { code: "G", name: "Grade G", sort: 7 },
  { code: "H", name: "Grade H", sort: 8 },
  { code: "N/A", name: "Not Graded", sort: 99 },
];

// Prevent Decimal overflow from concatenated price fields in PDF extraction.
// PostgreSQL Decimal(65,30) overflows above 10^35; cap well below that.
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
        seating: ParsedBJSeating[];
        tables: ParsedBJTable[];
        fabrics: ParsedBJFabric[];
        finishes: ParsedBJFinish[];
      };
    };

    if (!vendorId || !priceListName || !products) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { seating, tables, fabrics, finishes } = products;
    if (seating.length === 0 && tables.length === 0) {
      return res.status(400).json({ error: "No products to import" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      const costMultiplier = vendor.costMultiplier ? Number(vendor.costMultiplier) : 0.44;

      // Department + category for outdoor furniture
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

        // 3. Collections from both seating and table products
        const collectionNames = new Set<string>();
        for (const s of seating) {
          if (s.collection) collectionNames.add(s.collection);
        }
        for (const t of tables) {
          if (t.collection) collectionNames.add(t.collection);
        }

        const collectionMap: Record<string, number> = {};
        for (const name of collectionNames) {
          const collection = await tx.collection.upsert({
            where: { vendorId_name: { vendorId, name } },
            create: { vendorId, name },
            update: {},
          });
          collectionMap[name] = collection.id;
        }

        // 4. Mark existing styles as discontinued
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        // 5. Import seating as VendorStyles with StyleGradePrice rows
        for (const item of seating) {
          try {
            if (!item.styleNumber) {
              skippedCount++;
              continue;
            }

            // Use Grade A retail as baseRetail, derive baseCost
            const gradeAPrice = item.gradePrices.find((gp) => gp.grade === "A");
            const rawRetail = gradeAPrice?.retail ?? item.gradePrices[0]?.retail ?? null;
            const baseRetail = safeDecimal(rawRetail);
            const baseCost = safeDecimal(baseRetail != null ? baseRetail * costMultiplier : null);

            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: item.styleNumber, vendorId },
              },
              create: {
                styleNumber: item.styleNumber,
                name: item.description || item.styleNumber,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                collectionId: collectionMap[item.collection] || null,
                baseCost,
                baseRetail,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: item.description || item.styleNumber,
                collectionId: collectionMap[item.collection] || undefined,
                baseCost: baseCost ?? undefined,
                baseRetail: baseRetail ?? undefined,
                isDiscontinued: false,
              },
            });

            // Upsert grade prices (both cost and retail)
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

            // COM price
            if (item.comRetail != null && tierMap["COM"]) {
              const comRetail = safeDecimal(item.comRetail);
              const comCost = safeDecimal(item.comRetail * costMultiplier);
              if (comRetail != null) {
                await tx.styleGradePrice.upsert({
                  where: {
                    vendorStyleId_tierId: {
                      vendorStyleId: vendorStyle.id,
                      tierId: tierMap["COM"],
                    },
                  },
                  create: {
                    vendorStyleId: vendorStyle.id,
                    tierId: tierMap["COM"],
                    retail: comRetail,
                    cost: comCost,
                  },
                  update: { retail: comRetail, cost: comCost },
                });
              }
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Seating ${item.styleNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        // 6. Import tables as flat-priced VendorStyles (no grade tiers)
        for (const item of tables) {
          try {
            if (!item.styleNumber) {
              skippedCount++;
              continue;
            }

            const tableRetail = safeDecimal(item.msrp);
            const tableCost = safeDecimal(item.msrp * costMultiplier);

            await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: item.styleNumber, vendorId },
              },
              create: {
                styleNumber: item.styleNumber,
                name: item.description || item.styleNumber,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                collectionId: collectionMap[item.collection] || null,
                baseRetail: tableRetail,
                baseCost: tableCost,
                finish: item.tableTop || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: item.description || item.styleNumber,
                collectionId: collectionMap[item.collection] || undefined,
                baseRetail: tableRetail ?? undefined,
                baseCost: tableCost ?? undefined,
                finish: item.tableTop || undefined,
                isDiscontinued: false,
              },
            });

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Table ${item.styleNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        // 7. Import fabrics to FabricCatalog
        let fabricsImported = 0;
        for (const fabric of fabrics) {
          try {
            if (!fabric.fabricNumber || !fabric.grade) continue;

            const tierId = tierMap[fabric.grade];
            if (!tierId) continue;

            await tx.fabricCatalog.upsert({
              where: {
                vendorId_fabricName_colorName: {
                  vendorId,
                  fabricName: fabric.fabricName,
                  colorName: "",
                },
              },
              create: {
                vendorId,
                tierId,
                fabricName: fabric.fabricName,
                fabricCode: fabric.fabricNumber,
                colorName: "",
                collection: fabric.fabricType || null,
                isActive: true,
              },
              update: {
                tierId,
                fabricCode: fabric.fabricNumber,
                collection: fabric.fabricType || undefined,
                isActive: true,
              },
            });

            fabricsImported++;
          } catch (err: unknown) {
            errors.push(`Fabric ${fabric.fabricNumber}: ${getErrorMessage(err, "Unknown error")}`);
          }
        }

        // 8. Import paint finishes as VendorOption entries
        let finishesImported = 0;
        if (finishes && finishes.length > 0) {
          const finishGroup = await tx.vendorOptionGroup.upsert({
            where: { vendorId_name: { vendorId, name: "Paint Finish" } },
            create: {
              vendorId,
              name: "Paint Finish",
              description: "Available paint finish colors",
            },
            update: {},
          });

          for (let i = 0; i < finishes.length; i++) {
            const f = finishes[i];
            if (!f.finishName) continue;

            await tx.vendorOption.upsert({
              where: {
                groupId_name: { groupId: finishGroup.id, name: f.finishName },
              },
              create: {
                groupId: finishGroup.id,
                name: f.finishName,
                code: f.finishCode || null,
                surchargeType: "FLAT",
                defaultSurcharge: 0,
                sortOrder: i,
              },
              update: {
                code: f.finishCode || undefined,
                sortOrder: i,
              },
            });

            finishesImported++;
          }
        }

        return {
          importedCount,
          skippedCount,
          fabricsImported,
          finishesImported,
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
      logError("Retail grade-based import error", error);
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Import failed"),
      });
    }
  },
);
