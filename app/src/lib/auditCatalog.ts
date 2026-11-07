// /app/src/lib/auditCatalog.ts
//
// What the audit trail can record (GAP-29, DECISIONS 50): each event's name on the
// screen and the group it files under. Pure, so the screen and the server share it
// (rules 7, 37). __tests__/auditCoverage.test.ts fails on an event nothing records.
//
// An action with a history of its own stays there and isn't listed here (rule 6):
// order changes in OrderChangeLog, gift cards in GiftCardTransaction, store credit in
// CustomerCreditTransaction, payout edits in CommissionPayoutEdit, stock in
// StockMovement, presets in ConfigChangeLog. lib/auditFeed.ts reads those too.

export const AUDIT_GROUPS = {
  sales: "Orders and payments",
  prices: "Prices",
  access: "People and access",
  settings: "Settings",
  stock: "Stock",
  customers: "Customers",
  books: "Books and commission",
  data: "Data",
} as const;

export type AuditGroup = keyof typeof AUDIT_GROUPS;

export function isAuditGroup(value: unknown): value is AuditGroup {
  return typeof value === "string" && Object.hasOwn(AUDIT_GROUPS, value);
}

interface AuditEventInfo {
  label: string;
  group: AuditGroup;
}

export const AUDIT_EVENTS = {
  QUOTE_DELETED: { label: "Quote deleted", group: "sales" },

  PRODUCT_PRICE_CHANGED: { label: "Product price changed", group: "prices" },
  PRODUCT_COST_CHANGED: { label: "Vendor cost changed", group: "prices" },
  STYLE_PRICE_CHANGED: { label: "Vendor style price changed", group: "prices" },
  PRICES_IMPORTED: { label: "Prices imported", group: "prices" },

  ROLE_CHANGED: { label: "Role changed", group: "access" },
  STAFF_CHANGED: { label: "Staff member changed", group: "access" },
  PASSWORD_SET: { label: "Password set by an admin", group: "access" },
  PIN_CHANGED: { label: "Manager PIN changed", group: "access" },
  IMPERSONATION: { label: "Viewed the app as another role", group: "access" },

  SETTINGS_SAVED: { label: "Store settings saved", group: "settings" },
  CREDENTIAL_CHANGED: { label: "Integration key changed", group: "settings" },
  AUTOMATION_CHANGED: { label: "Automation changed", group: "settings" },
  TENDER_CHANGED: { label: "Payment type changed", group: "settings" },
  TAX_CHANGED: { label: "Tax setup changed", group: "settings" },
  EMAIL_WORDING_CHANGED: { label: "An email's wording changed", group: "settings" },

  STOCK_CLEARED: { label: "Stock cleared", group: "stock" },
  STOCK_RECONCILED: { label: "Stock reconciled", group: "stock" },
  RECONCILIATION_UNDONE: { label: "Reconciliation undone", group: "stock" },
  PHYSICAL_COUNT_DELETED: { label: "Physical count deleted", group: "stock" },
  SNAPSHOT_GENERATED: { label: "Stock snapshot generated", group: "stock" },
  SNAPSHOT_CLEARED: { label: "Stock snapshot cleared", group: "stock" },
  CONSIGNMENT_RESET: { label: "Missing consignment reset", group: "stock" },

  CUSTOMERS_MERGED: { label: "Customers merged", group: "customers" },
  VENDORS_MERGED: { label: "Vendors merged", group: "customers" },

  COMMISSION_PLAN_CHANGED: { label: "Commission plan changed", group: "books" },
  COMMISSION_PAYOUT_RUN: { label: "Commission payouts committed", group: "books" },
  JOURNAL_POSTED: { label: "Journal entry posted", group: "books" },

  BULK_DELETED: { label: "Everything deleted from a list", group: "data" },
  DATA_EXPORTED: { label: "Data exported", group: "data" },
  DATABASE_BACKUP_DOWNLOADED: { label: "Database backup downloaded", group: "data" },
  DATABASE_RESTORED: { label: "Database restored", group: "data" },
  PRACTICE_STARTING_POINT_SAVED: { label: "Practice starting point saved", group: "data" },
  PRACTICE_STARTED_OVER: { label: "Practice copy started over", group: "data" },
} as const satisfies Record<string, AuditEventInfo>;

export type AuditEvent = keyof typeof AUDIT_EVENTS;

export function isAuditEvent(value: string): value is AuditEvent {
  return Object.hasOwn(AUDIT_EVENTS, value);
}

/** Every event filed under a group. */
export function auditEventsIn(group: AuditGroup): AuditEvent[] {
  return (Object.keys(AUDIT_EVENTS) as AuditEvent[]).filter(
    (event) => AUDIT_EVENTS[event].group === group,
  );
}
