// /app/src/lib/homeAccessoryBuyerDraftMapping.ts
//
// THE key adaptation for the Home Accessory Order Import tool: FC's version
// of this tool built Ordorite import CSVs (files-only — Ordorite is FC's
// system of record). Holt IS its own system of record, so this file maps
// the composed `EffectiveRow[]` (from homeAccessoryRows.ts) into holt's
// native Buyer Drafts create payloads instead:
//
//   - one `BuyerDraftPurchaseOrder` per distinct order reference (a
//     multi-order vendor bundle, e.g. a K&K PDF carrying two orders,
//     creates two draft POs — "multi-PO bundles")
//   - one `BuyerDraftItem` per composed row, whether or not it landed on a
//     draft PO (a buyer-excluded row still becomes an item, just
//     unassigned)
//
// Pure — no I/O, no Prisma. The commit API route (pages/api/tools/
// home-accessory-order/commit.ts) hydrates vendor/context data, calls the
// functions here, then feeds the results through `buildPoCreateData` /
// `buildItemCreateData` (lib/buyerDraftRequestBody.ts, the existing
// buyer-drafts field-coercion contract — CLAUDE.md rule 14) and writes via
// Prisma inside a transaction.

import type { EffectiveRow } from "./homeAccessoryRows";
import type { BuyerDraftItemCreateBody, BuyerDraftPoCreateBody } from "./buyerDraftRequestBody";

export interface HomeAccessoryCommitContext {
  /** Resolved once against the Vendor table (by name, tolerant of "&" vs
   *  "and" via `sameSupplier`) — not re-resolved per row. Null when the
   *  typed supplier doesn't match any catalog Vendor; the created rows
   *  still carry `vendorName` as free text (mirrors how
   *  `BuyerDraftItem.vendorId` / `vendorName` already work for a
   *  not-yet-catalogued vendor mid-negotiation). */
  vendorId: number | null;
  vendorName: string;
  stockLocationId: number | null;
  buyId: number | null;
  /** Effective PO reference (after any buyer-typed override) -> the
   *  vendor-printed required/ship date for that order, so a created draft
   *  PO's `expectedShipMonth` isn't left blank when the document carried
   *  one. Missing/unparseable dates coerce to null downstream via
   *  `coerceShipMonthInput` — never throws. */
  requiredDateByReference?: Readonly<Record<string, string>>;
  /** Free-text audit trail stamped on every created PO's + item's `notes`
   *  (e.g. "Home Accessory Order Import — K & K Interiors"). */
  sourceLabel: string;
}

export interface HomeAccessoryPoGroup {
  reference: string;
  rows: EffectiveRow[];
}

/**
 * Group the rows bound for a draft PO by their EFFECTIVE reference
 * (`EffectiveRow.reference` already reflects any buyer-typed override —
 * see `composeHomeAccessoryRows` in homeAccessoryRows.ts). One
 * `BuyerDraftPurchaseOrder` is created per distinct reference; that's what
 * lets one multi-order vendor bundle (a K&K PDF carrying two orders)
 * create two draft POs instead of merging everything into one.
 *
 * Rows the buyer took off the PO (`poExcluded`) and rows with no
 * reference at all are excluded from every group — see `unassignedRows`.
 * Group order follows first appearance, so the created POs land in the
 * same order the buyer saw them in the preview.
 */
export function groupRowsByReference(rows: readonly EffectiveRow[]): HomeAccessoryPoGroup[] {
  const groups: HomeAccessoryPoGroup[] = [];
  const indexByReference = new Map<string, number>();
  for (const row of rows) {
    if (row.poExcluded) continue;
    const reference = (row.reference ?? "").trim();
    if (!reference) continue;
    const existingIndex = indexByReference.get(reference);
    if (existingIndex === undefined) {
      indexByReference.set(reference, groups.length);
      groups.push({ reference, rows: [row] });
    } else {
      groups[existingIndex].rows.push(row);
    }
  }
  return groups;
}

/**
 * Rows that do NOT belong to any PO group: buyer-excluded rows (a Wendover
 * side-marked piece "may already be on a PO in the system" — re-adding it
 * would order it twice) and rows with a blank reference (shouldn't
 * normally happen since every normalizer stamps one, but a buyer clearing
 * a single-order document's PO-number override could reach here). Both
 * still become `BuyerDraftItem`s — just with `draftPoId: null`.
 */
export function unassignedRows(rows: readonly EffectiveRow[]): EffectiveRow[] {
  return rows.filter((row) => row.poExcluded || !(row.reference ?? "").trim());
}

/**
 * A group's draft PO create body, ready to pass to
 * `buildPoCreateData` (lib/buyerDraftRequestBody.ts).
 */
export function buildHomeAccessoryPoCreateBody(
  group: HomeAccessoryPoGroup,
  ctx: HomeAccessoryCommitContext,
): BuyerDraftPoCreateBody {
  const requiredDate = ctx.requiredDateByReference?.[group.reference];
  return {
    vendorId: ctx.vendorId,
    vendorName: ctx.vendorName,
    referenceNumber: group.reference,
    // "" / undefined both coerce to null downstream (coerceShipMonthInput)
    // rather than throwing — an unparseable vendor date string is not
    // fatal, it just leaves the field blank for the buyer to fill in.
    expectedShipMonth: requiredDate || null,
    buyId: ctx.buyId,
    notes: `${ctx.sourceLabel} — order ${group.reference}`,
  };
}

/**
 * A row's `BuyerDraftItem` create body, ready to pass to
 * `buildItemCreateData` (lib/buyerDraftRequestBody.ts). Every composed row
 * becomes exactly one item, whether or not it landed on a draft PO —
 * `draftPoId` is the only field that differs between an assigned and an
 * excluded row.
 *
 * Field mapping (EffectiveRow -> BuyerDraftItemCreateBody):
 *   partNumber / productName / qty / cost -> as composed, unchanged
 *   msrp                                  -> row.msrp (nullable column)
 *   retail (REQUIRED, non-null column)    -> selling, else msrp, else cost
 *                                            — these documents often carry
 *                                            no retail at all (no markup
 *                                            typed), so cost is the last
 *                                            resort; mirrors the same
 *                                            never-leave-it-null fallback
 *                                            the historical-PO-import flow
 *                                            uses for the same column
 *                                            (docs/domains/buyer-drafts.md
 *                                            "avoids divide-by-zero in
 *                                            margin math")
 *   barcode                               -> "" coerces to null via
 *                                            buildItemCreateData's
 *                                            optionalString
 *   departmentId / categoryId             -> as composed (ids — the
 *                                            buyer-drafts API takes ids,
 *                                            not the exported NAMES)
 *   stockFamily                           -> as composed
 *   stockProgram                          -> true iff stockFamily is
 *                                            non-blank; this tool has no
 *                                            separate stocking-program
 *                                            checkbox, so a typed Stock
 *                                            Family label is taken to mean
 *                                            "yes, this is a stock item"
 *   itemType                              -> OTHER (home accessories /
 *                                            decor are neither the
 *                                            UPHOLSTERY nor CASE_GOODS
 *                                            description templates)
 *   source                                -> HOME_ACCESSORY_ORDER_IMPORT
 */
export function buildHomeAccessoryItemCreateBody(
  row: EffectiveRow,
  draftPoId: number | null,
  ctx: HomeAccessoryCommitContext,
): BuyerDraftItemCreateBody {
  const retail = row.selling ?? row.msrp ?? row.cost;
  return {
    vendorId: ctx.vendorId,
    vendorName: ctx.vendorName,
    partNumber: row.partNumber,
    productName: row.productName,
    cost: row.cost,
    retail,
    msrp: row.msrp,
    description: row.description ?? null,
    departmentId: row.departmentId,
    categoryId: row.categoryId,
    stockProgram: Boolean(row.stockFamily?.trim()),
    stockFamily: row.stockFamily || null,
    draftPoId,
    qty: row.qty,
    stockLocationId: ctx.stockLocationId,
    barcode: row.barcode || null,
    source: "HOME_ACCESSORY_ORDER_IMPORT",
    itemType: "OTHER",
    notes: `${ctx.sourceLabel} — order ${row.reference ?? "(unassigned)"}`,
  };
}

/**
 * Reconciliation total: qty x cost across every row NOT excluded from a
 * draft PO. Mirrors FC's "PO total ... matches the order documents"
 * banner — excluded rows are a deliberate buyer choice, not part of what
 * any draft PO is supposed to total.
 */
export function poReconciliationTotal(rows: readonly EffectiveRow[]): number {
  return rows.filter((r) => !r.poExcluded).reduce((sum, r) => sum + r.qty * r.cost, 0);
}

/**
 * The same total across EVERY composed row, including excluded ones — the
 * number that should match the vendor's own document total, since
 * excluding a row from the PO is a deliberate choice, not a split that
 * fails to reconcile.
 */
export function composedTotal(rows: readonly EffectiveRow[]): number {
  return rows.reduce((sum, r) => sum + r.qty * r.cost, 0);
}

/** Rows still missing a department or category — surfaced by the UI as a
 *  reason the "Create drafts" action is disabled, same guard FC used for
 *  its "New items" download. */
export function unclassifiedRowCount(rows: readonly EffectiveRow[]): number {
  return rows.filter((r) => !r.departmentId || !r.categoryId).length;
}
