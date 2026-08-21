// /app/src/lib/auth/pagePermissions.ts
//
// THE PAGE ACCESS MANIFEST — one entry per dashboard page, no exceptions.
//
// Every page called requirePage(), so every page required a LOGIN. What most of
// them did not require was a CAPABILITY: 84 pages admitted any signed-in user,
// including /app/inventory/consignment/payments and /app/inventory/products/new,
// and the rest gated on hardcoded role arrays -- the same "unanswerable in
// aggregate" pattern permissionCatalog.ts's header describes as the thing the
// permission layer exists to replace. The nav had already moved to permissions,
// so the menu and the guards were free to drift, which is precisely what
// requirePage's own documentation warns about.
//
// A page's entry is its permission. `null` means deliberately open to any signed
// -in staff member, and owes a reason.
//
// `widensFrom` marks a page whose mapped permission would ADMIT ROLES ITS
// CURRENT ROLE ARRAY EXCLUDES. Those are NOT applied: quietly granting access
// during a security cleanup is how a cleanup becomes an incident. They stay
// listed with the role array they have today, so the decision is visible and
// someone can take it deliberately.
//
// __tests__/pagePermissions.test.ts enforces all of it: a new page is a failure
// until it is classified, and an entry without `widensFrom` must match the guard
// the page actually calls.

export interface PageAccess {
  /** Catalog permission key, or null for pages any signed-in staff may open. */
  permission: string | null;
  /** Required when `permission` is null. */
  reason?: string;
  /**
   * The role array this page gates on today, when adopting `permission` would
   * widen access. Present means NOT YET APPLIED -- awaiting a decision.
   */
  widensFrom?: string;
}

export const PAGE_ACCESS: Record<string, PageAccess> = {
  "/app": { permission: null, reason: "the signed-in landing page; every staff member lands here" },
  "/app/account": { permission: "staff.self" },
  "/app/admin": { permission: "admin.settings" },
  "/app/admin/accounting/journal-entries": { permission: "accounting.read" },
  "/app/admin/automations/axper-traffic": { permission: "admin.settings" },
  "/app/admin/automations/customer-ar-drift-check": { permission: "admin.settings" },
  "/app/admin/automations/daily-reconciliation": { permission: "admin.settings" },
  "/app/admin/automations/mailchimp-sync": { permission: "admin.settings" },
  "/app/admin/automations/pos-import": { permission: "admin.settings" },
  "/app/admin/bookings": { permission: "admin.settings" },
  "/app/admin/buyer-drafts": { permission: "admin.settings" },
  "/app/admin/buyer-drafts/archive": { permission: "admin.settings" },
  "/app/admin/buyer-drafts/buy/[id]/performance": { permission: "admin.settings" },
  "/app/admin/cms": { permission: "admin.settings" },
  "/app/admin/cms/comments": { permission: "admin.settings" },
  "/app/admin/cms/menus": { permission: "admin.settings" },
  "/app/admin/cms/pages": { permission: "admin.settings" },
  "/app/admin/cms/pages/[id]": { permission: "admin.settings" },
  "/app/admin/cms/pages/new": { permission: "admin.settings" },
  "/app/admin/cms/posts": { permission: "admin.settings" },
  "/app/admin/cms/posts/[id]": { permission: "admin.settings" },
  "/app/admin/cms/posts/new": { permission: "admin.settings" },
  "/app/admin/diagnostics/lookup-test": { permission: "admin.settings" },
  "/app/admin/diagnostics/relink-line-items": { permission: "admin.settings" },
  "/app/admin/diagnostics/upcs": { permission: "admin.settings" },
  "/app/admin/email": { permission: "admin.settings" },
  "/app/admin/export/data": { permission: "admin.settings" },
  "/app/admin/export/windfall": { permission: "admin.settings" },
  "/app/admin/gift-cards": { permission: "admin.settings" },
  "/app/admin/gift-cards/[id]": { permission: "admin.settings" },
  "/app/admin/gift-cards/import": { permission: "admin.settings" },
  "/app/admin/goals": { permission: "admin.settings" },
  "/app/admin/import": { permission: "admin.data" },
  "/app/admin/import/categories": { permission: "admin.data" },
  "/app/admin/import/consignment": { permission: "admin.data" },
  "/app/admin/import/data": { permission: "admin.data" },
  "/app/admin/import/departments": { permission: "admin.data" },
  "/app/admin/import/inventory-snapshot": { permission: "admin.data" },
  "/app/admin/import/service-cases": { permission: "admin.data" },
  "/app/admin/import/types": { permission: "admin.data" },
  "/app/admin/import/vendors": { permission: "admin.data" },
  "/app/admin/import/windfall": { permission: "admin.data" },
  "/app/admin/inventory-exceptions": { permission: "admin.settings" },
  "/app/admin/login-activity": { permission: "admin.settings" },
  "/app/admin/pricing": { permission: "admin.settings" },
  "/app/admin/pricing/configurator": { permission: "admin.settings" },
  "/app/admin/pricing/fabrics": { permission: "admin.settings" },
  "/app/admin/pricing/import": { permission: "admin.settings" },
  "/app/admin/pricing/import/wesley-hall": { permission: "admin.settings" },
  "/app/admin/pricing/options": { permission: "admin.settings" },
  "/app/admin/pricing/product-review": { permission: "admin.settings" },
  "/app/admin/pricing/style-editor": { permission: "admin.settings" },
  "/app/admin/reports/commission-tiers": { permission: "admin.settings" },
  "/app/admin/reports/monthly-percentages": { permission: "admin.settings" },
  "/app/admin/sales/goals": { permission: "admin.settings" },
  "/app/admin/sales/salesperson-corrections": { permission: "admin.settings" },
  "/app/admin/scheduling": { permission: "admin.settings" },
  "/app/admin/service/delivery-zones": { permission: "admin.settings" },
  "/app/admin/service/installers": { permission: "admin.settings" },
  "/app/admin/service/vehicles": { permission: "admin.settings" },
  "/app/admin/settings": { permission: "admin.settings" },
  "/app/admin/settings/[module]": { permission: "admin.settings" },
  "/app/admin/settings/configuration": { permission: "admin.settings" },
  "/app/admin/settings/integrations": { permission: "admin.settings" },
  "/app/admin/setup": { permission: "admin.config" },
  "/app/admin/setup/accounting": { permission: "admin.config" },
  "/app/admin/setup/database": { permission: "admin.config" },
  "/app/admin/setup/email-templates": { permission: "admin.config" },
  "/app/admin/setup/gift-cards": { permission: "admin.config" },
  "/app/admin/setup/labels": { permission: "admin.config" },
  "/app/admin/setup/printers": { permission: "admin.config" },
  "/app/admin/setup/product-pairings": { permission: "admin.config" },
  "/app/admin/setup/registers": { permission: "admin.config" },
  "/app/admin/setup/roles": { permission: "admin.config" },
  "/app/admin/setup/service": { permission: "admin.config" },
  "/app/admin/setup/stores": { permission: "admin.config" },
  "/app/admin/setup/tax": { permission: "admin.config" },
  "/app/admin/setup/tax/load-zips": { permission: "admin.config" },
  "/app/admin/setup/trade-tiers": { permission: "admin.config" },
  "/app/admin/staff": { permission: "staff.manage" },
  "/app/admin/tools": { permission: "admin.settings" },
  "/app/admin/tools/categorize-products": { permission: "admin.settings" },
  "/app/admin/tools/customer-ledger-backfill": { permission: "admin.settings" },
  "/app/admin/tools/merge-customers": { permission: "admin.settings" },
  "/app/dispatch": { permission: "warehouse.read", widensFrom: "MANAGER,ADMIN,WAREHOUSE" },
  "/app/dispatch/driver": { permission: "warehouse.operate" },
  "/app/dispatch/pick-list/[id]": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/dispatch/planner": { permission: "warehouse.read", widensFrom: "MANAGER,ADMIN,WAREHOUSE" },
  "/app/dispatch/ready-to-deliver": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/dispatch/run/[id]": { permission: "warehouse.read", widensFrom: "MANAGER,ADMIN,WAREHOUSE" },
  "/app/helpdesk": { permission: "service.read" },
  "/app/helpdesk/[id]": { permission: "service.read", widensFrom: "ADMIN,MANAGER" },
  "/app/interactions": { permission: "customer.read" },
  "/app/interactions/[id]": { permission: "customer.read" },
  "/app/inventory": { permission: "inventory.read" },
  "/app/inventory/accurate-scans": { permission: "inventory.count" },
  "/app/inventory/categories": { permission: "catalog.read" },
  "/app/inventory/consignment": { permission: "inventory.read" },
  "/app/inventory/consignment/[id]": { permission: "inventory.read" },
  "/app/inventory/consignment/count": { permission: "inventory.read" },
  "/app/inventory/consignment/credits-owed": {
    permission: "inventory.read",
    widensFrom: "MANAGER,ADMIN",
  },
  "/app/inventory/consignment/payments": { permission: "accounting.read" },
  "/app/inventory/consignment/po-management": {
    permission: "inventory.read",
    widensFrom: "MANAGER,ADMIN",
  },
  "/app/inventory/consignment/receive": { permission: "inventory.read" },
  "/app/inventory/consignment/receiving-gaps": {
    permission: "inventory.read",
    widensFrom: "MANAGER,ADMIN",
  },
  "/app/inventory/consignment/reconciliation": { permission: "accounting.read" },
  "/app/inventory/consignment/return": { permission: "inventory.read" },
  "/app/inventory/consignment/returns-history": { permission: "inventory.read" },
  "/app/inventory/consignment/unpaid-sales": { permission: "accounting.read" },
  "/app/inventory/departments": { permission: "catalog.read" },
  "/app/inventory/freeze": { permission: "inventory.read", widensFrom: "MANAGER,ADMIN,WAREHOUSE" },
  "/app/inventory/hub": { permission: "inventory.read" },
  "/app/inventory/physical-count": { permission: "inventory.count" },
  "/app/inventory/product-variance/[externalId]": { permission: "inventory.read" },
  "/app/inventory/products": { permission: "catalog.read" },
  "/app/inventory/products/[id]": { permission: "catalog.read" },
  "/app/inventory/products/create-basic": { permission: "catalog.write" },
  "/app/inventory/products/create-variant": { permission: "catalog.write" },
  "/app/inventory/products/new": { permission: "catalog.write" },
  "/app/inventory/reconcile-photos": { permission: "inventory.count" },
  "/app/inventory/reconciled-items": { permission: "inventory.count" },
  "/app/inventory/summary-details": { permission: "inventory.read" },
  "/app/inventory/types": { permission: "catalog.read" },
  "/app/inventory/variance-apparel": { permission: "inventory.read" },
  "/app/inventory/variance-report": { permission: "inventory.read" },
  "/app/inventory/vendors": { permission: "inventory.read" },
  "/app/leads": { permission: "sales.lead" },
  "/app/payment/cancel": { permission: "payment.take" },
  "/app/payment/success": { permission: "payment.take" },
  "/app/purchasing": { permission: "purchasing.read" },
  "/app/purchasing/import-apparel": {
    permission: "purchasing.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/purchasing/import-order": {
    permission: "purchasing.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/purchasing/needs-ordering": {
    permission: "purchasing.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/purchasing/orders": {
    permission: "purchasing.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/purchasing/orders/[id]": {
    permission: "purchasing.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/purchasing/orders/[id]/receive": { permission: "purchasing.write" },
  "/app/purchasing/receiving": {
    permission: "purchasing.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/reports": { permission: "reporting.read" },
  "/app/reports/balance-aging": { permission: "reporting.read", widensFrom: "ADMIN" },
  "/app/reports/buyers": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/commission": { permission: "reporting.read" },
  "/app/reports/comparative-sales": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/consignment-report": { permission: "reporting.read", widensFrom: "ADMIN" },
  "/app/reports/cross-sell": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/customers": { permission: "reporting.read", widensFrom: "ADMIN,MARKETING" },
  "/app/reports/dashboard": { permission: "reporting.read" },
  "/app/reports/designer-dashboard": { permission: "reporting.read" },
  "/app/reports/detailed-sales": { permission: "reporting.read" },
  "/app/reports/dormant-customers": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/factsalesday": { permission: "reporting.read" },
  "/app/reports/gross-margin": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/inventory-health": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/mailchimp": { permission: "reporting.read" },
  "/app/reports/mailchimp/activity": { permission: "reporting.read" },
  "/app/reports/mailchimp/campaigns/[id]": { permission: "reporting.read" },
  "/app/reports/mailchimp/import": { permission: "reporting.read" },
  "/app/reports/monthly-performance": { permission: "reporting.read" },
  "/app/reports/open-orders": { permission: "reporting.read" },
  "/app/reports/opportunities": { permission: "reporting.read", widensFrom: "MARKETING,ADMIN" },
  "/app/reports/pay-period-sales": { permission: "reporting.read" },
  "/app/reports/pipeline-opportunity": {
    permission: "reporting.read",
    widensFrom: "MANAGER,ADMIN",
  },
  "/app/reports/po-gaps": { permission: "reporting.read", widensFrom: "ADMIN" },
  "/app/reports/po-sell-thru": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/returns": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/sales-by-salesperson": { permission: "reporting.read" },
  "/app/reports/sales-daily": { permission: "reporting.read" },
  "/app/reports/sales-explorer": { permission: "reporting.read", widensFrom: "ADMIN,MANAGER" },
  "/app/reports/sales-performance": { permission: "reporting.read" },
  "/app/reports/salesperson-detail": { permission: "reporting.read" },
  "/app/reports/service": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/stale-quotes": { permission: "reporting.read", widensFrom: "ADMIN" },
  "/app/reports/tax-summary": { permission: "reporting.read" },
  "/app/reports/till-reconciliation": { permission: "reporting.read" },
  "/app/reports/top-sellers": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/traffic": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/unclassified-returns": {
    permission: "reporting.read",
    widensFrom: "MANAGER,ADMIN",
  },
  "/app/reports/unmapped-payments": { permission: "reporting.read", widensFrom: "MANAGER,ADMIN" },
  "/app/reports/wealth-insights": { permission: "reporting.read", widensFrom: "ADMIN,MARKETING" },
  "/app/reports/weekly-summary": { permission: "reporting.read" },
  "/app/sales": { permission: "sales.read" },
  "/app/sales/customers": { permission: "sales.read" },
  "/app/sales/customers/[id]": { permission: "sales.read" },
  "/app/sales/gift-card-sale": { permission: "sales.read" },
  "/app/sales/import-hd": { permission: "sales.read" },
  "/app/sales/invoices": { permission: "sales.read", widensFrom: "MANAGER,ADMIN" },
  "/app/sales/invoices/[id]": { permission: "sales.read", widensFrom: "MANAGER,ADMIN" },
  "/app/sales/invoices/[id]/edit": { permission: "sales.write", widensFrom: "MANAGER,ADMIN" },
  "/app/sales/invoices/new": { permission: "sales.write", widensFrom: "MANAGER,ADMIN" },
  "/app/sales/orders": { permission: "sales.read" },
  "/app/sales/orders/[id]": { permission: "sales.read" },
  "/app/sales/pipeline": { permission: "sales.read" },
  "/app/sales/pos": { permission: "pos.operate" },
  "/app/sales/proposals": { permission: "sales.read", widensFrom: "MANAGER,ADMIN" },
  "/app/sales/proposals/[id]": { permission: "sales.read", widensFrom: "MANAGER,ADMIN" },
  "/app/sales/quotes/new": { permission: "sales.write" },
  "/app/sales/returns": { permission: "sales.read" },
  "/app/sales/returns/[id]": { permission: "sales.read" },
  "/app/sales/returns/new": { permission: "sales.write" },
  "/app/sales/till": { permission: "sales.read" },
  "/app/sales/till/[id]": { permission: "sales.read" },
  "/app/service": { permission: "service.read" },
  "/app/service/cases/[id]": { permission: "service.read" },
  "/app/service/cases/new": { permission: "service.write" },
  "/app/service/dispatch": {
    permission: "service.read",
    widensFrom: "MANAGER,ADMIN,DESIGNER,WAREHOUSE",
  },
  "/app/service/house-calls": { permission: "service.read", widensFrom: "MANAGER,ADMIN,DESIGNER" },
  "/app/service/house-calls/new": {
    permission: "service.write",
    widensFrom: "MANAGER,ADMIN,DESIGNER",
  },
  "/app/time": { permission: "staff.self" },
  "/app/tools": { permission: "admin.settings" },
  "/app/tools/apparel-order": { permission: "admin.settings" },
  "/app/tools/configurator": { permission: "admin.settings" },
  "/app/tools/create-project": { permission: "admin.settings" },
  "/app/tools/home-accessory-order": { permission: "admin.settings" },
  "/app/tools/legacy-archive": { permission: "admin.settings" },
  "/app/tools/query-builder": { permission: "admin.settings" },
  "/app/warehouse": { permission: "warehouse.read" },
  "/app/warehouse/awaiting-delivery": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/dashboard": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/dispatch": {
    permission: "warehouse.operate",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/inbound": { permission: "warehouse.read", widensFrom: "MANAGER,ADMIN,WAREHOUSE" },
  "/app/warehouse/locations": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/outbound": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/overview": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/pickups": {
    permission: "warehouse.operate",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/positions": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/returns": { permission: "warehouse.read", widensFrom: "MANAGER,ADMIN,WAREHOUSE" },
  "/app/warehouse/transfers": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/transfers/[id]": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
  "/app/warehouse/transfers/new": {
    permission: "warehouse.read",
    widensFrom: "MANAGER,ADMIN,WAREHOUSE",
  },
};

/** Pages whose mapped permission is applied and enforced. */
export function enforcedPages(): [string, PageAccess][] {
  return Object.entries(PAGE_ACCESS).filter(([, a]) => a.permission !== null && !a.widensFrom);
}

/** Pages awaiting a decision because the mapping would widen access. */
export function pendingWidening(): [string, PageAccess][] {
  return Object.entries(PAGE_ACCESS).filter(([, a]) => Boolean(a.widensFrom));
}
