// /app/src/lib/reports/agedStockShared.ts
//
// The age buckets of the Aged Stock report (lib/reports/agedStock.ts), which its
// screen reads too. Pure, so the screen can import it without the database
// (rule 7). 90, 180 and 365 days are Inventory Health's no-sale windows, so the
// two reports split time the same way.

export const AGE_BUCKETS = [
  { label: "0-90 days", upTo: 90 },
  { label: "91-180 days", upTo: 180 },
  { label: "181-365 days", upTo: 365 },
  { label: "Over a year", upTo: null },
] as const;

/** The bucket a whole number of days belongs in. */
export function ageBucketIndex(days: number): number {
  const i = AGE_BUCKETS.findIndex((b) => b.upTo !== null && days <= b.upTo);
  return i === -1 ? AGE_BUCKETS.length - 1 : i;
}
