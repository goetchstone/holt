// /app/src/lib/labels/batchPrintShared.ts
//
// The limits of POST /api/print-label/batch, shared by the route and the screens
// that print through it (rule 7): a screen with more tags than one request takes
// sends them in requests of this size. Pure.

/** The most products one batch request prints. */
export const PRINT_BATCH_MAX_ITEMS = 50;
/** The most copies of one product's tag a batch request prints. */
export const PRINT_BATCH_MAX_COPIES = 10;

/** `ids` in runs of at most `size`, in order. */
export function inBatches<T>(ids: readonly T[], size = PRINT_BATCH_MAX_ITEMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
