// /app/src/lib/auth/permissionCatalog.ts
//
// The permission vocabulary — the MECHANISM half of holt's authorization.
// Which roles hold which of these is DATA (Role + RolePermission rows, seeded
// from a config preset and editable per deployment); this file only declares
// what is grantable. Same split as INTEGRATION_PROVIDERS/IntegrationCredential
// and MODULES/AppSettings.features, and the same rule as docs/DECISIONS.md #13:
// policy is data, code is mechanism.
//
// Why this exists at all. Authorization used to be three disagreeing systems:
//   - `NavPermission` rows, which only hid menu items and were consulted by no
//     API guard anywhere — an operator who unchecked "Sales" for DESIGNER had
//     revoked nothing, which is worse than no permissions UI at all;
//   - hardcoded role arrays at ~180 routes, unanswerable in aggregate ("what
//     can a DESIGNER actually do?" required a grep);
//   - hand-rolled `getServerSession` role checks in the rest, several reading
//     the role off the session (stale after a role change, blind to isActive),
//     and at least one — issuing card refunds — checking no role at all.
//
// A permission is a CAPABILITY, not a job title. Routes ask "may you refund a
// payment", never "are you a MANAGER". That indirection is what lets a
// deployment say "our designers cannot discount" without forking, and what
// lets a deployment invent a "Floor Lead" role holding exactly the capabilities
// it needs.
//
// NAMING: `domain.action`, lowercase, dot-separated, both halves kebab-case.
// Keep it stable — a permission key is persisted in RolePermission rows and in
// committed config presets, so renaming one is a migration, not an edit.

/** Grouping for the admin UI; also the unit an operator reasons about. */
export interface PermissionDomain {
  key: string;
  label: string;
  /** Why this domain is separable — helps whoever builds a custom role. */
  description: string;
}

export interface PermissionDef {
  key: string;
  domain: string;
  label: string;
  /** What holding this actually lets someone do, in an operator's terms. */
  description: string;
  /**
   * Marks a capability that moves money, changes what money means, or grants
   * power to others. The admin UI warns before granting these, and they are
   * deliberately absent from every non-privileged built-in role. This is a
   * presentation and review aid — enforcement is identical for every
   * permission.
   */
  sensitive?: boolean;
}

export const PERMISSION_DOMAINS: PermissionDomain[] = [
  { key: "sales", label: "Sales", description: "Quotes, orders, proposals, the up-board." },
  { key: "pos", label: "Point of Sale", description: "Register, tenders, tills, drawer." },
  { key: "payment", label: "Payments", description: "Taking, refunding and voiding money." },
  { key: "customer", label: "Customers", description: "Customer records, credit, interactions." },
  { key: "catalog", label: "Catalog", description: "Products, categories, vendors, pricing." },
  { key: "inventory", label: "Inventory", description: "On-hand, counts, adjustments, transfers." },
  { key: "purchasing", label: "Purchasing", description: "Purchase orders and receiving." },
  { key: "warehouse", label: "Warehouse", description: "Pick lists, dispatch, deliveries." },
  { key: "service", label: "Service", description: "Tickets, service cases, installer dispatch." },
  { key: "accounting", label: "Accounting", description: "Journals, AR, reconciliation, close." },
  { key: "reporting", label: "Reporting", description: "Reports and data export." },
  { key: "marketing", label: "Marketing", description: "Leads, campaigns, list sync." },
  { key: "staff", label: "Staff", description: "People, roles, time, commission." },
  { key: "admin", label: "Administration", description: "Settings, integrations, configuration." },
];

/**
 * Every grantable capability. Additive changes are safe; a REMOVAL orphans
 * RolePermission rows and must be paired with a migration.
 *
 * The read/write split is deliberate and shallow: most domains need only
 * "can look" versus "can change". Extra verbs appear ONLY where the action is
 * genuinely separable in a real shop — refunding is not merely writing a
 * payment, and discounting is not merely writing an order. Resist adding a
 * verb until someone can name the person who should hold one but not the other.
 */
export const PERMISSIONS: PermissionDef[] = [
  // --- Sales -------------------------------------------------------------
  {
    key: "sales.read",
    domain: "sales",
    label: "View orders",
    description: "See quotes, orders and proposals.",
  },
  {
    key: "sales.write",
    domain: "sales",
    label: "Write orders",
    description: "Create and edit quotes, orders and proposals.",
  },
  {
    key: "sales.discount",
    domain: "sales",
    label: "Apply discounts",
    description: "Reduce a line or order price below list.",
    sensitive: true,
  },
  {
    key: "sales.cancel",
    domain: "sales",
    label: "Cancel orders",
    description: "Cancel an order or line after it is written.",
    sensitive: true,
  },
  {
    key: "sales.reassign",
    domain: "sales",
    label: "Reassign salesperson",
    description: "Change who is credited for a sale — moves commission.",
    sensitive: true,
  },

  // --- Point of sale -----------------------------------------------------
  {
    key: "pos.operate",
    domain: "pos",
    label: "Operate register",
    description: "Ring sales and take tenders at a register.",
  },
  {
    key: "pos.till.manage",
    domain: "pos",
    label: "Open and close tills",
    description: "Open, close and count a till.",
  },
  {
    key: "pos.till.adjust",
    domain: "pos",
    label: "Adjust till counts",
    description: "Correct a counted till after close — changes recorded cash.",
    sensitive: true,
  },

  // --- Payments ----------------------------------------------------------
  {
    key: "payment.take",
    domain: "payment",
    label: "Take payment",
    description: "Record a payment against an order.",
  },
  {
    key: "payment.refund",
    domain: "payment",
    label: "Refund payment",
    description: "Return money to a customer.",
    sensitive: true,
  },
  {
    key: "payment.void",
    domain: "payment",
    label: "Void payment",
    description: "Void a recorded or stuck pending payment.",
    sensitive: true,
  },
  {
    key: "payment.giftcard.issue",
    domain: "payment",
    label: "Issue gift cards",
    description: "Create or load a gift card — creates a liability.",
    sensitive: true,
  },

  // --- Customers ---------------------------------------------------------
  {
    key: "customer.read",
    domain: "customer",
    label: "View customers",
    description: "See customer records and history.",
  },
  {
    key: "customer.write",
    domain: "customer",
    label: "Edit customers",
    description: "Create and edit customer records and interactions.",
  },
  {
    key: "customer.credit.adjust",
    domain: "customer",
    label: "Adjust store credit",
    description: "Grant or remove store credit.",
    sensitive: true,
  },

  // --- Catalog -----------------------------------------------------------
  {
    key: "catalog.read",
    domain: "catalog",
    label: "View catalog",
    description: "See products, categories, vendors.",
  },
  {
    key: "catalog.write",
    domain: "catalog",
    label: "Edit catalog",
    description: "Create and edit products, categories, types, departments, vendors.",
  },
  {
    key: "catalog.pricing",
    domain: "catalog",
    label: "Change pricing",
    description: "Edit cost and price, run price imports.",
    sensitive: true,
  },

  // --- Inventory ---------------------------------------------------------
  {
    key: "inventory.read",
    domain: "inventory",
    label: "View inventory",
    description: "See on-hand and inventory reports.",
  },
  {
    key: "inventory.count",
    domain: "inventory",
    label: "Run counts",
    description: "Generate snapshots, scan and reconcile physical counts.",
  },
  {
    key: "inventory.adjust",
    domain: "inventory",
    label: "Adjust inventory",
    description: "Change on-hand outside a count or a sale.",
    sensitive: true,
  },
  {
    key: "inventory.transfer",
    domain: "inventory",
    label: "Transfer stock",
    description: "Move stock between locations.",
  },

  // --- Purchasing --------------------------------------------------------
  {
    key: "purchasing.read",
    domain: "purchasing",
    label: "View purchasing",
    description: "See purchase orders and buyer drafts.",
  },
  {
    key: "purchasing.write",
    domain: "purchasing",
    label: "Write purchase orders",
    description: "Create and edit purchase orders.",
  },
  {
    key: "purchasing.receive",
    domain: "purchasing",
    label: "Receive stock",
    description: "Receive against a purchase order — creates inventory.",
  },

  // --- Warehouse ---------------------------------------------------------
  {
    key: "warehouse.read",
    domain: "warehouse",
    label: "View warehouse",
    description: "See pick lists and dispatch schedules.",
  },
  {
    key: "warehouse.operate",
    domain: "warehouse",
    label: "Operate warehouse",
    description: "Pick, stage, dispatch and mark delivered.",
  },

  // --- Service -----------------------------------------------------------
  {
    key: "service.read",
    domain: "service",
    label: "View service",
    description: "See tickets and service cases.",
  },
  {
    key: "service.write",
    domain: "service",
    label: "Work service",
    description: "Create and update tickets, cases and appointments.",
  },

  // --- Accounting --------------------------------------------------------
  {
    key: "accounting.read",
    domain: "accounting",
    label: "View accounting",
    description: "See journals, AR and reconciliation.",
  },
  {
    key: "accounting.post",
    domain: "accounting",
    label: "Post journals",
    description: "Generate and export journal entries.",
    sensitive: true,
  },
  {
    key: "accounting.close",
    domain: "accounting",
    label: "Close periods",
    description: "Lock a period against further change.",
    sensitive: true,
  },

  // --- Reporting ---------------------------------------------------------
  {
    key: "reporting.read",
    domain: "reporting",
    label: "View reports",
    description: "Run reports on screen, including sales and margin figures.",
  },
  {
    key: "reporting.export",
    domain: "reporting",
    label: "Export data",
    description: "Download report data and customer lists.",
    sensitive: true,
  },

  // --- Marketing ---------------------------------------------------------
  {
    key: "marketing.read",
    domain: "marketing",
    label: "View marketing",
    description: "See leads and campaign state.",
  },
  {
    key: "marketing.write",
    domain: "marketing",
    label: "Run marketing",
    description: "Manage leads, campaigns and list sync.",
  },

  // --- Staff -------------------------------------------------------------
  {
    key: "staff.read",
    domain: "staff",
    label: "View staff",
    description: "See the staff list and schedules.",
  },
  {
    key: "staff.time",
    domain: "staff",
    label: "Manage time",
    description: "Edit time entries and shifts.",
  },
  {
    key: "staff.manage",
    domain: "staff",
    label: "Manage staff",
    description: "Create staff and assign roles — grants power to others.",
    sensitive: true,
  },
  {
    key: "staff.commission",
    domain: "staff",
    label: "Run commission",
    description: "Edit plans and run payouts.",
    sensitive: true,
  },

  // --- Administration ----------------------------------------------------
  {
    key: "admin.settings",
    domain: "admin",
    label: "Change settings",
    description: "Edit organization settings and feature modules.",
    sensitive: true,
  },
  {
    key: "admin.integrations",
    domain: "admin",
    label: "Manage integrations",
    description: "Configure credentials for external services.",
    sensitive: true,
  },
  {
    key: "admin.config",
    domain: "admin",
    label: "Manage configuration",
    description: "Apply config presets and mappings.",
    sensitive: true,
  },
  {
    key: "admin.impersonate",
    domain: "admin",
    label: "Impersonate",
    description: "View the app as another role.",
    sensitive: true,
  },
  {
    key: "admin.data",
    domain: "admin",
    label: "Destructive data operations",
    description: "Backups, restores, bulk deletes, imports.",
    sensitive: true,
  },
];

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

const PERMISSION_BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

export function isPermissionKey(key: string): boolean {
  return PERMISSION_BY_KEY.has(key);
}

export function getPermission(key: string): PermissionDef | undefined {
  return PERMISSION_BY_KEY.get(key);
}

/**
 * Built-in roles. These SHIP with the product and cannot be deleted — a
 * deployment would otherwise be able to lock itself out — but every one of
 * them can be re-permissioned, and a deployment can add roles of its own.
 *
 * The grants below are chosen to reproduce today's behaviour, so introducing
 * the permission layer changes nothing on day one. If a mapping here is wrong,
 * that is a bug to fix against observed behaviour, not a policy decision to
 * re-argue.
 *
 * `rank` exists ONLY to stop impersonation escalating (see roleDecision.ts).
 * Unranked roles are lateral — different jobs, not rungs — and may be
 * impersonated freely by anyone who can impersonate at all.
 */
export interface BuiltInRoleDef {
  key: string;
  name: string;
  description: string;
  rank?: number;
  /** "*" means every permission, including ones added in future releases. */
  permissions: readonly string[] | "*";
}

export const BUILT_IN_ROLES: BuiltInRoleDef[] = [
  {
    key: "SUPER_ADMIN",
    name: "Owner",
    description: "Unrestricted. Holds every permission, including ones added by future releases.",
    rank: 3,
    permissions: "*",
  },
  {
    key: "ADMIN",
    name: "Administrator",
    description: "Everything except the owner-only tier.",
    rank: 2,
    permissions: PERMISSIONS.map((p) => p.key).filter((k) => k !== "admin.impersonate"),
  },
  {
    key: "MANAGER",
    name: "Manager",
    description: "Runs the store day to day: money, people, stock, and the books they touch.",
    rank: 1,
    permissions: [
      "sales.read",
      "sales.write",
      "sales.discount",
      "sales.cancel",
      "sales.reassign",
      "pos.operate",
      "pos.till.manage",
      "pos.till.adjust",
      "payment.take",
      "payment.refund",
      "payment.void",
      "payment.giftcard.issue",
      "customer.read",
      "customer.write",
      "customer.credit.adjust",
      "catalog.read",
      "catalog.write",
      "catalog.pricing",
      "inventory.read",
      "inventory.count",
      "inventory.adjust",
      "inventory.transfer",
      "purchasing.read",
      "purchasing.write",
      "purchasing.receive",
      "warehouse.read",
      "warehouse.operate",
      "service.read",
      "service.write",
      "accounting.read",
      "reporting.read",
      "reporting.export",
      "marketing.read",
      "marketing.write",
      "staff.read",
      "staff.time",
      "staff.commission",
    ],
  },
  {
    key: "DESIGNER",
    name: "Designer",
    description:
      "Sells: writes orders and works customers. No refunds, no pricing, no discounts by default.",
    permissions: [
      "sales.read",
      "sales.write",
      "customer.read",
      "customer.write",
      "catalog.read",
      "inventory.read",
      "purchasing.read",
      "service.read",
      "service.write",
      "reporting.read",
    ],
  },
  {
    key: "REGISTER",
    name: "Register",
    description: "Counter staff: rings sales and takes payment, cannot refund.",
    permissions: [
      "sales.read",
      "sales.write",
      "pos.operate",
      "pos.till.manage",
      "payment.take",
      "customer.read",
      "customer.write",
      "catalog.read",
      "inventory.read",
    ],
  },
  {
    key: "WAREHOUSE",
    name: "Warehouse",
    description: "Receives, moves and dispatches stock.",
    permissions: [
      "sales.read",
      "catalog.read",
      "inventory.read",
      "inventory.count",
      "inventory.transfer",
      "purchasing.read",
      "purchasing.receive",
      "warehouse.read",
      "warehouse.operate",
    ],
  },
  {
    key: "INSTALLER",
    name: "Installer",
    description: "Delivers and services in the field.",
    permissions: [
      "sales.read",
      "customer.read",
      "warehouse.read",
      "warehouse.operate",
      "service.read",
      "service.write",
    ],
  },
  {
    key: "MARKETING",
    name: "Marketing",
    description: "Campaigns, leads and list sync.",
    permissions: [
      "customer.read",
      "catalog.read",
      "marketing.read",
      "marketing.write",
      "reporting.read",
    ],
  },
];

/** Resolve a built-in role's grants, expanding the "*" wildcard. */
export function permissionsForBuiltInRole(roleKey: string): string[] {
  const def = BUILT_IN_ROLES.find((r) => r.key === roleKey);
  if (!def) return [];
  return def.permissions === "*" ? [...PERMISSION_KEYS] : [...def.permissions];
}
