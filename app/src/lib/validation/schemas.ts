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
});

const wholesaleProductSchema = z.object({
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
  gradePrices: z.array(gradePriceInputSchema).min(1),
  overallWidth: optionalNumber,
  overallDepth: optionalNumber,
  overallHeight: optionalNumber,
  seatHeight: optionalNumber,
  armHeight: optionalNumber,
  seatDepth: optionalNumber,
  imageUrl: optionalString,
});

export const wholesaleImportSchema = z.object({
  vendorId: z.number().int().positive(),
  priceListName: z.string().min(1),
  effectiveDate: z.string().optional(),
  products: z.array(wholesaleProductSchema).min(1),
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
