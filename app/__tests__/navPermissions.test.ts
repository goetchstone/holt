// /app/__tests__/navPermissions.test.ts
//
// The menu is a function of what you can do. These pin that function:
//
//   - every built-in role gets the menu its GRANTS earn, with no role strings
//     anywhere in the derivation;
//   - a role a deployment invented, holding exactly one permission, gets
//     exactly the item that permission earns;
//   - a role scoped down to nothing still gets whatever the baseline floor
//     earns, and nothing else;
//   - SUPER_ADMIN sees everything without a privileged special case — it holds
//     every permission, so it satisfies every item on the ordinary path.
//
// Feature-module gating has its own file (navFeatureGating.test.ts); it is
// orthogonal and unchanged.

import {
  getVisibleNavItems,
  resolveViewerPermissions,
  NAV_ITEMS,
  NAV_FEATURE_KEYS,
} from "@/lib/auth/navPermissions";
import {
  BASELINE_PERMISSIONS,
  PERMISSION_KEYS,
  permissionsForBuiltInRole,
  withBaselinePermissions,
} from "@/lib/auth/permissionCatalog";
import { isValidFeatureKey } from "@/lib/featureCatalog";

/** Labels a holder of `permissions` sees, features all on. */
function labelsFor(permissions: readonly string[]): string[] {
  return getVisibleNavItems(permissions).map((i) => i.label);
}

/** Labels the named built-in role's GRANTS earn. No role string reaches the nav. */
function labelsForBuiltInRole(roleKey: string): string[] {
  return labelsFor(permissionsForBuiltInRole(roleKey));
}

const ALL_LABELS = NAV_ITEMS.map((i) => i.label);

describe("the nav item table itself", () => {
  it("names a permission that actually exists for every item", () => {
    // Tripwire, not decoration: a mistyped or renamed key fails open-ended —
    // the item silently disappears for everyone, including the owner, and no
    // other test in this file would necessarily catch which one.
    for (const item of NAV_ITEMS) {
      for (const key of item.permissions) {
        expect(PERMISSION_KEYS).toContain(key);
      }
      // An item with no permissions would be visible to nobody, silently.
      expect(item.permissions.length).toBeGreaterThan(0);
    }
  });

  it("gates each feature-gated item on a real module key", () => {
    for (const [label, featureKey] of Object.entries(NAV_FEATURE_KEYS)) {
      expect(ALL_LABELS).toContain(label);
      expect(isValidFeatureKey(featureKey)).toBe(true);
    }
  });
});

describe("built-in roles get the menu their grants earn", () => {
  it("SUPER_ADMIN sees everything", () => {
    // Via the wildcard, with no privileged early-return anywhere in the nav.
    expect(labelsForBuiltInRole("SUPER_ADMIN")).toEqual(ALL_LABELS);
  });

  it("ADMIN sees everything", () => {
    // ADMIN holds every permission except admin.impersonate, which no nav item
    // is gated on.
    expect(labelsForBuiltInRole("ADMIN")).toEqual(ALL_LABELS);
  });

  it("MANAGER sees every hub including Admin — it can use what is inside", () => {
    // Admin is a HUB: accounting, pricing, gift cards, goals and scheduling all
    // live under it and a Manager holds capabilities for several. Gating the
    // entry on admin.* alone removed the link while leaving every page behind
    // it reachable by URL, which is the menu lying about access.
    expect(labelsForBuiltInRole("MANAGER")).toEqual([
      "Sales",
      "Service",
      "Purchasing",
      "Warehouse",
      "Inventory",
      "Reports",
      "Helpdesk",
      "Time",
      "Admin",
      "Tools",
    ]);
  });

  it("DESIGNER sells and reads, and never sees Warehouse or Admin", () => {
    expect(labelsForBuiltInRole("DESIGNER")).toEqual([
      "Sales",
      "Service",
      "Purchasing",
      "Inventory",
      "Reports",
      "Helpdesk",
      "Time",
      "Tools",
    ]);
  });

  it("REGISTER sees the counter's surfaces only", () => {
    expect(labelsForBuiltInRole("REGISTER")).toEqual(["Sales", "Inventory", "Time", "Tools"]);
  });

  it("WAREHOUSE sees stock movement, and no Reports or Admin", () => {
    expect(labelsForBuiltInRole("WAREHOUSE")).toEqual([
      "Sales",
      "Purchasing",
      "Warehouse",
      "Inventory",
      "Time",
      "Tools",
    ]);
  });

  it("INSTALLER gets a menu at all — the old role table defined none", () => {
    // INSTALLER existed in the enum with no DEFAULT_NAV_PERMISSIONS entry, so
    // it used to sign in to an empty menu. Its grants say otherwise.
    expect(labelsForBuiltInRole("INSTALLER")).toEqual([
      "Sales",
      "Service",
      "Warehouse",
      "Helpdesk",
      "Time",
    ]);
  });

  it("MARKETING sees Sales for Customers, though it cannot read orders", () => {
    // It holds customer.read and not sales.read. Customers live under the Sales
    // hub, which is the only reason Marketing ever went there; requiring
    // sales.read took away the only route to a page it can use.
    expect(labelsForBuiltInRole("MARKETING")).toEqual(["Sales", "Reports", "Time", "Tools"]);
  });
});

describe("a role the deployment invented", () => {
  it("holding exactly sales.read sees Sales and not Warehouse", () => {
    const labels = labelsFor(["sales.read"]);
    expect(labels).toContain("Sales");
    expect(labels).not.toContain("Warehouse");
    expect(labels).not.toContain("Purchasing");
    expect(labels).not.toContain("Reports");
    expect(labels).not.toContain("Admin");
  });

  it("holding warehouse.read sees Warehouse and not Sales", () => {
    const labels = labelsFor(["warehouse.read"]);
    expect(labels).toContain("Warehouse");
    expect(labels).not.toContain("Sales");
  });

  it("needs no code change to get the right menu — the grant is the whole input", () => {
    // A "Floor Lead" nobody wrote a role string for. withBaselinePermissions is
    // what grantsForRoleKey() applies to every role's rows, invented or not.
    const floorLead = withBaselinePermissions(["sales.read", "reporting.read", "warehouse.read"]);
    expect(labelsFor(floorLead)).toEqual(["Sales", "Warehouse", "Reports", "Time"]);
  });
});

describe("the baseline floor", () => {
  it("earns Time and nothing else", () => {
    // /app/time is self-service: staff.self is exactly "clock yourself in and
    // out, see your own time". A role scoped to nothing can still reach it.
    expect(labelsFor([...BASELINE_PERMISSIONS])).toEqual(["Time"]);
    // And it reaches every role, invented ones included, because
    // permissionsForBuiltInRole/grantsForRoleKey union it in.
    expect(labelsFor(permissionsForBuiltInRole("SOME_ROLE_NOBODY_DECLARED"))).toEqual(["Time"]);
  });

  it("is still withheld when its feature module is off", () => {
    // A permission floor, not an exemption from what the deployment runs.
    expect(getVisibleNavItems(BASELINE_PERMISSIONS, { timeTracking: false })).toEqual([]);
  });

  it("is NOT re-added by the nav — holding nothing means an empty menu", () => {
    // The floor sits under a ROLE. Someone with no active staff row has no
    // role, so resolveGrantedPermissions() hands back [] and the menu is empty.
    // Unioning the floor here would quietly disagree with the guards, which
    // deny that person outright.
    expect(getVisibleNavItems([])).toEqual([]);
    expect(getVisibleNavItems(null)).toEqual([]);
    expect(getVisibleNavItems(undefined)).toEqual([]);
  });
});

describe("resolveViewerPermissions", () => {
  it("reads the keys the session carries", () => {
    expect(resolveViewerPermissions({ permissions: ["sales.read"] })).toContain("sales.read");
  });

  it("carries the baseline the token already contains, without re-adding it", () => {
    // The floor was unioned in server-side, where the role became grants.
    expect(resolveViewerPermissions({ permissions: ["sales.read", "staff.self"] })).toEqual([
      "sales.read",
      "staff.self",
    ]);
  });

  it("resolves to nothing for a session that carries nothing", () => {
    // Not signed in, session still loading, or a token minted before
    // permissions shipped. The least it can honestly claim.
    for (const session of [null, undefined, {}, { permissions: null }, { role: "ADMIN" }]) {
      expect(resolveViewerPermissions(session)).toEqual([]);
    }
  });

  it("ignores non-string entries rather than trusting the token's shape", () => {
    expect(resolveViewerPermissions({ permissions: ["sales.read", 7, null] })).toEqual([
      "sales.read",
    ]);
  });

  describe("impersonation", () => {
    const admin = { permissions: permissionsForBuiltInRole("ADMIN") };

    it("narrows the menu to the impersonated role", () => {
      const permissions = resolveViewerPermissions(admin, "REGISTER");
      expect(labelsFor(permissions)).toEqual(["Sales", "Inventory", "Time", "Tools"]);
    });

    it("can only ever narrow — never grant what the viewer does not hold", () => {
      // The server rule (roleDecision.ts): impersonation never escalates. An
      // ADMIN viewing as SUPER_ADMIN is still an ADMIN, so admin.impersonate —
      // the one key ADMIN lacks — stays absent.
      const permissions = resolveViewerPermissions(admin, "SUPER_ADMIN");
      expect(permissions).not.toContain("admin.impersonate");
      expect(labelsFor(permissions)).toEqual(ALL_LABELS);
    });

    it("narrows to the baseline for a role the catalog does not define", () => {
      // A deployment's own role: its grants live in the database, which the
      // browser has no copy of. Showing less is the safe direction, and the
      // guards decide what actually opens either way.
      expect(labelsFor(resolveViewerPermissions(admin, "FLOOR_LEAD"))).toEqual(["Time"]);
    });

    it("leaves the menu alone when nothing is being impersonated", () => {
      expect(labelsFor(resolveViewerPermissions(admin, null))).toEqual(ALL_LABELS);
      expect(labelsFor(resolveViewerPermissions(admin))).toEqual(ALL_LABELS);
    });
  });
});
