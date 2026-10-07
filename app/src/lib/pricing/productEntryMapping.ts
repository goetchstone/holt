// /app/src/lib/pricing/productEntryMapping.ts
//
// Maps configurator data to the POS fields for copy-paste item entry.
// Provides vendor-to-supplier name mapping, taxonomy suggestion (Department
// and Category), product name builder, and full-spec description builder.

// ─── the POS field shape ────────────────────────────────────────

export interface ProductEntryData {
  productName: string;
  sku: string;
  supplier: string;
  sellingPrice: string;
  description: string;
  department: string;
  category: string;
  stockType: string;
  /** Full specification text for the POS screen 2 (description + manufacturer build). */
  fullDescription: string;
}

// ─── Vendor → the POS supplier name mapping ─────────────────────

const VENDOR_SUPPLIER_MAP: Record<string, string> = {
  ekornes: "Ekornes Inc",
  stressless: "Ekornes Inc",
  "wesley hall": "Wesley Hall",
  "cr laine": "C.R. Laine",
  "c r laine": "C.R. Laine",
  "gat creek": "Gat Creek",
  polywood: "POLYWOOD",
  "kingsley bate": "Kingsley Bate",
  "brown jordan": "Brown Jordan",
  "summer classics": "Summer Classics",
  "jensen leisure": "Jensen Leisure",
  "american leather": "American Leather",
};

export function getSupplierName(vendorName: string): string {
  const key = vendorName.toLowerCase().trim();
  for (const [pattern, supplier] of Object.entries(VENDOR_SUPPLIER_MAP)) {
    if (key.includes(pattern)) return supplier;
  }
  return vendorName;
}

// ─── Taxonomy suggestion ─────────────────────────────────────────

interface TaxonomySuggestion {
  department: string;
  category: string;
  stockType: string;
}

// Vendor-level default department. Most vendors fall under "Furniture";
// outdoor brands get "Outdoor Furniture".
const VENDOR_DEPARTMENT: Record<string, string> = {
  ekornes: "Furniture",
  stressless: "Furniture",
  "wesley hall": "Furniture",
  "cr laine": "Furniture",
  "c r laine": "Furniture",
  "gat creek": "Furniture",
  polywood: "Outdoor Furniture",
  "kingsley bate": "Outdoor Furniture",
  "brown jordan": "Outdoor Furniture",
  "summer classics": "Outdoor Furniture",
  "jensen leisure": "Outdoor Furniture",
  "american leather": "Furniture",
};

// Collection-level category overrides. Keyed by lowercase vendor prefix
// then lowercase collection name.
const COLLECTION_CATEGORY: Record<string, Record<string, string>> = {
  ekornes: {
    laurel: "Dining Room",
    mint: "Dining Room",
    rosemary: "Dining Room",
    bay: "Dining Room",
    chilli: "Dining Room",
    sleep: "Bedroom",
    "sleep system": "Bedroom",
  },
  polywood: {
    "deep seating": "Deep Seating",
    adirondack: "Adirondack",
    dining: "Outdoor Dining",
    accessories: "Outdoor Accessory",
  },
};

// Description-keyword → category for product-level inference.
const PRODUCT_CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/\bdining\b/i, "Dining Room"],
  [/\bmattress\b/i, "Bedroom"],
  [/\bbed\b/i, "Bedroom"],
  [/\bsleep\b/i, "Bedroom"],
];

// Description-keyword → the POS stock type (product type).
const TYPE_KEYWORDS: [RegExp, string][] = [
  [/\brecliner\b/i, "Recliner"],
  [/\bsignature\b.*\bbase\b|\bclassic\b.*\bbase\b/i, "Recliner"],
  [/\bsectional\b/i, "Sectional"],
  [/\bsleeper\b/i, "Sleeper"],
  [/\bsofa\b/i, "Sofa"],
  [/\bloveseat\b/i, "Loveseat"],
  [/\bchaise\b/i, "Chaise"],
  [/\bchair\b/i, "Chair"],
  [/\botto?man\b/i, "Ottoman"],
  [/\bbench\b/i, "Bench"],
  [/\bstool\b/i, "Stool"],
  [/\btable\b/i, "Table"],
  [/\bmattress\b/i, "Mattress"],
  [/\bbed\b/i, "Bed"],
];

// Valid stock types per category. If the inferred type is not in the list
// for the chosen category, we fall back to the first entry.
const CATEGORY_VALID_TYPES: Record<string, string[]> = {
  "Living Room": [
    "Chair",
    "Recliner",
    "Sofa",
    "Loveseat",
    "Sectional",
    "Sleeper",
    "Ottoman",
    "Chaise",
    "Bench",
  ],
  "Dining Room": ["Chair", "Table", "Bench", "Stool"],
  Bedroom: ["Bed", "Mattress", "Bench"],
  Outdoor: ["Chair", "Table", "Bench", "Sofa", "Loveseat", "Ottoman"],
  "Deep Seating": ["Chair", "Sofa", "Loveseat", "Sectional", "Ottoman"],
  "Outdoor Dining": ["Chair", "Table", "Bench"],
  Adirondack: ["Chair"],
  "Outdoor Accessory": ["Table", "Bench"],
};

function inferType(description: string): string | null {
  for (const [pattern, type] of TYPE_KEYWORDS) {
    if (pattern.test(description)) return type;
  }
  return null;
}

function inferStockType(description: string, category: string): string {
  const type = inferType(description);
  const validTypes = CATEGORY_VALID_TYPES[category];
  if (!validTypes) return type || "";
  if (type && validTypes.includes(type)) return type;
  // Inferred type not valid for this category -- try first valid match from description
  if (type) return type;
  return "";
}

export function suggestTaxonomy(
  vendorName: string,
  collectionName: string | null,
  productDescription: string,
): TaxonomySuggestion {
  const vendorKey = vendorName.toLowerCase().trim();

  // Department: vendor-level default
  let department = "Furniture";
  for (const [pattern, dept] of Object.entries(VENDOR_DEPARTMENT)) {
    if (vendorKey.includes(pattern)) {
      department = dept;
      break;
    }
  }

  // Category: collection-level override, then product description, then default
  let category = department === "Outdoor Furniture" ? "Outdoor" : "Living Room";

  if (collectionName) {
    const collKey = collectionName.toLowerCase().trim();
    for (const [vendorPattern, collMap] of Object.entries(COLLECTION_CATEGORY)) {
      if (vendorKey.includes(vendorPattern)) {
        for (const [collPattern, cat] of Object.entries(collMap)) {
          if (collKey.includes(collPattern)) {
            category = cat;
            break;
          }
        }
        break;
      }
    }
  }

  // Product description can override (e.g. dining chairs in a mostly-recliner vendor)
  for (const [pattern, cat] of PRODUCT_CATEGORY_KEYWORDS) {
    if (pattern.test(productDescription)) {
      category = cat;
      break;
    }
  }

  const stockType = inferStockType(productDescription, category);

  return { department, category, stockType };
}

// ─── Product name builder ────────────────────────────────────────

export interface NameBuilderInput {
  vendorName: string;
  collection: string | null;
  productName: string;
  gradeName: string | null;
  fabricName: string | null;
  fabricColor: string | null;
  finishName: string | null;
}

/**
 * Build the POS Product Name field.
 * Pattern: [Brand] [Collection] [Model Details] [Grade] [Fabric Color]
 * Avoids repeating words that appear in multiple fields.
 */
export function buildProductName(input: NameBuilderInput): string {
  const parts: string[] = [];

  // Brand prefix (use vendor brand name for Stressless, otherwise vendor name)
  const brandName = input.vendorName.toLowerCase().includes("ekornes")
    ? "Stressless"
    : input.vendorName;
  parts.push(brandName);

  // Product name (includes model + variant from the parser)
  if (input.productName && input.productName !== input.collection) {
    parts.push(input.productName);
  } else if (input.collection) {
    parts.push(input.collection);
  }

  // Grade (if not a single-price / flat item)
  if (input.gradeName && input.gradeName !== "Base" && input.gradeName !== "Single Price") {
    parts.push(input.gradeName);
  }

  // Fabric color
  if (input.fabricColor) {
    parts.push(input.fabricColor);
  } else if (input.fabricName) {
    parts.push(input.fabricName);
  }

  return parts.join(" ");
}

// ─── Full description builder (the POS screen 2) ────────────────

export interface DescriptionBuilderInput {
  vendorName: string;
  collection: string | null;
  productName: string;
  styleNumber: string;
  gradeName: string | null;
  fabricName: string | null;
  fabricColor: string | null;
  fabricCode: string | null;
  finishName: string | null;
  selectedOptions: string[];
  width: number | null;
  depth: number | null;
  height: number | null;
  seatHeight: number | null;
  armHeight: number | null;
  seatDepth: number | null;
  comYardage: number | null;
  comYardagePattern: number | null;
  comYardageRepeat: number | null;
}

/**
 * Build the full specification description for the POS screen 2.
 * Also used as the Manufacturer Build Description.
 */
export function buildProductDescription(input: DescriptionBuilderInput): string {
  const lines: string[] = [];

  // Header: brand + product
  const brand = input.vendorName.toLowerCase().includes("ekornes")
    ? "Stressless"
    : input.vendorName;
  lines.push(`${brand} ${input.productName}`);
  lines.push(`Style: ${input.styleNumber}`);

  // Grade + fabric
  if (input.gradeName) {
    let gradeLine = `Grade: ${input.gradeName}`;
    if (input.fabricName) {
      gradeLine += ` - ${input.fabricName}`;
      if (input.fabricColor) gradeLine += ` ${input.fabricColor}`;
      if (input.fabricCode) gradeLine += ` (${input.fabricCode})`;
    }
    lines.push(gradeLine);
  }

  // Finish
  if (input.finishName) {
    lines.push(`Finish: ${input.finishName}`);
  }

  // Options
  if (input.selectedOptions.length > 0) {
    lines.push(`Options: ${input.selectedOptions.join(", ")}`);
  }

  // Dimensions
  const dims: string[] = [];
  if (input.width) dims.push(`W: ${input.width}"`);
  if (input.depth) dims.push(`D: ${input.depth}"`);
  if (input.height) dims.push(`H: ${input.height}"`);
  if (dims.length > 0) lines.push(dims.join(" x "));

  const seatDims: string[] = [];
  if (input.seatHeight) seatDims.push(`SH: ${input.seatHeight}"`);
  if (input.armHeight) seatDims.push(`AH: ${input.armHeight}"`);
  if (input.seatDepth) seatDims.push(`SD: ${input.seatDepth}"`);
  if (seatDims.length > 0) lines.push(seatDims.join(" | "));

  // COM yardage
  if (input.comYardage || input.comYardagePattern || input.comYardageRepeat) {
    const yardParts: string[] = [];
    if (input.comYardage) yardParts.push(`Plain: ${input.comYardage} yds`);
    if (input.comYardagePattern) yardParts.push(`Pattern: ${input.comYardagePattern} yds`);
    if (input.comYardageRepeat) yardParts.push(`Repeat: ${input.comYardageRepeat} yds`);
    lines.push(`COM Yardage: ${yardParts.join(", ")}`);
  }

  return lines.join("\n");
}

// ─── Composite: build all the POS fields ────────────────────────

export interface ProductEntryBuildInput {
  vendorName: string;
  collection: string | null;
  product: {
    productNumber: string;
    name: string;
    description: string | null;
    width: number | null;
    depth: number | null;
    height: number | null;
    seatHeight: number | null;
    armHeight: number | null;
    seatDepth: number | null;
    comYardage: number | null;
    comYardagePattern: number | null;
    comYardageRepeat: number | null;
  };
  gradeName: string | null;
  fabricName: string | null;
  fabricColor: string | null;
  fabricCode: string | null;
  finishName: string | null;
  selectedOptions: string[];
  asShownPrice: number;
}

export function buildProductEntryData(input: ProductEntryBuildInput): ProductEntryData {
  const taxonomy = suggestTaxonomy(
    input.vendorName,
    input.collection,
    input.product.name + " " + (input.product.description || ""),
  );

  const productName = buildProductName({
    vendorName: input.vendorName,
    collection: input.collection,
    productName: input.product.name,
    gradeName: input.gradeName,
    fabricName: input.fabricName,
    fabricColor: input.fabricColor,
    finishName: input.finishName,
  });

  const fullDescription = buildProductDescription({
    vendorName: input.vendorName,
    collection: input.collection,
    productName: input.product.name,
    styleNumber: input.product.productNumber,
    gradeName: input.gradeName,
    fabricName: input.fabricName,
    fabricColor: input.fabricColor,
    fabricCode: input.fabricCode,
    finishName: input.finishName,
    selectedOptions: input.selectedOptions,
    width: input.product.width,
    depth: input.product.depth,
    height: input.product.height,
    seatHeight: input.product.seatHeight,
    armHeight: input.product.armHeight,
    seatDepth: input.product.seatDepth,
    comYardage: input.product.comYardage,
    comYardagePattern: input.product.comYardagePattern,
    comYardageRepeat: input.product.comYardageRepeat,
  });

  return {
    productName,
    sku: input.product.productNumber,
    supplier: getSupplierName(input.vendorName),
    sellingPrice: Math.ceil(input.asShownPrice).toString(),
    description: productName,
    department: taxonomy.department,
    category: taxonomy.category,
    stockType: taxonomy.stockType,
    fullDescription,
  };
}
