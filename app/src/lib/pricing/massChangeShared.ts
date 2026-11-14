// /app/src/lib/pricing/massChangeShared.ts
//
// The contract of a mass price change (GAP-06), shared by the screen and the
// routes under /api/pricing/mass-change (rule 7): which products, what to do to
// their retail and was price, and how to round. Pure -- no Prisma -- so the
// screen imports it.
//
// A run is two steps. Preview works out each product's new price and says why
// any is skipped; apply sends back the previewed rows, and the server refuses
// any whose price has moved since (stale) rather than overwrite a change it
// never showed. There is no undo: a reversal is another mass change.

import { isRetailRounding, type RetailRounding } from "@/lib/pricing/rounding";

/** The most products one preview, apply or lock may touch. */
export const MASS_CHANGE_MAX_PRODUCTS = 2000;
/** The most rows one page of the list returns. */
export const MASS_CHANGE_PAGE_SIZE_MAX = 100;
/** The longest note a run's ledger rows carry. */
export const MASS_CHANGE_NOTE_MAX = 200;

/** Which products: every filter left out matches everything. */
export interface MassChangeFilter {
  vendorId?: number;
  departmentId?: number;
  categoryId?: number;
  /** Matched against product number and name, ignoring case. */
  q?: string;
  locked?: "locked" | "unlocked";
}

/** Chosen rows, or everything the filter matches (the server resolves it again). */
export type MassChangeSelection = { productIds: number[] } | { filter: MassChangeFilter };

export type RetailOperation =
  | { kind: "KEEP" }
  | { kind: "FROM_MARKUP" }
  | { kind: "PERCENT"; percent: number }
  | { kind: "AMOUNT"; amount: number };

/** KEEP leaves it; FROM_CURRENT makes today's retail the was price (a markdown); CLEAR removes it. */
export const WAS_OPERATIONS = ["KEEP", "FROM_CURRENT", "CLEAR"] as const;
export type WasOperation = (typeof WAS_OPERATIONS)[number];

export interface MassChangeOperation {
  retail: RetailOperation;
  was: WasOperation;
  /** Omitted: the store's rule (Admin > Settings). Applies to computed prices only. */
  rounding?: RetailRounding;
}

/** Why a product is left out of a run. */
export const MASS_CHANGE_SKIPS = {
  LOCKED: "Price locked",
  NO_COST: "No cost to price from",
  NO_MARKUP: "No markup set for its vendor, category or store",
  NO_RETAIL: "No retail to change",
  ROUNDS_TO_ZERO: "Would round to no price",
  WAS_NOT_ABOVE: "Was price would not be above the new retail",
  UNCHANGED: "Already at that price",
} as const;
export type MassChangeSkip = keyof typeof MASS_CHANGE_SKIPS;

export interface MassChangePreviewRow {
  productId: number;
  productNumber: string;
  name: string;
  fromRetail: number | null;
  toRetail: number | null;
  fromWas: number | null;
  toWas: number | null;
  skipped: MassChangeSkip | null;
}

/** One previewed row, sent back to apply. */
export interface MassChangeApplyRow {
  productId: number;
  fromRetail: number | null;
  toRetail: number | null;
  fromWas: number | null;
  toWas: number | null;
}

export interface MassChangeApplyResult {
  batchId: string;
  changed: number;
  unchanged: number;
  skippedLocked: number;
  /** Rows whose price moved after the preview: not changed. Preview again. */
  stale: number[];
  missing: number[];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const positiveId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const blank = (v: unknown) => v === undefined || v === null || v === "";

/** The filter's text and lock parts, or why one can't be read. */
function readTextAndLock(raw: Record<string, unknown>, filter: MassChangeFilter): string | null {
  if (!blank(raw.q)) {
    if (typeof raw.q !== "string") return "The search must be text.";
    const q = raw.q.trim().slice(0, 100);
    if (q) filter.q = q;
  }
  if (!blank(raw.locked)) {
    if (raw.locked !== "locked" && raw.locked !== "unlocked") {
      return 'locked must be "locked" or "unlocked".';
    }
    filter.locked = raw.locked;
  }
  return null;
}

/** A filter from a request body or query, every part optional. */
export function parseMassChangeFilter(raw: unknown): Parsed<MassChangeFilter> {
  if (blank(raw)) return { ok: true, value: {} };
  if (!isRecord(raw)) return { ok: false, error: "The filter must be an object." };
  const filter: MassChangeFilter = {};
  for (const key of ["vendorId", "departmentId", "categoryId"] as const) {
    if (blank(raw[key])) continue;
    const id = Number(raw[key]);
    if (!positiveId(id)) return { ok: false, error: `${key} must be an id.` };
    filter[key] = id;
  }
  const problem = readTextAndLock(raw, filter);
  return problem ? { ok: false, error: problem } : { ok: true, value: filter };
}

export function parseMassChangeSelection(raw: unknown): Parsed<MassChangeSelection> {
  if (!isRecord(raw)) return { ok: false, error: "Choose the products to change." };
  if (raw.productIds !== undefined) {
    const ids = raw.productIds;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(positiveId)) {
      return { ok: false, error: "productIds must be a list of product ids." };
    }
    if (ids.length > MASS_CHANGE_MAX_PRODUCTS) {
      return { ok: false, error: tooMany(ids.length) };
    }
    return { ok: true, value: { productIds: [...new Set(ids as number[])] } };
  }
  const filter = parseMassChangeFilter(raw.filter);
  if (!filter.ok) return filter;
  return { ok: true, value: { filter: filter.value } };
}

/** The refusal for a run over the cap. */
export function tooMany(count: number): string {
  return `That is ${count} products; a mass price change takes at most ${MASS_CHANGE_MAX_PRODUCTS} at a time. Narrow the filter or the selection.`;
}

/** The retail half of an operation. */
function parseRetailOperation(retail: unknown): Parsed<RetailOperation> {
  if (!isRecord(retail)) return { ok: false, error: "Say what to do to the retail price." };
  switch (retail.kind) {
    case "KEEP":
    case "FROM_MARKUP":
      return { ok: true, value: { kind: retail.kind } };
    case "PERCENT": {
      const percent = retail.percent;
      if (typeof percent !== "number" || !Number.isFinite(percent) || percent === 0) {
        return { ok: false, error: "The percent must be a number other than zero." };
      }
      if (percent <= -100 || percent > 1000) {
        return { ok: false, error: "The percent must be above -100 and at most 1000." };
      }
      return { ok: true, value: { kind: "PERCENT", percent } };
    }
    case "AMOUNT": {
      const amount = retail.amount;
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        return { ok: false, error: "The new price must be above zero." };
      }
      if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
        return { ok: false, error: "The new price must be to the cent." };
      }
      return { ok: true, value: { kind: "AMOUNT", amount } };
    }
    default:
      return {
        ok: false,
        error: "The retail change must be KEEP, FROM_MARKUP, PERCENT or AMOUNT.",
      };
  }
}

export function parseMassChangeOperation(raw: unknown): Parsed<MassChangeOperation> {
  if (!isRecord(raw)) return { ok: false, error: "Say what to change." };
  const retail = parseRetailOperation(raw.retail);
  if (!retail.ok) return retail;
  const was = raw.was ?? "KEEP";
  if (!(WAS_OPERATIONS as readonly unknown[]).includes(was)) {
    return {
      ok: false,
      error: `The was price change must be one of ${WAS_OPERATIONS.join(", ")}.`,
    };
  }
  if (retail.value.kind === "KEEP" && was === "KEEP") {
    return { ok: false, error: "That changes nothing: pick a retail or was price change." };
  }
  if (raw.rounding !== undefined && !isRetailRounding(raw.rounding)) {
    return { ok: false, error: "Unknown rounding rule." };
  }
  return {
    ok: true,
    value: {
      retail: retail.value,
      was: was as WasOperation,
      ...(raw.rounding !== undefined && { rounding: raw.rounding as RetailRounding }),
    },
  };
}

/**
 * No was price, or one above the retail, to the cent. A was price at or under
 * the retail is no sale, and a sale tag refuses it (lib/labels/productTag.ts).
 */
export function wasAboveRetail(toWas: number | null, toRetail: number | null): boolean {
  if (toWas === null || toRetail === null) return true;
  return Math.round(toWas * 100) > Math.round(toRetail * 100);
}

const priceOrNull = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

export function parseMassChangeApplyRows(raw: unknown): Parsed<MassChangeApplyRow[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "Send the previewed rows to apply." };
  }
  if (raw.length > MASS_CHANGE_MAX_PRODUCTS) return { ok: false, error: tooMany(raw.length) };
  const rows: MassChangeApplyRow[] = [];
  const seen = new Set<number>();
  for (const row of raw) {
    if (!isRecord(row) || !positiveId(row.productId)) {
      return { ok: false, error: "Each row needs its productId." };
    }
    if (seen.has(row.productId)) {
      return { ok: false, error: `Product ${row.productId} is listed twice.` };
    }
    seen.add(row.productId);
    const { fromRetail, toRetail, fromWas, toWas } = row;
    if (![fromRetail, toRetail, fromWas, toWas].every(priceOrNull)) {
      return {
        ok: false,
        error: `Product ${row.productId}: each price must be a number of zero or more, or null.`,
      };
    }
    if (!wasAboveRetail(toWas as number | null, toRetail as number | null)) {
      return {
        ok: false,
        error: `Product ${row.productId}: the was price must be above the retail price.`,
      };
    }
    rows.push({
      productId: row.productId,
      fromRetail: fromRetail as number | null,
      toRetail: toRetail as number | null,
      fromWas: fromWas as number | null,
      toWas: toWas as number | null,
    });
  }
  return { ok: true, value: rows };
}
