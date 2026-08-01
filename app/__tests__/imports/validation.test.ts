// /app/__tests__/imports/validation.test.ts
//
// Pure tests for validateImportDefinition (lib/imports/validation.ts): the
// RECONCILE-requires-runnerKey rule (the friendly pre-flight half of the
// ImportDefinition_reconcile_requires_runner DB CHECK constraint added in
// the Stage 1 migration) and the UPSERT-requires-naturalKeyFields rule.

import { isValidImportDefinition, validateImportDefinition } from "@/lib/imports/validation";

describe("RECONCILE requires a runnerKey", () => {
  test("RECONCILE without a runnerKey is rejected", () => {
    const errors = validateImportDefinition({ importMode: "RECONCILE" });
    expect(errors).toEqual([
      'importMode "RECONCILE" requires a runnerKey — reconciliation cannot be pure config.',
    ]);
  });

  test("RECONCILE with a blank/whitespace runnerKey is still rejected", () => {
    const errors = validateImportDefinition({ importMode: "RECONCILE", runnerKey: "   " });
    expect(errors.length).toBe(1);
  });

  test("RECONCILE with a runnerKey passes", () => {
    expect(isValidImportDefinition({ importMode: "RECONCILE", runnerKey: "ordoriteSales" })).toBe(
      true,
    );
  });
});

describe("INSERT_ONLY / UPSERT do not require a runnerKey", () => {
  test("INSERT_ONLY with no runnerKey is valid", () => {
    expect(isValidImportDefinition({ importMode: "INSERT_ONLY" })).toBe(true);
  });

  test("UPSERT with a natural key and no runnerKey is valid", () => {
    expect(
      isValidImportDefinition({ importMode: "UPSERT", naturalKeyFields: ["externalId"] }),
    ).toBe(true);
  });

  test("UPSERT MAY also carry a runnerKey (e.g. customer/product) — not forbidden", () => {
    expect(
      isValidImportDefinition({
        importMode: "UPSERT",
        naturalKeyFields: ["externalId"],
        runnerKey: "customer",
      }),
    ).toBe(true);
  });
});

describe("UPSERT requires at least one natural key field", () => {
  test("UPSERT with no naturalKeyFields is rejected", () => {
    const errors = validateImportDefinition({ importMode: "UPSERT" });
    expect(errors).toEqual(['importMode "UPSERT" requires at least one naturalKeyFields entry.']);
  });

  test("UPSERT with an empty naturalKeyFields array is rejected", () => {
    expect(isValidImportDefinition({ importMode: "UPSERT", naturalKeyFields: [] })).toBe(false);
  });
});

describe("a definition can fail both rules at once", () => {
  test("RECONCILE with no runnerKey combined with an unrelated issue still reports the RECONCILE rule", () => {
    const errors = validateImportDefinition({ importMode: "RECONCILE", naturalKeyFields: [] });
    expect(errors).toEqual([
      'importMode "RECONCILE" requires a runnerKey — reconciliation cannot be pure config.',
    ]);
  });
});
