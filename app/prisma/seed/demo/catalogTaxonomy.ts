// app/prisma/seed/demo/catalogTaxonomy.ts
//
// The Department -> Category -> Type taxonomy for the synthetic furniture
// retailer, plus the GL code suffix each department uses for its
// inventory/sales/COGS sub-accounts (docs/domains/accounting.md's
// "1-13XX / 4-40XX / 5-52XX, one sub-account per department" scheme).
// Shared between accounting.ts (builds the chart of accounts) and
// catalog.ts (builds Department/Category/Type/Product) so the two stay in
// lockstep without a runtime dependency between them.

export interface DepartmentDef {
  name: string;
  /** Two-digit suffix: inventory=1-13{suffix}, sales=4-40{suffix}, cogs=5-52{suffix}. */
  glSuffix: string;
  /**
   * Which column this department rolls up into on the designer dashboard.
   * Undefined means the dashboard excludes it.
   */
  reportGroup?: string;
  /** Offer this department to customers who have not bought from it. */
  crossSellTarget?: boolean;
  /** The department whose spend qualifies a customer for the cross-sell report. */
  crossSellAnchor?: boolean;
}

// The reporting roles matter for a fresh clone. Both report taxonomies used to
// be hardcoded to a different retailer's department names, none of which appear
// below -- so on the demo data the designer dashboard swept almost everything
// into one fallback column, and the cross-sell report anchored on a "Furniture"
// department that does not exist here and returned zero rows every time.
export const DEPARTMENTS: readonly DepartmentDef[] = [
  { name: "Living Room", glSuffix: "10", reportGroup: "Furniture", crossSellAnchor: true },
  { name: "Bedroom", glSuffix: "20", reportGroup: "Furniture" },
  { name: "Dining", glSuffix: "30", reportGroup: "Furniture" },
  { name: "Rugs", glSuffix: "40", reportGroup: "Rugs", crossSellTarget: true },
  { name: "Outdoor", glSuffix: "50", reportGroup: "Outdoor", crossSellTarget: true },
  { name: "Lighting", glSuffix: "60", reportGroup: "Lighting", crossSellTarget: true },
  {
    name: "Accessories & Decor",
    glSuffix: "70",
    reportGroup: "Accessories",
    crossSellTarget: true,
  },
  { name: "Mattresses", glSuffix: "80", reportGroup: "Furniture", crossSellTarget: true },
];

export interface CategoryDef {
  name: string;
  types: readonly string[];
}

export const CATEGORIES_BY_DEPARTMENT: Record<string, readonly CategoryDef[]> = {
  "Living Room": [
    { name: "Sofas & Sectionals", types: ["Sofa", "Sectional", "Loveseat"] },
    { name: "Chairs", types: ["Accent Chair", "Recliner", "Ottoman"] },
    { name: "Occasional Tables", types: ["Coffee Table", "End Table", "Console Table"] },
  ],
  Bedroom: [
    { name: "Bedroom Sets", types: ["Bed Frame", "Headboard"] },
    { name: "Storage", types: ["Dresser", "Nightstand", "Armoire"] },
  ],
  Dining: [
    { name: "Dining Tables", types: ["Dining Table", "Bar Table"] },
    { name: "Dining Seating", types: ["Dining Chair", "Bar Stool", "Bench"] },
    { name: "Storage & Display", types: ["Buffet", "China Cabinet"] },
  ],
  Rugs: [
    { name: "Area Rugs", types: ["Hand-Knotted Rug", "Power-Loomed Rug", "Flatweave Rug"] },
    { name: "Runners & Accents", types: ["Runner", "Doormat"] },
  ],
  Outdoor: [
    { name: "Outdoor Seating", types: ["Patio Sofa", "Patio Chair", "Sling Chair"] },
    { name: "Outdoor Tables", types: ["Patio Dining Table", "Fire Table"] },
  ],
  Lighting: [
    { name: "Lamps", types: ["Table Lamp", "Floor Lamp"] },
    { name: "Fixtures", types: ["Pendant", "Chandelier", "Sconce"] },
  ],
  "Accessories & Decor": [
    { name: "Wall Decor", types: ["Mirror", "Wall Art", "Wall Shelf"] },
    { name: "Decor Objects", types: ["Vase", "Sculpture", "Throw Pillow"] },
  ],
  Mattresses: [
    {
      name: "Mattresses",
      types: ["Innerspring Mattress", "Hybrid Mattress", "Memory Foam Mattress"],
    },
    { name: "Foundations", types: ["Adjustable Base", "Box Spring"] },
  ],
};
