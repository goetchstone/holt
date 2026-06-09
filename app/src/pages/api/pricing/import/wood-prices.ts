// /app/src/pages/api/pricing/import/wood-prices.ts
//
// Imports Gat Creek / Caperton wood furniture pricing.
// Creates/updates: PriceList, VendorPriceDimension (Wood Species + Width/Length),
// PriceDimensionTier, VendorStyle + StyleSpeciesPrice/StyleAxisPrice (catalog).
//
// Handles three product types from the parser:
//   SPECIES — Line items with up to 5 species prices → StyleSpeciesPrice rows
//   MATRIX  — Custom Shop width x length x species grids → StyleAxisPrice rows
//   ROUND   — Custom Shop diameter x species → StyleAxisPrice rows (tier1=species, tier2=diameter)

import { getErrorMessage } from "@/lib/toastError";
import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { ParsedGatCreekProduct } from "@/lib/pricing/gatCreekExtractor";
import type { SurchargeType } from "@prisma/client";
import { auditLog } from "@/lib/audit";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
// ─── Gat Creek vendor-level options ──────────────────────────────
// Seeded on every import. Uses upsert so manual edits are preserved.

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

const GAT_CREEK_OPTIONS: OptionSeedDef[] = [
  {
    groupName: "Case Goods Options",
    description: "Standard case goods upgrades",
    options: [
      { name: "Extra Shelf", surchargeType: "FLAT", surcharge: 85, sort: 0 },
      { name: "Reverse Door Opening", surchargeType: "FLAT", surcharge: 0, sort: 1 },
      {
        name: "Alternate Hardware (per drawer/door)",
        surchargeType: "PER_UNIT",
        surcharge: 10,
        sort: 2,
      },
      {
        name: "Wire Management Hole (per hole)",
        surchargeType: "PER_UNIT",
        surcharge: 30,
        sort: 3,
      },
    ],
  },
  {
    groupName: "Contrasting Finishes",
    description: "Contrasting finish surcharges",
    options: [
      { name: "Contrasting Table Base", surchargeType: "FLAT", surcharge: 250, sort: 0 },
      {
        name: "Contrasting Drawer Fronts (per drawer)",
        surchargeType: "PER_UNIT",
        surcharge: 20,
        sort: 1,
      },
      { name: "Contrasting Interior", surchargeType: "FLAT", surcharge: 250, sort: 2 },
      { name: "Contrasting Doors (per door)", surchargeType: "PER_UNIT", surcharge: 50, sort: 3 },
      { name: "Contrasting Top (excl. dining)", surchargeType: "FLAT", surcharge: 150, sort: 4 },
    ],
  },
  {
    groupName: "Bed Options",
    description: "Bed storage and accessory options",
    options: [
      { name: "2 Drawer Storage (Single)", surchargeType: "FLAT", surcharge: 125, sort: 0 },
      { name: "4 Drawer Storage (Dbl/Qn/Kg/CK)", surchargeType: "FLAT", surcharge: 250, sort: 1 },
      { name: "Trundle Mattress", surchargeType: "FLAT", surcharge: 390, sort: 2 },
    ],
  },
  {
    groupName: "Fabric Options",
    description: "Customer's Own Material options",
    options: [
      { name: "C.O.M. per Seat", surchargeType: "PER_UNIT", surcharge: 12, sort: 0 },
      { name: "C.O.M. Fully Upholstered Chair", surchargeType: "PER_UNIT", surcharge: 20, sort: 1 },
    ],
  },
  {
    groupName: "Paint Options",
    description: "Custom paint options",
    options: [
      { name: "Custom Paint Match (one-time)", surchargeType: "FLAT", surcharge: 80, sort: 0 },
    ],
  },
  {
    groupName: "Extension Leaf Options",
    description: "Additional leaves for extension tables",
    options: [{ name: 'Additional 18" Leaf', surchargeType: "FLAT", surcharge: 100, sort: 0 }],
  },
];

// ─── Species constants ───────────────────────────────────────────

const SPECIES_TIERS = [
  { code: "ASH", name: "Ash", sort: 0 },
  { code: "CHERRY", name: "Cherry", sort: 1 },
  { code: "MAPLE", name: "Maple", sort: 2 },
  { code: "WALNUT", name: "Walnut", sort: 3 },
  { code: "PAINT", name: "Paint", sort: 4 },
];

// ─── Handler ─────────────────────────────────────────────────────

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { vendorId, priceListName, effectiveDate, products } = req.body as {
      vendorId: number;
      priceListName: string;
      effectiveDate: string;
      products: ParsedGatCreekProduct[];
    };

    if (!vendorId || !priceListName || !products || products.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // Find or create department + category for wood furniture
      const department = await prisma.department.upsert({
        where: { name: "Furniture" },
        create: { name: "Furniture" },
        update: {},
      });

      const category = await prisma.category.upsert({
        where: {
          name_departmentId: { name: "Wood Furniture", departmentId: department.id },
        },
        create: { name: "Wood Furniture", departmentId: department.id },
        update: {},
      });

      // Check if we have Custom Shop products (need MULTI_AXIS dimensions)
      const hasMatrix = products.some((p) => p.pricingType === "MATRIX");
      const hasRound = products.some((p) => p.pricingType === "ROUND");

      // Collect unique widths, lengths, diameters from matrix/round products
      const allWidths = new Set<number>();
      const allLengths = new Set<number>();
      const allDiameters = new Set<number>();

      for (const p of products) {
        if (p.matrixPrices) {
          for (const m of p.matrixPrices) {
            allWidths.add(m.width);
            allLengths.add(m.length);
          }
        }
        if (p.roundPrices) {
          for (const r of p.roundPrices) {
            allDiameters.add(r.diameter);
          }
        }
      }

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
            priceType: "COST",
            isActive: true,
          },
          update: {
            effectiveDate: new Date(effectiveDate),
            isActive: true,
          },
        });

        // 2. Create Wood Species dimension + tiers
        const speciesDim = await tx.vendorPriceDimension.upsert({
          where: { vendorId_name: { vendorId, name: "Wood Species" } },
          create: {
            vendorId,
            name: "Wood Species",
            dimensionType: "WOOD_SPECIES",
          },
          update: {},
        });

        const speciesTierMap: Record<string, number> = {};
        for (const tier of SPECIES_TIERS) {
          const t = await tx.priceDimensionTier.upsert({
            where: {
              dimensionId_code: { dimensionId: speciesDim.id, code: tier.code },
            },
            create: {
              dimensionId: speciesDim.id,
              code: tier.code,
              name: tier.name,
              sortOrder: tier.sort,
            },
            update: { sortOrder: tier.sort },
          });
          speciesTierMap[tier.code] = t.id;
        }

        // 3. Create Width dimension + tiers (if Custom Shop)
        const widthTierMap: Record<number, number> = {};
        if (hasMatrix) {
          const widthDim = await tx.vendorPriceDimension.upsert({
            where: { vendorId_name: { vendorId, name: "Table Width" } },
            create: {
              vendorId,
              name: "Table Width",
              dimensionType: "CUSTOM",
            },
            update: {},
          });

          const sortedWidths = Array.from(allWidths).sort((a, b) => a - b);
          for (let i = 0; i < sortedWidths.length; i++) {
            const w = sortedWidths[i];
            const t = await tx.priceDimensionTier.upsert({
              where: {
                dimensionId_code: { dimensionId: widthDim.id, code: `${w}` },
              },
              create: {
                dimensionId: widthDim.id,
                code: `${w}`,
                name: `${w}"`,
                sortOrder: i,
              },
              update: { sortOrder: i },
            });
            widthTierMap[w] = t.id;
          }
        }

        // 4. Create Length dimension + tiers
        // Always created when matrix OR round products exist — round products
        // use a sentinel "N/A" tier for tier3Id since the composite unique key
        // @@unique([productId, tier1Id, tier2Id, tier3Id]) can't accept NULL.
        const lengthTierMap: Record<number, number> = {};
        let naTier3Id: number | null = null;
        if (hasMatrix || hasRound) {
          const lengthDim = await tx.vendorPriceDimension.upsert({
            where: { vendorId_name: { vendorId, name: "Table Length" } },
            create: {
              vendorId,
              name: "Table Length",
              dimensionType: "CUSTOM",
            },
            update: {},
          });

          const sortedLengths = Array.from(allLengths).sort((a, b) => a - b);
          for (let i = 0; i < sortedLengths.length; i++) {
            const l = sortedLengths[i];
            const t = await tx.priceDimensionTier.upsert({
              where: {
                dimensionId_code: { dimensionId: lengthDim.id, code: `${l}` },
              },
              create: {
                dimensionId: lengthDim.id,
                code: `${l}`,
                name: `${l}"`,
                sortOrder: i,
              },
              update: { sortOrder: i },
            });
            lengthTierMap[l] = t.id;
          }

          // Sentinel tier for round products (no length axis)
          const naTier = await tx.priceDimensionTier.upsert({
            where: {
              dimensionId_code: { dimensionId: lengthDim.id, code: "N_A" },
            },
            create: {
              dimensionId: lengthDim.id,
              code: "N_A",
              name: "N/A",
              sortOrder: 9999,
            },
            update: {},
          });
          naTier3Id = naTier.id;
        }

        // 5. Create Diameter dimension + tiers (if round tables exist)
        const diameterTierMap: Record<number, number> = {};
        if (hasRound) {
          const diamDim = await tx.vendorPriceDimension.upsert({
            where: { vendorId_name: { vendorId, name: "Table Diameter" } },
            create: {
              vendorId,
              name: "Table Diameter",
              dimensionType: "CUSTOM",
            },
            update: {},
          });

          const sortedDiameters = Array.from(allDiameters).sort((a, b) => a - b);
          for (let i = 0; i < sortedDiameters.length; i++) {
            const d = sortedDiameters[i];
            const t = await tx.priceDimensionTier.upsert({
              where: {
                dimensionId_code: { dimensionId: diamDim.id, code: `${d}` },
              },
              create: {
                dimensionId: diamDim.id,
                code: `${d}`,
                name: `${d}" diameter`,
                sortOrder: i,
              },
              update: { sortOrder: i },
            });
            diameterTierMap[d] = t.id;
          }
        }

        // 6. Mark all existing VendorStyles for this vendor as discontinued.
        //    As we process each style below, the upsert resets isDiscontinued = false.
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        // 7. Import products (VendorStyle + Product + pricing rows for each)
        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        for (const p of products) {
          try {
            if (p.pricingType === "SPECIES") {
              // ─── Species line items ────────────────────────────
              if (!p.itemNumber || !p.speciesPrices) {
                skippedCount++;
                continue;
              }

              // Use the lowest non-null species price as baseCost
              const speciesValues = [
                p.speciesPrices.ash,
                p.speciesPrices.cherry,
                p.speciesPrices.maple,
                p.speciesPrices.walnut,
                p.speciesPrices.paint,
              ].filter((v): v is number => v !== null);
              const baseCost = speciesValues.length > 0 ? Math.min(...speciesValues) : null;

              // Build product name: "Description [Size]"
              const name = p.size ? `${p.description} ${p.size}`.trim() : p.description;

              // ── VendorStyle (catalog template) ──────────────────
              const vendorStyle = await tx.vendorStyle.upsert({
                where: {
                  styleNumber_vendorId: {
                    styleNumber: p.itemNumber,
                    vendorId,
                  },
                },
                create: {
                  styleNumber: p.itemNumber,
                  name,
                  description: p.description,
                  vendorId,
                  departmentId: department.id,
                  categoryId: category.id,
                  baseCost,
                  isActive: true,
                  isDiscontinued: false,
                },
                update: {
                  name,
                  description: p.description,
                  baseCost,
                  isDiscontinued: false,
                },
              });

              // Upsert species prices
              const speciesMap: [string, number | null][] = [
                ["ASH", p.speciesPrices.ash],
                ["CHERRY", p.speciesPrices.cherry],
                ["MAPLE", p.speciesPrices.maple],
                ["WALNUT", p.speciesPrices.walnut],
                ["PAINT", p.speciesPrices.paint],
              ];

              for (const [code, cost] of speciesMap) {
                if (cost === null) continue;
                const tierId = speciesTierMap[code];
                if (!tierId) continue;

                await tx.styleSpeciesPrice.upsert({
                  where: {
                    vendorStyleId_tierId: { vendorStyleId: vendorStyle.id, tierId },
                  },
                  create: {
                    vendorStyleId: vendorStyle.id,
                    tierId,
                    cost,
                  },
                  update: { cost },
                });
              }

              importedCount++;
            } else if (p.pricingType === "MATRIX" && p.matrixPrices) {
              // ─── Custom Shop rectangular tables ────────────────
              const productNumber = p.itemNumber; // CS-AUSTIN, CS-CLAIRE, etc.
              const name = p.description;
              const baseCost =
                p.matrixPrices.length > 0 ? Math.min(...p.matrixPrices.map((m) => m.cost)) : null;

              // ── VendorStyle (catalog template) ──────────────────
              const vendorStyle = await tx.vendorStyle.upsert({
                where: {
                  styleNumber_vendorId: {
                    styleNumber: productNumber,
                    vendorId,
                  },
                },
                create: {
                  styleNumber: productNumber,
                  name,
                  description: p.description,
                  vendorId,
                  departmentId: department.id,
                  categoryId: category.id,
                  baseCost,
                  isActive: true,
                  isDiscontinued: false,
                },
                update: {
                  name,
                  description: p.description,
                  baseCost,
                  isDiscontinued: false,
                },
              });

              // Upsert axis prices for each width x length x species combo
              for (const m of p.matrixPrices) {
                const tier1Id = resolveSpeciesTier(m.species, speciesTierMap);
                const tier2Id = widthTierMap[m.width];
                const tier3Id = lengthTierMap[m.length];
                if (!tier1Id || !tier2Id || !tier3Id) continue;

                await tx.styleAxisPrice.upsert({
                  where: {
                    vendorStyleId_tier1Id_tier2Id_tier3Id: {
                      vendorStyleId: vendorStyle.id,
                      tier1Id,
                      tier2Id,
                      tier3Id,
                    },
                  },
                  create: {
                    vendorStyleId: vendorStyle.id,
                    tier1Id,
                    tier2Id,
                    tier3Id,
                    cost: m.cost,
                  },
                  update: { cost: m.cost },
                });
              }

              importedCount++;
            } else if (p.pricingType === "ROUND" && p.roundPrices) {
              // ─── Custom Shop round tables ──────────────────────
              const productNumber = p.itemNumber;
              const name = p.description;
              const baseCost =
                p.roundPrices.length > 0 ? Math.min(...p.roundPrices.map((r) => r.cost)) : null;

              // ── VendorStyle (catalog template) ──────────────────
              const vendorStyle = await tx.vendorStyle.upsert({
                where: {
                  styleNumber_vendorId: {
                    styleNumber: productNumber,
                    vendorId,
                  },
                },
                create: {
                  styleNumber: productNumber,
                  name,
                  description: p.description,
                  vendorId,
                  departmentId: department.id,
                  categoryId: category.id,
                  baseCost,
                  isActive: true,
                  isDiscontinued: false,
                },
                update: {
                  name,
                  description: p.description,
                  baseCost,
                  isDiscontinued: false,
                },
              });

              // Upsert axis prices: tier1=species, tier2=diameter, tier3=N/A sentinel
              for (const r of p.roundPrices) {
                const tier1Id = resolveSpeciesTier(r.species, speciesTierMap);
                const tier2Id = diameterTierMap[r.diameter];
                if (!tier1Id || !tier2Id || !naTier3Id) continue;

                await tx.styleAxisPrice.upsert({
                  where: {
                    vendorStyleId_tier1Id_tier2Id_tier3Id: {
                      vendorStyleId: vendorStyle.id,
                      tier1Id,
                      tier2Id,
                      tier3Id: naTier3Id,
                    },
                  },
                  create: {
                    vendorStyleId: vendorStyle.id,
                    tier1Id,
                    tier2Id,
                    tier3Id: naTier3Id,
                    cost: r.cost,
                  },
                  update: { cost: r.cost },
                });
              }

              importedCount++;
            } else {
              skippedCount++;
            }
          } catch (err: unknown) {
            errors.push(`${p.itemNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        return { importedCount, skippedCount, errors, priceListId: priceList.id };
      }, TX_TIMEOUT.LONG);

      // Update vendor pricing model
      const pricingModel = hasMatrix || hasRound ? "MULTI_AXIS" : "SPECIES_MATRIX";
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { pricingModel },
      });

      // Seed vendor-level options
      await seedGatCreekOptions(vendorId);

      auditLog("IMPORT_WOOD", (session.user as any)?.email || "unknown", {
        vendorId,
        priceListName,
        productCount: products.length,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error: unknown) {
      logError("Wood prices import error", error);
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Map a species label from the parser to a tier ID.
 * Handles "Ash/Cherry/Maple" → ASH tier, "Paint" → PAINT tier, etc.
 */
function resolveSpeciesTier(species: string, tierMap: Record<string, number>): number | null {
  const s = species.toLowerCase();
  if (s.startsWith("ash")) return tierMap["ASH"] || null;
  if (s === "paint") return tierMap["PAINT"] || null;
  if (s === "walnut") return tierMap["WALNUT"] || null;
  if (s === "cherry") return tierMap["CHERRY"] || null;
  if (s === "maple") return tierMap["MAPLE"] || null;
  return null;
}

/**
 * Seed Gat Creek vendor-level option groups (upsert pattern).
 */
async function seedGatCreekOptions(vendorId: number): Promise<void> {
  for (const groupDef of GAT_CREEK_OPTIONS) {
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
