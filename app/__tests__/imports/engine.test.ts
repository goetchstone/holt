// /app/__tests__/imports/engine.test.ts
//
// Pure tests for the configurable-import execution engine
// (lib/imports/engine.ts): field mapping, value mapping (including the
// unmapped-value-must-be-reported invariant), transforms, required-field
// validation, and would-create/would-update/skipped/error classification
// for each importMode.

import { computeNaturalKey, runImportEngine } from "@/lib/imports/engine";
import type { FieldMappingInput, ValueMappingInput } from "@/lib/imports/types";

describe("field mapping", () => {
  test("picks the raw source column value onto the target field", () => {
    const fieldMappings: FieldMappingInput[] = [{ sourceColumn: "Full Name", targetField: "name" }];
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings,
      valueMappings: [],
      rows: [{ "Full Name": "Ada Lovelace" }],
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      index: 0,
      outcome: "would-create",
      record: { name: "Ada Lovelace" },
      errors: [],
    });
  });

  test("a blank cell leaves the target field unset, not empty-string", () => {
    const fieldMappings: FieldMappingInput[] = [
      { sourceColumn: "Name", targetField: "name" },
      { sourceColumn: "Phone", targetField: "phone" },
    ];
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings,
      valueMappings: [],
      rows: [{ Name: "Ada", Phone: "  " }],
    });
    expect(result.rows[0].record).toEqual({ name: "Ada" });
  });

  test("a row where every mapped column is blank is skipped, not errored", () => {
    const fieldMappings: FieldMappingInput[] = [
      { sourceColumn: "Name", targetField: "name", required: true },
    ];
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings,
      valueMappings: [],
      rows: [{ Name: "" }, {}],
    });
    expect(result.rows.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(result.summary).toMatchObject({ total: 2, skipped: 2, errors: 0 });
  });
});

describe("value mapping", () => {
  const fieldMappings: FieldMappingInput[] = [
    { sourceColumn: "Modeofpayment", targetField: "paymentType" },
  ];
  const valueMappings: ValueMappingInput[] = [
    { targetField: "paymentType", sourceValue: "Card Connect", targetValue: "CARD" },
    { targetField: "paymentType", sourceValue: "Credit Note", targetValue: "STORE_CREDIT" },
  ];

  test("translates a configured source value onto the bounded target vocabulary", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings,
      valueMappings,
      rows: [{ Modeofpayment: "Card Connect" }],
    });
    expect(result.rows[0]).toMatchObject({
      outcome: "would-create",
      record: { paymentType: "CARD" },
    });
  });

  test("an unmapped value is a reported error, never a silent pass-through", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings,
      valueMappings,
      rows: [{ Modeofpayment: "Bitcoin" }],
    });
    expect(result.rows[0].outcome).toBe("error");
    // The raw, untranslated value must NOT leak into the normalized record.
    expect(result.rows[0].record.paymentType).toBeUndefined();
    expect(result.rows[0].errors).toEqual(['Unmapped value "Bitcoin" for field "paymentType"']);

    expect(result.unmappedValues).toEqual([
      { targetField: "paymentType", sourceValue: "Bitcoin", count: 1, rowIndexes: [0] },
    ]);
    expect(result.summary).toMatchObject({ total: 1, errors: 1 });
  });

  test("unmapped-value occurrences aggregate across rows with a running count", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings,
      valueMappings,
      rows: [
        { Modeofpayment: "Bitcoin" },
        { Modeofpayment: "Card Connect" },
        { Modeofpayment: "Bitcoin" },
      ],
    });
    expect(result.unmappedValues).toEqual([
      { targetField: "paymentType", sourceValue: "Bitcoin", count: 2, rowIndexes: [0, 2] },
    ]);
    expect(result.summary).toMatchObject({ total: 3, wouldCreate: 1, errors: 2 });
  });

  test("a field with no configured value mappings passes its value straight through", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings: [{ sourceColumn: "City", targetField: "city" }],
      valueMappings: [],
      rows: [{ City: "Glastonbury" }],
    });
    expect(result.rows[0]).toMatchObject({
      outcome: "would-create",
      record: { city: "Glastonbury" },
    });
  });
});

describe("transforms applied after value mapping", () => {
  test("a NUMBER transform coerces a mapped field's string cell to a number", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings: [{ sourceColumn: "Cost", targetField: "baseCost", transform: "NUMBER" }],
      valueMappings: [],
      rows: [{ Cost: "12.50" }],
    });
    expect(result.rows[0]).toMatchObject({ outcome: "would-create", record: { baseCost: 12.5 } });
  });

  test("a transform failure is reported as a row error, not a thrown exception", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings: [{ sourceColumn: "Cost", targetField: "baseCost", transform: "NUMBER" }],
      valueMappings: [],
      rows: [{ Cost: "twelve dollars" }],
    });
    expect(result.rows[0].outcome).toBe("error");
    expect(result.rows[0].errors[0]).toMatch(/not a valid number/);
  });
});

describe("required-field validation", () => {
  test("a missing required field is reported per row", () => {
    const fieldMappings: FieldMappingInput[] = [
      { sourceColumn: "SKU", targetField: "productNumber", required: true },
      { sourceColumn: "Name", targetField: "name", required: true },
    ];
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings,
      valueMappings: [],
      rows: [
        { SKU: "A1", Name: "Widget" },
        { SKU: "", Name: "Missing SKU" },
      ],
    });
    expect(result.rows[0].outcome).toBe("would-create");
    expect(result.rows[1]).toMatchObject({
      outcome: "error",
      errors: ['Missing required field "productNumber"'],
    });
    expect(result.summary).toMatchObject({ total: 2, wouldCreate: 1, errors: 1 });
  });
});

describe("computeNaturalKey", () => {
  test("joins present fields into one key", () => {
    const result = computeNaturalKey(["productNumber", "vendor"], {
      productNumber: "A1",
      vendor: "Acme",
    });
    expect(result).toEqual({ key: JSON.stringify(["A1", "Acme"]) });
  });

  test("reports the first missing field", () => {
    const result = computeNaturalKey(["productNumber", "vendor"], { productNumber: "A1" });
    expect(result).toEqual({ missingField: "vendor" });
  });

  test("field splits that would collide under a naive delimiter join stay distinct", () => {
    const a = computeNaturalKey(["a", "b"], { a: "X", b: "Y,Z" });
    const b = computeNaturalKey(["a", "b"], { a: "X,Y", b: "Z" });
    expect("key" in a && "key" in b && a.key !== b.key).toBe(true);
  });
});

describe("dry-run classification — INSERT_ONLY", () => {
  test("every valid row is would-create; there is no would-update concept", () => {
    const result = runImportEngine({
      importMode: "INSERT_ONLY",
      fieldMappings: [{ sourceColumn: "Name", targetField: "name" }],
      valueMappings: [],
      rows: [{ Name: "A" }, { Name: "B" }],
    });
    expect(result.rows.map((r) => r.outcome)).toEqual(["would-create", "would-create"]);
  });
});

describe("dry-run classification — UPSERT", () => {
  const fieldMappings: FieldMappingInput[] = [
    { sourceColumn: "Code", targetField: "externalId", required: true },
    { sourceColumn: "Name", targetField: "name" },
  ];

  test("a natural key present in existingNaturalKeys classifies as would-update", () => {
    const result = runImportEngine({
      importMode: "UPSERT",
      naturalKeyFields: ["externalId"],
      fieldMappings,
      valueMappings: [],
      rows: [{ Code: "C-1", Name: "Existing Customer" }],
      existingNaturalKeys: new Set([JSON.stringify(["C-1"])]),
    });
    expect(result.rows[0]).toMatchObject({
      outcome: "would-update",
      naturalKey: JSON.stringify(["C-1"]),
    });
  });

  test("a natural key absent from existingNaturalKeys classifies as would-create", () => {
    const result = runImportEngine({
      importMode: "UPSERT",
      naturalKeyFields: ["externalId"],
      fieldMappings,
      valueMappings: [],
      rows: [{ Code: "C-2", Name: "New Customer" }],
      existingNaturalKeys: new Set([JSON.stringify(["C-1"])]),
    });
    expect(result.rows[0].outcome).toBe("would-create");
  });

  test("omitting existingNaturalKeys classifies every row as would-create", () => {
    const result = runImportEngine({
      importMode: "UPSERT",
      naturalKeyFields: ["externalId"],
      fieldMappings,
      valueMappings: [],
      rows: [{ Code: "C-1", Name: "Whoever" }],
    });
    expect(result.rows[0].outcome).toBe("would-create");
  });

  test("a row that can't produce a natural key is an error, not a create", () => {
    const result = runImportEngine({
      importMode: "UPSERT",
      naturalKeyFields: ["externalId"],
      fieldMappings: [{ sourceColumn: "Name", targetField: "name" }],
      valueMappings: [],
      rows: [{ Name: "No code column mapped for externalId" }],
    });
    expect(result.rows[0]).toMatchObject({
      outcome: "error",
      errors: ['Cannot compute natural key: field "externalId" is empty'],
    });
  });
});

describe("summary counts", () => {
  test("tallies every outcome kind across a mixed batch", () => {
    const result = runImportEngine({
      importMode: "UPSERT",
      naturalKeyFields: ["externalId"],
      fieldMappings: [
        { sourceColumn: "Code", targetField: "externalId", required: true },
        { sourceColumn: "Name", targetField: "name" },
      ],
      valueMappings: [],
      rows: [
        { Code: "C-1", Name: "Update me" }, // would-update
        { Code: "C-2", Name: "Create me" }, // would-create
        {}, // skipped
        { Code: "", Name: "No code" }, // error: missing required field
      ],
      existingNaturalKeys: new Set([JSON.stringify(["C-1"])]),
    });
    expect(result.summary).toEqual({
      total: 4,
      wouldCreate: 1,
      wouldUpdate: 1,
      skipped: 1,
      errors: 1,
    });
  });
});
