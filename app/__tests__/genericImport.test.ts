// /app/__tests__/genericImport.test.ts
//
// Pure tests for the generic CSV importer's client/server contract: entity
// lookup, header auto-mapping across realistic export shapes, claim-once
// behavior, and registry integrity (no duplicate entity or field keys).

import {
  IMPORT_ENTITIES,
  getImportEntity,
  suggestMapping,
  type ImportEntityDef,
} from "@/lib/genericImport";

describe("getImportEntity", () => {
  test("returns the customer and product entities", () => {
    expect(getImportEntity("customer")?.label).toBe("Customers");
    expect(getImportEntity("product")?.label).toBe("Products");
  });

  test("returns undefined for an unknown entity", () => {
    expect(getImportEntity("nope")).toBeUndefined();
  });
});

describe("registry integrity", () => {
  test("entity keys are unique", () => {
    const keys = IMPORT_ENTITIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("field keys are unique within each entity", () => {
    for (const entity of IMPORT_ENTITIES) {
      const keys = entity.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("suggestMapping — customers", () => {
  const entity = getImportEntity("customer")!;

  test("maps a typical CRM export with separate name columns", () => {
    const headers = [
      "Customer Code",
      "First Name",
      "Last Name",
      "Email Address",
      "Phone Number",
      "Street Address",
      "City",
      "State",
      "Zip Code",
    ];
    expect(suggestMapping(headers, entity)).toEqual({
      externalId: "Customer Code",
      name: null,
      firstName: "First Name",
      lastName: "Last Name",
      email: "Email Address",
      phone: "Phone Number",
      address1: "Street Address",
      city: "City",
      state: "State",
      zip: "Zip Code",
    });
  });

  test("matches a single full-name column and is punctuation/case insensitive", () => {
    const map = suggestMapping(["customer", "e-mail", "TEL"], entity);
    expect(map.name).toBe("customer");
    expect(map.email).toBe("e-mail");
    expect(map.phone).toBe("TEL");
    expect(map.firstName).toBeNull();
  });
});

describe("suggestMapping — products", () => {
  const entity = getImportEntity("product")!;

  test("maps a typical catalog export and keeps Name and Description distinct", () => {
    const headers = [
      "SKU",
      "Product Name",
      "Supplier",
      "Department",
      "Category",
      "Cost",
      "Retail Price",
      "Description",
    ];
    expect(suggestMapping(headers, entity)).toEqual({
      productNumber: "SKU",
      name: "Product Name",
      vendor: "Supplier",
      department: "Department",
      category: "Category",
      baseCost: "Cost",
      baseRetail: "Retail Price",
      description: "Description",
    });
  });

  test("required fields are null when no column matches", () => {
    const map = suggestMapping(["Foo", "Bar"], entity);
    expect(map.productNumber).toBeNull();
    expect(map.name).toBeNull();
  });
});

describe("suggestMapping — claim-once", () => {
  // Two fields sharing an alias: the first field in declaration order wins the
  // single matching header; the second is left unmapped rather than
  // double-claiming the same column.
  const entity: ImportEntityDef = {
    key: "fake",
    label: "Fake",
    description: "",
    fields: [
      { key: "a", label: "A", type: "string", aliases: ["shared"] },
      { key: "b", label: "B", type: "string", aliases: ["shared"] },
    ],
  };

  test("a single shared header is claimed by the first field only", () => {
    expect(suggestMapping(["Shared"], entity)).toEqual({ a: "Shared", b: null });
  });

  test("two matching headers are split across both fields", () => {
    // Both headers normalize to a candidate of both fields; each field takes
    // the first still-unclaimed header.
    expect(suggestMapping(["shared", "Shared"], entity)).toEqual({
      a: "shared",
      b: "Shared",
    });
  });
});
