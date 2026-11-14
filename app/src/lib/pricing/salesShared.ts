// /app/src/lib/pricing/salesShared.ts
//
// The contract of a scheduled sale (GAP-06 part B, DECISIONS 60), shared by the
// Sales screen and the routes under /api/pricing/sales (rule 7). Pure -- no
// Prisma -- so the screen imports it.
//
// A sale is a name, a run of the store's days (startsOn to endsOn, both
// included) and a sale price for each of its products. Whether a price applies
// is decided at read time (lib/pricing/salePrice.ts). What may change follows
// from where the sale stands today:
//
//   UPCOMING  name, note, dates and products all change; it can be deleted.
//   ON        name and note change; it can be ended early, and nothing else.
//   ENDED     name and note change. Its rows stay as the record of what was charged.
//
// Products are added the mass price change's way (its filter and selection,
// lib/pricing/massChangeShared.ts) and priced by a percent off the regular price,
// rounded by the store's rule or one chosen for the run, or a typed amount.

import { formatDate } from "@/lib/formatMoney";
import { dayKeyToDbDate, isDayKey } from "@/lib/reports/businessDay";
import { isRetailRounding, roundRetail, type RetailRounding } from "@/lib/pricing/rounding";
import { MASS_CHANGE_MAX_PRODUCTS } from "@/lib/pricing/massChangeShared";

export const SALE_NAME_MAX = 100;
export const SALE_NOTE_MAX = 500;
/** The most products one sale may carry: the mass change's cap. */
export const SALE_MAX_ITEMS = MASS_CHANGE_MAX_PRODUCTS;

/**
 * Why a sale with `count` products can't be saved, or null. The save routes
 * refuse with it, and the Sales screen shows it against its draft before Save,
 * since each "Add to the sale" round adds to the draft. Pure.
 */
export function saleSizeProblem(count: number): string | null {
  if (count <= SALE_MAX_ITEMS) return null;
  return `A sale takes at most ${SALE_MAX_ITEMS} products; this one has ${count}. Remove ${count - SALE_MAX_ITEMS} before saving.`;
}

export const SALE_STATUSES = ["UPCOMING", "ON", "ENDED"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

export const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  UPCOMING: "Upcoming",
  ON: "On now",
  ENDED: "Ended",
};

/** Where a sale stands on `today` ("YYYY-MM-DD", the store's day). Pure. */
export function saleStatus(
  sale: { startsOn: string; endsOn: string; endedEarlyAt: Date | string | null },
  today: string,
): SaleStatus {
  if (sale.endedEarlyAt !== null) return "ENDED";
  if (today < sale.startsOn) return "UPCOMING";
  if (today > sale.endsOn) return "ENDED";
  return "ON";
}

/**
 * A store's day ("YYYY-MM-DD") as people read it, in the store's locale: "Nov 30,
 * 2026". A day key is midnight UTC (dayKeyToDbDate), so it is read in UTC and
 * can't shift a day in any browser or store time zone. Pure; the screens and the
 * sale tag's saleEnds both use it.
 */
export function saleDayText(day: string | null, locale: string): string {
  if (!day || !isDayKey(day)) return "";
  return formatDate(dayKeyToDbDate(day), { locale, timezone: "UTC" });
}

/** How a selection of products is priced for a sale. */
export type SalePricing =
  | { kind: "PERCENT_OFF"; percent: number; rounding?: RetailRounding }
  | { kind: "AMOUNT"; amount: number };

/** Why a product is left out of a sale's preview. */
export const SALE_SKIPS = {
  NO_RETAIL: "No regular price to take a sale price from",
  OVERLAPS: "Already in another sale on some of these days",
  NOT_BELOW_REGULAR: "Sale price would not be below the regular price",
  ROUNDS_TO_ZERO: "Would round to no price",
} as const;
export type SaleSkip = keyof typeof SALE_SKIPS;

export interface SalePreviewRow {
  productId: number;
  productNumber: string;
  name: string;
  regularPrice: number | null;
  salePrice: number | null;
  skipped: SaleSkip | null;
  /** The sale it overlaps, when skipped OVERLAPS. */
  overlaps: { id: number; name: string } | null;
}

/** One product's sale price, as saved. */
export interface SaleItemInput {
  productId: number;
  salePrice: number;
}

export interface SaleFields {
  name: string;
  startsOn: string;
  endsOn: string;
  note: string | null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const positiveId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const toTheCent = (n: number) => Math.abs(n * 100 - Math.round(n * 100)) <= 1e-6;

function parseName(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "Give the sale a name." };
  const name = raw.trim();
  if (name.length > SALE_NAME_MAX) {
    return { ok: false, error: `Keep the name to ${SALE_NAME_MAX} characters.` };
  }
  return { ok: true, value: name };
}

function parseNote(raw: unknown): Parsed<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "The note must be text." };
  const note = raw.trim();
  if (note.length > SALE_NOTE_MAX) {
    return { ok: false, error: `Keep the note to ${SALE_NOTE_MAX} characters.` };
  }
  return { ok: true, value: note || null };
}

/** Why a sale can't run from startsOn to endsOn, written on `today`, or null. */
export function saleDatesProblem(startsOn: unknown, endsOn: unknown, today: string): string | null {
  if (!isDayKey(startsOn)) return "startsOn must be a date (YYYY-MM-DD).";
  if (!isDayKey(endsOn)) return "endsOn must be a date (YYYY-MM-DD).";
  if (startsOn < today) return "A sale can't start before today.";
  if (endsOn < startsOn) return "A sale's last day can't be before its first.";
  return null;
}

/** A new sale's fields. Dates are checked against today by saleDatesProblem. */
export function parseSaleFields(raw: unknown, today: string): Parsed<SaleFields> {
  if (!isRecord(raw)) return { ok: false, error: "Send the sale's name and dates." };
  const name = parseName(raw.name);
  if (!name.ok) return name;
  const note = parseNote(raw.note);
  if (!note.ok) return note;
  const dates = saleDatesProblem(raw.startsOn, raw.endsOn, today);
  if (dates) return { ok: false, error: dates };
  return {
    ok: true,
    value: {
      name: name.value,
      startsOn: raw.startsOn as string,
      endsOn: raw.endsOn as string,
      note: note.value,
    },
  };
}

/** A change to a sale: only what is sent. Dates come as a pair. */
export interface SalePatch {
  name?: string;
  note?: string | null;
  startsOn?: string;
  endsOn?: string;
  items?: SaleItemInput[];
}

export function parseSalePatch(raw: unknown): Parsed<SalePatch> {
  if (!isRecord(raw)) return { ok: false, error: "Send what to change." };
  const patch: SalePatch = {};
  if (raw.name !== undefined) {
    const name = parseName(raw.name);
    if (!name.ok) return name;
    patch.name = name.value;
  }
  if (raw.note !== undefined) {
    const note = parseNote(raw.note);
    if (!note.ok) return note;
    patch.note = note.value;
  }
  if (raw.startsOn !== undefined || raw.endsOn !== undefined) {
    if (!isDayKey(raw.startsOn) || !isDayKey(raw.endsOn)) {
      return { ok: false, error: "Send both dates (YYYY-MM-DD) to change them." };
    }
    patch.startsOn = raw.startsOn;
    patch.endsOn = raw.endsOn;
  }
  if (raw.items !== undefined) {
    const items = parseSaleItems(raw.items);
    if (!items.ok) return items;
    patch.items = items.value;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "That changes nothing." };
  return { ok: true, value: patch };
}

/** A sale's products and their prices. Each above zero, to the cent, once. */
export function parseSaleItems(raw: unknown): Parsed<SaleItemInput[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "items must be a list." };
  const tooBig = saleSizeProblem(raw.length);
  if (tooBig) return { ok: false, error: tooBig };
  const items: SaleItemInput[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!isRecord(item) || !positiveId(item.productId)) {
      return { ok: false, error: "Each item needs its productId." };
    }
    if (seen.has(item.productId)) {
      return { ok: false, error: `Product ${item.productId} is listed twice.` };
    }
    seen.add(item.productId);
    const price = item.salePrice;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      return { ok: false, error: `Product ${item.productId}: the sale price must be above zero.` };
    }
    if (!toTheCent(price)) {
      return { ok: false, error: `Product ${item.productId}: the sale price must be to the cent.` };
    }
    if (price >= 1e8) {
      return { ok: false, error: `Product ${item.productId}: the sale price is too large.` };
    }
    items.push({ productId: item.productId, salePrice: price });
  }
  return { ok: true, value: items };
}

export function parseSalePricing(raw: unknown): Parsed<SalePricing> {
  if (!isRecord(raw)) return { ok: false, error: "Say how to price the sale." };
  if (raw.kind === "PERCENT_OFF") {
    const percent = raw.percent;
    if (
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent <= 0 ||
      percent >= 100
    ) {
      return { ok: false, error: "The percent off must be above 0 and below 100." };
    }
    if (raw.rounding !== undefined && !isRetailRounding(raw.rounding)) {
      return { ok: false, error: "Unknown rounding rule." };
    }
    return {
      ok: true,
      value: {
        kind: "PERCENT_OFF",
        percent,
        ...(raw.rounding !== undefined && { rounding: raw.rounding as RetailRounding }),
      },
    };
  }
  if (raw.kind === "AMOUNT") {
    const amount = raw.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: "The sale price must be above zero." };
    }
    if (!toTheCent(amount)) return { ok: false, error: "The sale price must be to the cent." };
    return { ok: true, value: { kind: "AMOUNT", amount } };
  }
  return { ok: false, error: "The pricing must be PERCENT_OFF or AMOUNT." };
}

/**
 * One product's sale price from its regular price, or why it has none. Pure.
 * A percent off is rounded (the run's rule, else the store's); a typed amount
 * is the person's and is not.
 */
export function planSalePrice(
  regularPrice: number | null,
  pricing: SalePricing,
  storeRounding: RetailRounding,
): { salePrice: number | null; skipped: SaleSkip | null } {
  if (regularPrice === null || !(regularPrice > 0))
    return { salePrice: null, skipped: "NO_RETAIL" };
  const salePrice =
    pricing.kind === "AMOUNT"
      ? pricing.amount
      : roundRetail(regularPrice * (1 - pricing.percent / 100), pricing.rounding ?? storeRounding);
  if (!(salePrice > 0)) return { salePrice: null, skipped: "ROUNDS_TO_ZERO" };
  if (!isBelow(salePrice, regularPrice)) return { salePrice, skipped: "NOT_BELOW_REGULAR" };
  return { salePrice, skipped: null };
}

/** a below b, to the cent. */
export function isBelow(a: number, b: number): boolean {
  return Math.round(a * 100) < Math.round(b * 100);
}

/**
 * Why this change can't be made to a sale standing at `status`, or null.
 * Dates and products change only before it starts.
 */
export function saleChangeProblem(status: SaleStatus, patch: SalePatch): string | null {
  const touchesRun = patch.startsOn !== undefined || patch.items !== undefined;
  if (touchesRun && status !== "UPCOMING") {
    return status === "ON"
      ? "This sale has started: its dates and products can't change. End it early instead."
      : "This sale has ended: its dates and products can't change.";
  }
  return null;
}

/** Why a sale standing at `status` can't be ended early, or null. */
export function endEarlyProblem(status: SaleStatus): string | null {
  if (status === "UPCOMING") return "This sale hasn't started: change or delete it instead.";
  if (status === "ENDED") return "This sale has already ended.";
  return null;
}

/** Why a sale standing at `status` can't be deleted, or null. */
export function deleteProblem(status: SaleStatus): string | null {
  return status === "UPCOMING"
    ? null
    : "Only a sale that hasn't started can be deleted; it stays as the record of what was charged.";
}

/** A product whose tag must change today, and to which tag. */
export interface TagToChange {
  productId: number;
  productNumber: string;
  name: string;
  /** What the register charges today. */
  price: number | null;
  regularPrice: number | null;
  /** The sale whose tag it now needs (SALE) or whose sale ended (PRODUCT). */
  saleName: string;
  saleEndsOn: string | null;
}

export interface TagsToChange {
  today: string;
  /** Sales starting today: print a SALE tag. */
  saleTags: TagToChange[];
  /** Sales that ended yesterday or were ended early since: print a PRODUCT tag. */
  productTags: TagToChange[];
}

/** A sale as GET /api/pricing/sales lists it, with where it stands today. */
export interface SaleSummary {
  id: number;
  name: string;
  startsOn: string;
  endsOn: string;
  note: string | null;
  status: SaleStatus;
  itemCount: number;
  createdBy: string;
  endedEarlyAt: string | null;
  endedEarlyBy: string | null;
}

/** One sale with its products: GET /api/pricing/sales/[id]. */
export interface SaleDetail extends SaleSummary {
  items: SaleItemRow[];
}

/** One product in a sale, as GET /api/pricing/sales/[id] answers and the screen drafts. */
export interface SaleItemRow {
  productId: number;
  productNumber: string;
  name: string;
  regularPrice: number | null;
  salePrice: number;
}

/**
 * A draft sale's products after adding a preview's priced rows. A product
 * already in the draft takes the new price; skipped rows are left out. The
 * server checks every price again when the sale is saved. Pure.
 */
export function addPreviewToItems(
  items: readonly SaleItemRow[],
  rows: readonly SalePreviewRow[],
): SaleItemRow[] {
  const byId = new Map(items.map((i) => [i.productId, i]));
  for (const row of rows) {
    if (row.skipped || row.salePrice === null) continue;
    byId.set(row.productId, {
      productId: row.productId,
      productNumber: row.productNumber,
      name: row.name,
      regularPrice: row.regularPrice,
      salePrice: row.salePrice,
    });
  }
  return [...byId.values()];
}

/** The sale prices to save for a draft's products. */
export function itemsToSave(items: readonly SaleItemRow[]): SaleItemInput[] {
  return items.map((i) => ({ productId: i.productId, salePrice: i.salePrice }));
}

/** Sales in the order the screen lists them: on now, upcoming, then ended. Stable within each. */
export function salesInListOrder<T extends { status: SaleStatus }>(sales: readonly T[]): T[] {
  const rank: Record<SaleStatus, number> = { ON: 0, UPCOMING: 1, ENDED: 2 };
  return sales
    .map((sale, i) => ({ sale, i }))
    .sort((a, b) => rank[a.sale.status] - rank[b.sale.status] || a.i - b.i)
    .map((x) => x.sale);
}
