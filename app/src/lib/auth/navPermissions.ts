// /app/src/lib/auth/navPermissions.ts

type NavItem = {
  label: string;
  href: string;
  roles: string[];
};

const NAV_ITEMS: { label: string; href: string }[] = [
  { label: "Sales", href: "/app/sales" },
  { label: "Service", href: "/app/service" },
  { label: "Purchasing", href: "/app/purchasing" },
  { label: "Warehouse", href: "/app/warehouse" },
  { label: "Inventory", href: "/app/inventory" },
  { label: "Reports", href: "/app/reports" },
  { label: "Helpdesk", href: "/app/helpdesk" },
  { label: "Time", href: "/app/time" },
  { label: "Admin", href: "/app/admin" },
  { label: "Tools", href: "/app/tools" },
];

// Maps a nav item to the optional feature module that gates it (keys from
// lib/featureCatalog.ts). When that module is disabled in AppSettings.features,
// the nav item is hidden regardless of role. Items not listed here are core
// (Sales, Reports, Admin, Tools) and are always available.
const NAV_FEATURE_KEYS: Record<string, string> = {
  Service: "dispatch",
  Purchasing: "purchasing",
  Warehouse: "warehousing",
  Inventory: "warehousing",
  Helpdesk: "helpdesk",
  Time: "timeTracking",
};

// SUPER_ADMIN is the owner-only role above ADMIN. Everywhere ADMIN
// appears below, SUPER_ADMIN gets the same access (handled via the
// `isPrivilegedRole` helper + the early-return in getVisibleNavItems).
// SUPER_ADMIN-exclusive surfaces (e.g. commission tiers) gate
// separately via `role === 'SUPER_ADMIN'` checks at the page/endpoint.
const DEFAULT_NAV_PERMISSIONS: Record<string, string[]> = {
  Sales: ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER", "REGISTER", "MARKETING"],
  Service: ["SUPER_ADMIN", "ADMIN", "MANAGER", "WAREHOUSE"],
  Purchasing: ["SUPER_ADMIN", "ADMIN", "MANAGER", "WAREHOUSE"],
  Warehouse: ["SUPER_ADMIN", "ADMIN", "MANAGER", "WAREHOUSE"],
  Inventory: ["SUPER_ADMIN", "ADMIN", "MANAGER", "WAREHOUSE"],
  Reports: ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER", "MARKETING"],
  Helpdesk: ["SUPER_ADMIN", "ADMIN", "MANAGER"],
  Time: ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER"],
  Admin: ["SUPER_ADMIN", "ADMIN", "MANAGER"],
  // Designers need Tools for the Product Configurator (retail-only price
  // exploration + add-to-quote flow). The /tools/configurator page already
  // uses bare withAuth() so any authenticated user could reach it via
  // direct URL -- this just surfaces it in the nav. Query Builder card on
  // the /tools index page is still ADMIN-only via its own `roles` filter.
  Tools: ["SUPER_ADMIN", "ADMIN", "MANAGER", "DESIGNER"],
};

/**
 * SUPER_ADMIN and ADMIN both bypass DB-level permission overrides and
 * see every nav item. Use this in auth helpers + route gates to mean
 * "owner-or-admin-equivalent access."
 */
export function isPrivilegedRole(role: string | null | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

/**
 * Client-side equivalent of the requireAuthWithRole auto-promotion:
 * SUPER_ADMIN satisfies any check that would accept ADMIN, plus
 * itself. Use anywhere UI code reads `role === "X"` to gate UI.
 *
 * Origin: 2026-05-19 — first SUPER_ADMIN login lost the impersonate
 * dropdown + several conditional UI elements because client checks
 * were still hard-coded to `=== "ADMIN"`.
 */
export function hasRoleAccess(
  userRole: string | null | undefined,
  ...allowedRoles: string[]
): boolean {
  if (!userRole) return false;
  if (userRole === "SUPER_ADMIN") {
    return allowedRoles.includes("SUPER_ADMIN") || allowedRoles.includes("ADMIN");
  }
  return allowedRoles.includes(userRole);
}

type DbPermission = {
  navItem: string;
  role: string;
};

function buildPermissionMap(dbPermissions: DbPermission[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const p of dbPermissions) {
    if (!map[p.navItem]) map[p.navItem] = [];
    map[p.navItem].push(p.role);
  }
  return map;
}

// True when a nav item's gating feature module is enabled (or it has no
// gating feature, i.e. it's a core item). `enabledFeatures` maps a feature
// key to its on/off state; when omitted, all items pass (feature gating off).
function isNavFeatureEnabled(label: string, enabledFeatures?: Record<string, boolean>): boolean {
  if (!enabledFeatures) return true;
  const featureKey = NAV_FEATURE_KEYS[label];
  if (!featureKey) return true; // core item, never gated
  return enabledFeatures[featureKey] !== false;
}

export function getVisibleNavItems(
  role: string,
  dbPermissions?: DbPermission[],
  enabledFeatures?: Record<string, boolean>,
): NavItem[] {
  // SUPER_ADMIN + ADMIN bypass DB role overrides, but feature toggles still
  // apply -- a disabled module is hidden for everyone, owner included, so the
  // nav reflects what the deployment actually runs.
  if (isPrivilegedRole(role)) {
    return NAV_ITEMS.filter((item) => isNavFeatureEnabled(item.label, enabledFeatures)).map(
      (item) => ({
        ...item,
        roles: DEFAULT_NAV_PERMISSIONS[item.label] || [],
      }),
    );
  }

  const permMap =
    dbPermissions && dbPermissions.length > 0
      ? buildPermissionMap(dbPermissions)
      : DEFAULT_NAV_PERMISSIONS;

  return NAV_ITEMS.filter((item) => {
    if (!isNavFeatureEnabled(item.label, enabledFeatures)) return false;
    const allowed = permMap[item.label] || [];
    return allowed.includes(role);
  }).map((item) => ({
    ...item,
    roles: permMap[item.label] || [],
  }));
}

export { NAV_ITEMS, DEFAULT_NAV_PERMISSIONS, NAV_FEATURE_KEYS };
export type { NavItem, DbPermission };
