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
}

export const DEPARTMENTS: readonly DepartmentDef[] = [
  { name: "Living Room", glSuffix: "10" },
  { name: "Bedroom", glSuffix: "20" },
  { name: "Dining", glSuffix: "30" },
  { name: "Rugs", glSuffix: "40" },
  { name: "Outdoor", glSuffix: "50" },
  { name: "Lighting", glSuffix: "60" },
  { name: "Accessories & Decor", glSuffix: "70" },
  { name: "Mattresses", glSuffix: "80" },
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
