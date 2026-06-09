// /app/src/pages/api/pricing/products.ts
//
// Returns catalog entries with full pricing data for the configurator.
// Grade-based vendors: queries VendorStyles (catalog templates from price list imports).
// Wood vendors: queries Products (species/axis pricing).
// GET ?vendorId=X — loads all entries with gradePrices, options, tiers.

import type { NextApiRequest, NextApiResponse } from "next";
import type { DimensionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "../auth/[...nextauth]";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const vendorId = Number.parseInt(req.query.vendorId as string);
  if (Number.isNaN(vendorId)) {
    return res.status(400).json({ error: "vendorId is required" });
  }

  try {
    // Get vendor with markup info
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: {
        id: true,
        name: true,
        pricingModel: true,
        defaultMarkup: true,
        defaultDiscount: true,
        costMultiplier: true,
        mapEnforced: true,
      },
    });

    if (!vendor) {
      return res.status(404).json({ error: "Vendor not found" });
    }

    // ─── Frame+Cushion pricing (outdoor vendors like Kingsley Bate) ──
    if (vendor.pricingModel === "FRAME_PLUS_CUSHION") {
      return handleFramePlusCushion(req, res, vendor, vendorId);
    }

    // ─── Species/Axis pricing (wood vendors like Gat Creek) ─────────
    if (vendor.pricingModel === "SPECIES_MATRIX" || vendor.pricingModel === "MULTI_AXIS") {
      return handleWoodVendor(req, res, vendor, vendorId);
    }

    // ─── Grade-based pricing (upholstery vendors) ───────────────────
    // Query VendorStyles (catalog templates created by wholesale price list import).
    // These carry StyleGradePrices and StyleOptionOverrides — the full pricing data
    // needed by the configurator.
    const styles = await prisma.vendorStyle.findMany({
      where: { vendorId, isActive: true, isDiscontinued: false },
      select: {
        id: true,
        styleNumber: true,
        name: true,
        description: true,
        baseCost: true,
        baseRetail: true,
        mapPrice: true,
        comYardage: true,
        comYardagePattern: true,
        comYardageRepeat: true,
        gradeRiser: true,
        standardSeat: true,
        standardBack: true,
        standardPillows: true,
        finish: true,
        width: true,
        depth: true,
        height: true,
        seatHeight: true,
        armHeight: true,
        seatDepth: true,
        imageUrl: true,
        collection: { select: { name: true } },
        gradePrices: {
          select: {
            id: true,
            tierId: true,
            cost: true,
            wholesale: true,
            retail: true,
            msrp: true,
            tier: {
              select: {
                id: true,
                code: true,
                name: true,
                sortOrder: true,
                dimension: { select: { dimensionType: true } },
              },
            },
          },
          orderBy: { tier: { sortOrder: "asc" } },
        },
        optionOverrides: {
          select: {
            id: true,
            surcharge: true,
            isAvailable: true,
            isStandard: true,
            notes: true,
            option: {
              select: {
                id: true,
                name: true,
                surchargeType: true,
                defaultSurcharge: true,
                group: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { styleNumber: "asc" },
    });

    // Get vendor-level option groups (for options without per-product overrides)
    const vendorOptionGroups = await prisma.vendorOptionGroup.findMany({
      where: { vendorId },
      include: {
        options: {
          orderBy: { sortOrder: "asc" },
        },
      },
    });

    // Load all dimension tiers for this vendor (for grade riser extrapolation)
    const vendorDimensions = await prisma.vendorPriceDimension.findMany({
      where: { vendorId },
      include: {
        tiers: { orderBy: { sortOrder: "asc" } },
      },
    });

    // Count fabrics per grade tier for this vendor (lightweight aggregation)
    const fabricCountsByTier = await prisma.fabricCatalog.groupBy({
      by: ["tierId"],
      where: { vendorId, isActive: true },
      _count: true,
    });
    const fabricCountMap: Record<number, number> = {};
    for (const row of fabricCountsByTier) {
      fabricCountMap[row.tierId] = row._count;
    }

    // Build a map of all tiers by dimension for extrapolation
    const allTiersByDimension = new Map<
      number,
      {
        dimensionType: DimensionType;
        tiers: { id: number; code: string; name: string; sortOrder: number }[];
      }
    >();
    for (const dim of vendorDimensions) {
      allTiersByDimension.set(dim.id, {
        dimensionType: dim.dimensionType,
        tiers: dim.tiers,
      });
    }

    // Transform into configurator-friendly format.
    // Maps VendorStyle fields to the ProductWithPricing shape expected by
    // the configurator UI (styleNumber → productNumber).
    const transformedProducts = styles.map((p) => {
      // Transform grade prices
      const gradePrices = p.gradePrices.map((gp) => ({
        tierId: gp.tier.id,
        tierCode: gp.tier.code,
        tierName: gp.tier.name,
        dimensionType: gp.tier.dimension?.dimensionType || null,
        cost: Number(gp.cost) || 0,
        retail: gp.retail ? Number(gp.retail) : null,
        extrapolated: false,
        fabricCount: fabricCountMap[gp.tier.id] || 0,
      }));

      // ─── Grade riser extrapolation ──────────────────────────────
      // If the style has a gradeRiser and explicit grade prices,
      // compute prices for all higher tiers that don't have explicit data.
      const riser = p.gradeRiser ? Number(p.gradeRiser) : null;
      if (riser && riser > 0 && gradePrices.length > 0) {
        // Find which dimension these grades belong to
        const explicitTierIds = new Set(gradePrices.map((gp) => gp.tierId));

        for (const [, dim] of allTiersByDimension) {
          // Check if this dimension contains our product's grades
          const matchingTiers = dim.tiers.filter((t) => explicitTierIds.has(t.id));
          if (matchingTiers.length === 0) continue;

          // Find the highest explicitly-priced numeric grade
          // (Skip COM/COL as base — we want the highest numbered grade)
          let highestExplicit: {
            tierId: number;
            code: string;
            cost: number;
            sortOrder: number;
          } | null = null;
          for (const gp of gradePrices) {
            const tierInfo = dim.tiers.find((t) => t.id === gp.tierId);
            if (!tierInfo) continue;
            const numCode = Number.parseInt(tierInfo.code);
            if (Number.isNaN(numCode)) continue; // skip COM/COL/letters for now
            if (!highestExplicit || tierInfo.sortOrder > highestExplicit.sortOrder) {
              highestExplicit = {
                tierId: tierInfo.id,
                code: tierInfo.code,
                cost: gp.cost,
                sortOrder: tierInfo.sortOrder,
              };
            }
          }

          if (!highestExplicit) continue;

          // For each tier above the highest explicit, extrapolate
          for (const tier of dim.tiers) {
            if (tier.sortOrder <= highestExplicit.sortOrder) continue;
            if (explicitTierIds.has(tier.id)) continue;

            // Only extrapolate numeric grades (not letter grades like leather)
            const numCode = Number.parseInt(tier.code);
            if (Number.isNaN(numCode)) continue;

            const stepsAbove = numCode - Number.parseInt(highestExplicit.code);
            if (stepsAbove <= 0) continue;

            const extrapolatedCost = highestExplicit.cost + stepsAbove * riser;

            gradePrices.push({
              tierId: tier.id,
              tierCode: tier.code,
              tierName: tier.name,
              dimensionType: dim.dimensionType,
              cost: Math.round(extrapolatedCost),
              retail: null,
              extrapolated: true,
              fabricCount: fabricCountMap[tier.id] || 0,
            });
          }
        }

        // Re-sort: COM/COL first, then numeric ascending
        gradePrices.sort((a, b) => {
          if (a.tierCode === "COM" || a.tierCode === "COL") return -1;
          if (b.tierCode === "COM" || b.tierCode === "COL") return 1;
          const aNum = Number.parseInt(a.tierCode);
          const bNum = Number.parseInt(b.tierCode);
          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
          return a.tierCode.localeCompare(b.tierCode);
        });
      }

      // Build available options from overrides + vendor defaults
      const overrideMap = new Map(p.optionOverrides.map((o) => [o.option.id, o]));

      const hasPillows = !!p.standardPillows;

      const availableOptions = vendorOptionGroups.flatMap((group) => {
        // Only show pillow upgrade options on products that include pillows
        if (group.name === "Pillow Upgrades" && !hasPillows) return [];

        return group.options.map((opt) => {
          const override = overrideMap.get(opt.id);
          // Use per-style surcharge if set, otherwise fall back to vendor default.
          // Explicit null in override means "use default" (N/A in price list).
          const overrideSurcharge = override?.surcharge != null ? Number(override.surcharge) : null;
          const surcharge = overrideSurcharge ?? Number(opt.defaultSurcharge);

          return {
            optionId: opt.id,
            groupName: group.name,
            optionName: opt.name,
            surcharge,
            surchargeType: opt.surchargeType,
            isStandard: override?.isStandard ?? false,
            isAvailable: override?.isAvailable ?? true,
            requiresTextInput: opt.requiresTextInput,
            textInputLabel: opt.textInputLabel,
          };
        });
      });

      return {
        id: p.id,
        productNumber: p.styleNumber,
        name: p.name,
        description: p.description,
        baseCost: p.baseCost ? Number(p.baseCost) : null,
        baseRetail: p.baseRetail ? Number(p.baseRetail) : null,
        mapPrice: p.mapPrice ? Number(p.mapPrice) : null,
        comYardage: p.comYardage ? Number(p.comYardage) : null,
        comYardagePattern: p.comYardagePattern ? Number(p.comYardagePattern) : null,
        comYardageRepeat: p.comYardageRepeat ? Number(p.comYardageRepeat) : null,
        gradeRiser: p.gradeRiser ? Number(p.gradeRiser) : null,
        standardSeat: p.standardSeat || null,
        standardBack: p.standardBack || null,
        standardPillows: p.standardPillows || null,
        finish: p.finish || null,
        width: p.width || null,
        depth: p.depth || null,
        height: p.height || null,
        seatHeight: p.seatHeight || null,
        armHeight: p.armHeight || null,
        seatDepth: p.seatDepth || null,
        imageUrl: p.imageUrl || null,
        collection: p.collection?.name || null,
        gradePrices,
        availableOptions,
      };
    });

    return res.status(200).json({
      vendor: {
        id: vendor.id,
        name: vendor.name,
        pricingModel: vendor.pricingModel,
        defaultMarkup: vendor.defaultMarkup ? Number(vendor.defaultMarkup) : 2.5,
        defaultDiscount: vendor.defaultDiscount ? Number(vendor.defaultDiscount) : 0,
        mapEnforced: vendor.mapEnforced,
      },
      products: transformedProducts,
      totalCount: transformedProducts.length,
    });
  } catch (error: unknown) {
    logError("Pricing products query error", error);
    return res.status(500).json({
      error: "Failed to fetch products",
      details: getErrorMessage(error, "Internal server error"),
    });
  }
}

// ─── Wood vendor handler (species/axis pricing) ──────────────────

async function handleWoodVendor(
  req: NextApiRequest,
  res: NextApiResponse,
  vendor: {
    id: number;
    name: string;
    pricingModel: string | null;
    defaultMarkup: any;
    defaultDiscount: any;
    costMultiplier: any;
    mapEnforced: boolean;
  },
  vendorId: number,
) {
  // Fetch VendorStyles with species and axis prices.
  // Wood vendors store catalog data on VendorStyles (not Products).
  const styles = await prisma.vendorStyle.findMany({
    where: { vendorId, isActive: true, isDiscontinued: false },
    select: {
      id: true,
      styleNumber: true,
      name: true,
      description: true,
      baseCost: true,
      baseRetail: true,
      mapPrice: true,
      imageUrl: true,
      speciesPrices: {
        select: {
          id: true,
          tierId: true,
          cost: true,
          tier: {
            select: {
              id: true,
              code: true,
              name: true,
              sortOrder: true,
            },
          },
        },
        orderBy: { tier: { sortOrder: "asc" } },
      },
      axisPrices: {
        select: {
          id: true,
          tier1Id: true,
          tier2Id: true,
          tier3Id: true,
          cost: true,
        },
      },
      optionOverrides: {
        select: {
          id: true,
          surcharge: true,
          isAvailable: true,
          isStandard: true,
          notes: true,
          option: {
            select: {
              id: true,
              name: true,
              surchargeType: true,
              defaultSurcharge: true,
              group: {
                select: { name: true },
              },
            },
          },
        },
      },
    },
    orderBy: { styleNumber: "asc" },
  });

  // Fetch vendor dimensions + tiers (species, width, length, diameter)
  const vendorDimensions = await prisma.vendorPriceDimension.findMany({
    where: { vendorId },
    include: {
      tiers: { orderBy: { sortOrder: "asc" } },
    },
  });

  // Get vendor-level option groups
  const vendorOptionGroups = await prisma.vendorOptionGroup.findMany({
    where: { vendorId },
    include: {
      options: { orderBy: { sortOrder: "asc" } },
    },
  });

  // Build a tier lookup for axis prices
  const tierLookup = new Map<number, { id: number; code: string; name: string }>();
  for (const dim of vendorDimensions) {
    for (const tier of dim.tiers) {
      tierLookup.set(tier.id, { id: tier.id, code: tier.code, name: tier.name });
    }
  }

  // Transform styles (mapped to productNumber for API response compatibility)
  const transformedProducts = styles.map((p) => {
    const speciesPrices = p.speciesPrices.map((sp) => ({
      tierId: sp.tier.id,
      tierCode: sp.tier.code,
      tierName: sp.tier.name,
      cost: Number(sp.cost) || 0,
    }));

    const axisPrices = p.axisPrices.map((ap) => ({
      tier1Id: ap.tier1Id,
      tier1: tierLookup.get(ap.tier1Id) || null,
      tier2Id: ap.tier2Id,
      tier2: ap.tier2Id ? tierLookup.get(ap.tier2Id) || null : null,
      tier3Id: ap.tier3Id,
      tier3: ap.tier3Id ? tierLookup.get(ap.tier3Id) || null : null,
      cost: Number(ap.cost) || 0,
    }));

    const overrideMap = new Map(p.optionOverrides.map((o) => [o.option.id, o]));

    const availableOptions = vendorOptionGroups.flatMap((group) =>
      group.options.map((opt) => {
        const override = overrideMap.get(opt.id);
        return {
          optionId: opt.id,
          groupName: group.name,
          optionName: opt.name,
          surcharge: override?.surcharge
            ? Number(override.surcharge)
            : Number(opt.defaultSurcharge),
          surchargeType: opt.surchargeType,
          isStandard: override?.isStandard ?? false,
          isAvailable: override?.isAvailable ?? true,
          requiresTextInput: opt.requiresTextInput,
          textInputLabel: opt.textInputLabel,
        };
      }),
    );

    return {
      id: p.id,
      productNumber: p.styleNumber,
      name: p.name,
      description: p.description,
      baseCost: p.baseCost ? Number(p.baseCost) : null,
      baseRetail: p.baseRetail ? Number(p.baseRetail) : null,
      mapPrice: p.mapPrice ? Number(p.mapPrice) : null,
      imageUrl: p.imageUrl || null,
      speciesPrices,
      axisPrices,
      availableOptions,
    };
  });

  // Format dimensions for the configurator UI
  const dimensions = vendorDimensions.map((dim) => ({
    id: dim.id,
    name: dim.name,
    type: dim.dimensionType,
    tiers: dim.tiers.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      sortOrder: t.sortOrder,
    })),
  }));

  return res.status(200).json({
    vendor: {
      id: vendor.id,
      name: vendor.name,
      pricingModel: vendor.pricingModel,
      defaultMarkup: vendor.defaultMarkup ? Number(vendor.defaultMarkup) : 2.5,
      defaultDiscount: vendor.defaultDiscount ? Number(vendor.defaultDiscount) : 0,
      costMultiplier: vendor.costMultiplier ? Number(vendor.costMultiplier) : null,
      mapEnforced: vendor.mapEnforced,
    },
    dimensions,
    products: transformedProducts,
    totalCount: transformedProducts.length,
  });
}

// ─── Frame+Cushion handler (Kingsley Bate) ────────────────────────

async function handleFramePlusCushion(
  req: NextApiRequest,
  res: NextApiResponse,
  vendor: {
    id: number;
    name: string;
    pricingModel: string | null;
    defaultMarkup: any;
    defaultDiscount: any;
    costMultiplier: any;
    mapEnforced: boolean;
  },
  vendorId: number,
) {
  // Fetch all non-discontinued VendorStyles for this vendor.
  // Frames have framePrice set, cushions have grade prices, covers have baseRetail.
  const styles = await prisma.vendorStyle.findMany({
    where: { vendorId, isActive: true, isDiscontinued: false },
    select: {
      id: true,
      styleNumber: true,
      name: true,
      description: true,
      baseRetail: true,
      framePrice: true,
      cushionRef: true,
      comYardage: true,
      finish: true,
      width: true,
      depth: true,
      height: true,
      imageUrl: true,
      collection: {
        select: { id: true, name: true },
      },
      gradePrices: {
        select: {
          id: true,
          tierId: true,
          retail: true,
          tier: {
            select: {
              id: true,
              code: true,
              name: true,
              sortOrder: true,
            },
          },
        },
        orderBy: { tier: { sortOrder: "asc" } },
      },
      optionOverrides: {
        select: {
          id: true,
          surcharge: true,
          isAvailable: true,
          isStandard: true,
          notes: true,
          option: {
            select: {
              id: true,
              name: true,
              surchargeType: true,
              defaultSurcharge: true,
              group: {
                select: { name: true },
              },
            },
          },
        },
      },
    },
    orderBy: { styleNumber: "asc" },
  });

  // Separate into frames, cushions, covers
  const frames: any[] = [];
  const cushions: any[] = [];
  const covers: any[] = [];

  for (const style of styles) {
    const framePrice = style.framePrice ? Number(style.framePrice) : null;
    const isCushion = style.styleNumber.startsWith("CUS");
    const isCover = style.styleNumber.startsWith("FC") || style.styleNumber.startsWith("CVR");

    if (isCushion) {
      cushions.push({
        id: style.id,
        cushionCode: style.styleNumber,
        name: style.name,
        description: style.description,
        comYardage: style.comYardage ? Number(style.comYardage) : null,
        finish: style.finish,
        gradePrices: style.gradePrices.map((gp) => ({
          tierId: gp.tier.id,
          tierCode: gp.tier.code,
          tierName: gp.tier.name,
          retail: gp.retail ? Number(gp.retail) : null,
        })),
      });
    } else if (isCover) {
      covers.push({
        id: style.id,
        coverCode: style.styleNumber,
        name: style.name,
        description: style.description,
        retailPrice: style.baseRetail ? Number(style.baseRetail) : null,
        fitsFrame: style.cushionRef,
      });
    } else if (framePrice !== null) {
      frames.push({
        id: style.id,
        productNumber: style.styleNumber,
        name: style.name,
        description: style.description,
        framePrice,
        cushionRef: style.cushionRef,
        finish: style.finish,
        collection: style.collection?.name || null,
        width: style.width,
        depth: style.depth,
        height: style.height,
        imageUrl: style.imageUrl,
        gradePrices: style.gradePrices.map((gp) => ({
          tierId: gp.tier.id,
          tierCode: gp.tier.code,
          tierName: gp.tier.name,
          retail: gp.retail ? Number(gp.retail) : null,
        })),
      });
    }
  }

  // Vendor-level option groups
  const vendorOptionGroups = await prisma.vendorOptionGroup.findMany({
    where: { vendorId },
    include: {
      options: { orderBy: { sortOrder: "asc" } },
    },
  });

  const availableOptions = vendorOptionGroups.flatMap((group) =>
    group.options.map((opt) => ({
      optionId: opt.id,
      groupName: group.name,
      optionName: opt.name,
      surcharge: Number(opt.defaultSurcharge),
      surchargeType: opt.surchargeType,
      isStandard: false,
      isAvailable: true,
      requiresTextInput: opt.requiresTextInput,
      textInputLabel: opt.textInputLabel,
    })),
  );

  // Fetch vendor dimensions + tiers (for fabric grade display)
  const vendorDimensions = await prisma.vendorPriceDimension.findMany({
    where: { vendorId },
    include: {
      tiers: { orderBy: { sortOrder: "asc" } },
    },
  });

  const dimensions = vendorDimensions.map((dim) => ({
    id: dim.id,
    name: dim.name,
    type: dim.dimensionType,
    tiers: dim.tiers.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      sortOrder: t.sortOrder,
    })),
  }));

  // Fabric counts per tier
  const fabricCountsByTier = await prisma.fabricCatalog.groupBy({
    by: ["tierId"],
    where: { vendorId, isActive: true },
    _count: true,
  });
  const fabricCountMap: Record<number, number> = {};
  for (const row of fabricCountsByTier) {
    fabricCountMap[row.tierId] = row._count;
  }

  return res.status(200).json({
    vendor: {
      id: vendor.id,
      name: vendor.name,
      pricingModel: vendor.pricingModel,
      defaultMarkup: vendor.defaultMarkup ? Number(vendor.defaultMarkup) : 2.5,
      defaultDiscount: vendor.defaultDiscount ? Number(vendor.defaultDiscount) : 0,
      costMultiplier: vendor.costMultiplier ? Number(vendor.costMultiplier) : null,
      mapEnforced: vendor.mapEnforced,
    },
    dimensions,
    frames,
    cushions,
    covers,
    availableOptions,
    fabricCounts: fabricCountMap,
    totalCount: styles.length,
  });
}
