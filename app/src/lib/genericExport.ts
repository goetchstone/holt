// /app/src/lib/genericExport.ts
//
// Client/server contract (CLAUDE.md rule 7) for the data-export feature: the
// catalog of business entities a deployment can export to CSV. The Settings/
// Export UI renders one download per entry; the export API validates the
// requested entity against this same list. No Prisma or server-only imports
// here so the admin page and the API can both read this single source of truth.
//
// Deliberately scoped to BUSINESS DATA. Auth/credential tables (User, Account,
// Session, IntegrationCredential, StaffMember.passwordHash) are never exported
// here — a customer porting their data wants records, not secrets.

export const EXPORT_ENTITY_KEYS = [
  "customers",
  "customerAddresses",
  "products",
  "productVariants",
  "vendors",
  "departments",
  "categories",
  "salesOrders",
  "orderLineItems",
  "invoices",
  "payments",
  "purchaseOrders",
  "purchaseOrderItems",
  "inventoryPositions",
  "staff",
] as const;

export type ExportEntityKey = (typeof EXPORT_ENTITY_KEYS)[number];

export interface ExportEntityDef {
  key: ExportEntityKey;
  label: string;
  description: string;
}

export const EXPORT_ENTITIES: readonly ExportEntityDef[] = [
  { key: "customers", label: "Customers", description: "Customer records and contact details." },
  {
    key: "customerAddresses",
    label: "Customer Addresses",
    description: "Billing and delivery addresses linked to customers.",
  },
  { key: "products", label: "Products", description: "Product catalog items." },
  {
    key: "productVariants",
    label: "Product Variants",
    description: "Size / color / finish variants of catalog products.",
  },
  { key: "vendors", label: "Vendors", description: "Suppliers and their details." },
  { key: "departments", label: "Departments", description: "Top-level product classification." },
  { key: "categories", label: "Categories", description: "Product categories within departments." },
  {
    key: "salesOrders",
    label: "Sales Orders",
    description: "Order headers: customer, store, status, totals.",
  },
  {
    key: "orderLineItems",
    label: "Order Line Items",
    description: "Individual lines on every sales order.",
  },
  { key: "invoices", label: "Invoices", description: "Invoice headers and totals." },
  {
    key: "payments",
    label: "Payments",
    description: "Payments and refunds recorded against orders.",
  },
  {
    key: "purchaseOrders",
    label: "Purchase Orders",
    description: "PO headers: vendor, status, dates.",
  },
  {
    key: "purchaseOrderItems",
    label: "Purchase Order Items",
    description: "Individual lines on every purchase order.",
  },
  {
    key: "inventoryPositions",
    label: "Inventory Positions",
    description: "On-hand quantities by product and location.",
  },
  {
    key: "staff",
    label: "Staff",
    description: "Staff member records (passwords are never included).",
  },
];

export function getExportEntity(key: string): ExportEntityDef | undefined {
  return EXPORT_ENTITIES.find((e) => e.key === key);
}
