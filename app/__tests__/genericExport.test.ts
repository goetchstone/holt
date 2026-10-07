// /app/__tests__/genericExport.test.ts

import { EXPORT_ENTITIES, EXPORT_ENTITY_KEYS, getExportEntity } from "@/lib/genericExport";

describe("genericExport catalog", () => {
  test("every key in EXPORT_ENTITY_KEYS has a matching entity def", () => {
    for (const key of EXPORT_ENTITY_KEYS) {
      expect(getExportEntity(key)?.key).toBe(key);
    }
  });

  test("entity defs and key list stay in sync (no orphans either way)", () => {
    const defKeys = EXPORT_ENTITIES.map((e) => e.key).sort();
    const listKeys = [...EXPORT_ENTITY_KEYS].sort();
    expect(defKeys).toEqual(listKeys);
  });

  test("entity keys are unique", () => {
    const keys = EXPORT_ENTITIES.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("getExportEntity returns undefined for an unknown key", () => {
    expect(getExportEntity("nope")).toBeUndefined();
    expect(getExportEntity("user")).toBeUndefined();
    expect(getExportEntity("integrationCredential")).toBeUndefined();
  });

  test("does not expose auth or credential tables", () => {
    const keys = EXPORT_ENTITIES.map((e) => e.key as string);
    expect(keys).not.toContain("user");
    expect(keys).not.toContain("account");
    expect(keys).not.toContain("session");
    expect(keys).not.toContain("integrationCredential");
  });
});
