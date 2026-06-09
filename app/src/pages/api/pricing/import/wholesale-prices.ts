// /app/src/pages/api/pricing/import/wholesale-prices.ts
//
// Imports wholesale grade-based pricing data for a vendor.
// Creates/updates: PriceList, VendorPriceDimension, PriceDimensionTier,
// VendorStyle, StyleGradePrice, StyleOptionOverride in a single transaction.

import type { NextApiRequest, NextApiResponse } from "next";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import type { SurchargeType, DimensionType } from "@prisma/client";
import { wholesaleImportSchema } from "@/lib/validation/schemas";
import { validateBody } from "@/lib/validation/validate";
import { ValidationError } from "@/lib/apiHandler";
import { auditLog } from "@/lib/audit";

import { requireAuthWithRole } from "@/lib/auth/requireAuth";
import { logError } from "@/lib/logger";
import { getErrorMessage } from "@/lib/toastError";
// ─── Vendor name normalization ────────────────────────────────────
// Maps vendor DB names to canonical keys used in VENDOR_OPTION_SEEDS
// and VENDOR_SURCHARGE_MAP. Handles spelling variants like
// "CR Laine" vs "C R Laine".

const VENDOR_NAME_ALIASES: Record<string, string> = {
  "cr laine": "c r laine",
  "c r laine furniture": "c r laine",
  "cr laine furniture": "c r laine",
};

function resolveVendorKey(name: string): string {
  const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
  return VENDOR_NAME_ALIASES[normalized] || normalized;
}

// ─── Vendor-level decorative options ──────────────────────────────
// Seeded on every import via upsert so they survive DB truncates.
// Uses update:{} (no-op) so manual edits to surcharges are preserved.

interface OptionSeedDef {
  groupName: string;
  description: string;
  options: {
    name: string;
    code?: string;
    surchargeType: SurchargeType;
    surcharge: number;
    sort: number;
    requiresTextInput?: boolean;
    textInputLabel?: string;
  }[];
}

const VENDOR_OPTION_SEEDS: Record<string, OptionSeedDef[]> = {
  "wesley hall": [
    {
      groupName: "Decorative Trim",
      description: "Decorative trim options (per yard pricing)",
      options: [
        {
          name: "Rope Welt",
          surchargeType: "PER_UNIT",
          surcharge: 20,
          sort: 0,
          requiresTextInput: true,
          textInputLabel: "Specify trim details (color, placement)",
        },
        {
          name: "Brush Fringe",
          surchargeType: "PER_UNIT",
          surcharge: 30,
          sort: 1,
          requiresTextInput: true,
          textInputLabel: "Specify fringe details (color, placement)",
        },
        {
          name: "Decorative Tape",
          surchargeType: "PER_UNIT",
          surcharge: 30,
          sort: 2,
          requiresTextInput: true,
          textInputLabel: "Specify tape details (color, width, placement)",
        },
        {
          name: "Contrast Welt (fabric)",
          surchargeType: "FLAT",
          surcharge: 55,
          sort: 3,
          requiresTextInput: true,
          textInputLabel: "Specify contrast fabric details",
        },
        {
          name: "Contrast Leather Welt",
          surchargeType: "FLAT",
          surcharge: 100,
          sort: 4,
          requiresTextInput: true,
          textInputLabel: "Specify leather details",
        },
      ],
    },
    {
      groupName: "Leather Treatment",
      description: "Leather banding and welt treatments",
      options: [
        {
          name: "Bridle Banding",
          surchargeType: "PER_UNIT",
          surcharge: 100,
          sort: 0,
          requiresTextInput: true,
          textInputLabel: "Specify banding details (color, placement)",
        },
        {
          name: "Luxe Bridle Banding",
          surchargeType: "PER_UNIT",
          surcharge: 150,
          sort: 1,
          requiresTextInput: true,
          textInputLabel: "Specify banding details (color, placement)",
        },
      ],
    },
    {
      groupName: "Skirt Options",
      description: "Skirt fabric banding surcharges by piece type",
      options: [
        { name: "Fabric Banding - Sofa", surchargeType: "FLAT", surcharge: 50, sort: 0 },
        { name: "Fabric Banding - Loveseat", surchargeType: "FLAT", surcharge: 45, sort: 1 },
        { name: "Fabric Banding - Chair", surchargeType: "FLAT", surcharge: 40, sort: 2 },
      ],
    },
    {
      groupName: "Special Features",
      description: "Miscellaneous optional upgrades",
      options: [
        { name: "Ring Base Swivel", surchargeType: "FLAT", surcharge: 150, sort: 0 },
        { name: "Castors", surchargeType: "FLAT", surcharge: 0, sort: 1 },
        { name: "Air Mattress Upgrade (Sleeper)", surchargeType: "FLAT", surcharge: 150, sort: 2 },
        { name: "Arm Guards", surchargeType: "FLAT", surcharge: 30, sort: 3 },
      ],
    },
    {
      groupName: "Pillow Upgrades",
      description: "Pillow treatment surcharges (per pillow)",
      options: [
        { name: "Pleated Corner Pillows", surchargeType: "PER_UNIT", surcharge: 20, sort: 0 },
        { name: "Bordered Pillow Treatment", surchargeType: "PER_UNIT", surcharge: 30, sort: 1 },
        { name: "Pillow Flange Treatment", surchargeType: "PER_UNIT", surcharge: 40, sort: 2 },
        { name: "Pillow Ruching Treatment", surchargeType: "PER_UNIT", surcharge: 50, sort: 3 },
      ],
    },
    {
      groupName: "Nailhead Trim",
      description: "Decorative nailhead trim options",
      options: [
        {
          name: "Nailhead Trim",
          surchargeType: "FLAT",
          surcharge: 0,
          sort: 0,
          requiresTextInput: true,
          textInputLabel: "Specify nailhead details (size, finish, placement)",
        },
      ],
    },
    {
      groupName: "Wood Finish",
      description: "Traditional finishes at no charge; decorative finishes at $100 upcharge",
      options: [
        // Traditional Finishes (no additional charge)
        { name: "Alabaster", surchargeType: "FLAT", surcharge: 0, sort: 0 },
        { name: "Alsace", surchargeType: "FLAT", surcharge: 0, sort: 1 },
        { name: "Brownstone", surchargeType: "FLAT", surcharge: 0, sort: 2 },
        { name: "Burgundy Mahogany", surchargeType: "FLAT", surcharge: 0, sort: 3 },
        { name: "Carbon", surchargeType: "FLAT", surcharge: 0, sort: 4 },
        { name: "Chantilly", surchargeType: "FLAT", surcharge: 0, sort: 5 },
        { name: "Espresso", surchargeType: "FLAT", surcharge: 0, sort: 6 },
        { name: "Fawn", surchargeType: "FLAT", surcharge: 0, sort: 7 },
        { name: "French Roast", surchargeType: "FLAT", surcharge: 0, sort: 8 },
        { name: "Gloss Black", surchargeType: "FLAT", surcharge: 0, sort: 9 },
        { name: "Gloss White", surchargeType: "FLAT", surcharge: 0, sort: 10 },
        { name: "Granite", surchargeType: "FLAT", surcharge: 0, sort: 11 },
        { name: "Gunmetal", surchargeType: "FLAT", surcharge: 0, sort: 12 },
        { name: "Iron", surchargeType: "FLAT", surcharge: 0, sort: 13 },
        { name: "Linen", surchargeType: "FLAT", surcharge: 0, sort: 14 },
        { name: "Mercury", surchargeType: "FLAT", surcharge: 0, sort: 15 },
        { name: "Mink", surchargeType: "FLAT", surcharge: 0, sort: 16 },
        { name: "Normandy", surchargeType: "FLAT", surcharge: 0, sort: 17 },
        { name: "Otter", surchargeType: "FLAT", surcharge: 0, sort: 18 },
        { name: "Oxford", surchargeType: "FLAT", surcharge: 0, sort: 19 },
        { name: "Oyster", surchargeType: "FLAT", surcharge: 0, sort: 20 },
        { name: "Pebble", surchargeType: "FLAT", surcharge: 0, sort: 21 },
        { name: "Seal", surchargeType: "FLAT", surcharge: 0, sort: 22 },
        { name: "Tifton", surchargeType: "FLAT", surcharge: 0, sort: 23 },
        { name: "Toffee", surchargeType: "FLAT", surcharge: 0, sort: 24 },
        { name: "Willow", surchargeType: "FLAT", surcharge: 0, sort: 25 },
        // Decorative Finishes ($100 upcharge)
        { name: "Champagne", code: "DEC", surchargeType: "FLAT", surcharge: 100, sort: 26 },
        { name: "Greystone", code: "DEC", surchargeType: "FLAT", surcharge: 100, sort: 27 },
        { name: "Java", code: "DEC", surchargeType: "FLAT", surcharge: 100, sort: 28 },
        { name: "Sandalwood", code: "DEC", surchargeType: "FLAT", surcharge: 100, sort: 29 },
      ],
    },
  ],
  "c r laine": [
    {
      groupName: "Cushion Upgrade",
      description: "Cushion fill upgrade options (per product surcharge)",
      options: [
        { name: "Hamilton Spring Down", surchargeType: "FLAT", surcharge: 0, sort: 0 },
        { name: "Comfort Down", surchargeType: "FLAT", surcharge: 0, sort: 1 },
        { name: "Harmony", surchargeType: "FLAT", surcharge: 0, sort: 2 },
      ],
    },
    {
      groupName: "Decorative Finish",
      description: "Premium finish upcharge",
      options: [{ name: "Premium Finish", surchargeType: "FLAT", surcharge: 0, sort: 0 }],
    },
    {
      groupName: "Nailhead Trim",
      description: "Decorative nailhead trim options",
      options: [{ name: "Nailhead Trim", surchargeType: "FLAT", surcharge: 0, sort: 0 }],
    },
    {
      groupName: "Welting",
      description: "Welting treatment options (per product surcharge)",
      options: [
        {
          name: "Contrast Welt",
          surchargeType: "FLAT",
          surcharge: 0,
          sort: 0,
          requiresTextInput: true,
          textInputLabel: "Specify contrast welt fabric details",
        },
        {
          name: "Contrast Bias Welt",
          surchargeType: "FLAT",
          surcharge: 0,
          sort: 1,
          requiresTextInput: true,
          textInputLabel: "Specify contrast bias welt fabric details",
        },
      ],
    },
    {
      groupName: "Back Fill",
      description: "Back cushion fill upgrade options (per product surcharge)",
      options: [
        { name: "Fiber Back", surchargeType: "FLAT", surcharge: 0, sort: 0 },
        { name: "Comfort Down Back", surchargeType: "FLAT", surcharge: 0, sort: 1 },
        { name: "Legacy Down Back", surchargeType: "FLAT", surcharge: 0, sort: 2 },
        { name: "Extra Full Back", surchargeType: "FLAT", surcharge: 0, sort: 3 },
      ],
    },
  ],
};

// ─── Per-product surcharge mapping ───────────────────────────────
// Maps product fields to option group/name for automatic override creation.
// Keyed by vendor name (lowercase). Each entry describes which product field
// provides the surcharge value and which option group/name to create.

interface SurchargeMapping {
  productField: keyof ProductInput;
  /** Optional field name for the isStandard flag (e.g. "springDownBdbIsStandard") */
  isStandardField?: keyof ProductInput;
  groupName: string;
  optionName: string;
  sortOrder: number;
}

const VENDOR_SURCHARGE_MAP: Record<string, SurchargeMapping[]> = {
  "wesley hall": [
    {
      productField: "springDownBdbSurcharge",
      isStandardField: "springDownBdbIsStandard",
      groupName: "Cushion Upgrade",
      optionName: "Spring-Down / BDB",
      sortOrder: 0,
    },
    {
      productField: "comfortDownBdbSurcharge",
      isStandardField: "comfortDownBdbIsStandard",
      groupName: "Cushion Upgrade",
      optionName: "Comfort Down / BDB",
      sortOrder: 1,
    },
    {
      productField: "cdcSeatBdbBackSurcharge",
      isStandardField: "cdcSeatBdbBackIsStandard",
      groupName: "Cushion Upgrade",
      optionName: "CDC Seat / BDB Back",
      sortOrder: 2,
    },
    {
      productField: "nailheadSurcharge",
      isStandardField: "nailheadIsStandard",
      groupName: "Nailhead Trim",
      optionName: "Nailhead Trim",
      sortOrder: 0,
    },
    {
      productField: "armGuardSurcharge",
      isStandardField: "armGuardIsStandard",
      groupName: "Special Features",
      optionName: "Arm Guards",
      sortOrder: 2,
    },
    {
      productField: "ringBaseSwivelSurcharge",
      isStandardField: "ringBaseSwivelIsStandard",
      groupName: "Special Features",
      optionName: "Ring Base Swivel",
      sortOrder: 1,
    },
    {
      productField: "castorSurcharge",
      isStandardField: "castorIsStandard",
      groupName: "Special Features",
      optionName: "Castors",
      sortOrder: 3,
    },
  ],
  "c r laine": [
    {
      productField: "springDownBdbSurcharge",
      isStandardField: "springDownBdbIsStandard",
      groupName: "Cushion Upgrade",
      optionName: "Hamilton Spring Down",
      sortOrder: 0,
    },
    {
      productField: "comfortDownBdbSurcharge",
      isStandardField: "comfortDownBdbIsStandard",
      groupName: "Cushion Upgrade",
      optionName: "Comfort Down",
      sortOrder: 1,
    },
    {
      productField: "harmonySurcharge",
      isStandardField: "harmonyIsStandard",
      groupName: "Cushion Upgrade",
      optionName: "Harmony",
      sortOrder: 2,
    },
    {
      productField: "decorativeFinishSurcharge",
      isStandardField: "decorativeFinishIsStandard",
      groupName: "Decorative Finish",
      optionName: "Premium Finish",
      sortOrder: 0,
    },
    {
      productField: "nailheadSurcharge",
      isStandardField: "nailheadIsStandard",
      groupName: "Nailhead Trim",
      optionName: "Nailhead Trim",
      sortOrder: 0,
    },
    {
      productField: "contrastWeltSurcharge",
      isStandardField: "contrastWeltIsStandard",
      groupName: "Welting",
      optionName: "Contrast Welt",
      sortOrder: 0,
    },
    {
      productField: "contrastBiasWeltSurcharge",
      isStandardField: "contrastBiasWeltIsStandard",
      groupName: "Welting",
      optionName: "Contrast Bias Welt",
      sortOrder: 1,
    },
    {
      productField: "fiberBackSurcharge",
      isStandardField: "fiberBackIsStandard",
      groupName: "Back Fill",
      optionName: "Fiber Back",
      sortOrder: 0,
    },
    {
      productField: "comfortDownBackSurcharge",
      isStandardField: "comfortDownBackIsStandard",
      groupName: "Back Fill",
      optionName: "Comfort Down Back",
      sortOrder: 1,
    },
    {
      productField: "legacyDownBackSurcharge",
      isStandardField: "legacyDownBackIsStandard",
      groupName: "Back Fill",
      optionName: "Legacy Down Back",
      sortOrder: 2,
    },
    {
      productField: "extraFullBackSurcharge",
      isStandardField: "extraFullBackIsStandard",
      groupName: "Back Fill",
      optionName: "Extra Full Back",
      sortOrder: 3,
    },
  ],
};

async function seedVendorOptions(vendorId: number, vendorName: string) {
  const key = resolveVendorKey(vendorName);
  const seeds = VENDOR_OPTION_SEEDS[key] || [];

  for (const groupDef of seeds) {
    const group = await prisma.vendorOptionGroup.upsert({
      where: { vendorId_name: { vendorId, name: groupDef.groupName } },
      create: { vendorId, name: groupDef.groupName, description: groupDef.description },
      update: {},
    });
    for (const opt of groupDef.options) {
      await prisma.vendorOption.upsert({
        where: { groupId_name: { groupId: group.id, name: opt.name } },
        create: {
          groupId: group.id,
          name: opt.name,
          code: opt.code ?? null,
          surchargeType: opt.surchargeType,
          defaultSurcharge: opt.surcharge,
          sortOrder: opt.sort,
          requiresTextInput: opt.requiresTextInput ?? false,
          textInputLabel: opt.textInputLabel ?? null,
        },
        update: {
          code: opt.code ?? undefined,
          requiresTextInput: opt.requiresTextInput ?? false,
          textInputLabel: opt.textInputLabel ?? null,
        },
      });
    }
  }
}

// Increase body size limit for large price book imports (default is 1MB)
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

interface GradePriceInput {
  grade: string;
  cost: number;
}

interface ProductInput {
  styleNumber: string;
  description: string;
  styleName: string;
  leatherStyleNumber?: string | null;
  finish?: string | null;
  decorativeFinishSurcharge?: number | null;
  decorativeFinishIsStandard?: boolean;
  standardPillows?: string | null;
  gradeRiser?: number | null;
  standardSeat?: string | null;
  standardBack?: string | null;
  springDownBdbSurcharge?: number | null;
  springDownBdbIsStandard?: boolean;
  comfortDownBdbSurcharge?: number | null;
  comfortDownBdbIsStandard?: boolean;
  yardagePlain?: number | null;
  yardagePattern?: number | null;
  yardageRepeat?: number | null;
  nailheadSurcharge?: number | null;
  nailheadIsStandard?: boolean;
  armGuardSurcharge?: number | null;
  armGuardIsStandard?: boolean;
  ringBaseSwivelSurcharge?: number | null;
  ringBaseSwivelIsStandard?: boolean;
  castorSurcharge?: number | null;
  castorIsStandard?: boolean;
  cdcSeatBdbBackSurcharge?: number | null;
  cdcSeatBdbBackIsStandard?: boolean;
  harmonySurcharge?: number | null;
  harmonyIsStandard?: boolean;
  contrastWeltSurcharge?: number | null;
  contrastWeltIsStandard?: boolean;
  contrastBiasWeltSurcharge?: number | null;
  contrastBiasWeltIsStandard?: boolean;
  fiberBackSurcharge?: number | null;
  fiberBackIsStandard?: boolean;
  comfortDownBackSurcharge?: number | null;
  comfortDownBackIsStandard?: boolean;
  legacyDownBackSurcharge?: number | null;
  legacyDownBackIsStandard?: boolean;
  extraFullBackSurcharge?: number | null;
  extraFullBackIsStandard?: boolean;
  gradePrices: GradePriceInput[];
  overallWidth?: number | null;
  overallDepth?: number | null;
  overallHeight?: number | null;
  seatHeight?: number | null;
  armHeight?: number | null;
  seatDepth?: number | null;
  imageUrl?: string | null;
}

// ─── Grade sorting ─────────────────────────────────────────────────

/**
 * Sort grades: COM/COL first, then bare numeric (7-60), then L-prefixed
 * numeric (L7-L25), then single letter (C-Z).
 */
function sortGrades(a: string, b: string): number {
  if (a === "COM" || a === "COL") return -1;
  if (b === "COM" || b === "COL") return 1;

  const aL = a.match(/^L(\d+)$/);
  const bL = b.match(/^L(\d+)$/);
  if (aL && bL) return Number.parseInt(aL[1]) - Number.parseInt(bL[1]);

  const aNum = Number.parseInt(a);
  const bNum = Number.parseInt(b);
  const aIsNum = !Number.isNaN(aNum) && /^\d{1,2}$/.test(a);
  const bIsNum = !Number.isNaN(bNum) && /^\d{1,2}$/.test(b);

  if (aIsNum && bIsNum) return aNum - bNum;
  if (aIsNum && !bIsNum) return -1;
  if (!aIsNum && bIsNum) return 1;

  // L-prefixed after bare numeric, before single letters
  if (aL && !bL) return -1;
  if (!aL && bL) return 1;

  return a.localeCompare(b);
}

/**
 * Partition grade codes into fabric and leather groups.
 * Fabric: COM + bare numeric grades (7, 8, 14, 15, ...)
 * Leather: COL + single-letter grades (C, D, ...) + L-prefixed numeric (L7, L8, ...)
 */
function partitionGrades(grades: string[]): {
  fabricGrades: string[];
  leatherGrades: string[];
} {
  const fabricGrades: string[] = [];
  const leatherGrades: string[] = [];

  for (const g of grades) {
    if (g === "COM") {
      fabricGrades.push(g);
    } else if (g === "COL") {
      leatherGrades.push(g);
    } else if (/^[A-Z]$/.test(g)) {
      leatherGrades.push(g);
    } else if (/^L\d{1,2}$/.test(g)) {
      leatherGrades.push(g);
    } else if (/^\d{1,2}$/.test(g)) {
      fabricGrades.push(g);
    }
  }

  return { fabricGrades, leatherGrades };
}

/**
 * Generate a human-readable tier name from a grade code.
 */
function tierDisplayName(code: string): string {
  if (code === "COM") return "COM (Customer's Own Material)";
  if (code === "COL") return "COL (Customer's Own Leather)";
  if (/^\d{1,2}$/.test(code)) return `Grade ${code}`;
  if (/^[A-Z]$/.test(code)) return `Grade ${code}`;
  const lMatch = code.match(/^L(\d+)$/);
  if (lMatch) return `Leather Grade ${lMatch[1]}`;
  return code;
}

// ─── Handler ───────────────────────────────────────────────────────

export default requireAuthWithRole(
  ["MANAGER", "ADMIN"],
  async (req: NextApiRequest, res: NextApiResponse, session) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    let validated: {
      vendorId: number;
      priceListName: string;
      effectiveDate: string;
      products: any[];
    };
    try {
      validated = validateBody(wholesaleImportSchema, req.body) as typeof validated;
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return res
          .status(400)
          .json({ error: getErrorMessage(err, "Unknown error"), details: err.details });
      }
      throw err;
    }
    const { vendorId, priceListName, effectiveDate, products } = validated;

    // Merge duplicate style numbers. Wesley Hall PDFs have separate fabric
    // and leather sections for the same frame, producing two rows with the
    // same styleNumber but different grade prices and metadata. Merge them
    // so a single product carries both fabric (COM/14-35) and leather
    // (COL/C-Z) grades plus the leatherStyleNumber from the leather section.
    const deduped = new Map<string, ProductInput>();
    for (const p of products) {
      if (!p.styleNumber) continue;
      const existing = deduped.get(p.styleNumber);
      if (existing) {
        for (const gp of p.gradePrices) {
          if (!existing.gradePrices.some((eg) => eg.grade === gp.grade)) {
            existing.gradePrices.push(gp);
          }
        }
        existing.leatherStyleNumber = existing.leatherStyleNumber || p.leatherStyleNumber;
        existing.description = existing.description || p.description;
        existing.styleName = existing.styleName || p.styleName;
        existing.finish = existing.finish || p.finish;
        existing.standardPillows = existing.standardPillows || p.standardPillows;
        existing.standardSeat = existing.standardSeat || p.standardSeat;
        existing.standardBack = existing.standardBack || p.standardBack;
        existing.yardagePlain = existing.yardagePlain ?? p.yardagePlain;
        existing.yardagePattern = existing.yardagePattern ?? p.yardagePattern;
        existing.yardageRepeat = existing.yardageRepeat ?? p.yardageRepeat;
        existing.gradeRiser = existing.gradeRiser ?? p.gradeRiser;
        existing.imageUrl = existing.imageUrl || p.imageUrl;
      } else {
        deduped.set(p.styleNumber, p);
      }
    }
    const uniqueProducts = Array.from(deduped.values());

    try {
      // Verify vendor exists
      const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }

      // Find or create a default department and category for upholstered products
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

      // Collect all unique grades across all products and partition into
      // fabric vs leather groups. CR Laine uses L-prefixed numeric grades
      // (L7-L12) for leather alongside bare numeric (7-25) for fabric.
      // Wesley Hall uses bare numeric (14-35) for fabric and single letters
      // (C-Z) for leather. partitionGrades() handles both patterns.
      const allGrades = new Set<string>();
      for (const p of uniqueProducts) {
        for (const gp of p.gradePrices) {
          allGrades.add(gp.grade);
        }
      }
      const sortedGrades = Array.from(allGrades).sort(sortGrades);
      const { fabricGrades, leatherGrades } = partitionGrades(sortedGrades);

      // Seed vendor-level option groups and options before the transaction
      // so DEC finish options exist when the product loop needs them.
      await seedVendorOptions(vendorId, vendor.name);

      const result = await prisma.$transaction(async (tx) => {
        // 1. Create/update PriceList
        const priceList = await tx.priceList.upsert({
          where: {
            vendorId_name: { vendorId, name: priceListName },
          },
          create: {
            vendorId,
            name: priceListName,
            effectiveDate: new Date(effectiveDate || Date.now()),
            priceType: "COST",
            isActive: true,
          },
          update: {
            effectiveDate: new Date(effectiveDate || Date.now()),
            isActive: true,
          },
        });

        // 2-3. Create VendorPriceDimensions and tiers for fabric and/or leather.
        // A single vendor may have both (e.g., CR Laine has fabric 7-25 AND
        // leather L7-L12). Build a unified tierMap so StyleGradePrice upserts
        // can map any grade code to the correct tier regardless of dimension.
        const tierMap: Record<string, number> = {};

        // Helper: upsert a dimension and its tiers, extending the full range
        // for riser extrapolation.
        async function upsertDimensionTiers(
          dimName: string,
          dimType: DimensionType,
          grades: string[],
          fullRange: string[],
        ) {
          const dim = await tx.vendorPriceDimension.upsert({
            where: { vendorId_name: { vendorId, name: dimName } },
            create: { vendorId, name: dimName, dimensionType: dimType },
            update: {},
          });

          const sorted = grades.sort(sortGrades);
          for (let i = 0; i < sorted.length; i++) {
            const tier = await tx.priceDimensionTier.upsert({
              where: { dimensionId_code: { dimensionId: dim.id, code: sorted[i] } },
              create: {
                dimensionId: dim.id,
                name: tierDisplayName(sorted[i]),
                code: sorted[i],
                sortOrder: i,
              },
              update: { sortOrder: i },
            });
            tierMap[sorted[i]] = tier.id;
          }

          // Extend to full range for riser extrapolation
          let nextSort = sorted.length;
          for (const code of fullRange) {
            if (tierMap[code]) continue;
            const tier = await tx.priceDimensionTier.upsert({
              where: { dimensionId_code: { dimensionId: dim.id, code } },
              create: {
                dimensionId: dim.id,
                name: tierDisplayName(code),
                code,
                sortOrder: nextSort++,
              },
              update: {},
            });
            tierMap[code] = tier.id;
          }

          // Re-sort all tiers under this dimension
          const allDimCodes = Object.keys(tierMap)
            .filter(
              (c) =>
                grades.includes(c) ||
                fullRange.includes(c) ||
                (dimType === "FABRIC_GRADE" && (c === "COM" || /^\d{1,2}$/.test(c))) ||
                (dimType === "LEATHER_GRADE" &&
                  (c === "COL" || /^[A-Z]$/.test(c) || /^L\d{1,2}$/.test(c))),
            )
            .sort(sortGrades);
          for (let i = 0; i < allDimCodes.length; i++) {
            if (tierMap[allDimCodes[i]]) {
              await tx.priceDimensionTier.update({
                where: { id: tierMap[allDimCodes[i]] },
                data: { sortOrder: i },
              });
            }
          }
        }

        // Fabric dimension
        if (fabricGrades.length > 0) {
          const fabricFullRange: string[] = ["COM"];
          const numericGrades = fabricGrades
            .map((g) => Number.parseInt(g))
            .filter((n) => !Number.isNaN(n));
          if (numericGrades.length > 0) {
            const minGrade = Math.min(...numericGrades);
            const maxGrade = Math.max(...numericGrades);
            const upperBound = Math.max(maxGrade, 60);
            for (let g = minGrade; g <= upperBound; g++) fabricFullRange.push(String(g));
          }
          await upsertDimensionTiers("Fabric Grade", "FABRIC_GRADE", fabricGrades, fabricFullRange);
        }

        // Leather dimension (only if leather grades are present)
        if (leatherGrades.length > 0) {
          const leatherFullRange: string[] = ["COL"];
          const hasLetterGrades = leatherGrades.some((g) => /^[A-Z]$/.test(g));
          if (hasLetterGrades) {
            // Wesley Hall pattern: single-letter grades C-Z
            for (let c = 67; c <= 90; c++) leatherFullRange.push(String.fromCharCode(c));
          } else {
            // CR Laine pattern: L-prefixed numeric grades
            const lNums = leatherGrades
              .map((g) => {
                const m = g.match(/^L(\d+)$/);
                return m ? Number.parseInt(m[1]) : NaN;
              })
              .filter((n) => !Number.isNaN(n));
            if (lNums.length > 0) {
              const minL = Math.min(...lNums);
              const maxL = Math.max(Math.max(...lNums), 25);
              for (let g = minL; g <= maxL; g++) leatherFullRange.push(`L${g}`);
            }
          }
          await upsertDimensionTiers(
            "Leather Grade",
            "LEATHER_GRADE",
            leatherGrades,
            leatherFullRange,
          );
        }

        // 4. Mark all existing VendorStyles for this vendor as discontinued.
        //    As we process each style below, the upserts reset
        //    isDiscontinued = false. After import, any style NOT in the
        //    new PDF stays deactivated.
        await tx.vendorStyle.updateMany({
          where: { vendorId },
          data: { isDiscontinued: true },
        });

        // 5. Cache decorative finish (DEC) option IDs for per-frame overrides.
        //    These were seeded above via seedVendorOptions(). Frames that include
        //    decorative finishes at no charge get isStandard overrides on these options.
        const woodFinishGroup = await tx.vendorOptionGroup.findUnique({
          where: { vendorId_name: { vendorId, name: "Wood Finish" } },
          include: { options: { where: { code: "DEC" } } },
        });
        const decOptions = woodFinishGroup?.options ?? [];

        // 6. Upsert VendorStyles, StyleGradePrices, StyleOptionOverrides.
        let importedCount = 0;
        let skippedCount = 0;
        const errors: string[] = [];

        for (const p of uniqueProducts) {
          try {
            if (!p.styleNumber || p.gradePrices.length === 0) {
              skippedCount++;
              continue;
            }

            // Find base price: COM (fabric) or COL (leather)
            const basePrice = p.gradePrices.find((gp) => gp.grade === "COM" || gp.grade === "COL");

            const styleName = p.styleName
              ? `${p.styleName} ${p.description}`.trim()
              : p.description || p.styleNumber;

            // ── VendorStyle (catalog template) ──────────────────────
            const vendorStyle = await tx.vendorStyle.upsert({
              where: {
                styleNumber_vendorId: {
                  styleNumber: p.styleNumber,
                  vendorId,
                },
              },
              create: {
                styleNumber: p.styleNumber,
                name: styleName,
                description: p.description || null,
                vendorId,
                departmentId: department.id,
                categoryId: category.id,
                baseCost: basePrice ? basePrice.cost : null,
                comYardage: p.yardagePlain || null,
                comYardagePattern: p.yardagePattern || null,
                comYardageRepeat: p.yardageRepeat || null,
                gradeRiser: p.gradeRiser || null,
                standardSeat: p.standardSeat || null,
                standardBack: p.standardBack || null,
                standardPillows: p.standardPillows || null,
                finish: p.finish || null,
                width: p.overallWidth || null,
                depth: p.overallDepth || null,
                height: p.overallHeight || null,
                seatHeight: p.seatHeight || null,
                armHeight: p.armHeight || null,
                seatDepth: p.seatDepth || null,
                imageUrl: p.imageUrl || null,
                isActive: true,
                isDiscontinued: false,
              },
              update: {
                name: styleName,
                description: p.description || undefined,
                baseCost: basePrice ? basePrice.cost : undefined,
                comYardage: p.yardagePlain ?? undefined,
                comYardagePattern: p.yardagePattern ?? undefined,
                comYardageRepeat: p.yardageRepeat ?? undefined,
                gradeRiser: p.gradeRiser ?? undefined,
                standardSeat: p.standardSeat ?? undefined,
                standardBack: p.standardBack ?? undefined,
                standardPillows: p.standardPillows ?? undefined,
                finish: p.finish ?? undefined,
                width: p.overallWidth ?? undefined,
                depth: p.overallDepth ?? undefined,
                height: p.overallHeight ?? undefined,
                seatHeight: p.seatHeight ?? undefined,
                armHeight: p.armHeight ?? undefined,
                seatDepth: p.seatDepth ?? undefined,
                imageUrl: p.imageUrl ?? undefined,
                isActive: true,
                isDiscontinued: false,
              },
            });

            // ── Grade prices ──────────────────────────────────────
            // Filter leather grades from the primary VendorStyle only
            // when the product also has fabric grades (meaning the
            // leather grades are duplicates from a combined row) or
            // when a separate leather style number routes them to a
            // dedicated leather VendorStyle below. Leather-only frames
            // (e.g. Wesley Hall 660) keep their letter grades here.
            const hasLeatherVariant = !!p.leatherStyleNumber;
            const leatherGradeSet = new Set(leatherGrades);
            const productHasFabricGrades = p.gradePrices.some(
              (gp) => !leatherGradeSet.has(gp.grade),
            );
            const skipLeather = hasLeatherVariant || productHasFabricGrades;

            for (const gp of p.gradePrices) {
              if (skipLeather && leatherGradeSet.has(gp.grade)) continue;

              const tierId = tierMap[gp.grade];
              if (!tierId) continue;

              await tx.styleGradePrice.upsert({
                where: {
                  vendorStyleId_tierId: { vendorStyleId: vendorStyle.id, tierId },
                },
                create: {
                  vendorStyleId: vendorStyle.id,
                  tierId,
                  cost: gp.cost,
                },
                update: {
                  cost: gp.cost,
                },
              });
            }

            // ── Leather variant VendorStyle ──────────────────────
            // When a product has a separate leather style number, create a
            // distinct VendorStyle with leather-only grade pricing. Normalize
            // the leather style number to always start with "L" to prevent
            // collisions with the primary (fabric) VendorStyle.
            if (hasLeatherVariant) {
              let leatherStyleNum = p.leatherStyleNumber!;
              if (!/^L/i.test(leatherStyleNum)) {
                leatherStyleNum = `L${leatherStyleNum}`;
              }

              // Remove stale leather grade prices from the primary VendorStyle
              // left over from previous imports where the leather style number
              // collided with the primary style number.
              const leatherTierIds = leatherGrades.map((g) => tierMap[g]).filter(Boolean);
              if (leatherTierIds.length > 0) {
                await tx.styleGradePrice.deleteMany({
                  where: {
                    vendorStyleId: vendorStyle.id,
                    tierId: { in: leatherTierIds },
                  },
                });
              }

              const leatherPrices = p.gradePrices.filter((gp) => leatherGradeSet.has(gp.grade));
              if (leatherPrices.length > 0) {
                const leatherBase = leatherPrices.find((gp) => gp.grade === "COL");
                const leatherStyleName = p.styleName
                  ? `${p.styleName} ${p.description} (Leather)`.trim()
                  : `${p.description || leatherStyleNum} (Leather)`;

                const leatherVendorStyle = await tx.vendorStyle.upsert({
                  where: {
                    styleNumber_vendorId: {
                      styleNumber: leatherStyleNum,
                      vendorId,
                    },
                  },
                  create: {
                    styleNumber: leatherStyleNum,
                    name: leatherStyleName,
                    description: p.description || null,
                    vendorId,
                    departmentId: department.id,
                    categoryId: category.id,
                    baseCost: leatherBase ? leatherBase.cost : null,
                    comYardage: p.yardagePlain || null,
                    comYardagePattern: p.yardagePattern || null,
                    comYardageRepeat: p.yardageRepeat || null,
                    gradeRiser: p.gradeRiser || null,
                    standardSeat: p.standardSeat || null,
                    standardBack: p.standardBack || null,
                    standardPillows: p.standardPillows || null,
                    finish: p.finish || null,
                    width: p.overallWidth || null,
                    depth: p.overallDepth || null,
                    height: p.overallHeight || null,
                    seatHeight: p.seatHeight || null,
                    armHeight: p.armHeight || null,
                    seatDepth: p.seatDepth || null,
                    imageUrl: p.imageUrl || null,
                    isActive: true,
                    isDiscontinued: false,
                  },
                  update: {
                    name: leatherStyleName,
                    description: p.description || undefined,
                    baseCost: leatherBase ? leatherBase.cost : undefined,
                    comYardage: p.yardagePlain ?? undefined,
                    comYardagePattern: p.yardagePattern ?? undefined,
                    comYardageRepeat: p.yardageRepeat ?? undefined,
                    gradeRiser: p.gradeRiser ?? undefined,
                    standardSeat: p.standardSeat ?? undefined,
                    standardBack: p.standardBack ?? undefined,
                    standardPillows: p.standardPillows ?? undefined,
                    finish: p.finish ?? undefined,
                    width: p.overallWidth ?? undefined,
                    depth: p.overallDepth ?? undefined,
                    height: p.overallHeight ?? undefined,
                    seatHeight: p.seatHeight ?? undefined,
                    armHeight: p.armHeight ?? undefined,
                    seatDepth: p.seatDepth ?? undefined,
                    imageUrl: p.imageUrl ?? undefined,
                    isActive: true,
                    isDiscontinued: false,
                  },
                });

                for (const gp of leatherPrices) {
                  const tierId = tierMap[gp.grade];
                  if (!tierId) continue;

                  await tx.styleGradePrice.upsert({
                    where: {
                      vendorStyleId_tierId: {
                        vendorStyleId: leatherVendorStyle.id,
                        tierId,
                      },
                    },
                    create: {
                      vendorStyleId: leatherVendorStyle.id,
                      tierId,
                      cost: gp.cost,
                    },
                    update: {
                      cost: gp.cost,
                    },
                  });
                }

                importedCount++;
              }
            }

            // ── Option overrides ─────────────────────────────────────
            //    Driven by vendor-specific surcharge map.
            //    N/A from the PDF means "available at upcharge, not included as
            //    standard" (per Wesley Hall front-of-book convention). We create
            //    an override with surcharge=null so the configurator falls back
            //    to VendorOption.defaultSurcharge.
            const surchargeMap = VENDOR_SURCHARGE_MAP[resolveVendorKey(vendor.name)] || [];
            for (const mapping of surchargeMap) {
              const surchargeValue = p[mapping.productField] as number | null | undefined;
              const isStandard = mapping.isStandardField
                ? ((p[mapping.isStandardField] as boolean | undefined) ?? false)
                : false;

              // Determine if the raw field was present at all. If the product
              // field is undefined (not in the parsed data), the option row
              // wasn't in the PDF for this product -- skip it entirely.
              const rawFieldPresent = p[mapping.productField] !== undefined;
              if (!rawFieldPresent && !isStandard) continue;

              const group = await tx.vendorOptionGroup.upsert({
                where: { vendorId_name: { vendorId, name: mapping.groupName } },
                create: { vendorId, name: mapping.groupName },
                update: {},
              });
              const option = await tx.vendorOption.upsert({
                where: { groupId_name: { groupId: group.id, name: mapping.optionName } },
                create: {
                  groupId: group.id,
                  name: mapping.optionName,
                  surchargeType: "FLAT",
                  defaultSurcharge: 0,
                  sortOrder: mapping.sortOrder,
                },
                update: {},
              });

              // surcharge: null means "use VendorOption.defaultSurcharge" in the configurator.
              // >= 0 (not > 0) so that N/C ($0) is stored as explicit zero
              // rather than falling back to the default surcharge.
              const effectiveSurcharge = isStandard
                ? 0
                : surchargeValue != null && surchargeValue >= 0
                  ? surchargeValue
                  : null;

              await tx.styleOptionOverride.upsert({
                where: {
                  vendorStyleId_optionId: { vendorStyleId: vendorStyle.id, optionId: option.id },
                },
                create: {
                  vendorStyleId: vendorStyle.id,
                  optionId: option.id,
                  surcharge: effectiveSurcharge,
                  isAvailable: true,
                  isStandard,
                },
                update: { surcharge: effectiveSurcharge, isAvailable: true, isStandard },
              });
            }

            // ── Decorative finish per-frame overrides ─────────────
            //    Some frames include DEC finishes at no charge. Override the
            //    individual DEC options in the "Wood Finish" group rather than
            //    creating a separate "Decorative Finish" group.
            if (decOptions.length > 0) {
              const decorativeSurcharge = p.decorativeFinishSurcharge as number | null | undefined;
              const decorativeIsStandard =
                (p.decorativeFinishIsStandard as boolean | undefined) ?? false;

              if (
                decorativeIsStandard ||
                (decorativeSurcharge != null && decorativeSurcharge !== 100)
              ) {
                for (const decOpt of decOptions) {
                  const decEffective = decorativeIsStandard ? 0 : decorativeSurcharge;
                  await tx.styleOptionOverride.upsert({
                    where: {
                      vendorStyleId_optionId: {
                        vendorStyleId: vendorStyle.id,
                        optionId: decOpt.id,
                      },
                    },
                    create: {
                      vendorStyleId: vendorStyle.id,
                      optionId: decOpt.id,
                      surcharge: decEffective,
                      isAvailable: true,
                      isStandard: decorativeIsStandard,
                    },
                    update: {
                      surcharge: decEffective,
                      isAvailable: true,
                      isStandard: decorativeIsStandard,
                    },
                  });
                }
              }
            }

            importedCount++;
          } catch (err: unknown) {
            errors.push(`Style ${p.styleNumber}: ${getErrorMessage(err, "Unknown error")}`);
            skippedCount++;
          }
        }

        return { importedCount, skippedCount, errors, priceListId: priceList.id };
      }, TX_TIMEOUT.LONG);

      // Update vendor pricing model
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { pricingModel: "GRADE_BASED" },
      });

      // Clean up legacy "Decorative Finish" group if it exists (Wesley Hall only).
      // Individual DEC options in the "Wood Finish" group now handle this.
      if (resolveVendorKey(vendor.name) === "wesley hall") {
        const legacyGroup = await prisma.vendorOptionGroup.findUnique({
          where: { vendorId_name: { vendorId, name: "Decorative Finish" } },
          include: { options: true },
        });
        if (legacyGroup) {
          const optionIds = legacyGroup.options.map((o) => o.id);
          await prisma.styleOptionOverride.deleteMany({ where: { optionId: { in: optionIds } } });
          await prisma.productOptionOverride.deleteMany({ where: { optionId: { in: optionIds } } });
          await prisma.vendorOption.deleteMany({ where: { groupId: legacyGroup.id } });
          await prisma.vendorOptionGroup.delete({ where: { id: legacyGroup.id } });
        }
      }

      auditLog("IMPORT_WHOLESALE", (session.user as any)?.email || "unknown", {
        vendorId,
        priceListName,
        productCount: products.length,
      });

      return res.status(200).json({
        success: true,
        ...result,
      });
    } catch (error: unknown) {
      logError("Wholesale import error", error);
      return res.status(500).json({
        error: "Import failed",
        details: getErrorMessage(error, "Unknown error"),
      });
    }
  },
);
