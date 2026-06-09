// /app/src/lib/historicalPoSiblings.ts
//
// Slice 6.13 followup (2026-05-22) — Suggest sibling POs after a
// historical PO import.
//
// Use case: the owner described the POS's partial-receive workflow —
// when a PO partial-receives, the remainder gets cancelled on the
// original PO and a NEW PO is created for the missing items. the POS
// ships no parent-link between the original and the remainder. To
// reconstruct a buy from history the buyer has to know BOTH PONs,
// which is hard if they don't have a written record.
//
// This helper finds candidate sibling PONs after a successful import:
// same vendor, near same date, sharing partNos with the imported PO.
// The modal surfaces them as "Also import?" suggestions so the buyer
// can stitch a split-receive back together with one extra click each.
//
// Pure — no I/O. The API handler does the Prisma read + filtering.
// This helper just scores + ranks the candidates.

/** A candidate sibling PO + its line-item partNos (for overlap math). */
export interface SiblingCandidate {
  id: number;
  poNumber: string;
  orderDate: Date;
  vendorId: number;
  vendorName: string;
  status: string;
  lineCount: number;
  partNos: ReadonlyArray<string>; // partNo values from this PO's line items (de-duped, non-null)
  alreadyImportedToBuyId: number | null; // null if not yet imported anywhere
}

/** The source PO we're looking for siblings of. */
export interface SiblingSource {
  id: number;
  partNos: ReadonlyArray<string>; // partNos on the imported PO's line items
}

/** A scored sibling — same shape as candidate plus the overlap count. */
export interface ScoredSibling extends SiblingCandidate {
  /** Count of distinct partNos appearing on both source and this candidate. */
  overlapCount: number;
  /** True if every distinct partNo on this candidate also appears on the source.
   *  Strong signal it's a remainder PO carved out of the source. */
  fullyContainedBySource: boolean;
}

/**
 * Score + rank sibling candidates by partNo overlap with the source.
 *
 * Rules:
 *  - Exclude the source itself (same id).
 *  - Exclude candidates with `alreadyImportedToBuyId !== null` — those
 *    are already in some buy; surfacing them as suggestions is noise.
 *  - Score = count of distinct partNos shared between source and candidate.
 *  - `fullyContainedBySource` = all candidate.partNos appear in source.partNos.
 *    Useful for distinguishing "remainder PO carved from this one" (high signal)
 *    from "unrelated PO that happens to share some items" (low signal).
 *  - Sort by `overlapCount DESC, fullyContainedBySource DESC, orderDate ASC`
 *    so the most-likely sibling lands at the top of the list, oldest first.
 *  - Drop candidates with `overlapCount = 0` — no shared partNos means it's
 *    almost certainly a different buy.
 */
export function scoreSiblings(
  source: SiblingSource,
  candidates: ReadonlyArray<SiblingCandidate>,
): ScoredSibling[] {
  const sourcePartNoSet = new Set(source.partNos);
  const scored: ScoredSibling[] = [];

  for (const cand of candidates) {
    if (cand.id === source.id) continue;
    if (cand.alreadyImportedToBuyId !== null) continue;

    const candDistinctPartNos = new Set(cand.partNos);
    let overlap = 0;
    for (const partNo of candDistinctPartNos) {
      if (sourcePartNoSet.has(partNo)) overlap++;
    }
    if (overlap === 0) continue;

    const fullyContained =
      candDistinctPartNos.size > 0 &&
      Array.from(candDistinctPartNos).every((p) => sourcePartNoSet.has(p));

    scored.push({
      ...cand,
      overlapCount: overlap,
      fullyContainedBySource: fullyContained,
    });
  }

  scored.sort((a, b) => {
    if (b.overlapCount !== a.overlapCount) return b.overlapCount - a.overlapCount;
    if (a.fullyContainedBySource !== b.fullyContainedBySource) {
      return a.fullyContainedBySource ? -1 : 1;
    }
    return a.orderDate.getTime() - b.orderDate.getTime();
  });

  return scored;
}
