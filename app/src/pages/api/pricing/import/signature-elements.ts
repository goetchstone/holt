// /app/src/pages/api/pricing/import/signature-elements.ts
//
// POST /api/pricing/import/signature-elements
//
// Imports Signature Elements pricing from the Wesley Hall wholesale PDF.
// Creates synthetic VendorStyles (e.g., SE-F21-XLS) for each piece-type +
// material + depth combination, with per-grade pricing and cushion upgrade
// option overrides. Also seeds SEComponent records for the configurator UI.

import { getErrorMessage } from "@/lib/toastError";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { ParsedSEProduct } from "@/lib/pricing/wesleyHallParser";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

// Grade sort: COM/COL first, then numeric, then letter
function sortGrades(a: string, b: string): number {
  if (a === "COM" || a === "COL") return -1;
  if (b === "COM" || b === "COL") return 1;
  const numA = Number.parseInt(a);
  const numB = Number.parseInt(b);
  if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
  if (!Number.isNaN(numA)) return -1;
  if (!Number.isNaN(numB)) return 1;
  return a.localeCompare(b);
}

function tierDisplayName(code: string): string {
  if (code === "COM") return "COM (Customer's Own Material)";
  if (code === "COL") return "COL (Customer's Own Leather)";
  return `Grade ${code}`;
}

// SE component catalog for the configurator wizard.
// Each array defines the selectable options for one component type.
const SE_COMPONENT_SEEDS: {
  componentType: string;
  entries: { code: string; name: string; sortOrder: number; isDefault?: boolean }[];
}[] = [
  {
    componentType: "DEPTH",
    entries: [
      { code: "21", name: 'Standard Depth (21")', sortOrder: 0, isDefault: true },
      { code: "24", name: 'Extended Depth (24")', sortOrder: 1 },
    ],
  },
  {
    componentType: "BASE",
    entries: [
      { code: "1", name: "Tapered Leg", sortOrder: 0, isDefault: true },
      { code: "2", name: "Turned Leg", sortOrder: 1 },
      { code: "3", name: "Bun Foot", sortOrder: 2 },
      { code: "4", name: "Skirted", sortOrder: 3 },
      { code: "5", name: "Plinth Base", sortOrder: 4 },
      { code: "6", name: "Block Leg", sortOrder: 5 },
      { code: "7", name: "Metal Leg", sortOrder: 6 },
      { code: "8", name: "Swivel Base", sortOrder: 7 },
    ],
  },
  {
    componentType: "ARM",
    entries: [
      { code: "A", name: "English Arm", sortOrder: 0, isDefault: true },
      { code: "B", name: "Track Arm", sortOrder: 1 },
      { code: "C", name: "Slope Arm", sortOrder: 2 },
      { code: "D", name: "Flared Arm", sortOrder: 3 },
      { code: "E", name: "Key Arm", sortOrder: 4 },
      { code: "F", name: "Sock Arm", sortOrder: 5 },
      { code: "G", name: "Tuxedo Arm", sortOrder: 6 },
      { code: "H", name: "Pleated Arm", sortOrder: 7 },
      { code: "J", name: "Scoop Arm", sortOrder: 8 },
    ],
  },
  {
    componentType: "BACK_TYPE",
    entries: [
      { code: "TB", name: "Tight Back", sortOrder: 0, isDefault: true },
      { code: "FB", name: "Filled Back", sortOrder: 1 },
      { code: "LB", name: "Loose Back", sortOrder: 2 },
      { code: "CB", name: "Channeled Back", sortOrder: 3 },
      { code: "TF", name: "Tufted Back", sortOrder: 4 },
      { code: "SB", name: "Shelter Back", sortOrder: 5 },
    ],
  },
  {
    componentType: "CUSHION_FILL",
    entries: [
      { code: "UC", name: "Ultra Crown (Standard)", sortOrder: 0, isDefault: true },
      { code: "CD", name: "Comfort Down", sortOrder: 1 },
      { code: "SD", name: "Spring Down", sortOrder: 2 },
    ],
  },
  {
    componentType: "CASTOR",
    entries: [
      { code: "NONE", name: "No Castors", sortOrder: 0, isDefault: true },
      { code: "STD", name: "Standard Castors", sortOrder: 1 },
    ],
  },
];

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
      products: ParsedSEProduct[];
    };

    if (!vendorId || !priceListName || !products || products.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // Collect all unique grades across all SE products
      const allGrades = new Set<string>();
      for (const p of products) {
        for (const gp of p.gradePrices) {
          allGrades.add(gp.grade);
        }
      }
      const sortedGrades = Array.from(allGrades).sort(sortGrades);

      // Detect fabric vs leather from grades
      const hasFabricGrades = sortedGrades.some(
        (g) => g === "COM" || !Number.isNaN(Number.parseInt(g)),
      );
      const hasLeatherGrades = sortedGrades.some(
        (g) => g === "COL" || (g.length === 1 && g >= "C" && g <= "Z"),
      );

      // SE products span both fabric and leather dimensions. Create both if needed.
      const fabricDimName = "Fabric Grade";
      const leatherDimName = "Leather Grade";

      const result = await prisma.$transaction(async (tx) => {
        // 1. Create/update PriceList
        const priceList = await tx.priceList.upsert({
          where: { vendorId_name: { vendorId, name: priceListName } },
          create: {
            vendorId,
            name: priceListName,
            effectiveDate: new Date(effectiveDate),
            priceType: "COST",
            isActive: true,
          },
          update: {
            effectiveDate: new Date(effectiveDate),
            isActive: true,
          },
        });

        // 2. Ensure dimensions and tiers exist for both fabric and leather
        const tierMap: Record<string, number> = {};

        if (hasFabricGrades) {
          const dim = await tx.vendorPriceDimension.upsert({
            where: { vendorId_name: { vendorId, name: fabricDimName } },
            create: { vendorId, name: fabricDimName, dimensionType: "FABRIC_GRADE" },
            update: {},
          });
          const fabricGrades = sortedGrades.filter(
            (g) => g === "COM" || !Number.isNaN(Number.parseInt(g)),
          );
          for (let i = 0; i < fabricGrades.length; i++) {
            const tier = await tx.priceDimensionTier.upsert({
              where: { dimensionId_code: { dimensionId: dim.id, code: fabricGrades[i] } },
              create: {
                dimensionId: dim.id,
                name: tierDisplayName(fabricGrades[i]),
                code: fabricGrades[i],
                sortOrder: i,
              },
              update: {},
            });
            tierMap[fabricGrades[i]] = tier.id;
          }
        }

        if (hasLeatherGrades) {
          const dim = await tx.vendorPriceDimension.upsert({
            where: { vendorId_name: { vendorId, name: leatherDimName } },
            create: { vendorId, name: leatherDimName, dimensionType: "LEATHER_GRADE" },
            update: {},
          });
          const leatherGrades = sortedGrades.filter(
            (g) => g === "COL" || (g.length === 1 && g >= "C" && g <= "Z"),
          );
          for (let i = 0; i < leatherGrades.length; i++) {
            const tier = await tx.priceDimensionTier.upsert({
              where: { dimensionId_code: { dimensionId: dim.id, code: leatherGrades[i] } },
              create: {
                dimensionId: dim.id,
                name: tierDisplayName(leatherGrades[i]),
                code: leatherGrades[i],
                sortOrder: i,
              },
              update: {},
            });
            tierMap[leatherGrades[i]] = tier.id;
          }
        }

        // 3. Mark existing SE styles as discontinued; upserts below reactivate current ones
        await tx.vendorStyle.updateMany({
          where: { vendorId, styleNumber: { startsWith: "SE-" } },
          data: { isDiscontinued: true },
        });

        // 4. Ensure cushion upgrade option groups exist for overrides
        const cushionGroup = await tx.vendorOptionGroup.upsert({
          where: { vendorId_name: { vendorId, name: "Cushion Fill" } },
          create: { vendorId, name: "Cushion Fill" },
          update: {},
        });
        const comfortDownOpt = await tx.vendorOption.upsert({
          where: { groupId_name: { groupId: cushionGroup.id, name: "Comfort Down" } },
          create: {
            groupId: cushionGroup.id,
            name: "Comfort Down",
            surchargeType: "FLAT",
            defaultSurcharge: 0,
            sortOrder: 1,
          },
          update: {},
        });
        const springDownOpt = await tx.vendorOption.upsert({
          where: { groupId_name: { groupId: cushionGroup.id, name: "Spring Down" } },
          create: {
            groupId: cushionGroup.id,
            name: "Spring Down",
            surchargeType: "FLAT",
            defaultSurcharge: 0,
            sortOrder: 2,
          },
          update: {},
        });

        // Decorative finish option
        const woodFinishGroup = await tx.vendorOptionGroup.upsert({
          where: { vendorId_name: { vendorId, name: "Wood Finish" } },
          create: { vendorId, name: "Wood Finish" },
          update: {},
        });
        const decFinishOpt = await tx.vendorOption.upsert({
          where: { groupId_name: { groupId: woodFinishGroup.id, name: "Decorative Finish" } },
          create: {
            groupId: woodFinishGroup.id,
            name: "Decorative Finish",
            code: "DEC",
            surchargeType: "FLAT",
            defaultSurcharge: 100,
            sortOrder: 10,
          },
          update: {},
        });

        // 5. Upsert VendorStyles with grade prices and cushion overrides
        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        for (const p of products) {
          try {
            if (p.gradePrices.length === 0) {
              skippedCount++;
              continue;
            }

            const basePrice = p.gradePrices.find((gp) => gp.grade === "COM" || gp.grade === "COL");

            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: p.styleNumber, vendorId },
              },
              create: {
                styleNumber: p.styleNumber,
                name: `SE ${p.styleName}`,
                description: p.description,
                vendorId,
                baseCost: basePrice ? basePrice.cost : null,
                gradeRiser: p.gradeRiser,
                standardSeat: p.standardSeat,
                standardBack: p.standardBack,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: `SE ${p.styleName}`,
                description: p.description,
                baseCost: basePrice ? basePrice.cost : undefined,
                gradeRiser: p.gradeRiser ?? undefined,
                standardSeat: p.standardSeat ?? undefined,
                standardBack: p.standardBack ?? undefined,
                isActive: true,
                isDiscontinued: false,
              },
            });

            // Grade prices
            for (const gp of p.gradePrices) {
              const tierId = tierMap[gp.grade];
              if (!tierId) continue;
              await tx.styleGradePrice.upsert({
                where: {
                  vendorStyleId_tierId: { vendorStyleId: vendorStyle.id, tierId },
                },
                create: { vendorStyleId: vendorStyle.id, tierId, cost: gp.cost },
                update: { cost: gp.cost },
              });
            }

            // Cushion upgrade overrides (Comfort Down and Spring Down).
            // The surcharge depends on back type (Tight Back vs Filled Back).
            // We store the Tight Back surcharge as the default since it's more
            // common; the SE configurator adjusts for Filled Back at runtime.
            if (p.comfortDownTightBack != null) {
              await tx.styleOptionOverride.upsert({
                where: {
                  vendorStyleId_optionId: {
                    vendorStyleId: vendorStyle.id,
                    optionId: comfortDownOpt.id,
                  },
                },
                create: {
                  vendorStyleId: vendorStyle.id,
                  optionId: comfortDownOpt.id,
                  surcharge: p.comfortDownTightBack,
                  isAvailable: true,
                  isStandard: false,
                },
                update: {
                  surcharge: p.comfortDownTightBack,
                  isAvailable: true,
                },
              });
            }

            if (p.springDownTightBack != null) {
              await tx.styleOptionOverride.upsert({
                where: {
                  vendorStyleId_optionId: {
                    vendorStyleId: vendorStyle.id,
                    optionId: springDownOpt.id,
                  },
                },
                create: {
                  vendorStyleId: vendorStyle.id,
                  optionId: springDownOpt.id,
                  surcharge: p.springDownTightBack,
                  isAvailable: true,
                  isStandard: false,
                },
                update: {
                  surcharge: p.springDownTightBack,
                  isAvailable: true,
                },
              });
            }

            // Decorative finish override
            if (p.decorativeFinishSurcharge != null) {
              await tx.styleOptionOverride.upsert({
                where: {
                  vendorStyleId_optionId: {
                    vendorStyleId: vendorStyle.id,
                    optionId: decFinishOpt.id,
                  },
                },
                create: {
                  vendorStyleId: vendorStyle.id,
                  optionId: decFinishOpt.id,
                  surcharge: p.decorativeFinishSurcharge,
                  isAvailable: true,
                  isStandard: false,
                },
                update: {
                  surcharge: p.decorativeFinishSurcharge,
                  isAvailable: true,
                },
              });
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Style ${p.styleNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        return { importedCount, skippedCount, errors, priceListId: priceList.id };
      }, TX_TIMEOUT.LONG);

      // 6. Seed SE component catalog (outside transaction for idempotency)
      for (const group of SE_COMPONENT_SEEDS) {
        for (const entry of group.entries) {
          await prisma.sEComponent.upsert({
            where: {
              vendorId_componentType_code: {
                vendorId,
                componentType: group.componentType,
                code: entry.code,
              },
            },
            create: {
              vendorId,
              componentType: group.componentType,
              code: entry.code,
              name: entry.name,
              sortOrder: entry.sortOrder,
              isDefault: entry.isDefault ?? false,
            },
            update: {
              name: entry.name,
              sortOrder: entry.sortOrder,
              isDefault: entry.isDefault ?? false,
            },
          });
        }
      }

      // Also seed piece type components from the imported products
      const seenPieceTypes = new Set<string>();
      let ptSortOrder = 0;
      for (const p of products) {
        if (seenPieceTypes.has(p.pieceTypeCode)) continue;
        seenPieceTypes.add(p.pieceTypeCode);
        await prisma.sEComponent.upsert({
          where: {
            vendorId_componentType_code: {
              vendorId,
              componentType: "PIECE_TYPE",
              code: p.pieceTypeCode,
            },
          },
          create: {
            vendorId,
            componentType: "PIECE_TYPE",
            code: p.pieceTypeCode,
            name: p.styleName,
            sortOrder: ptSortOrder++,
          },
          update: {
            name: p.styleName,
            sortOrder: ptSortOrder - 1,
          },
        });
      }

      return res.status(200).json({
        success: true,
        ...result,
        componentsSeeded: SE_COMPONENT_SEEDS.reduce((sum, g) => sum + g.entries.length, 0),
        pieceTypesSeeded: seenPieceTypes.size,
      });
    } catch (error: unknown) {
      logError("SE import error", error);
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);
