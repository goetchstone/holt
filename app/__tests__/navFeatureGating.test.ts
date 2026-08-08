// /app/__tests__/navFeatureGating.test.ts
//
// Pure tests for feature-module gating of nav items. Permission logic is
// covered in navPermissions.test.ts; these pin that the two are ORTHOGONAL — a
// module the deployment switched off hides its item even for someone who holds
// the permission, including the owner, and core items are never gated.

import { getVisibleNavItems, NAV_FEATURE_KEYS } from "@/lib/auth/navPermissions";
import { permissionsForBuiltInRole } from "@/lib/auth/permissionCatalog";

const OWNER = permissionsForBuiltInRole("SUPER_ADMIN");
const WAREHOUSE = permissionsForBuiltInRole("WAREHOUSE");

function labels(permissions: readonly string[], features?: Record<string, boolean>): string[] {
  return getVisibleNavItems(permissions, features).map((i) => i.label);
}

describe("nav feature gating", () => {
  test("omitting enabledFeatures leaves all permitted items visible (back-compat)", () => {
    const visible = labels(OWNER);
    expect(visible).toContain("Inventory");
    expect(visible).toContain("Service");
    expect(visible).toContain("Purchasing");
  });

  test("disabling warehousing hides Inventory and Warehouse for the owner", () => {
    const visible = labels(OWNER, { warehousing: false });
    expect(visible).not.toContain("Inventory");
    expect(visible).not.toContain("Warehouse");
    // Core items remain
    expect(visible).toContain("Sales");
    expect(visible).toContain("Reports");
  });

  test("disabling dispatch hides Service", () => {
    expect(labels(OWNER, { dispatch: false })).not.toContain("Service");
  });

  test("an enabled feature keeps its item visible", () => {
    const visible = labels(OWNER, { warehousing: true, purchasing: true });
    expect(visible).toContain("Inventory");
    expect(visible).toContain("Purchasing");
  });

  test("core items (Sales/Reports/Admin/Tools) have no gating feature", () => {
    expect(NAV_FEATURE_KEYS.Sales).toBeUndefined();
    expect(NAV_FEATURE_KEYS.Reports).toBeUndefined();
    expect(NAV_FEATURE_KEYS.Admin).toBeUndefined();
    expect(NAV_FEATURE_KEYS.Tools).toBeUndefined();
  });

  test("a disabled module hides its item even from someone who holds the permission", () => {
    // The point of keeping the two axes separate: WAREHOUSE holds
    // warehouse.read and inventory.read, and still sees neither item when the
    // deployment does not run the module.
    expect(labels(WAREHOUSE)).toEqual(expect.arrayContaining(["Warehouse", "Inventory"]));
    const off = labels(WAREHOUSE, { warehousing: false });
    expect(off).not.toContain("Warehouse");
    expect(off).not.toContain("Inventory");
    // Its other items are untouched.
    expect(off).toContain("Purchasing");
  });

  test("permission is still required when the module is on", () => {
    // Turning a module on grants nobody anything. MARKETING holds neither
    // warehouse.read nor inventory.read.
    const marketing = permissionsForBuiltInRole("MARKETING");
    const visible = labels(marketing, { warehousing: true });
    expect(visible).not.toContain("Warehouse");
    expect(visible).not.toContain("Inventory");
  });
});
