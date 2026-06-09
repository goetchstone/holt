// /app/src/pages/api/pricing/import/frame-cushion-prices.ts
//
// Imports Kingsley Bate frame+cushion retail pricing.
// Creates/updates: PriceList, Collections, VendorPriceDimension (Cushion Fabric Grade),
// PriceDimensionTier (QS/A/B/C/D), VendorStyle (frames, cushions, covers),
// StyleGradePrice (cushion grade prices), FabricCatalog, VendorOptionGroups.
//
// The import endpoint receives pre-parsed data from the client (parsed by
// parseKingsleyBatePriceList via parse-pdf.ts) as JSON, following the same
// pattern as wholesale-prices.ts and wood-prices.ts.

import { getErrorMessage } from "@/lib/toastError";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { SurchargeType } from "@prisma/client";
import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import type {
  ParsedKBFrame,
  ParsedKBCushion,
  ParsedKBCover,
  ParsedKBFabric,
} from "@/lib/pricing/kingsleyBateParser";

// Increase body size limit for large imports
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

// ─── Kingsley Bate vendor-level options ──────────────────────────
// Cushion customization surcharges from the PDF (p.32).

interface OptionSeedDef {
  groupName: string;
  description: string;
  options: {
    name: string;
    surchargeType: SurchargeType;
    surcharge: number;
    sort: number;
  }[];
}

const KB_OPTION_SEEDS: OptionSeedDef[] = [
  {
    groupName: "Cushion Fill",
    description: "Cushion fill upgrade options",
    options: [
      { name: "Water-Resistant Liner", surchargeType: "PERCENTAGE", surcharge: 0.15, sort: 0 },
      { name: "Reticulated Foam", surchargeType: "FLAT", surcharge: 0, sort: 1 },
    ],
  },
  {
    groupName: "Cushion Construction",
    description: "Cushion construction surcharges",
    options: [
      { name: "Add Welt (Deep Seating)", surchargeType: "PERCENTAGE", surcharge: 0.15, sort: 0 },
      { name: "Add Welt (Other)", surchargeType: "PERCENTAGE", surcharge: 0.2, sort: 1 },
      { name: "Cut on Bias Welt", surchargeType: "PERCENTAGE", surcharge: 0.05, sort: 2 },
      { name: "Vented Design", surchargeType: "PERCENTAGE", surcharge: 0.2, sort: 3 },
    ],
  },
  {
    groupName: "Components",
    description: "Individual cushion components (seat or back only)",
    options: [
      { name: "Seat Only", surchargeType: "PERCENTAGE", surcharge: 0.6, sort: 0 },
      { name: "Back Only", surchargeType: "PERCENTAGE", surcharge: 0.6, sort: 1 },
    ],
  },
];

// ─── Cushion fabric grade tiers ──────────────────────────────────

const CUSHION_GRADE_TIERS = [
  { code: "QS", name: "Quick Ship", sort: 0 },
  { code: "A", name: "Grade A", sort: 1 },
  { code: "B", name: "Grade B", sort: 2 },
  { code: "C", name: "Grade C", sort: 3 },
  { code: "D", name: "Grade D", sort: 4 },
];

// ─── Handler ─────────────────────────────────────────────────────

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
        frames: ParsedKBFrame[];
        cushions: ParsedKBCushion[];
        covers: ParsedKBCover[];
        fabrics: ParsedKBFabric[];
      };
    };

    if (!vendorId || !priceListName || !products) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { frames, cushions, covers, fabrics } = products;
    if (frames.length === 0 && cushions.length === 0) {
      return res.status(400).json({ error: "No frames or cushions to import" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

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

      // Seed vendor-level options before the transaction
      await seedKBOptions(vendorId);

      const result = await prisma.$transaction(async (tx) => {
        // 1. Create/update PriceList
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

        // 2. Create Cushion Fabric Grade dimension + tiers
        const dimension = await tx.vendorPriceDimension.upsert({
          where: { vendorId_name: { vendorId, name: "Cushion Fabric Grade" } },
          create: {
            vendorId,
            name: "Cushion Fabric Grade",
            dimensionType: "FABRIC_GRADE",
          },
          update: {},
        });

        const tierMap: Record<string, number> = {};
        for (const tier of CUSHION_GRADE_TIERS) {
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

        // 3. Create Collections for each unique collection name from frames
        const collectionNames = new Set(frames.map((f) => f.collection).filter(Boolean));
        const collectionMap: Record<string, number> = {};
        for (const name of collectionNames) {
          const collection = await tx.collection.upsert({
            where: { vendorId_name: { vendorId, name } },
            create: { vendorId, name },
            update: {},
          });
          collectionMap[name] = collection.id;
        }

        // 4. Mark existing VendorStyles as discontinued
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        // 5. Import frames as VendorStyles
        for (const frame of frames) {
          try {
            if (!frame.styleNumber) {
              skippedCount++;
              continue;
            }

            const finishStr = [
              frame.stockedFinishes ? `STOCKED: ${frame.stockedFinishes}` : "",
              frame.specialOrderOptions ? `SPECIAL ORDER: ${frame.specialOrderOptions}` : "",
            ]
              .filter(Boolean)
              .join(" | ");

            const frameStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: frame.styleNumber, vendorId },
              },
              create: {
                styleNumber: frame.styleNumber,
                name: frame.description || frame.styleNumber,
                description: frame.category || null,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                collectionId: collectionMap[frame.collection] || null,
                framePrice: frame.framePrice,
                cushionRef: frame.cushionRef || null,
                baseRetail: frame.framePrice,
                finish: finishStr || null,
                width: frame.width || null,
                depth: frame.depth || null,
                height: frame.height || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: frame.description || frame.styleNumber,
                description: frame.category || undefined,
                collectionId: collectionMap[frame.collection] || undefined,
                framePrice: frame.framePrice,
                cushionRef: frame.cushionRef || undefined,
                baseRetail: frame.framePrice,
                finish: finishStr || undefined,
                width: frame.width ?? undefined,
                depth: frame.depth ?? undefined,
                height: frame.height ?? undefined,
                isDiscontinued: false,
              },
            });

            // Store combined (frame+cushion) retail prices from the frame section.
            // These are the authoritative A/B/C/D prices shown in the price book.
            const combinedGrades: [string, number | null][] = [
              ["A", frame.combinedPrices.a],
              ["B", frame.combinedPrices.b],
              ["C", frame.combinedPrices.c],
              ["D", frame.combinedPrices.d],
            ];
            for (const [code, price] of combinedGrades) {
              if (price === null) continue;
              const tierId = tierMap[code];
              if (!tierId) continue;
              await tx.styleGradePrice.upsert({
                where: {
                  vendorStyleId_tierId: { vendorStyleId: frameStyle.id, tierId },
                },
                create: { vendorStyleId: frameStyle.id, tierId, retail: price },
                update: { retail: price },
              });
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Frame ${frame.styleNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        // 6. Import cushions as VendorStyles with StyleGradePrice rows
        for (const cushion of cushions) {
          try {
            if (!cushion.cushionCode) {
              skippedCount++;
              continue;
            }

            const fitsStr = cushion.fitsFrames.join(", ");

            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: cushion.cushionCode, vendorId },
              },
              create: {
                styleNumber: cushion.cushionCode,
                name: cushion.description || cushion.cushionCode,
                description: fitsStr ? `Fits: ${fitsStr}` : null,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                comYardage: cushion.comYardage,
                finish: cushion.fabricRestriction
                  ? `Restriction: ${cushion.fabricRestriction}`
                  : null,
                isActive: true,
                isDiscontinued: cushion.isDiscontinued,
              },
              update: {
                name: cushion.description || cushion.cushionCode,
                description: fitsStr ? `Fits: ${fitsStr}` : undefined,
                comYardage: cushion.comYardage ?? undefined,
                finish: cushion.fabricRestriction
                  ? `Restriction: ${cushion.fabricRestriction}`
                  : undefined,
                isDiscontinued: cushion.isDiscontinued,
              },
            });

            // Upsert grade prices for QS, A, B, C, D (retail prices)
            const gradePrices: [string, number | null][] = [
              ["QS", cushion.prices.qs],
              ["A", cushion.prices.a],
              ["B", cushion.prices.b],
              ["C", cushion.prices.c],
              ["D", cushion.prices.d],
            ];

            for (const [code, price] of gradePrices) {
              if (price === null) continue;
              const tierId = tierMap[code];
              if (!tierId) continue;

              await tx.styleGradePrice.upsert({
                where: {
                  vendorStyleId_tierId: { vendorStyleId: vendorStyle.id, tierId },
                },
                create: {
                  vendorStyleId: vendorStyle.id,
                  tierId,
                  retail: price,
                },
                update: {
                  retail: price,
                },
              });
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Cushion ${cushion.cushionCode}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        // 6b. Cross-reference: use cushion fitsFrames to update frame cushionRef
        for (const cushion of cushions) {
          if (!cushion.cushionCode || cushion.fitsFrames.length === 0) continue;
          await tx.vendorStyle.updateMany({
            where: {
              vendorId,
              styleNumber: { in: cushion.fitsFrames },
              framePrice: { not: null },
            },
            data: { cushionRef: cushion.cushionCode },
          });
        }

        // 7. Import covers as VendorStyles
        for (const cover of covers) {
          try {
            if (!cover.coverCode) {
              skippedCount++;
              continue;
            }

            await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: cover.coverCode, vendorId },
              },
              create: {
                styleNumber: cover.coverCode,
                name: cover.description || cover.coverCode,
                description: cover.fitsFrame ? `Fits: ${cover.fitsFrame}` : null,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                baseRetail: cover.retailPrice,
                cushionRef: cover.fitsFrame || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: cover.description || cover.coverCode,
                description: cover.fitsFrame ? `Fits: ${cover.fitsFrame}` : undefined,
                baseRetail: cover.retailPrice,
                cushionRef: cover.fitsFrame || undefined,
                isDiscontinued: false,
              },
            });

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Cover ${cover.coverCode}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        // 8. Import fabrics to FabricCatalog
        let fabricsImported = 0;
        for (const fabric of fabrics) {
          try {
            if (!fabric.code || !fabric.grade) continue;

            const tierId = tierMap[fabric.grade];
            if (!tierId) continue;

            await tx.fabricCatalog.upsert({
              where: {
                vendorId_fabricName_colorName: {
                  vendorId,
                  fabricName: fabric.name,
                  colorName: "",
                },
              },
              create: {
                vendorId,
                tierId,
                fabricName: fabric.name,
                fabricCode: fabric.code,
                colorName: "",
                notes:
                  [
                    fabric.weltType !== "Self" ? `Welt: ${fabric.weltType}` : "",
                    fabric.restrictionCode ? `Restriction: ${fabric.restrictionCode}` : "",
                  ]
                    .filter(Boolean)
                    .join("; ") || null,
                isActive: true,
              },
              update: {
                tierId,
                fabricCode: fabric.code,
                notes:
                  [
                    fabric.weltType !== "Self" ? `Welt: ${fabric.weltType}` : "",
                    fabric.restrictionCode ? `Restriction: ${fabric.restrictionCode}` : "",
                  ]
                    .filter(Boolean)
                    .join("; ") || undefined,
                isActive: true,
              },
            });

            fabricsImported++;
          } catch (err: unknown) {
            errors.push(`Fabric ${fabric.code}: ${getErrorMessage(err, "Unknown error")}`);
          }
        }

        return {
          importedCount,
          skippedCount,
          fabricsImported,
          errors,
          priceListId: priceList.id,
        };
      }, TX_TIMEOUT.LONG);

      // Update vendor pricing model
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { pricingModel: "FRAME_PLUS_CUSHION" },
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error: unknown) {
      logError("Frame+cushion import error", error);
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);

// ─── Helpers ─────────────────────────────────────────────────────

async function seedKBOptions(vendorId: number): Promise<void> {
  for (const groupDef of KB_OPTION_SEEDS) {
    const group = await prisma.vendorOptionGroup.upsert({
      where: { vendorId_name: { vendorId, name: groupDef.groupName } },
      create: {
        vendorId,
        name: groupDef.groupName,
        description: groupDef.description,
      },
      update: {},
    });

    for (const opt of groupDef.options) {
      await prisma.vendorOption.upsert({
        where: { groupId_name: { groupId: group.id, name: opt.name } },
        create: {
          groupId: group.id,
          name: opt.name,
          surchargeType: opt.surchargeType,
          defaultSurcharge: opt.surcharge,
          sortOrder: opt.sort,
        },
        update: {},
      });
    }
  }
}
