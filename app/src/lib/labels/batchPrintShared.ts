// /app/src/lib/labels/batchPrintShared.ts
//
// The item limit of POST /api/print-label/batch (copies per tag is MAX_TAG_COPIES in
// labels/productTag.ts, the one home of that limit), shared by the route and the screens
// that print through it (rule 7): a screen with more tags than one request takes
// sends them in requests of this size. Pure.

/** The most products one batch request prints. */
export const PRINT_BATCH_MAX_ITEMS = 50;

/** `ids` in runs of at most `size`, in order. */
export function inBatches<T>(ids: readonly T[], size = PRINT_BATCH_MAX_ITEMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
