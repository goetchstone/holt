// /app/src/lib/pricing/priceCalculator.ts
//
// Pure client-side price calculator. Takes product pricing data +
// user selections (grade, options) and returns a full price breakdown.
// No database dependency — operates entirely on passed-in data.

export interface GradePrice {
  tierId: number;
  tierCode: string;
  tierName: string;
  cost: number;
  retail: number | null;
  extrapolated?: boolean;
  fabricCount?: number;
}

export interface AvailableOption {
  optionId: number;
  groupName: string;
  optionName: string;
  surcharge: number;
  surchargeType: "FLAT" | "PERCENTAGE" | "PER_UNIT";
  isStandard: boolean;
  isAvailable: boolean;
  requiresTextInput: boolean;
  textInputLabel: string | null;
}

export interface ProductWithPricing {
  id: number;
  productNumber: string;
  name: string;
  description: string | null;
  baseCost: number | null;
  baseRetail: number | null;
  mapPrice: number | null;
  comYardage: number | null;
  comYardagePattern: number | null;
  comYardageRepeat: number | null;
  gradeRiser: number | null;
  standardSeat: string | null;
  standardBack: string | null;
  standardPillows: string | null;
  finish: string | null;
  width: number | null;
  depth: number | null;
  height: number | null;
  seatHeight: number | null;
  armHeight: number | null;
  seatDepth: number | null;
  imageUrl: string | null;
  collection: string | null;
  gradePrices: GradePrice[];
  availableOptions: AvailableOption[];
}

export interface PriceLineItem {
  label: string;
  amount: number;
}

export interface PriceCalculation {
  basePrice: number;
  gradeName: string;
  optionLines: PriceLineItem[];
  subtotalOptions: number;
  totalCost: number;
  // Retail pricing
  suggestedRetail: number;
  estimatedRetail: number; // Alias for suggestedRetail (backward compat)
  // Discount & as-shown
  discountPercent: number;
  discountAmount: number;
  asShownPrice: number;
  // Margin
  margin: number;
  marginPercent: number;
  // MAP
  mapPrice: number | null;
  mapWarning: boolean;
  // Other
  comYardage: number | null;
  comYardagePattern: number | null;
  comYardageRepeat: number | null;
  gradeRiser: number | null;
}

// ─── Frame+Cushion types (Kingsley Bate / outdoor) ──────────────

export interface CushionGradePrice {
  tierId: number;
  tierCode: string;
  tierName: string;
  retail: number | null;
}

export interface FramePlusCushionCalculation {
  framePrice: number;
  cushionPrice: number;
  frameCost: number | null;
  cushionCost: number | null;
  totalCost: number | null;
  margin: number | null;
  marginPercent: number | null;
  optionLines: PriceLineItem[];
  subtotalOptions: number;
  totalRetail: number;
  gradeName: string;
}

/**
 * Calculate the total retail price for a frame+cushion configuration.
 * When costMultiplier is provided, also computes cost and margin.
 */
export function calculateFramePlusCushionPrice(
  framePrice: number,
  cushionGradePrice: number | null,
  selectedOptions: { label: string; surchargeType: string; surcharge: number }[],
  cushionBaseForSurcharges?: number,
  costMultiplier?: number | null,
): FramePlusCushionCalculation {
  const cushionPrice = cushionGradePrice ?? 0;
  const surchargeBase = cushionBaseForSurcharges ?? cushionPrice;

  const optionLines: PriceLineItem[] = [];
  for (const opt of selectedOptions) {
    let amount = 0;
    switch (opt.surchargeType) {
      case "FLAT":
        amount = opt.surcharge;
        break;
      case "PERCENTAGE":
        amount = surchargeBase * opt.surcharge;
        break;
      case "PER_UNIT":
        amount = opt.surcharge;
        break;
    }
    if (amount !== 0) {
      optionLines.push({ label: opt.label, amount });
    }
  }

  const subtotalOptions = optionLines.reduce((sum, l) => sum + l.amount, 0);
  const totalRetail = framePrice + cushionPrice + subtotalOptions;

  let frameCost: number | null = null;
  let cushionCost: number | null = null;
  let totalCost: number | null = null;
  let margin: number | null = null;
  let marginPercent: number | null = null;

  if (costMultiplier != null) {
    frameCost = framePrice * costMultiplier;
    cushionCost = cushionPrice * costMultiplier;
    totalCost = totalRetail * costMultiplier;
    margin = totalRetail - totalCost;
    marginPercent = totalRetail > 0 ? margin / totalRetail : 0;
  }

  return {
    framePrice,
    cushionPrice,
    frameCost,
    cushionCost,
    totalCost,
    margin,
    marginPercent,
    optionLines,
    subtotalOptions,
    totalRetail,
    gradeName: cushionGradePrice !== null ? "Selected Grade" : "Frame Only",
  };
}

// ─── Wood product types (Gat Creek / species-based) ─────────────

export interface SpeciesPrice {
  tierId: number;
  tierCode: string;
  tierName: string;
  cost: number;
}

export interface AxisPrice {
  tier1Id: number;
  tier1: { id: number; code: string; name: string } | null;
  tier2Id: number | null;
  tier2: { id: number; code: string; name: string } | null;
  tier3Id: number | null;
  tier3: { id: number; code: string; name: string } | null;
  cost: number;
}

export interface WoodProductWithPricing {
  id: number;
  productNumber: string;
  name: string;
  description: string | null;
  baseCost: number | null;
  baseRetail: number | null;
  mapPrice: number | null;
  imageUrl: string | null;
  speciesPrices: SpeciesPrice[];
  axisPrices: AxisPrice[];
  availableOptions: AvailableOption[];
}

/**
 * Calculate the full price breakdown for a configured product.
 *
 * @param product - The product with all pricing data
 * @param selectedTierId - The selected grade tier ID
 * @param selectedOptionIds - Set of selected option IDs
 * @param retailMarkup - Markup multiplier for retail estimate (e.g., 2.5)
 * @param discountPercent - Discount off suggested retail (e.g., 0.20 for 20%)
 * @param mapEnforced - Whether MAP pricing is enforced for this vendor
 */
export function calculatePrice(
  product: ProductWithPricing,
  selectedTierId: number,
  selectedOptionIds: Set<number>,
  retailMarkup: number = 2.5,
  discountPercent: number = 0,
  mapEnforced: boolean = false,
): PriceCalculation {
  // Find the selected grade price
  const gradePrice = product.gradePrices.find((gp) => gp.tierId === selectedTierId);
  const basePrice = gradePrice?.cost ?? product.baseCost ?? 0;
  const gradeName = gradePrice?.tierName ?? "Base";

  // Calculate option surcharges
  const optionLines: PriceLineItem[] = [];

  for (const option of product.availableOptions) {
    if (!option.isAvailable) continue;

    // Standard options are included (no extra charge)
    if (option.isStandard) continue;

    // Only add if user selected this option
    if (!selectedOptionIds.has(option.optionId)) continue;

    let surcharge = 0;
    switch (option.surchargeType) {
      case "FLAT":
        surcharge = option.surcharge;
        break;
      case "PERCENTAGE":
        surcharge = basePrice * option.surcharge;
        break;
      case "PER_UNIT":
        surcharge = option.surcharge; // Per-unit handled at order level
        break;
    }

    optionLines.push({
      label: `${option.groupName}: ${option.optionName}`,
      amount: surcharge,
    });
  }

  const subtotalOptions = optionLines.reduce((sum, l) => sum + l.amount, 0);
  const totalCost = basePrice + subtotalOptions;

  // Retail pricing: prefer stored retail if available (retail-first vendors
  // like Brown Jordan), otherwise compute from cost * markup (wholesale-first
  // vendors like Wesley Hall / C R Laine).
  const storedRetail = gradePrice?.retail;
  const suggestedRetail =
    storedRetail != null ? storedRetail + subtotalOptions * retailMarkup : totalCost * retailMarkup;

  // Discount & as-shown
  const clampedDiscount = Math.max(0, Math.min(1, discountPercent));
  const discountAmount = suggestedRetail * clampedDiscount;
  const asShownPrice = suggestedRetail - discountAmount;

  // MAP enforcement
  const mapPrice = product.mapPrice;
  const mapWarning = !!(mapEnforced && mapPrice != null && asShownPrice < mapPrice);

  // Margin
  const margin = asShownPrice - totalCost;
  const marginPercent = asShownPrice > 0 ? margin / asShownPrice : 0;

  return {
    basePrice,
    gradeName,
    optionLines,
    subtotalOptions,
    totalCost,
    suggestedRetail,
    estimatedRetail: suggestedRetail, // backward compat alias
    discountPercent: clampedDiscount,
    discountAmount,
    asShownPrice,
    margin,
    marginPercent,
    mapPrice,
    mapWarning,
    comYardage: product.comYardage,
    comYardagePattern: product.comYardagePattern,
    comYardageRepeat: product.comYardageRepeat,
    gradeRiser: product.gradeRiser,
  };
}

// ─── Wood product calculator ─────────────────────────────────────

/**
 * Calculate the full price breakdown for a wood (species-based) product.
 *
 * For SPECIES products: pass selectedSpeciesTierId.
 * For MATRIX products: pass selectedSpeciesTierId + selectedWidthTierId + selectedLengthTierId.
 * For ROUND products: pass selectedSpeciesTierId + selectedDiameterTierId (via selectedWidthTierId).
 */
export function calculateWoodPrice(
  product: WoodProductWithPricing,
  selectedSpeciesTierId: number,
  selectedOptionIds: Set<number>,
  retailMarkup: number = 2.5,
  discountPercent: number = 0,
  mapEnforced: boolean = false,
  selectedWidthTierId?: number,
  selectedLengthTierId?: number,
): PriceCalculation {
  let basePrice = 0;
  let gradeName = "Base";

  // Determine which pricing to use
  if (product.speciesPrices.length > 0) {
    // SPECIES product: lookup by species tier
    const speciesPrice = product.speciesPrices.find((sp) => sp.tierId === selectedSpeciesTierId);
    basePrice = speciesPrice?.cost ?? product.baseCost ?? 0;
    gradeName = speciesPrice?.tierName ?? "Species";
  } else if (product.axisPrices.length > 0) {
    // MATRIX or ROUND product: lookup by species + width [+ length]
    const axisPrice = product.axisPrices.find((ap) => {
      if (ap.tier1Id !== selectedSpeciesTierId) return false;
      if (selectedWidthTierId && ap.tier2Id !== selectedWidthTierId) return false;
      if (selectedLengthTierId && ap.tier3Id !== selectedLengthTierId) return false;
      // For round tables (no length), match where tier3 is the N/A sentinel
      if (!selectedLengthTierId && ap.tier3?.code !== "N_A") return false;
      return true;
    });

    basePrice = axisPrice?.cost ?? product.baseCost ?? 0;

    // Build a descriptive name from the selected tiers
    const parts: string[] = [];
    if (axisPrice?.tier1) parts.push(axisPrice.tier1.name);
    if (axisPrice?.tier2) parts.push(axisPrice.tier2.name);
    if (axisPrice?.tier3 && axisPrice.tier3.code !== "N_A") parts.push(axisPrice.tier3.name);
    gradeName = parts.length > 0 ? parts.join(" × ") : "Custom Size";
  } else {
    basePrice = product.baseCost ?? 0;
  }

  // Calculate option surcharges (same logic as grade-based)
  const optionLines: PriceLineItem[] = [];

  for (const option of product.availableOptions) {
    if (!option.isAvailable) continue;
    if (option.isStandard) continue;
    if (!selectedOptionIds.has(option.optionId)) continue;

    let surcharge = 0;
    switch (option.surchargeType) {
      case "FLAT":
        surcharge = option.surcharge;
        break;
      case "PERCENTAGE":
        surcharge = basePrice * option.surcharge;
        break;
      case "PER_UNIT":
        surcharge = option.surcharge;
        break;
    }

    optionLines.push({
      label: `${option.groupName}: ${option.optionName}`,
      amount: surcharge,
    });
  }

  const subtotalOptions = optionLines.reduce((sum, l) => sum + l.amount, 0);
  const totalCost = basePrice + subtotalOptions;

  // Retail pricing
  const suggestedRetail = totalCost * retailMarkup;

  // Discount & as-shown
  const clampedDiscount = Math.max(0, Math.min(1, discountPercent));
  const discountAmount = suggestedRetail * clampedDiscount;
  const asShownPrice = suggestedRetail - discountAmount;

  // MAP enforcement
  const mapPrice = product.mapPrice;
  const mapWarning = !!(mapEnforced && mapPrice != null && asShownPrice < mapPrice);

  // Margin
  const margin = asShownPrice - totalCost;
  const marginPercent = asShownPrice > 0 ? margin / asShownPrice : 0;

  return {
    basePrice,
    gradeName,
    optionLines,
    subtotalOptions,
    totalCost,
    suggestedRetail,
    estimatedRetail: suggestedRetail,
    discountPercent: clampedDiscount,
    discountAmount,
    asShownPrice,
    margin,
    marginPercent,
    mapPrice,
    mapWarning,
    comYardage: null,
    comYardagePattern: null,
    comYardageRepeat: null,
    gradeRiser: null,
  };
}
