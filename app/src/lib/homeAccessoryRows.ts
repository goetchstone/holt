// /app/src/lib/homeAccessoryRows.ts
//
// Pure row composition for the Home Accessory Order Import page: expands
// the parsed lines into the rows that actually get created as
// `BuyerDraftItem`s (a plain line becomes one row; a split set becomes one
// row per piece) and resolves every value's precedence.
//
// Ported from furniture-configurator's src/lib/homeAccessoryRows.ts. The
// split-set math, precedence rules, and render-grouping are unchanged.
// Dropped relative to FC's version, because they have no holt analog:
//   - Ordorite catalog match (`CatalogMatch` / `ChildMatch` / adopting an
//     existing split) — holt's buyer drafts are pre-catalog negotiation
//     records, not reconciled against `Product` rows at import time. A
//     buyer who wants to link a draft to an existing catalog Product
//     already has the barcode-lookup quick-add flow
//     (`lib/buyerDraftFromProduct.ts`) for that.
//   - `oversell` — an Ordorite PO-import column with no `BuyerDraftItem`
//     field.
//   - `ordoriteId` on the row — no analog; `BuyerDraftItem` has no
//     "already in the catalog" concept at draft time.
//
// Lifted out of the page so the precedence rules that decide MONEY and
// CLASSIFICATION are unit-testable without rendering React (CLAUDE.md
// rule 14). The page keeps only state + rendering.

import {
  applyMarkup,
  buildHomeAccessoryPartNumber,
  detectSetSize,
  splitPieceName,
} from "./homeAccessoryOrders";
import type { HomeAccessoryDraft, HomeAccessoryExportRow } from "./homeAccessoryOrders";

export interface DeptOption {
  id: number;
  name: string;
}
export interface CatOption {
  id: number;
  name: string;
  departmentId: number;
}

/** A buyer-entered split component: the size marker appended to the part
 *  number and that piece's share of the set's cost. */
export interface SplitPart {
  suffix: string;
  cost: string;
}

/** One row to create plus the page-only bookkeeping that ties it back to
 *  the parsed line it came from. */
export interface EffectiveRow extends HomeAccessoryExportRow {
  key: string;
  rowIndex: number;
  setSize: number | null;
  isSplitChild: boolean;
  /** Buyer took this row off the draft PO — it still becomes a
   *  `BuyerDraftItem` (unassigned, `draftPoId` null), it just doesn't land
   *  on any PO. Mirrors FC's "off PO but still in item files" concept —
   *  the item data is still worth correcting even when it's already on a
   *  PO elsewhere (a Wendover side-marked piece, for instance). */
  poExcluded: boolean;
  /**
   * The resolved ids behind the `department` / `category` NAMES.
   *
   * The UI needs ids for its <select>s, and deriving the id back from the
   * name is lossy when the same name is used by more than one category
   * across departments — so both travel with the row.
   */
  departmentId: number | null;
  categoryId: number | null;
}

export interface RowEdits {
  rowDepts: Record<string, number>;
  rowCats: Record<string, number>;
  sellings: Record<string, string>;
  msrps: Record<string, string>;
  /** The vendor's wording is not always what belongs on the shelf tag, so
   *  name and description are editable; and a barcode can be typed when
   *  the document carries none. */
  names: Record<string, string>;
  descriptions: Record<string, string>;
  barcodes: Record<string, string>;
  /**
   * Hand-typed part numbers. The composed `PREFIX-ITEM[-SUFFIX]` is only a
   * prefill: a vendor whose item numbers already carry the prefix reads
   * back redundantly (Graf & Lantz `GL` + `GL60BIN50FTLG` ->
   * `GL-GL60BIN50FTLG`), so the buyer gets the last word.
   *
   * Blank falls back to the composed value — clearing the box is "go back
   * to the default", not "ship an empty part number".
   */
  partNumbers: Record<string, string>;
  /**
   * Rows the buyer has taken OFF the draft PO (a Wendover side-marked
   * piece "may already be on a PO in the system", so re-adding it would
   * order it twice). The item still becomes a `BuyerDraftItem` — only the
   * PO assignment drops.
   */
  poExcluded: Record<string, boolean>;
}

export interface ComposeInput {
  draft: HomeAccessoryDraft | null;
  splits: Record<number, SplitPart[]>;
  edits: RowEdits;
  departments: readonly DeptOption[];
  categories: readonly CatOption[];
  defaultDepartmentId: number | null;
  defaultCategoryId: number | null;
  markup: number;
  supplier: string;
  prefix: string;
  /** Run-level Stock Family, written to every row's `stockFamily`
   *  (overridable per row is not exposed — matches FC's run-level-only
   *  field). */
  stockFamily: string;
  /**
   * Typed PO numbers, keyed by the vendor's own order number — because one
   * document can hold SEVERAL orders (a K&K bundle carries two) and each
   * can have its own pre-set-up draft PO.
   *
   * A blank/missing entry leaves that order on its own vendor order number.
   * Keying per order is what keeps the orders apart: a draft PO groups by
   * its repeated `reference`, so one typed number applied across every row
   * would silently MERGE a two-order bundle into a single draft PO.
   */
  poNumbers: Readonly<Record<string, string>>;
}

/**
 * A split piece's barcode: the set's own UPC with a -1 / -2 / -3 suffix
 * (mirrors FC's 2026-07-17 direction: "when we split we need to use and
 * append the barcode with a -1 -2 etc (to keep them unique)").
 *
 * The set arrives as one box with one manufacturer UPC and becomes N
 * sellable items. They cannot share the code downstream once the draft
 * fulfills to a real Product (`Upc.upc` is unique) -- the suffix keeps
 * each piece unique while still pointing back at the box it came from. A
 * set with no printed UPC stays blank.
 */
export function splitChildBarcode(setBarcode: string, pieceIndex: number): string {
  const stem = setBarcode.trim();
  if (!stem) return "";
  return `${stem}-${pieceIndex + 1}`;
}

/** One row to build. Named rather than positional: the split fields made
 *  the call sites a run of bare values that read as nothing. */
interface ComposeRowInput {
  base: HomeAccessoryExportRow;
  key: string;
  rowIndex: number;
  partNumber: string;
  cost: number;
  barcode: string;
  isSplitChild: boolean;
  splitSuffix?: string;
  /**
   * The parent line's department/category, for a split piece to inherit
   * (mirrors FC's 2026-07-17 direction: "splits should inherit the primary
   * department and category").
   *
   * Without this each piece resolves independently — since every piece has
   * its OWN part number, an edit on one piece could otherwise leave its
   * siblings on the run default while it took a different pick. Three
   * pieces of one set would then land in different departments.
   */
  inherited?: { departmentId: number | null; categoryId: number | null };
}

/** Expand the parsed lines into the rows that actually get created: a
 *  plain line becomes one row; a split set becomes one row per piece.
 *  Per-row picks beat the parent line's inherited classification, which
 *  beats the run-level default. */
export function composeHomeAccessoryRows(input: ComposeInput): EffectiveRow[] {
  const { draft, splits, edits, departments, categories, markup, supplier, prefix } = input;
  if (!draft) return [];
  const nameOf = <T extends { id: number; name: string }>(
    list: readonly T[],
    id: number | null | undefined,
  ) => list.find((x) => x.id === id)?.name ?? "";

  const compose = ({
    base,
    key,
    rowIndex,
    partNumber,
    cost,
    barcode,
    isSplitChild,
    splitSuffix,
    inherited,
  }: ComposeRowInput): EffectiveRow => {
    // A typed part number wins over the composed one.
    const effectivePartNumber = edits.partNumbers[key]?.trim() || partNumber;
    const editedName = edits.names[key];
    const pieceName =
      isSplitChild && splitSuffix
        ? splitPieceName(base.productName, splitSuffix)
        : base.productName;
    const editedBarcode = edits.barcodes[key];
    // A split piece takes the parent line's classification unless the buyer
    // picks one for it explicitly. The set is one product to the buyer.
    const deptId = edits.rowDepts[key] ?? inherited?.departmentId ?? input.defaultDepartmentId;
    const catId = edits.rowCats[key] ?? inherited?.categoryId ?? input.defaultCategoryId;
    const auto = applyMarkup(cost, markup);
    const sellingRaw = edits.sellings[key];
    const msrpRaw = edits.msrps[key];
    const selling = sellingRaw === undefined ? auto : Number.parseFloat(sellingRaw);
    const msrp = msrpRaw === undefined ? auto : Number.parseFloat(msrpRaw);
    return {
      ...base,
      key,
      rowIndex,
      // Set-ness reads the VENDOR's wording: renaming an item must not hide
      // its split action.
      setSize: detectSetSize(base.productName),
      isSplitChild,
      partNumber: effectivePartNumber,
      cost,
      // A split piece is not the set: drop "Set of N" and say which piece it
      // is. Prefill only — an edited name still wins.
      productName: editedName ?? pieceName,
      // Fall back to the PARSED description, not undefined: a vendor whose
      // document carries a real long-form description (Wendover's
      // "Medium: … Treatment: … Size: … Frame: …") would otherwise be
      // silently dropped. An edit still wins, and clearing the box to ""
      // still falls through to the composed form (the UI's own default).
      description:
        edits.descriptions[key] ?? (isSplitChild && splitSuffix ? pieceName : base.description),
      barcode: editedBarcode ?? barcode,
      stockFamily: input.stockFamily,
      // Per-order: a row keeps its own order's PO, so a multi-order bundle
      // still creates one draft PO per order.
      reference: input.poNumbers[base.reference ?? ""]?.trim() || base.reference,
      department: nameOf(departments, deptId),
      category: nameOf(categories, catId),
      departmentId: deptId ?? null,
      categoryId: catId ?? null,
      poExcluded: edits.poExcluded[key] === true,
      supplier,
      selling: selling === null || Number.isNaN(selling) ? null : selling,
      msrp: msrp === null || Number.isNaN(msrp) ? null : msrp,
    };
  };

  return draft.rows.flatMap((row, i) => {
    const parts = splits[i];
    if (!parts) {
      const pn = buildHomeAccessoryPartNumber(prefix, row.partNumber);
      return [
        compose({
          base: row,
          key: String(i),
          rowIndex: i,
          partNumber: pn,
          cost: row.cost,
          barcode: row.barcode,
          isSplitChild: false,
        }),
      ];
    }
    // Every piece takes the PARENT line's classification, resolved once
    // here. Resolving per-piece let one piece take a different pick while
    // its siblings fell back to the run default -- three pieces of one set
    // in different departments.
    const inherited = {
      departmentId: edits.rowDepts[String(i)] ?? input.defaultDepartmentId,
      categoryId: edits.rowCats[String(i)] ?? input.defaultCategoryId,
    };

    return parts.map((p, ci) =>
      compose({
        base: row,
        key: `${i}:${ci}`,
        rowIndex: i,
        partNumber: buildHomeAccessoryPartNumber(prefix, row.partNumber, p.suffix),
        cost: Number.parseFloat(p.cost) || 0,
        // The set has ONE manufacturer UPC and becomes N items, so the
        // pieces cannot share it once fulfilled to a real Product (unique
        // UPC constraint) -- the set's UPC is kept as the stem and
        // suffixed, which stays unique AND traceable back to the box it
        // came in. A set with no printed UPC still stays blank.
        barcode: splitChildBarcode(row.barcode, ci),
        isSplitChild: true,
        splitSuffix: p.suffix,
        inherited,
      }),
    );
  });
}

/**
 * A render block: either a plain line (one row) or a split set (its pieces
 * collected into one group). The page renders a split group inside a
 * single bordered, headed container so several sets split back-to-back
 * read as distinct blocks instead of a run of look-alike cards.
 */
export type RenderBlock =
  | { kind: "single"; row: EffectiveRow }
  | {
      kind: "splitGroup";
      /** The parsed line every piece came from — the container's identity. */
      rowIndex: number;
      /** Position among split GROUPS in order, so adjacent groups can
       *  alternate their accent colour and never blur together. */
      groupOrdinal: number;
      rows: EffectiveRow[];
    };

/**
 * Collapse the flat composed rows into render blocks: each split set's
 * pieces (contiguous, sharing a `rowIndex`) become one `splitGroup`;
 * everything else is a `single`. `groupOrdinal` counts only split groups,
 * so the page can give consecutive groups alternating accents.
 *
 * Pure so the grouping is unit-tested without rendering React (CLAUDE.md
 * rule 14) — the branchy "is this the same group as the previous row?"
 * logic is exactly the kind that hides bugs inside JSX.
 */
export function groupRowsForRender(rows: readonly EffectiveRow[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let groupOrdinal = 0;
  for (const row of rows) {
    if (!row.isSplitChild) {
      blocks.push({ kind: "single", row });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === "splitGroup" && last.rowIndex === row.rowIndex) {
      last.rows.push(row);
      continue;
    }
    blocks.push({
      kind: "splitGroup",
      rowIndex: row.rowIndex,
      groupOrdinal: groupOrdinal++,
      rows: [row],
    });
  }
  return blocks;
}
