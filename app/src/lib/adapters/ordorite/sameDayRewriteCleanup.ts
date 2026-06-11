// /app/src/lib/adapters/ordorite/sameDayRewriteCleanup.ts
//
// Pure helper for the same-day-rewrite cleanup that runSalesImport runs
// post-import (and the backfill migrations run against history).
//
// THE QUIRK we're cleaning up
// --------------------------
// When Ordorite "rewrites" an order on the same day it was placed (e.g.
// customer changes their mind before close-of-business), it produces a
// three-part chain:
//   1. Base order — still ACTIVE, full original line set
//   2. Accounting return (SBOA/CHOA/GTOA, same-day) — negative-quantity
//      lines for items the customer KEPT (the return is the credit
//      side of the rewrite re-charge, so kept items get refunded then
//      re-billed; net zero customer-facing).
//   3. Rewrite (orderno + " - A") — positive-quantity lines for the
//      items they kept (or partially-kept with adjusted price).
//
// Under the doctrine in CLAUDE.md ("Order rewrites keep the whole chain
// active"), DAILY SALES totals add all three orders' lines as-is. That
// works correctly when:
//   - Items KEPT-WITH-CREDIT-CYCLE → base ACTIVE + return NEGATIVE + rewrite POSITIVE = +rewrite (correct)
//   - Items RETURNED-BUT-NOT-REWRITTEN → base ACTIVE + return NEGATIVE = 0 (correct)
//   - Items KEPT-WITHOUT-CYCLE (e.g. unchanged base lines, MRC fees) → base ACTIVE = +base (correct)
//   - Items DROPPED with NO return → base ACTIVE = OVER-COUNTS (the bug)
//
// Only the fourth case needs intervention.
//
// FAILURE LOG 2026-05-15 (this rewrite): the original implementation
// (2026-05-12, CHOM1726-era) used `lineNumber > max(rewrite.lineNumber)`
// alone as a proxy for "dropped." That worked by coincidence for CHOM1726
// (dropped items were at high lineNumbers AND had no return) but over-
// cancelled badly on SBOM39618 — base lines 3,4,5 had matching returns
// (truly kept-with-credit-cycle) but the helper cancelled them because
// they were beyond the rewrite's last line. Audit against 2026-05-15
// backup: SBOM39618 ERP $20,169 vs Ordorite $24,493 = $4,324 gap,
// exactly the four cancelled lines' net prices.
//
// Detection rule (this version) — CONSERVATIVE, combined heuristic:
// A base line is "dropped" only when ALL of the following hold:
//   1. lineNumber > max(rewrite.lineNumber)  — outside the rewrite's
//      footprint (protects unchanged base lines that Ordorite leaves
//      in place, e.g. the JRS Vidya duvet + shams on SBOM39618).
//   2. No matching RETURN line (partNo + sign-inverted orderedQuantity)
//      that hasn't already been consumed by an earlier base line.
//   3. No matching REWRITE line (partNo only — rewrites can adjust qty)
//      that hasn't already been consumed.
//
// Consumption-based matching is the subtle bit: CHOM1726 has TWO
// DELIVERY CHARGE lines on the base (lineNumber 3 = kept + lineNumber 5
// = dropped), and ONE DELIVERY CHARGE line on the return + ONE on the
// rewrite. Without consumption tracking, both base DELIVERY lines would
// claim the single return-match and neither would be cancelled. With
// consumption, line 3 (within rewrite footprint) is auto-kept, line 5
// (beyond footprint) finds no available match → cancelled.
//
// Known small gap (acceptable): "sticky fee" line items like MRC
// (Miscellaneous Charge, ~$16) do NOT participate in returns or
// rewrites — they sit on the base order regardless. Per rule 1 above
// they'll be cancelled if they happen to land beyond the rewrite's
// footprint. On SBOM39618 this re-cancels the $16 MRC line. The gap is
// surfaced by daily reconciliation. A future config-driven NEVER_CANCEL
// list could close this; for now, the under-count is small and visible.
//
// FAILURE LOG 2026-05-22 (SBOM39876 — return-lookup bug + 50% guard):
// Initial diagnosis (PR #320) was: heuristic can't distinguish price-
// tweak rewrites from drop rewrites because their CSV shapes are
// "structurally indistinguishable." A deeper audit proved that wrong.
// What was actually broken:
//
//   1. The return-orderno lookup was wrong. `swapToReturnPrefix` mapped
//      "SBOM39876" → "SBOA39876", but Ordorite's accounting-return
//      ordernos use an INDEPENDENT numeric sequence: CHOM1726's return
//      is CHOA010045, SBOM39876's is SBOA013572. The base's number
//      doesn't appear in the return at all.
//   2. Audit query: 193 of 195 same-day rewrites have a same-day
//      SBOA/CHOA/etc. return for the same customer. The broken swap
//      found 2.
//   3. Consequence: `returnLines` was [] in ~99% of same-day rewrites.
//      Gate 2 of this helper was perpetually trivially satisfied. The
//      heuristic was running blind to the actual returns.
//
// Two structural fixes (2026-05-22b):
//
//   A. In `cleanupOneRewriteChain` (ordoriteImportRunners.ts) — look
//      up the return by `(customerId, orderDate, OA-prefix-pattern)`,
//      not by exact orderno swap. With the real return data:
//        - CHOM1726: gate 2 correctly claims base lines 1,2,3 via
//          returns. Lines 4,5 fail all three gates → still cancelled
//          (correct).
//        - SBOM39876: gate 2 claims base line 3 via return. Lines 1,2,4
//          STILL fail all gates → would be cancelled (still wrong).
//   B. 50% safety guard in `cleanupOneRewriteChain` — if dropped /
//      activeBase >= 0.5, skip and log. CHOM1726 (2/5 = 40%) passes
//      through; SBOM39876 (2/4 = 50%) gets skipped. The price-tweak
//      shape has a structural tell: the rewrite covers a small fraction
//      of the base, so the heuristic would over-cancel a majority of
//      lines. The guard catches that without requiring operator input.
//
// Backfill: migration `20260522b_restore_over_cancelled_price_tweak_
// rewrites` re-runs the new heuristic over historical data. Restores
// 29 lines / $13,948.04 across 16 base orders, 8 distinct order dates
// from 2025-05-02 through 2026-05-21. True CHOM1726-shape cancellations
// (24 lines across 19 pairs) are NOT touched.
//
// Operator override (`SalesOrder.skipSameDayRewriteCleanup`, PR #320)
// is preserved as a final-safety escape hatch for cases the 50% guard
// somehow doesn't catch. The migration `20260522_skip_same_day_rewrite
// _cleanup_flag` still ships in place.

export interface LineItemForCleanup {
  id: number;
  lineNumber: number | null;
  lineItemStatus: string;
  partNo: string | null;
  orderedQuantity: number;
}

export interface SameDayRewriteTriple {
  /** Base order line items (all of them, regardless of current status). */
  baseLines: readonly LineItemForCleanup[];
  /** Rewrite order line items. */
  rewriteLines: readonly LineItemForCleanup[];
  /** Same-day accounting-return line items (SBOA/CHOA/GTOA matching the
   *  base order's prefix + same orderDate). May be empty if the customer
   *  modified the order via Ordorite's no-credit path (rare but possible). */
  returnLines: readonly LineItemForCleanup[];
}

/**
 * Given a same-day base + rewrite + return triple, return the base line IDs
 * that should be CANCELLED. Returns an empty array if nothing to do.
 *
 * Rule: a base line is "dropped" iff ALL of these hold:
 *   - It is NOT already CANCELLED (idempotent — safe to re-run)
 *   - Its partNo is not null (conservative — can't match → keep ACTIVE)
 *   - Its lineNumber is greater than the max lineNumber in the rewrite
 *     (positional check — base lines within the rewrite's footprint are
 *     presumed kept)
 *   - There is NO available matching return line (same partNo, qty =
 *     -base.qty) that hasn't been claimed by an earlier base line
 *   - There is NO available matching rewrite line (same partNo) that
 *     hasn't been claimed
 *
 * Consumption-based matching ensures duplicated partNos on the base
 * (e.g. two DELIVERY CHARGE lines) split correctly — one is kept (it
 * has a return/rewrite to claim), the other is dropped.
 */
export function findDroppedBaseLineIds(triple: SameDayRewriteTriple): number[] {
  const droppedIds: number[] = [];

  // Compute the rewrite's max lineNumber. Lines beyond this are
  // candidates for cancellation; lines at or before are auto-kept.
  const rewriteMaxLineNumber = triple.rewriteLines.reduce(
    (max, r) => (r.lineNumber !== null && r.lineNumber > max ? r.lineNumber : max),
    0,
  );

  // Consumption tracking — each return/rewrite line can claim at most
  // one base line. Process base lines in lineNumber order so the
  // "in-footprint" lines claim first.
  const consumedReturnIds = new Set<number>();
  const consumedRewriteIds = new Set<number>();

  const sortedBase = [...triple.baseLines].sort((a, b) => {
    const aLn = a.lineNumber ?? Number.MAX_SAFE_INTEGER;
    const bLn = b.lineNumber ?? Number.MAX_SAFE_INTEGER;
    return aLn - bLn;
  });

  for (const base of sortedBase) {
    if (base.lineItemStatus === "CANCELLED") continue;
    if (base.partNo === null) continue; // conservative: can't match → keep ACTIVE

    // First-pass claim: try to consume a matching return slot. A return
    // match means the customer credit-cycled this line. If there's
    // also a matching rewrite line, consume that slot too — the rewrite
    // is the re-billing leg of the same credit cycle, owned by this
    // base line. This is what makes the CHOM1726 case work: the
    // single DELIVERY return + DELIVERY rewrite both belong to the
    // first DELIVERY base line, leaving the second (dropped) one with
    // no claim.
    const matchedReturn = triple.returnLines.find(
      (r) =>
        !consumedReturnIds.has(r.id) &&
        r.partNo === base.partNo &&
        r.orderedQuantity === -base.orderedQuantity,
    );
    if (matchedReturn) {
      consumedReturnIds.add(matchedReturn.id);
      const pairedRewrite = triple.rewriteLines.find(
        (r) => !consumedRewriteIds.has(r.id) && r.partNo === base.partNo,
      );
      if (pairedRewrite) consumedRewriteIds.add(pairedRewrite.id);
      continue;
    }

    // No return match — try a rewrite-only match. This catches price-
    // adjustment rewrites that don't go through a refund cycle.
    const matchedRewrite = triple.rewriteLines.find(
      (r) => !consumedRewriteIds.has(r.id) && r.partNo === base.partNo,
    );
    if (matchedRewrite) {
      consumedRewriteIds.add(matchedRewrite.id);
      continue;
    }

    // No available return/rewrite match. Position check is the final
    // safety net — if the line is within the rewrite's footprint, treat
    // it as a kept-base-line that Ordorite chose not to disturb
    // (unchanged item, sticky fee, etc.). Otherwise it's a drop.
    if (base.lineNumber !== null && base.lineNumber <= rewriteMaxLineNumber) {
      continue;
    }

    droppedIds.push(base.id);
  }

  return droppedIds;
}

/**
 * Back-compat alias for the old `SameDayRewritePair` shape — used by
 * any callers that imported the type before the 2026-05-15 rewrite.
 */
export type SameDayRewritePair = SameDayRewriteTriple;
