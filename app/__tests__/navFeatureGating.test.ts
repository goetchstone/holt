// /app/__tests__/navFeatureGating.test.ts
//
// Pure tests for feature-module gating of nav items. Role logic is covered
// elsewhere; these pin that a disabled feature hides its nav item for every
// role (owner included) and that core items are never gated.

import { getVisibleNavItems, NAV_FEATURE_KEYS } from "@/lib/auth/navPermissions";

describe("nav feature gating", () => {
  test("omitting enabledFeatures leaves all role-permitted items visible (back-compat)", () => {
    const labels = getVisibleNavItems("ADMIN").map((i) => i.label);
    expect(labels).toContain("Inventory");
    expect(labels).toContain("Service");
    expect(labels).toContain("Purchasing");
  });

  test("disabling warehousing hides Inventory and Warehouse for the owner", () => {
    const labels = getVisibleNavItems("SUPER_ADMIN", undefined, { warehousing: false }).map(
      (i) => i.label,
    );
    expect(labels).not.toContain("Inventory");
    expect(labels).not.toContain("Warehouse");
    // Core items remain
    expect(labels).toContain("Sales");
    expect(labels).toContain("Reports");
  });

  test("disabling dispatch hides Service", () => {
    const labels = getVisibleNavItems("ADMIN", undefined, { dispatch: false }).map((i) => i.label);
    expect(labels).not.toContain("Service");
  });

  test("an enabled feature keeps its item visible", () => {
    const labels = getVisibleNavItems("ADMIN", undefined, {
      warehousing: true,
      purchasing: true,
    }).map((i) => i.label);
    expect(labels).toContain("Inventory");
    expect(labels).toContain("Purchasing");
  });

  test("core items (Sales/Reports/Admin/Tools) have no gating feature", () => {
    expect(NAV_FEATURE_KEYS.Sales).toBeUndefined();
    expect(NAV_FEATURE_KEYS.Reports).toBeUndefined();
    expect(NAV_FEATURE_KEYS.Admin).toBeUndefined();
    expect(NAV_FEATURE_KEYS.Tools).toBeUndefined();
  });

  test("a non-privileged role still gets feature filtering on top of role filtering", () => {
    // WAREHOUSE normally sees Inventory; disabling warehousing removes it.
    const withFeature = getVisibleNavItems("WAREHOUSE", undefined, { warehousing: false }).map(
      (i) => i.label,
    );
    expect(withFeature).not.toContain("Inventory");
  });
});
