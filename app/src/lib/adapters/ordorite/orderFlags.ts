// /app/src/lib/adapters/ordorite/orderFlags.ts
//
// The Ordorite adapter's own per-order memory.
//
// This used to be SalesOrder.skipSameDayRewriteCleanup -- a boolean on the
// highest-traffic table in the product that only this importer ever read, set on
// exactly 1 order in 49,769. It is a fact about one source system's rewrite
// quirks, not about the sale, so it lives with the adapter that cares.
//
// AdapterOrderFlag is generic on purpose: a second adapter records its own
// per-order state by writing a different `adapter` key, with no schema change.

import type { PrismaClient, Prisma } from "@prisma/client";

/** This adapter's key in lib/adapters/index.ts. */
export const ORDORITE_ADAPTER = "ordorite";

/**
 * Operator override for the same-day rewrite cleanup heuristic.
 *
 * The cleanup cancels base lines that a same-day rewrite superseded. It cannot
 * tell that shape apart from a genuine drop, so an operator who has checked the
 * order and found it correct as-is sets this and the heuristic stands down.
 */
export const SKIP_SAME_DAY_REWRITE_CLEANUP = "skipSameDayRewriteCleanup";

type Client = PrismaClient | Prisma.TransactionClient;

/** True when the operator has told this adapter to leave the order alone. */
export async function hasOrderFlag(
  prisma: Client,
  salesOrderId: number,
  flag: string,
): Promise<boolean> {
  const row = await prisma.adapterOrderFlag.findUnique({
    where: {
      salesOrderId_adapter_flag: { salesOrderId, adapter: ORDORITE_ADAPTER, flag },
    },
    select: { value: true },
  });
  return row?.value === true;
}

/**
 * Set or clear a flag. Idempotent, so re-running an import cannot pile up rows.
 * `note` is worth filling in -- a manual override with no reason ages badly.
 */
export async function setOrderFlag(
  prisma: Client,
  salesOrderId: number,
  flag: string,
  value: boolean,
  opts?: { note?: string; actor?: string },
): Promise<void> {
  await prisma.adapterOrderFlag.upsert({
    where: {
      salesOrderId_adapter_flag: { salesOrderId, adapter: ORDORITE_ADAPTER, flag },
    },
    update: { value, note: opts?.note, updatedBy: opts?.actor },
    create: {
      salesOrderId,
      adapter: ORDORITE_ADAPTER,
      flag,
      value,
      note: opts?.note,
      createdBy: opts?.actor,
    },
  });
}
