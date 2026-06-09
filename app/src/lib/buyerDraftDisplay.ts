// /app/src/lib/buyerDraftDisplay.ts
//
// Slice 6.1 (2026-05-12) — display helpers for buyer-draft items that
// have been linked (via Slice 5 auto-link or a manual override) to a
// real Product. The buyer wants to see the catalog data on the draft
// card so they can verify "this draft now corresponds to THIS catalog
// item" — works for both production verification AND the historical-
// testing case where the draft is a re-creation of an existing Product.
//
// Pure helpers. The fallback rule is the same for every field:
//   - If the buyer typed a value on the draft → use it (their plan is
//     authoritative; the link is for verification/lookup)
//   - Else if the linked Product has a value → use it (catalog fills
//     in the blanks)
//   - Else → null
//
// Numeric Decimal fields come in as strings or { toString() } shapes
// from Prisma; the resolved value is always a string in the caller's
// preferred precision (no Number coercion here).

/** Prisma Decimal columns serialize as a `{ toString(): string }` shape
 *  on the wire; some call sites already pre-stringify. Accept either. */
export type DecimalLike = string | { toString(): string };
/** Same as DecimalLike but allows explicit absence (nullable column). */
export type NullableDecimalLike = DecimalLike | null;

export interface DraftItemDisplayInput {
  description: string | null;
  cost: DecimalLike;
  retail: DecimalLike;
  msrp: NullableDecimalLike;
  productWidth: NullableDecimalLike;
  productLength: NullableDecimalLike;
  productHeight: NullableDecimalLike;
}

export interface LinkedProductDisplayInput {
  description: string | null;
  baseCost: { toString(): string } | null;
  baseRetail: { toString(): string } | null;
  mapPrice: { toString(): string } | null;
  width: number | null;
  depth: number | null;
  height: number | null;
}

export interface ResolvedDisplay {
  description: string | null;
  cost: string;
  retail: string;
  msrp: string | null;
  productWidth: string | null;
  productLength: string | null;
  productHeight: string | null;
  /** Per-field source so the UI can show a "from catalog" hint when the
   *  draft was blank and we fell back. Only fields where the fallback
   *  was triggered appear as `"linked"`. */
  source: Record<string, "draft" | "linked">;
}

/** Resolve display values for a draft item, falling back to its linked
 * Product when the draft fields are blank/null. Pure — no DOM, no I/O. */
export function resolveDraftDisplay(
  draft: DraftItemDisplayInput,
  linked: LinkedProductDisplayInput | null,
): ResolvedDisplay {
  const source: Record<string, "draft" | "linked"> = {};

  const description = preferDraft(
    "description",
    draft.description,
    linked?.description ?? null,
    source,
  );

  const cost = preferDraftDecimal("cost", draft.cost, linked?.baseCost ?? null, source);
  const retail = preferDraftDecimal("retail", draft.retail, linked?.baseRetail ?? null, source);
  const msrp = preferDraftDecimalOrNull(
    "msrp",
    draft.msrp ?? null,
    linked?.mapPrice ?? null,
    source,
  );

  const productWidth = preferDraftDecimalOrNull(
    "productWidth",
    draft.productWidth ?? null,
    linked?.width ?? null,
    source,
  );
  const productLength = preferDraftDecimalOrNull(
    "productLength",
    draft.productLength ?? null,
    linked?.depth ?? null,
    source,
  );
  const productHeight = preferDraftDecimalOrNull(
    "productHeight",
    draft.productHeight ?? null,
    linked?.height ?? null,
    source,
  );

  return {
    description,
    cost: cost ?? "0",
    retail: retail ?? "0",
    msrp,
    productWidth,
    productLength,
    productHeight,
    source,
  };
}

// ─── Internals ─────────────────────────────────────────────────────────

function preferDraft(
  field: string,
  draftVal: string | null,
  linkedVal: string | null,
  source: Record<string, "draft" | "linked">,
): string | null {
  if (draftVal && draftVal.trim() !== "") {
    source[field] = "draft";
    return draftVal;
  }
  if (linkedVal && linkedVal.trim() !== "") {
    source[field] = "linked";
    return linkedVal;
  }
  return null;
}

function preferDraftDecimal(
  field: string,
  draftVal: string | { toString(): string } | null | undefined,
  linkedVal: { toString(): string } | null,
  source: Record<string, "draft" | "linked">,
): string | null {
  const draftStr = draftVal === null || draftVal === undefined ? null : String(draftVal);
  if (draftStr !== null && draftStr !== "" && Number(draftStr) !== 0) {
    source[field] = "draft";
    return draftStr;
  }
  if (linkedVal !== null) {
    source[field] = "linked";
    return String(linkedVal);
  }
  // Fall back to draft even if it's "0"/empty, so callers don't crash on null
  return draftStr;
}

function preferDraftDecimalOrNull(
  field: string,
  draftVal: string | number | { toString(): string } | null | undefined,
  linkedVal: number | { toString(): string } | null,
  source: Record<string, "draft" | "linked">,
): string | null {
  const draftStr = draftVal === null || draftVal === undefined ? null : String(draftVal);
  if (draftStr !== null && draftStr !== "") {
    source[field] = "draft";
    return draftStr;
  }
  if (linkedVal !== null) {
    source[field] = "linked";
    return String(linkedVal);
  }
  return null;
}
