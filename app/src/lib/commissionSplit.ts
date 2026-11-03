// /app/src/lib/commissionSplit.ts
//
// GAP-07: how a split sale is credited. A sale written by two people credits
// its salesperson SalesOrder.splitPercent of it and the split partner the
// rest. The share is chosen when the split is made, from the store's
// AppSettings.defaultSplitPercent (50, an even split, to start), and recorded
// on the order, so changing the default moves no sale already split.
//
// Every report and commission sum that credits a person for a sale takes that
// person's share from creditShare(), the one place the rule lives. Before it,
// the same `splitWithId ? 0.5 : 1` was written into eight places, so a store
// that split 60/40 could not be represented at all, and all eight agreed with
// each other while all being wrong (docs/tenant-literal-sweep.md).
//
// Imported by screens as well as servers: no Prisma, no I/O.

export const SPLIT_PERCENT_MIN = 1;
export const SPLIT_PERCENT_MAX = 99;
/** An even split: where AppSettings.defaultSplitPercent starts. */
export const EVEN_SPLIT_PERCENT = 50;

/** A sale as the split rule reads it. */
export interface SplitOrder {
  salesPersonId?: number | null;
  splitWithId: number | null;
  /** The salesperson's share in whole percent; read only while split. */
  splitPercent: number;
}

/** Why `raw` can't be a split share, or null when it can. */
export function splitPercentProblem(raw: unknown): string | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return "A split share is a whole percent.";
  }
  if (raw < SPLIT_PERCENT_MIN || raw > SPLIT_PERCENT_MAX) {
    return `A split share is ${SPLIT_PERCENT_MIN} to ${SPLIT_PERCENT_MAX} percent: each person gets some of it.`;
  }
  return null;
}

export function isSplitPercent(raw: unknown): raw is number {
  return splitPercentProblem(raw) === null;
}

/**
 * The share a sale's split records after a change: the one staff chose; else
 * the one it already has, when it was already split (a new partner takes the
 * old one's share); else the store's default. Unsplit, it keeps what it has,
 * which nothing reads.
 */
export function nextSplitPercent(input: {
  current: { splitWithId: number | null; splitPercent: number };
  splitWithId: number | null;
  chosen?: number;
  storeDefault: number;
}): number {
  if (input.splitWithId == null) return input.current.splitPercent;
  if (input.chosen !== undefined) return input.chosen;
  if (input.current.splitWithId != null) return input.current.splitPercent;
  return input.storeDefault;
}

/** The salesperson's share of the sale: all of it unless it is split. */
export function primaryShare(order: SplitOrder): number {
  return order.splitWithId == null ? 1 : order.splitPercent / 100;
}

/** The split partner's share of the sale: none unless it is split. */
export function partnerShare(order: SplitOrder): number {
  return order.splitWithId == null ? 0 : (100 - order.splitPercent) / 100;
}

/**
 * The share of the sale credited to `staffId`, who matched the order as its
 * salesperson (by id or by the name on it) or as its split partner. The
 * partner when they are the order's splitWithId; otherwise the salesperson --
 * which is also who a name-only match (staffId null) is. Someone who is both
 * gets all of it.
 */
export function creditShare(order: SplitOrder, staffId: number | null): number {
  if (order.splitWithId == null) return 1;
  if (staffId != null && staffId === order.splitWithId) {
    return order.salesPersonId === staffId ? 1 : partnerShare(order);
  }
  return primaryShare(order);
}

/**
 * What the register and the quote builder need to offer a split: who it can
 * be split with, and where the share starts. Built on the server for someone
 * allowed to split a sale (lib/sales/splitSaleSetup.ts); null for anyone else.
 */
export interface SplitSaleSetup {
  partners: { id: number; name: string }[];
  defaultPercent: number;
}

/** "60/40": the salesperson's share, then the partner's. */
export function splitLabel(splitPercent: number): string {
  return `${splitPercent}/${100 - splitPercent}`;
}
