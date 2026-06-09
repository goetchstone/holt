// /app/src/pages/api/pricing/import/american-leather.ts
//
// Imports American Leather retail (MRP) and optional wholesale pricing.
// Creates VendorStyles, Collections, dual grade dimensions (Leather Grade
// + Fabric Grade), StyleGradePrice rows, and option groups.
//
// Retail prices are the store's selling price. Wholesale prices are stored
// as cost for margin reporting. When only wholesale is available for an
// option, the program-level multiplier derives an estimated retail.

import { getErrorMessage } from "@/lib/toastError";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { ALParsedProduct, ALParsedPage } from "@/lib/pricing/americanLeatherExtractor";
import {
  parseOptionPrices,
  parseMattressPrices,
  extractPowerBatteryOptions,
  frameSizeFromNumber,
  parseStandardFeatures,
} from "@/lib/pricing/americanLeatherExtractor";
import type { ALStandardFeatures } from "@/lib/pricing/americanLeatherExtractor";
import type { SurchargeType } from "@prisma/client";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

// ─── Grade tier definitions ──────────────────────────────────────

const LEATHER_TIERS = [
  { code: "C", name: "Grade C", sort: 0 },
  { code: "D/F", name: "Grade D/F (C.O.L.)", sort: 1 },
  { code: "G", name: "Grade G", sort: 2 },
  { code: "H", name: "Grade H", sort: 3 },
  { code: "J", name: "Grade J", sort: 4 },
];

const FABRIC_TIERS = [
  { code: "I", name: "Grade I (C.O.M.)", sort: 0 },
  { code: "II", name: "Grade II", sort: 1 },
  { code: "III", name: "Grade III", sort: 2 },
  { code: "V", name: "Grade V", sort: 3 },
];

// ─── Program-level cost-to-retail multipliers ────────────────────
// Used when only wholesale pricing is available for an option and
// we need to derive an estimated retail price.

const PROGRAM_MULTIPLIER: Record<string, number> = {
  "Comfort Sleeper": 2.3,
  "Silver Sleeper": 2.3,
  "Today Sleeper": 2.01,
  "Comfort Air": 1.91,
  "Comfort Air Echo": 1.91,
  "Comfort Solace": 1.91,
  "Style In Motion": 3.31,
  "Style In Motion A": 3.31,
  "Style In Motion I": 3.31,
  "Style In Motion L": 3.31,
  "Style In Motion M": 3.31,
  "Re-Invented Recliner": 2.0,
  "Recliner Program": 2.0,
  "Comfort Relax": 2.0,
  Personalize: 2.3,
  "American Leather": 3.31,
};

function getMultiplier(programType: string): number {
  return PROGRAM_MULTIPLIER[programType] ?? 2.3;
}

function safeDecimal(val: number | null | undefined): number | null {
  if (val == null || !isFinite(val)) return null;
  return Math.round(val * 100) / 100;
}

// ─── Static option seeds ─────────────────────────────────────────
// Options that appear across most AL products but have no extracted
// surcharge (selection-only) or a fixed price for all styles.

interface OptionSeedDef {
  groupName: string;
  options: {
    name: string;
    surchargeType: SurchargeType;
    surcharge: number;
    sort: number;
    requiresTextInput?: boolean;
    textInputLabel?: string;
  }[];
}

const AL_OPTION_SEEDS: OptionSeedDef[] = [
  {
    groupName: "Leg Finish",
    options: [
      { name: "Aluminum (Standard)", surchargeType: "FLAT", surcharge: 0, sort: 0 },
      { name: "Wood - Dune", surchargeType: "FLAT", surcharge: 0, sort: 1 },
      { name: "Wood - Ebony", surchargeType: "FLAT", surcharge: 0, sort: 2 },
      { name: "Wood - Mink", surchargeType: "FLAT", surcharge: 0, sort: 3 },
      { name: "Wood - Oiled Ash", surchargeType: "FLAT", surcharge: 0, sort: 4 },
      { name: "Metal - Antique Brass", surchargeType: "FLAT", surcharge: 0, sort: 5 },
      { name: "Metal - Burnished Bronze", surchargeType: "FLAT", surcharge: 0, sort: 6 },
      { name: "Metal - Polished Nickel", surchargeType: "FLAT", surcharge: 0, sort: 7 },
    ],
  },
  {
    groupName: "Natural Walnut Upgrade",
    options: [{ name: "Solid Natural Walnut", surchargeType: "FLAT", surcharge: 195, sort: 0 }],
  },
  {
    groupName: "Contrasting Stitch",
    options: [
      {
        name: "Contrasting Stitch Detail",
        surchargeType: "FLAT",
        surcharge: 0,
        sort: 0,
        requiresTextInput: true,
        textInputLabel: "Thread color",
      },
    ],
  },
];

// ─── Request body types ──────────────────────────────────────────

interface ImportBody {
  vendorId: number;
  priceListName: string;
  effectiveDate: string;
  products: {
    products: ALParsedProduct[];
    pages?: ALParsedPage[];
    collections: string[];
    effectiveDate: string | null;
    isRetail: boolean;
  };
}

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { vendorId, priceListName, effectiveDate, products } = req.body as ImportBody;

    if (!vendorId || !priceListName || !products) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const {
      products: alProducts,
      pages: alPages,
      collections: collectionNames,
      isRetail,
    } = products;
    if (!alProducts || alProducts.length === 0) {
      return res.status(400).json({ error: "No products to import" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // costMultiplier is used when importing a retail PDF to derive wholesale cost.
      // For American Leather, this varies by program, so we use the program-level
      // multipliers instead. The vendor.costMultiplier is a fallback.
      const vendorMultiplier = vendor.costMultiplier ? Number(vendor.costMultiplier) : null;

      // Deduplicate by frameNumber -- multi-page PDFs can produce duplicates
      const deduped = new Map<string, ALParsedProduct>();
      for (const p of alProducts) {
        if (p.frameNumber) {
          deduped.set(p.frameNumber, p);
        }
      }
      const uniqueProducts = Array.from(deduped.values());

      // Find or create department and category
      const department = await prisma.department.upsert({
        where: { name: "Upholstery" },
        create: { name: "Upholstery" },
        update: {},
      });

      const category = await prisma.category.upsert({
        where: {
          name_departmentId: { name: "Upholstered Furniture", departmentId: department.id },
        },
        create: { name: "Upholstered Furniture", departmentId: department.id },
        update: {},
      });

      const result = await prisma.$transaction(async (tx) => {
        // 1. PriceList
        const priceList = await tx.priceList.upsert({
          where: { vendorId_name: { vendorId, name: priceListName } },
          create: {
            vendorId,
            name: priceListName,
            effectiveDate: new Date(effectiveDate),
            priceType: isRetail ? "RETAIL" : "COST",
            isActive: true,
          },
          update: {
            effectiveDate: new Date(effectiveDate),
            priceType: isRetail ? "RETAIL" : "COST",
            isActive: true,
          },
        });

        // 2. Leather Grade dimension + tiers
        const leatherDim = await tx.vendorPriceDimension.upsert({
          where: { vendorId_name: { vendorId, name: "Leather Grade" } },
          create: { vendorId, name: "Leather Grade", dimensionType: "LEATHER_GRADE" },
          update: {},
        });

        const tierMap: Record<string, number> = {};
        for (const tier of LEATHER_TIERS) {
          const t = await tx.priceDimensionTier.upsert({
            where: { dimensionId_code: { dimensionId: leatherDim.id, code: tier.code } },
            create: {
              dimensionId: leatherDim.id,
              code: tier.code,
              name: tier.name,
              sortOrder: tier.sort,
            },
            update: { name: tier.name, sortOrder: tier.sort },
          });
          tierMap[tier.code] = t.id;
        }

        // 3. Fabric Grade dimension + tiers
        const fabricDim = await tx.vendorPriceDimension.upsert({
          where: { vendorId_name: { vendorId, name: "Fabric Grade" } },
          create: { vendorId, name: "Fabric Grade", dimensionType: "FABRIC_GRADE" },
          update: {},
        });

        for (const tier of FABRIC_TIERS) {
          const t = await tx.priceDimensionTier.upsert({
            where: { dimensionId_code: { dimensionId: fabricDim.id, code: tier.code } },
            create: {
              dimensionId: fabricDim.id,
              code: tier.code,
              name: tier.name,
              sortOrder: tier.sort,
            },
            update: { name: tier.name, sortOrder: tier.sort },
          });
          tierMap[tier.code] = t.id;
        }

        // 4. Collections
        const collectionMap: Record<string, number> = {};
        for (const name of collectionNames) {
          const collection = await tx.collection.upsert({
            where: { vendorId_name: { vendorId, name } },
            create: { vendorId, name },
            update: {},
          });
          collectionMap[name] = collection.id;
        }

        // 5. Mark existing styles as discontinued
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        // 6. Seed static option groups (leg finish, walnut, stitch)
        const optionIdMap: Record<string, number> = {};
        for (const groupDef of AL_OPTION_SEEDS) {
          const group = await tx.vendorOptionGroup.upsert({
            where: { vendorId_name: { vendorId, name: groupDef.groupName } },
            create: { vendorId, name: groupDef.groupName },
            update: {},
          });
          for (const opt of groupDef.options) {
            const option = await tx.vendorOption.upsert({
              where: { groupId_name: { groupId: group.id, name: opt.name } },
              create: {
                groupId: group.id,
                name: opt.name,
                surchargeType: opt.surchargeType,
                defaultSurcharge: opt.surcharge,
                sortOrder: opt.sort,
                requiresTextInput: opt.requiresTextInput ?? false,
                textInputLabel: opt.textInputLabel ?? null,
              },
              update: {
                requiresTextInput: opt.requiresTextInput ?? false,
                textInputLabel: opt.textInputLabel ?? null,
              },
            });
            optionIdMap[`${groupDef.groupName}::${opt.name}`] = option.id;
          }
        }

        // 7. Parse dynamic options and standard features from page data
        // Build caches keyed by (collectionName, programType) for lookup during product import
        interface ParsedPageOptions {
          cushionOptions: { name: string; price: number; perSeat: boolean }[];
          mattressPrices: {
            size: string;
            gelPrice: number | null;
            tempurPedicPrice: number | null;
          }[];
          powerBatteryOptions: { name: string; price: number; perSeat: boolean }[];
          generalOptions: { name: string; price: number; perSeat: boolean }[];
        }
        const pageOptionsCache = new Map<string, ParsedPageOptions>();
        const stdFeaturesCache = new Map<string, ALStandardFeatures>();

        if (alPages && alPages.length > 0) {
          for (const page of alPages) {
            const key = `${page.collectionName}::${page.programType}`;

            // Standard features (one per collection/program combination)
            if (!stdFeaturesCache.has(key)) {
              stdFeaturesCache.set(key, parseStandardFeatures(page.standardFeaturesText));
            }

            if (pageOptionsCache.has(key)) continue;

            const allParsed = parseOptionPrices(page.optionsText);
            const mattressOpts = parseMattressPrices(page.optionsText);
            const powerOpts = extractPowerBatteryOptions(page.optionsText);

            // Split parsed options: cushion fills (asterisk prefix) vs general options
            const cushionNames = new Set<string>();
            // [^=\n]+? avoids the ambiguous \w/\s/\s* nesting flagged by polynomial-redos.
            // Greedy [^=\n]+ can't backtrack across `=` (excluded from char class).
            const cushionPattern = /\*([^=\n]+)=\s{0,16}\$(\d+)/g;
            let m;
            while ((m = cushionPattern.exec(page.optionsText)) !== null) {
              cushionNames.add(m[1].trim().toLowerCase());
            }

            const cushionOptions: ParsedPageOptions["cushionOptions"] = [];
            const generalOptions: ParsedPageOptions["generalOptions"] = [];
            for (const o of allParsed) {
              const entry = { name: o.optionName, price: o.retailPrice ?? 0, perSeat: o.perSeat };
              if (cushionNames.has(o.optionName.toLowerCase())) {
                cushionOptions.push(entry);
              } else {
                generalOptions.push(entry);
              }
            }

            pageOptionsCache.set(key, {
              cushionOptions,
              mattressPrices: mattressOpts,
              powerBatteryOptions: powerOpts.map((o) => ({
                name: o.optionName,
                price: o.retailPrice ?? 0,
                perSeat: o.perSeat,
              })),
              generalOptions,
            });
          }
        }

        // Seed dynamic option groups from aggregated parsed options
        const allCushionNames = new Set<string>();
        const allPowerNames = new Set<string>();
        const allGeneralNames = new Set<string>();
        let hasMattress = false;
        for (const opts of pageOptionsCache.values()) {
          for (const c of opts.cushionOptions) allCushionNames.add(c.name);
          for (const p of opts.powerBatteryOptions) allPowerNames.add(p.name);
          for (const g of opts.generalOptions) allGeneralNames.add(g.name);
          if (opts.mattressPrices.length > 0) hasMattress = true;
        }

        // Cushion Fill group
        if (allCushionNames.size > 0) {
          const group = await tx.vendorOptionGroup.upsert({
            where: { vendorId_name: { vendorId, name: "Cushion Fill" } },
            create: { vendorId, name: "Cushion Fill" },
            update: {},
          });
          let sort = 0;
          for (const name of allCushionNames) {
            const option = await tx.vendorOption.upsert({
              where: { groupId_name: { groupId: group.id, name } },
              create: {
                groupId: group.id,
                name,
                surchargeType: "FLAT" as SurchargeType,
                defaultSurcharge: 0,
                sortOrder: sort++,
              },
              update: {},
            });
            optionIdMap[`Cushion Fill::${name}`] = option.id;
          }
        }

        // Mattress Upgrade group
        if (hasMattress) {
          const group = await tx.vendorOptionGroup.upsert({
            where: { vendorId_name: { vendorId, name: "Mattress Upgrade" } },
            create: { vendorId, name: "Mattress Upgrade" },
            update: {},
          });
          for (const [idx, name] of ["GEL", "Tempur-Pedic"].entries()) {
            const option = await tx.vendorOption.upsert({
              where: { groupId_name: { groupId: group.id, name } },
              create: {
                groupId: group.id,
                name,
                surchargeType: "FLAT" as SurchargeType,
                defaultSurcharge: 0,
                sortOrder: idx,
              },
              update: {},
            });
            optionIdMap[`Mattress Upgrade::${name}`] = option.id;
          }
        }

        // Power / Battery / Lumbar groups (each as its own group)
        for (const optName of allPowerNames) {
          const group = await tx.vendorOptionGroup.upsert({
            where: { vendorId_name: { vendorId, name: optName } },
            create: { vendorId, name: optName },
            update: {},
          });
          const option = await tx.vendorOption.upsert({
            where: { groupId_name: { groupId: group.id, name: optName } },
            create: {
              groupId: group.id,
              name: optName,
              surchargeType: "FLAT" as SurchargeType,
              defaultSurcharge: 0,
              sortOrder: 0,
            },
            update: {},
          });
          optionIdMap[`${optName}::${optName}`] = option.id;
        }

        // General options (nailhead, headrest, pillow upgrades, etc.)
        for (const optName of allGeneralNames) {
          const group = await tx.vendorOptionGroup.upsert({
            where: { vendorId_name: { vendorId, name: optName } },
            create: { vendorId, name: optName },
            update: {},
          });
          const option = await tx.vendorOption.upsert({
            where: { groupId_name: { groupId: group.id, name: optName } },
            create: {
              groupId: group.id,
              name: optName,
              surchargeType: "FLAT" as SurchargeType,
              defaultSurcharge: 0,
              sortOrder: 0,
            },
            update: {},
          });
          optionIdMap[`${optName}::${optName}`] = option.id;
        }

        // 8. Import products
        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        for (const item of uniqueProducts) {
          try {
            if (!item.frameNumber || item.gradePrices.length === 0) {
              skippedCount++;
              continue;
            }

            // Base price: Grade C (leather) is the lowest tier
            const baseGradePrice = item.gradePrices.find((gp) => gp.grade === "C");
            const baseRetail = isRetail ? safeDecimal(baseGradePrice?.cost ?? null) : null;
            const multiplier = vendorMultiplier ?? 1 / getMultiplier(item.programType);
            const baseCost = isRetail
              ? safeDecimal(baseRetail != null ? baseRetail * multiplier : null)
              : safeDecimal(baseGradePrice?.cost ?? null);

            const styleName = `${item.collectionName} ${item.description}`.trim();
            const collectionId = collectionMap[item.collectionName] || null;

            // Look up standard features for this product's page
            const pageKey = `${item.collectionName}::${item.programType}`;
            const stdFeatures = stdFeaturesCache.get(pageKey);

            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: { styleNumber: item.frameNumber, vendorId },
              },
              create: {
                styleNumber: item.frameNumber,
                name: styleName,
                description: item.description || null,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                collectionId,
                baseCost,
                baseRetail,
                comYardage: item.comUsage,
                standardSeat: stdFeatures?.standardSeat || null,
                standardBack: stdFeatures?.standardBack || null,
                standardPillows: stdFeatures?.standardPillows || null,
                finish: stdFeatures?.finish || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: styleName,
                description: item.description || undefined,
                collectionId: collectionId ?? undefined,
                baseCost: baseCost ?? undefined,
                baseRetail: baseRetail ?? undefined,
                comYardage: item.comUsage ?? undefined,
                standardSeat: stdFeatures?.standardSeat ?? undefined,
                standardBack: stdFeatures?.standardBack ?? undefined,
                standardPillows: stdFeatures?.standardPillows ?? undefined,
                finish: stdFeatures?.finish ?? undefined,
                isDiscontinued: false,
              },
            });

            // Upsert grade prices for all 9 grades (5 leather + 4 fabric)
            for (const gp of item.gradePrices) {
              const tierId = tierMap[gp.grade];
              if (!tierId) continue;

              const price = safeDecimal(gp.cost);
              if (price == null) continue;

              // Retail PDF: price = retail, derive cost via program multiplier.
              // Wholesale PDF: price = cost, retail is null (merged later).
              const retail = isRetail ? price : null;
              const cost = isRetail
                ? safeDecimal(price * (vendorMultiplier ?? 1 / getMultiplier(item.programType)))
                : price;

              await tx.styleGradePrice.upsert({
                where: {
                  vendorStyleId_tierId: { vendorStyleId: vendorStyle.id, tierId },
                },
                create: { vendorStyleId: vendorStyle.id, tierId, retail, cost },
                update: { retail: retail ?? undefined, cost: cost ?? undefined },
              });
            }

            // Create StyleOptionOverrides from parsed page options
            const pageOpts = pageOptionsCache.get(pageKey);
            if (pageOpts) {
              // Cushion fill overrides
              for (const co of pageOpts.cushionOptions) {
                const optId = optionIdMap[`Cushion Fill::${co.name}`];
                if (!optId) continue;
                await tx.styleOptionOverride.upsert({
                  where: {
                    vendorStyleId_optionId: { vendorStyleId: vendorStyle.id, optionId: optId },
                  },
                  create: { vendorStyleId: vendorStyle.id, optionId: optId, surcharge: co.price },
                  update: { surcharge: co.price },
                });
              }

              // Mattress upgrade overrides (size-specific pricing)
              if (pageOpts.mattressPrices.length > 0) {
                const frameSize = frameSizeFromNumber(item.frameNumber);
                const sizeMatch = frameSize
                  ? pageOpts.mattressPrices.find((m) => m.size === frameSize)
                  : null;
                // Fall back to Queen if no size match (most common)
                const mattressRow =
                  sizeMatch ?? pageOpts.mattressPrices.find((m) => m.size === "QUEEN") ?? null;

                if (mattressRow) {
                  if (mattressRow.gelPrice != null) {
                    const optId = optionIdMap["Mattress Upgrade::GEL"];
                    if (optId) {
                      await tx.styleOptionOverride.upsert({
                        where: {
                          vendorStyleId_optionId: {
                            vendorStyleId: vendorStyle.id,
                            optionId: optId,
                          },
                        },
                        create: {
                          vendorStyleId: vendorStyle.id,
                          optionId: optId,
                          surcharge: mattressRow.gelPrice,
                        },
                        update: { surcharge: mattressRow.gelPrice },
                      });
                    }
                  }
                  if (mattressRow.tempurPedicPrice != null) {
                    const optId = optionIdMap["Mattress Upgrade::Tempur-Pedic"];
                    if (optId) {
                      await tx.styleOptionOverride.upsert({
                        where: {
                          vendorStyleId_optionId: {
                            vendorStyleId: vendorStyle.id,
                            optionId: optId,
                          },
                        },
                        create: {
                          vendorStyleId: vendorStyle.id,
                          optionId: optId,
                          surcharge: mattressRow.tempurPedicPrice,
                        },
                        update: { surcharge: mattressRow.tempurPedicPrice },
                      });
                    }
                  }
                }
              }

              // Power / Battery / Lumbar overrides
              for (const po of pageOpts.powerBatteryOptions) {
                const optId = optionIdMap[`${po.name}::${po.name}`];
                if (!optId) continue;
                await tx.styleOptionOverride.upsert({
                  where: {
                    vendorStyleId_optionId: { vendorStyleId: vendorStyle.id, optionId: optId },
                  },
                  create: { vendorStyleId: vendorStyle.id, optionId: optId, surcharge: po.price },
                  update: { surcharge: po.price },
                });
              }

              // General option overrides (nailhead, headrest, pillow upgrades, etc.)
              for (const go of pageOpts.generalOptions) {
                const optId = optionIdMap[`${go.name}::${go.name}`];
                if (!optId) continue;
                await tx.styleOptionOverride.upsert({
                  where: {
                    vendorStyleId_optionId: { vendorStyleId: vendorStyle.id, optionId: optId },
                  },
                  create: { vendorStyleId: vendorStyle.id, optionId: optId, surcharge: go.price },
                  update: { surcharge: go.price },
                });
              }
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`${item.frameNumber}: ${getErrorMessage(err, "Unknown error")}`);
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
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);
