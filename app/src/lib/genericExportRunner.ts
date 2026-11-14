// /app/src/lib/genericExportRunner.ts
//
// Server-side execution of the generic data export. Each entity selects exactly
// the columns its catalog entry allows (lib/genericExport.ts), so a credential
// column (StaffMember.pinHash, passwordHash) or one a later migration adds
// never leaves the system unless someone lists it there. Fail closed, CLAUDE.md
// principle 8: this used to read every column and strip a short list of known
// secret names, and pinHash went out because nobody had listed it.
//
// Returns plain row objects; the API layer turns them into CSV via lib/csv.ts.

import { prisma } from "@/lib/prisma";
import { getExportEntity, type ExportEntityKey } from "@/lib/genericExport";

type Row = Record<string, unknown>;
type Query = { select: Record<string, true>; orderBy: { id: "asc" } };

// Each entity is a thunk so only the requested query runs. The select is built
// from the catalog's string list, so the args are cast to each model's own type;
// the catalog's `satisfies` checks the names at compile time, and the
// integration test runs every entity against Postgres. `as unknown as
// Promise<Row[]>` bridges Prisma's per-model row type to the generic Row shape;
// every selected field is a scalar.
const QUERIES: Record<ExportEntityKey, (q: Query) => Promise<Row[]>> = {
  customers: (q) => prisma.customer.findMany(q as never) as unknown as Promise<Row[]>,
  customerAddresses: (q) =>
    prisma.customerAddress.findMany(q as never) as unknown as Promise<Row[]>,
  products: (q) => prisma.product.findMany(q as never) as unknown as Promise<Row[]>,
  productVariants: (q) => prisma.productVariant.findMany(q as never) as unknown as Promise<Row[]>,
  vendors: (q) => prisma.vendor.findMany(q as never) as unknown as Promise<Row[]>,
  departments: (q) => prisma.department.findMany(q as never) as unknown as Promise<Row[]>,
  categories: (q) => prisma.category.findMany(q as never) as unknown as Promise<Row[]>,
  salesOrders: (q) => prisma.salesOrder.findMany(q as never) as unknown as Promise<Row[]>,
  orderLineItems: (q) => prisma.orderLineItem.findMany(q as never) as unknown as Promise<Row[]>,
  invoices: (q) => prisma.invoice.findMany(q as never) as unknown as Promise<Row[]>,
  payments: (q) => prisma.payment.findMany(q as never) as unknown as Promise<Row[]>,
  purchaseOrders: (q) => prisma.purchaseOrder.findMany(q as never) as unknown as Promise<Row[]>,
  purchaseOrderItems: (q) =>
    prisma.purchaseOrderItem.findMany(q as never) as unknown as Promise<Row[]>,
  inventoryPositions: (q) =>
    prisma.inventoryPosition.findMany(q as never) as unknown as Promise<Row[]>,
  staff: (q) => prisma.staffMember.findMany(q as never) as unknown as Promise<Row[]>,
};

/**
 * Fetch all rows for an export entity: its allowed columns, nothing more.
 * Throws if the key is not a known export entity (the API validates first, so
 * this is a guard against programmer error).
 */
export async function runGenericExport(entityKey: string): Promise<Row[]> {
  const entity = getExportEntity(entityKey);
  if (!entity) {
    throw new Error(`Unknown export entity: ${entityKey}`);
  }
  const select = Object.fromEntries(entity.columns.map((c) => [c, true] as const));
  return QUERIES[entity.key]({ select, orderBy: { id: "asc" } });
}
