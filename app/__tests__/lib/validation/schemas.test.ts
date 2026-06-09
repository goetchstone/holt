// /app/__tests__/lib/validation/schemas.test.ts

import {
  wholesaleImportSchema,
  foundationsImportSchema,
  fabricImportSchema,
  woodPricesImportSchema,
  paginationSchema,
  idParamSchema,
} from "@/lib/validation/schemas";

// ─── wholesaleImportSchema ──────────────────────────────────────────

describe("wholesaleImportSchema", () => {
  const validPayload = {
    vendorId: 1,
    priceListName: "2026 Wholesale",
    products: [
      {
        styleNumber: "1500",
        description: "Sofa",
        styleName: "Hartwell",
        gradePrices: [{ grade: "COM", cost: 1200 }],
      },
    ],
  };

  it("accepts a valid payload", () => {
    const result = wholesaleImportSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects missing vendorId", () => {
    const result = wholesaleImportSchema.safeParse({ ...validPayload, vendorId: undefined });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive vendorId", () => {
    const result = wholesaleImportSchema.safeParse({ ...validPayload, vendorId: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects empty priceListName", () => {
    const result = wholesaleImportSchema.safeParse({ ...validPayload, priceListName: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty products array", () => {
    const result = wholesaleImportSchema.safeParse({ ...validPayload, products: [] });
    expect(result.success).toBe(false);
  });

  it("rejects product with empty styleNumber", () => {
    const payload = {
      ...validPayload,
      products: [
        {
          styleNumber: "",
          description: "X",
          styleName: "X",
          gradePrices: [{ grade: "COM", cost: 1 }],
        },
      ],
    };
    const result = wholesaleImportSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("rejects product with no grade prices", () => {
    const payload = {
      ...validPayload,
      products: [{ styleNumber: "1500", description: "X", styleName: "X", gradePrices: [] }],
    };
    const result = wholesaleImportSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("accepts optional fields as null", () => {
    const payload = {
      ...validPayload,
      products: [
        {
          styleNumber: "1500",
          description: "Sofa",
          styleName: "Hartwell",
          gradePrices: [{ grade: "COM", cost: 1200 }],
          overallWidth: null,
          finish: null,
          gradeRiser: null,
        },
      ],
    };
    const result = wholesaleImportSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});

// ─── foundationsImportSchema ────────────────────────────────────────

describe("foundationsImportSchema", () => {
  const validPayload = {
    vendorId: 1,
    priceListName: "Foundations 2026",
    products: [
      {
        styleNumber: "F-100",
        description: "Chair",
        styleName: "Entry",
        foundationsCost: 500,
        standardSeat: "Firm",
        standardBack: null,
        springDownSeatSurcharge: null,
        cdcSeatBdbBackSurcharge: null,
        decorativeFinishSurcharge: null,
        ringBaseSwivel: null,
        nailheadTrim: null,
      },
    ],
  };

  it("accepts a valid payload", () => {
    const result = foundationsImportSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("rejects non-positive foundationsCost", () => {
    const payload = {
      ...validPayload,
      products: [{ ...validPayload.products[0], foundationsCost: 0 }],
    };
    const result = foundationsImportSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

// ─── fabricImportSchema ─────────────────────────────────────────────

describe("fabricImportSchema", () => {
  it("accepts a valid payload", () => {
    const result = fabricImportSchema.safeParse({
      vendorId: 1,
      fabrics: [{ fabricName: "Beacon Hill", grade: "14" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty fabrics array", () => {
    const result = fabricImportSchema.safeParse({ vendorId: 1, fabrics: [] });
    expect(result.success).toBe(false);
  });

  it("rejects fabric with empty name", () => {
    const result = fabricImportSchema.safeParse({
      vendorId: 1,
      fabrics: [{ fabricName: "", grade: "14" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional clearExisting flag", () => {
    const result = fabricImportSchema.safeParse({
      vendorId: 1,
      fabrics: [{ fabricName: "Test", grade: "14" }],
      clearExisting: true,
    });
    expect(result.success).toBe(true);
  });
});

// ─── woodPricesImportSchema ─────────────────────────────────────────

describe("woodPricesImportSchema", () => {
  it("accepts a SPECIES product", () => {
    const result = woodPricesImportSchema.safeParse({
      vendorId: 1,
      priceListName: "Gat Creek 2026",
      products: [
        {
          productNumber: "GC-100",
          name: "Table",
          productType: "SPECIES",
          speciesPrices: [{ speciesName: "Cherry", cost: 1500 }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid productType", () => {
    const result = woodPricesImportSchema.safeParse({
      vendorId: 1,
      priceListName: "Gat Creek 2026",
      products: [{ productNumber: "GC-100", name: "Table", productType: "INVALID" }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Utility schemas ────────────────────────────────────────────────

describe("paginationSchema", () => {
  it("provides defaults for missing fields", () => {
    const result = paginationSchema.parse({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(10);
    expect(result.search).toBe("");
  });

  it("coerces string values to numbers", () => {
    const result = paginationSchema.parse({ page: "3", limit: "25" });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(25);
  });

  it("rejects limit over 100", () => {
    const result = paginationSchema.safeParse({ limit: 200 });
    expect(result.success).toBe(false);
  });
});

describe("idParamSchema", () => {
  it("coerces string ID to number", () => {
    const result = idParamSchema.parse({ id: "42" });
    expect(result.id).toBe(42);
  });

  it("rejects non-positive ID", () => {
    const result = idParamSchema.safeParse({ id: 0 });
    expect(result.success).toBe(false);
  });
});
