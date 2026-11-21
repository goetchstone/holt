// /app/src/lib/labels/batchPrintRequest.ts
//
// What POST /api/print-label/batch was asked to print, read from its body
// without a printer or the database, so every rule is tested on its own
// (rule 14): the route's rules and messages, in the route's order. The route
// looks up the store and prints.
//
// Server only: validateTagCopies, the one guard on copies (rule 42), lives in
// lib/labelPrinter.ts, which builds the Prisma client when imported. Never
// import this from a client component; lib/labels/batchPrintShared.ts, which
// the screens import, stays free of it.

import { validateTagCopies } from "@/lib/labelPrinter";
import { PRINT_BATCH_MAX_ITEMS } from "@/lib/labels/batchPrintShared";
import { isProductTagKind, type ProductTagKind } from "@/lib/labels/productTag";

/** One item to print. Ids are passed on as the caller sent them, as the route always has. */
export interface BatchPrintJob {
  productId: number;
  templateId?: number;
  printerId?: number;
  copies: number;
}

/** What became of one item: the route's answer for it. */
export interface BatchPrintResult {
  productId: number;
  success: boolean;
  printer?: string;
  template?: string;
  error?: string;
}

/** Each item in order: a job to print, or its failure already. */
export type BatchPrintEntry = { job: BatchPrintJob } | { result: BatchPrintResult };

export type BatchPrintRequest =
  | { error: string }
  | { kind: ProductTagKind | null; storeLocationId: number | null; entries: BatchPrintEntry[] };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Number(value), as the route always read a store id, or NaN where Number
 * throws: JSON can send an object whose toString is null, which has no
 * primitive value (found by the property in batchPrintRequest.test.ts).
 */
function toNumber(value: unknown): number {
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

/** One item. No productId, or copies the bound refuses, fails that item alone. */
function readItem(value: unknown): BatchPrintEntry {
  const item = asRecord(value);
  const productId = item.productId as number;
  if (!productId) {
    return { result: { productId, success: false, error: "productId is required" } };
  }
  try {
    const copies = validateTagCopies(item.copies === undefined ? 1 : item.copies);
    const templateId = item.templateId as number | undefined;
    const printerId = item.printerId as number | undefined;
    return { job: { productId, templateId, printerId, copies } };
  } catch (err: unknown) {
    return { result: { productId, success: false, error: (err as Error).message } };
  }
}

/**
 * The batch request, or the 400 the route answers with. Never throws: a body
 * that isn't an object reads as {} (Next gives null when none was sent), and so
 * does an item that isn't one.
 */
export function readBatchPrintRequest(body: unknown): BatchPrintRequest {
  const request = asRecord(body);
  const { items, kind } = request;
  if (!Array.isArray(items) || items.length === 0) return { error: "items array is required" };
  if (items.length > PRINT_BATCH_MAX_ITEMS) {
    return { error: `Batch size exceeds maximum of ${PRINT_BATCH_MAX_ITEMS} items` };
  }
  if (kind !== undefined && kind !== null && !isProductTagKind(kind)) {
    return { error: "kind must be PRODUCT, SALE or LAW." };
  }
  return {
    kind: isProductTagKind(kind) ? kind : null,
    storeLocationId: request.storeLocationId ? toNumber(request.storeLocationId) : null,
    entries: items.map(readItem),
  };
}
