// /app/src/lib/buyerDraftPoAutoLink.ts
//
// Slice 6.14 (2026-05-22) — Pure helper that matches newly-imported
// real PurchaseOrders against existing BuyerDraftPurchaseOrder rows
// and proposes the auto-link set.
//
// Runs as a post-batch sweep inside `runPurchaseOrdersImport` (mirrors
// the Slice 5 pattern in `lib/buyerDraftAutoLink.ts` which auto-links
// draft ITEMS to real Products). The handler hydrates inputs from
// Prisma; this helper does the deterministic matching + scoring.
//
// MATCHING RULES
// --------------
// For each new/updated real PO:
//   1. Skip if it's already linked to a draft PO (the unique constraint
//      on BuyerDraftPoRealPoLink.realPoId is the source of truth).
//   2. Find candidate draft POs:
//        - same vendorId
//        - status in (DRAFT, READY, EXPORTED) — the buyer's flow is
//          DRAFT → READY (mark for export) → EXPORTED (CSV downloaded) →
//          FULFILLED (real PO confirmed). EXPORTED is the prime candidate;
//          DRAFT/READY catch the case where the buyer didn't go through
//          the formal export step (e.g. they typed the PO into the POS
//          directly).
//   3. Compute item-overlap by partNo (real PO's partNo set vs draft PO's
//      partNumber set) AND by fulfilledProductId (the draft items' link
//      to real Products; populated by Slice 5).
//   4. The match score = overlap ratio relative to the REAL PO's lines.
//      High threshold (default 0.6) so noise from products that happen
//      to share partNos doesn't false-positive.
//   5. If exactly ONE candidate above threshold → propose link.
//   6. If multiple → propose nothing for that real PO; log for operator
//      to handle manually.
//
// SAFETY
// ------
// The helper NEVER attaches to a draft PO that already has a different
// real PO linked unless the draft PO has > 0 items NOT yet on any
// already-linked real PO. (Avoids attaching the same draft PO to
// completely-unrelated real POs just because the vendor matches.)
//
// Same idempotency shape as Slice 5: re-running on the same inputs
// produces the same output. The runner uses the unique-constraint at
// the DB layer as the second line of defense.

/** A real PO we're considering for auto-link. */
export interface RealPoForAutoLink {
  id: number;
  vendorId: number;
  /** Distinct partNos on this real PO's line items, lowercased + trimmed. */
  partNos: ReadonlyArray<string>;
  /** Distinct productIds (via PurchaseOrderItem.productId) on this real PO. */
  productIds: ReadonlyArray<number>;
  /** True if this real PO already has a row in BuyerDraftPoRealPoLink.
   *  Set from the back-relation; caller fills it in. */
  alreadyLinked: boolean;
}

/** A draft PO we're considering as a target. */
export interface DraftPoForAutoLink {
  id: number;
  vendorId: number;
  status: "DRAFT" | "READY" | "EXPORTED" | "FULFILLED" | "CANCELLED";
  /** Distinct partNumbers on this draft PO's items, lowercased + trimmed. */
  partNumbers: ReadonlyArray<string>;
  /** Distinct fulfilledProductIds on this draft PO's items (Slice 5 link). */
  fulfilledProductIds: ReadonlyArray<number>;
}

/** A proposed link the caller should write to the DB. */
export interface ProposedAutoLink {
  draftPoId: number;
  realPoId: number;
  /** Match score 0..1 — fraction of the real PO's signals (partNo or
   *  productId) that are present on the draft PO. Stored for debugging
   *  + future tuning, not currently persisted. */
  matchScore: number;
}

/** Skipped real POs + reason (for logging / operator visibility). */
export interface SkippedRealPo {
  realPoId: number;
  reason:
    | "already-linked"
    | "no-vendor-match"
    | "no-signal-overlap"
    | "below-threshold"
    | "ambiguous-multiple-candidates";
  candidateDraftPoIds?: number[];
  topScore?: number;
}

export interface AutoLinkPlan {
  links: ProposedAutoLink[];
  skipped: SkippedRealPo[];
}

/**
 * Default match threshold: a real PO needs >=60% of its signals
 * (partNo + productId set, deduped) to be present on the draft PO
 * for the match to count. Justification: too low and stocking-SKU
 * overlap false-positives ("Vendor X has 5 standing PO items; one
 * happens to be on my Spring draft → wrong attach"); too high and
 * legitimate partial-overlap cases (3 of 5 items on the draft) miss.
 * 60% empirically catches the typical 80-100% overlap of a real PO
 * matching its draft, with a margin for missing barcodes / partNos.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.6;

export interface PlanOptions {
  threshold?: number;
}

// Build the signal set for one PO side. Lowercased + de-duped union of
// partNos (prefixed `pn:`) and productIds (prefixed `p:`). Extracted so
// `planPoAutoLinks` stays under Sonar S3776 cognitive complexity = 15.
function buildSignalSet(
  partNos: ReadonlyArray<string>,
  productIds: ReadonlyArray<number>,
): Set<string> {
  const out = new Set<string>();
  for (const pn of partNos) out.add(`pn:${pn}`);
  for (const pid of productIds) out.add(`p:${pid}`);
  return out;
}

// Build the by-vendor candidate index for draft POs. Skips terminal
// states (FULFILLED, CANCELLED) — those are out of the auto-link pool.
function indexCandidatesByVendor(
  draftPos: ReadonlyArray<DraftPoForAutoLink>,
): Map<number, DraftPoForAutoLink[]> {
  const draftsByVendor = new Map<number, DraftPoForAutoLink[]>();
  for (const dp of draftPos) {
    if (dp.status === "FULFILLED" || dp.status === "CANCELLED") continue;
    const bucket = draftsByVendor.get(dp.vendorId) ?? [];
    bucket.push(dp);
    draftsByVendor.set(dp.vendorId, bucket);
  }
  return draftsByVendor;
}

// Score every candidate against the real PO's signal set; return only
// those at or above threshold.
function scoreCandidates(
  rpSignals: ReadonlySet<string>,
  candidates: ReadonlyArray<DraftPoForAutoLink>,
  proposedDraftPoIds: ReadonlySet<number>,
  threshold: number,
): Array<{ draftPo: DraftPoForAutoLink; score: number }> {
  const scored: Array<{ draftPo: DraftPoForAutoLink; score: number }> = [];
  for (const dp of candidates) {
    if (proposedDraftPoIds.has(dp.id)) continue;
    const dpSignals = buildSignalSet(dp.partNumbers, dp.fulfilledProductIds);
    let overlap = 0;
    for (const sig of rpSignals) {
      if (dpSignals.has(sig)) overlap++;
    }
    const score = overlap / rpSignals.size;
    if (score >= threshold) {
      scored.push({ draftPo: dp, score });
    }
  }
  return scored;
}

// Evaluate one real PO against the candidate pool and return EITHER
// a proposed link OR a skip reason. The main loop turns this into the
// final plan.
function evaluateRealPo(
  rp: RealPoForAutoLink,
  draftsByVendor: ReadonlyMap<number, DraftPoForAutoLink[]>,
  proposedDraftPoIds: ReadonlySet<number>,
  threshold: number,
): { link: ProposedAutoLink } | { skip: SkippedRealPo } {
  if (rp.alreadyLinked) {
    return { skip: { realPoId: rp.id, reason: "already-linked" } };
  }
  const candidates = draftsByVendor.get(rp.vendorId);
  if (!candidates || candidates.length === 0) {
    return { skip: { realPoId: rp.id, reason: "no-vendor-match" } };
  }
  const rpSignals = buildSignalSet(rp.partNos, rp.productIds);
  if (rpSignals.size === 0) {
    return { skip: { realPoId: rp.id, reason: "no-signal-overlap" } };
  }
  const scored = scoreCandidates(rpSignals, candidates, proposedDraftPoIds, threshold);
  if (scored.length === 0) {
    return {
      skip: {
        realPoId: rp.id,
        reason: "below-threshold",
        candidateDraftPoIds: candidates.map((d) => d.id),
      },
    };
  }
  if (scored.length > 1) {
    scored.sort((a, b) => b.score - a.score);
    return {
      skip: {
        realPoId: rp.id,
        reason: "ambiguous-multiple-candidates",
        candidateDraftPoIds: scored.map((s) => s.draftPo.id),
        topScore: scored[0].score,
      },
    };
  }
  const winner = scored[0];
  return {
    link: { draftPoId: winner.draftPo.id, realPoId: rp.id, matchScore: winner.score },
  };
}

export function planPoAutoLinks(
  realPos: ReadonlyArray<RealPoForAutoLink>,
  draftPos: ReadonlyArray<DraftPoForAutoLink>,
  options: PlanOptions = {},
): AutoLinkPlan {
  const threshold = options.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const links: ProposedAutoLink[] = [];
  const skipped: SkippedRealPo[] = [];

  const draftsByVendor = indexCandidatesByVendor(draftPos);

  // Track which draft POs we've already proposed a link for in this
  // pass — prevents the same draft PO from being attached to two
  // unrelated real POs in a single batch.
  const proposedDraftPoIds = new Set<number>();

  for (const rp of realPos) {
    const result = evaluateRealPo(rp, draftsByVendor, proposedDraftPoIds, threshold);
    if ("link" in result) {
      links.push(result.link);
      proposedDraftPoIds.add(result.link.draftPoId);
    } else {
      skipped.push(result.skip);
    }
  }

  return { links, skipped };
}
