// /app/src/lib/auth/navPermissions.ts
//
// THE MENU IS A FUNCTION OF WHAT YOU CAN DO.
//
// A nav item is visible when the viewer holds the one permission that makes
// that destination worth opening. There is nothing to configure, nothing an
// operator can set that disagrees with the guards, and a role a deployment
// invents next year gets the right menu with no further work — because the
// grant that lets someone use a surface is the same grant that puts it in their
// menu.
//
// This replaces the `NavPermission` role table. Per permissionCatalog.ts's
// header, those rows only hid menu items and were consulted by no API guard
// anywhere: an operator who unchecked "Sales" for DESIGNER had revoked nothing,
// which is worse than no permissions UI at all. The role strings it filtered on
// were hardcoded here too, so a deployment's own "Floor Lead" got a menu that
// had nothing to do with what it could actually do.
//
// NAV IS PRESENTATION; THE GUARDS ARE ENFORCEMENT. Nothing in this file is a
// security boundary. The viewer's permission keys reach the browser on the
// NextAuth session (see pages/api/auth/[...nextauth].ts) as a DISPLAY
// CONVENIENCE. The Role/RolePermission grant table, read per request by
// permissionResolver.ts, is authoritative. A stale token can therefore only
// show or hide a link — it can never grant anything, because nothing on the
// enforcement path reads it.
//
// FEATURE MODULES ARE ORTHOGONAL and still apply on top: a module a deployment
// switched off hides its item regardless of permission.

import { permissionsForBuiltInRole } from "@/lib/auth/permissionCatalog";

type NavItem = {
  label: string;
  href: string;
  /**
   * The capability that makes this destination worth opening. Chosen by reading
   * the page, not by matching the label — see the comments below. One key per
   * item on purpose: a list of keys is a role table wearing a different hat, and
   * the point of this file is that there is no second policy to keep in sync.
   */
  /**
   * The viewer sees this item when they hold ANY of these. Several, not one,
   * because most of these are HUBS: /app/admin alone contains accounting, gift
   * cards, pricing, goals and scheduling, and its cards already self-filter.
   * Requiring one permission for the whole hub hid it from a Manager who can
   * use most of what is inside — the same "menu does not match what you can
   * do" failure this file exists to end, just pointing the other way.
   */
  permissions: readonly string[];
};

const NAV_ITEMS: NavItem[] = [
  // Pipeline, quotes, orders, proposals, invoices, POS, returns — every card on
  // the hub is an order surface, so being able to see orders is the floor.
  { label: "Sales", href: "/app/sales", permissions: ["sales.read", "customer.read"] },

  // The service-case queue. `service.read` is, verbatim, "See tickets and
  // service cases".
  { label: "Service", href: "/app/service", permissions: ["service.read"] },

  // Needs-ordering, purchase orders, receiving, vendor returns.
  { label: "Purchasing", href: "/app/purchasing", permissions: ["purchasing.read"] },

  // Inbound, outbound, awaiting delivery, transfers, pick and dispatch.
  { label: "Warehouse", href: "/app/warehouse", permissions: ["warehouse.read"] },

  // Products, vendors, categories, counts, consignment, on-hand. Reading
  // on-hand is what the hub exists for; changing it is a separate grant.
  { label: "Inventory", href: "/app/inventory", permissions: ["inventory.read"] },

  // Running reports on screen. Exporting them is `reporting.export`, which is
  // sensitive and is not what opening the hub needs.
  { label: "Reports", href: "/app/reports", permissions: ["reporting.read"] },

  // The staff ticket queue (customer-submitted support tickets). Same
  // capability as Service — `service.read` names tickets explicitly — kept a
  // separate nav item because it has its own feature module.
  { label: "Helpdesk", href: "/app/helpdesk", permissions: ["service.read"] },

  // READ THE PAGE, NOT THE LABEL. /app/time is SELF-SERVICE: it logs your own
  // entries and opens on "Mine"; the team toggle is an overlay for whoever can
  // already see other people. That is `staff.self` — the baseline everyone
  // holds — and NOT `staff.time`, which means editing somebody else's time and
  // has no surface of its own here. Gating this on staff.time would hide the
  // clock from the people who have to use it, which is the exact failure
  // BASELINE_PERMISSIONS exists to prevent.
  { label: "Time", href: "/app/time", permissions: ["staff.self"] },

  // Settings, integrations, CMS, import/export, system tools, login activity —
  // the surfaces a deployment is administered from. NOTE: no built-in role
  // below ADMIN holds any `admin.*` permission, so MANAGER no longer gets this
  // item, even though a handful of cards on the hub (Vendor Pricing, Sales
  // Goals, Salesperson Corrections, Inventory Exceptions) are manager work.
  // The fix for those is to move them to the hub of the domain they belong to,
  // NOT to widen this gate: widening it would mean granting admin.settings so
  // that a menu looks right, which is precisely the "grant power to fix the
  // menu" failure the permission layer exists to end.
  {
    label: "Admin",
    href: "/app/admin",
    permissions: [
      "admin.settings",
      "admin.integrations",
      "admin.config",
      "admin.data",
      // A Manager reaches accounting, pricing, gift cards and commission
      // through this hub. Gating it on admin.* alone took the whole menu
      // entry away from them while leaving every page inside reachable by URL.
      "accounting.read",
      "catalog.pricing",
      "payment.giftcard.issue",
      "staff.commission",
      "staff.manage",
    ],
  },

  // The only card on /app/tools with no gate of its own is the Product
  // Configurator — browse products, pick grades and options, see retail
  // pricing. That is catalog reading. Query Builder and the vendor-order
  // importers on the same page keep their own ADMIN gates.
  { label: "Tools", href: "/app/tools", permissions: ["catalog.read"] },
];

// Maps a nav item to the optional feature module that gates it (keys from
// lib/featureCatalog.ts). When that module is disabled in AppSettings.features,
// the nav item is hidden regardless of permission. Items not listed here are
// core (Sales, Reports, Admin, Tools) and are always available.
const NAV_FEATURE_KEYS: Record<string, string> = {
  Service: "dispatch",
  Purchasing: "purchasing",
  Warehouse: "warehousing",
  Inventory: "warehousing",
  Helpdesk: "helpdesk",
  Time: "timeTracking",
};

/**
 * SUPER_ADMIN and ADMIN both bypass DB-level permission overrides and
 * see every nav item. Use this in auth helpers + route gates to mean
 * "owner-or-admin-equivalent access."
 *
 * NOT used by the nav any more: SUPER_ADMIN needs no special case here, because
 * it holds every permission through the `grantsAllPermissions` wildcard and
 * therefore satisfies every item's key on the ordinary path.
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

// True when a nav item's gating feature module is enabled (or it has no
// gating feature, i.e. it's a core item). `enabledFeatures` maps a feature
// key to its on/off state; when omitted, all items pass (feature gating off).
function isNavFeatureEnabled(label: string, enabledFeatures?: Record<string, boolean>): boolean {
  if (!enabledFeatures) return true;
  const featureKey = NAV_FEATURE_KEYS[label];
  if (!featureKey) return true; // core item, never gated
  return enabledFeatures[featureKey] !== false;
}

/**
 * The nav items a viewer holding `permissions` should see.
 *
 * A plain filter over what it is handed. It deliberately does NOT union the
 * baseline floor: the floor is a floor under a ROLE, and it is applied at the
 * one place a role key becomes a grant list — grantsForRoleKey() in
 * permissionResolver.ts, the same function the guards resolve through
 * (CLAUDE.md rule 42). Someone with no active staff row has no role, so they
 * hold nothing, not even the floor, and their menu is empty. Adding the floor
 * here would quietly disagree with that.
 *
 * There is no role argument and no privileged early-return. SUPER_ADMIN sees
 * everything because it holds everything; a deployment's own role sees exactly
 * what it was granted.
 */
export function getVisibleNavItems(
  permissions: Iterable<string> | null | undefined,
  enabledFeatures?: Record<string, boolean>,
): NavItem[] {
  const held = new Set(permissions ?? []);
  return NAV_ITEMS.filter(
    (item) =>
      isNavFeatureEnabled(item.label, enabledFeatures) && item.permissions.some((p) => held.has(p)),
  );
}

/**
 * The permission keys the nav should filter on for the current viewer.
 *
 * `session` is the NextAuth session object; [...nextauth].ts attaches the
 * viewer's granted keys to it, following the same route `role` already takes so
 * there is no second mechanism and no per-page fetch. The baseline floor is
 * already in that list — it was unioned in where the role became grants — so
 * nothing is added here. Anything else (not signed in, session still loading, a
 * token minted before this shipped) resolves to NOTHING, which is the least
 * this can honestly claim and the safe direction for a menu.
 *
 * Impersonation resolves client-side from the sh-impersonate cookie exactly as
 * `role` does (useEffectiveRole). The impersonated role's built-in grants are
 * INTERSECTED with what the viewer actually holds, so "View as" can only ever
 * narrow the menu — the same rule roleDecision.ts enforces on the server, where
 * impersonation never escalates. A role key the catalog does not define narrows
 * to the baseline: a smaller menu, never a larger one.
 */
export function resolveViewerPermissions(
  session: unknown,
  impersonatedRole?: string | null,
): string[] {
  const raw = (session as { permissions?: unknown } | null | undefined)?.permissions;
  const held = Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  if (!impersonatedRole) return held;
  const viewed = new Set(permissionsForBuiltInRole(impersonatedRole));
  return held.filter((key) => viewed.has(key));
}

/**
 * The nav vocabulary itself: what the menu contains, and which module flag (if
 * any) each entry needs. `getVisibleNavItems` is the only thing that should
 * decide visibility; these are exported for it and for the tests that assert
 * every entry names a real permission and a real module.
 *
 * Both surfaces that once depended on the retired `NavPermission` role table
 * are gone: the admin Nav Permissions page, and
 * `pages/api/admin/permissions/index.ts` (deleted here — main had only swapped
 * its guard). Nothing reads a role table to decide what a viewer sees any more,
 * and nothing should: the thing that shows the link is the thing that grants
 * the page.
 */
export { NAV_ITEMS, NAV_FEATURE_KEYS };
export type { NavItem };
