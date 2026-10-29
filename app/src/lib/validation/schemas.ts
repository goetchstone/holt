// /app/src/lib/validation/schemas.ts
//
// Zod schemas for API request validation. Each schema matches the
// request body shape expected by its corresponding import endpoint.

import { z } from "zod";

// ─── Shared primitives ──────────────────────────────────────────────

const optionalNumber = z.number().nullable().optional();
const optionalString = z.string().nullable().optional();
const optionalBoolean = z.boolean().optional();

// ─── Wholesale import ───────────────────────────────────────────────

const gradePriceInputSchema = z.object({
  grade: z.string().min(1),
  cost: z.number().positive(),
  /**
   * The material the book declares for this grade (the standard layout's
   * "Fabric 14" / "Leather D" headers, lib/pricing/standardPriceBook.ts).
   * When present it wins over the vendor profile and the shape guess; a
   * vendor's own grades are declared, never inferred.
   */
  material: z.enum(["FABRIC", "LEATHER"]).optional(),
});

/**
 * An option the book priced for one style (`StyleOption`,
 * lib/pricing/wholesale/profile.ts): the wholesale engine reads it off the
 * style's own page and the import writes it as a StyleOptionOverride.
 */
const styleOptionSchema = z.object({
  groupName: z.string().min(1),
  optionName: z.string().min(1),
  surcharge: z.number(),
  surchargeType: z.enum(["FLAT", "PERCENTAGE", "PER_UNIT"]),
  isStandard: z.boolean(),
  isAvailable: z.boolean(),
  requiresTextInput: z.boolean(),
  textInputLabel: z.string().nullable(),
  sortOrder: z.number().int(),
});

// Every field the import reads must be declared here. z.object() STRIPS
// undeclared keys, so an option the parsers produced but this schema did not
// name never reached the route: until 2026-10-29 that was `styleOptions` and
// the castor, CDC seat, Harmony, contrast welt, fiber/comfort/legacy down
// back and extra-full back surcharges, and no book's per-style options were
// ever written. The route's input type is z.infer of this schema (rule 7).
export const wholesaleProductSchema = z.object({
  styleNumber: z.string().min(1),
  description: z.string(),
  styleName: z.string(),
  leatherStyleNumber: optionalString,
  finish: optionalString,
  decorativeFinishSurcharge: optionalNumber,
  decorativeFinishIsStandard: optionalBoolean,
  standardPillows: optionalString,
  gradeRiser: optionalNumber,
  standardSeat: optionalString,
  standardBack: optionalString,
  springDownBdbSurcharge: optionalNumber,
  springDownBdbIsStandard: optionalBoolean,
  comfortDownBdbSurcharge: optionalNumber,
  comfortDownBdbIsStandard: optionalBoolean,
  yardagePlain: optionalNumber,
  yardagePattern: optionalNumber,
  yardageRepeat: optionalNumber,
  nailheadSurcharge: optionalNumber,
  nailheadIsStandard: optionalBoolean,
  armGuardSurcharge: optionalNumber,
  armGuardIsStandard: optionalBoolean,
  ringBaseSwivelSurcharge: optionalNumber,
  ringBaseSwivelIsStandard: optionalBoolean,
  castorSurcharge: optionalNumber,
  castorIsStandard: optionalBoolean,
  cdcSeatBdbBackSurcharge: optionalNumber,
  cdcSeatBdbBackIsStandard: optionalBoolean,
  harmonySurcharge: optionalNumber,
  harmonyIsStandard: optionalBoolean,
  contrastWeltSurcharge: optionalNumber,
  contrastWeltIsStandard: optionalBoolean,
  contrastBiasWeltSurcharge: optionalNumber,
  contrastBiasWeltIsStandard: optionalBoolean,
  fiberBackSurcharge: optionalNumber,
  fiberBackIsStandard: optionalBoolean,
  comfortDownBackSurcharge: optionalNumber,
  comfortDownBackIsStandard: optionalBoolean,
  legacyDownBackSurcharge: optionalNumber,
  legacyDownBackIsStandard: optionalBoolean,
  extraFullBackSurcharge: optionalNumber,
  extraFullBackIsStandard: optionalBoolean,
  styleOptions: z.array(styleOptionSchema).optional(),
  gradePrices: z.array(gradePriceInputSchema).min(1),
  overallWidth: optionalNumber,
  overallDepth: optionalNumber,
  overallHeight: optionalNumber,
  seatHeight: optionalNumber,
  armHeight: optionalNumber,
  seatDepth: optionalNumber,
  imageUrl: optionalString,
});

export const wholesaleImportSchema = z
  .object({
    vendorId: z.number().int().positive(),
    priceListName: z.string().min(1),
    effectiveDate: z.string().optional(),
    products: z.array(wholesaleProductSchema).min(1),
    // "update" is additive; "renew" retires this book's styles the new PDF no
    // longer carries. Defaults to renew -- the historical behaviour -- but now
    // scoped to `sourceBook`, never the whole vendor.
    mode: z.enum(["update", "renew"]).default("renew"),
    // The book this import owns: "wholesale", "signature-elements", "casegoods",
    // "promo", ... A slug, because it is written to every style and compared on
    // every renew.
    sourceBook: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/, "sourceBook must be a lowercase slug")
      .default("wholesale"),
    // A renew that would retire more than half of the book is refused with 409
    // unless the caller says it really means it.
    confirmShrink: z.boolean().optional(),
  })
  .superRefine((book, ctx) => {
    // The import keys its grade tiers by code alone, so one code cannot be a
    // fabric grade on one style and a leather grade on another.
    const declared = new Map<string, string>();
    for (const p of book.products) {
      for (const gp of p.gradePrices) {
        if (!gp.material) continue;
        const seen = declared.get(gp.grade);
        if (seen && seen !== gp.material) {
          ctx.addIssue({
            code: "custom",
            message: `Grade "${gp.grade}" is declared as both fabric and leather; give one of them another code.`,
            path: ["products"],
          });
          return;
        }
        declared.set(gp.grade, gp.material);
      }
    }
  });

export type WholesaleImportInput = z.infer<typeof wholesaleImportSchema>;

// ─── Foundations import ─────────────────────────────────────────────

const foundationsProductSchema = z.object({
  styleNumber: z.string().min(1),
  description: z.string(),
  styleName: z.string(),
  foundationsCost: z.number().positive(),
  standardSeat: z.string().nullable(),
  standardBack: z.string().nullable(),
  springDownSeatSurcharge: z.number().nullable(),
  springDownSeatIsStandard: optionalBoolean,
  cdcSeatBdbBackSurcharge: z.number().nullable(),
  cdcSeatBdbBackIsStandard: optionalBoolean,
  decorativeFinishSurcharge: z.number().nullable(),
  decorativeFinishIsStandard: optionalBoolean,
  ringBaseSwivel: z.number().nullable(),
  nailheadTrim: z.string().nullable(),
  nailheadSurcharge: optionalNumber,
  nailheadIsStandard: optionalBoolean,
});

export const foundationsImportSchema = z.object({
  vendorId: z.number().int().positive(),
  priceListName: z.string().min(1),
  effectiveDate: z.string().optional(),
  products: z.array(foundationsProductSchema).min(1),
});

export type FoundationsImportInput = z.infer<typeof foundationsImportSchema>;

// ─── Fabric catalog import ──────────────────────────────────────────

const fabricRowSchema = z.object({
  fabricName: z.string().min(1),
  fabricCode: optionalString,
  grade: z.string().min(1),
  colorName: z.string().optional().default(""),
  colorCode: optionalString,
  patternRepeat: optionalString,
  width: optionalString,
  content: optionalString,
  collection: optionalString,
  usage: optionalString,
  notes: optionalString,
});

export const fabricImportSchema = z.object({
  vendorId: z.number().int().positive(),
  fabrics: z.array(fabricRowSchema).min(1),
  clearExisting: z.boolean().optional(),
});

export type FabricImportInput = z.infer<typeof fabricImportSchema>;

// ─── Wood prices import ─────────────────────────────────────────────

const speciesEntrySchema = z.object({
  speciesName: z.string(),
  cost: z.number(),
});

const matrixEntrySchema = z.object({
  width: z.string(),
  length: z.string(),
  speciesName: z.string(),
  cost: z.number(),
});

const roundEntrySchema = z.object({
  diameter: z.string(),
  speciesName: z.string(),
  cost: z.number(),
});

const woodProductSchema = z.object({
  productNumber: z.string().min(1),
  name: z.string(),
  description: z.string().optional().default(""),
  productType: z.enum(["SPECIES", "MATRIX", "ROUND"]),
  speciesPrices: z.array(speciesEntrySchema).optional().default([]),
  matrixPrices: z.array(matrixEntrySchema).optional().default([]),
  roundPrices: z.array(roundEntrySchema).optional().default([]),
});

export const woodPricesImportSchema = z.object({
  vendorId: z.number().int().positive(),
  priceListName: z.string().min(1),
  effectiveDate: z.string().optional(),
  products: z.array(woodProductSchema).min(1),
});

export type WoodPricesImportInput = z.infer<typeof woodPricesImportSchema>;

// ─── Shared utility schemas ─────────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  search: z.string().optional().default(""),
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
