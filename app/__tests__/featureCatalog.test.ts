// /app/__tests__/featureCatalog.test.ts

import { FEATURES, isFeatureEnabled, isValidFeatureKey } from "@/lib/featureCatalog";

describe("featureCatalog operational flags", () => {
  it("exposes the operational module flags a reporting-first deployment can switch off", () => {
    for (const key of ["pos", "giftCards", "tills"]) {
      expect(isValidFeatureKey(key)).toBe(true);
      // Default ON for the full-ERP product; a deployment turns them off.
      expect(FEATURES.find((f) => f.key === key)?.defaultEnabled).toBe(true);
    }
  });

  it("resolves a feature via explicit AppSettings value, else catalog default", () => {
    // Reporting-first tenant: explicitly off -> hidden.
    expect(isFeatureEnabled({ pos: false, giftCards: false, tills: false }, "pos")).toBe(false);
    expect(isFeatureEnabled({ pos: false }, "giftCards")).toBe(true); // unset -> default ON
    expect(isFeatureEnabled({}, "tills")).toBe(true); // unset -> default ON
  });

  it("rejects unknown keys", () => {
    expect(isValidFeatureKey("not-a-feature")).toBe(false);
    expect(isFeatureEnabled({}, "not-a-feature")).toBe(false);
  });
});
