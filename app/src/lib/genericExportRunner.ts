// /app/src/lib/genericExportRunner.ts
//
// Server-side execution of the generic data export. Each entity maps to a
// Prisma findMany with NO select/include, so Prisma returns exactly the
// model's scalar columns (no relations) — drift-proof as the schema evolves.
// Sensitive columns are stripped by name before serialization so secrets
// (password hashes, encrypted credentials) never leave the system, even if a
// future migration adds one to an exported table.
//
// Returns plain row objects; the API layer turns them into CSV via lib/csv.ts.

import { prisma } from "@/lib/prisma";
import { getExportEntity, type ExportEntityKey } from "@/lib/genericExport";

type Row = Record<string, unknown>;

// Column names that must never appear in an export, matched case-insensitively
// against every row's keys. Defense in depth: the exported entities don't
// include auth tables today, but this guarantees nothing sensitive leaks if
// the catalog or schema changes later.
const SENSITIVE_KEYS = new Set([
  "password",
  "passwordhash",
  "ciphertext",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
]);

function stripSensitive(rows: Row[]): Row[] {
  return rows.map((row) => {
    const clean: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (!SENSITIVE_KEYS.has(key.toLowerCase())) clean[key] = value;
    }
    return clean;
  });
}

// Each entity is a thunk so only the requested query runs. `as unknown as
// Promise<Row[]>` bridges Prisma's per-model row type to the generic Row shape;
// safe because no select/include means every field is a scalar.
const QUERIES: Record<ExportEntityKey, () => Promise<Row[]>> = {
  customers: () =>
    prisma.customer.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  customerAddresses: () =>
    prisma.customerAddress.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  products: () => prisma.product.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  productVariants: () =>
    prisma.productVariant.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  vendors: () => prisma.vendor.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  departments: () =>
    prisma.department.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  categories: () =>
    prisma.category.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  salesOrders: () =>
    prisma.salesOrder.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  orderLineItems: () =>
    prisma.orderLineItem.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  invoices: () => prisma.invoice.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  payments: () => prisma.payment.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  purchaseOrders: () =>
    prisma.purchaseOrder.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  purchaseOrderItems: () =>
    prisma.purchaseOrderItem.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  inventoryPositions: () =>
    prisma.inventoryPosition.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
  staff: () => prisma.staffMember.findMany({ orderBy: { id: "asc" } }) as unknown as Promise<Row[]>,
};

/**
 * Fetch all rows for an export entity, with sensitive columns stripped.
 * Throws if the key is not a known export entity (the API validates first, so
 * this is a guard against programmer error).
 */
export async function runGenericExport(entityKey: string): Promise<Row[]> {
  if (!getExportEntity(entityKey)) {
    throw new Error(`Unknown export entity: ${entityKey}`);
  }
  const query = QUERIES[entityKey as ExportEntityKey];
  const rows = await query();
  return stripSensitive(rows);
}
