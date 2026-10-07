// /app/src/lib/tillVariance.ts
//
// Till variance discipline (Phase 0.6). Previously "captured, no
// thresholds enforced" per docs/domains/pos.md -- this module is the
// single source of truth for the three thresholds and the pure
// classification logic (CLAUDE.md rule 14: branching logic lives in a
// pure helper, not the route handler; rule 37: thresholds are named
// constants in exactly one file).
//
// Variance = actualCash - expectedCash, computed in
// pages/api/tills/[id]/close.ts (NOT reconcile.ts -- despite the
// pos.md phrasing, reconcile.ts only transitions CLOSED -> RECONCILED
// and never recomputes variance; see that file's comments).
//
// Thresholds apply to the ABSOLUTE VALUE of the variance. A $150
// overage is as much a control failure as a $150 shortage -- an
// overage still means the till doesn't reconcile to recorded sales,
// which can hide a mis-rung sale, an untracked cash movement (see the
// "Cash movements" gap in pos.md), or till-to-till cash contamination.
// No documented reason was found to treat the signs asymmetrically.
//
// Consumers (both close.ts and reconcile.ts need this -- CLAUDE.md
// rule 42, a guard present on one mutation path and missing on
// another is no guard at all):
//   - pages/api/tills/[id]/close.ts       -- computes variance, blocks
//     the close if a mandatory note is missing, escalates + blocks the
//     register in the same transaction that sets status=CLOSED.
//   - pages/api/tills/[id]/reconcile.ts   -- defense-in-depth re-check
//     (manager role is already required for every reconcile via
//     requireAuthWithRole; this only re-validates the note and
//     re-applies the register block if it somehow isn't set yet).
//   - pages/api/registers/[id]/tills/open.ts -- reads Register.blockedAt
//     (set by applyRegisterVarianceBlock) to refuse new opens.

import type { Prisma } from "@prisma/client";

/** Variance strictly greater than this (in dollars, absolute value) requires a note. */
export const TILL_VARIANCE_NOTE_THRESHOLD = 5;

/** Variance strictly greater than this (in dollars, absolute value) requires a manager. */
export const TILL_VARIANCE_MANAGER_THRESHOLD = 20;

/** Variance strictly greater than this (in dollars, absolute value) escalates and blocks the register. */
export const TILL_VARIANCE_ESCALATION_THRESHOLD = 100;

export type TillVarianceLevel = "NONE" | "NOTE" | "MANAGER" | "ESCALATION";

export interface TillVarianceClassification {
  /** Highest control tier triggered by this variance. */
  level: TillVarianceLevel;
  /** abs(variance) > $5 */
  requiresNote: boolean;
  /** abs(variance) > $20 */
  requiresManager: boolean;
  /** abs(variance) > $100 -- register must be blocked for new opens until cleared. */
  blocksRegister: boolean;
}

/**
 * Classify a till's cash variance (actualCash - expectedCash, in
 * dollars) against the three Phase 0.6 thresholds. Pure, no I/O --
 * every threshold check is "strictly greater than" so a variance of
 * exactly $5.00 / $20.00 / $100.00 does NOT yet trigger the next tier.
 */
export function classifyTillVariance(variance: number): TillVarianceClassification {
  const magnitude = Math.abs(variance);

  if (magnitude > TILL_VARIANCE_ESCALATION_THRESHOLD) {
    return { level: "ESCALATION", requiresNote: true, requiresManager: true, blocksRegister: true };
  }
  if (magnitude > TILL_VARIANCE_MANAGER_THRESHOLD) {
    return { level: "MANAGER", requiresNote: true, requiresManager: true, blocksRegister: false };
  }
  if (magnitude > TILL_VARIANCE_NOTE_THRESHOLD) {
    return { level: "NOTE", requiresNote: true, requiresManager: false, blocksRegister: false };
  }
  return { level: "NONE", requiresNote: false, requiresManager: false, blocksRegister: false };
}

/**
 * A note "counts" if it's a non-empty string once trimmed. Shared so
 * close.ts and reconcile.ts agree on what "supplied" means (rule 42).
 */
export function hasVarianceNote(note: string | null | undefined): boolean {
  return typeof note === "string" && note.trim().length > 0;
}

/**
 * Format the standard mandatory-note rejection message. One place so
 * the wording can't drift between close.ts and reconcile.ts.
 */
export function varianceNoteRequiredMessage(variance: number): string {
  return (
    `Variance of $${Math.abs(variance).toFixed(2)} exceeds the ` +
    `$${TILL_VARIANCE_NOTE_THRESHOLD.toFixed(2)} mandatory-note threshold -- ` +
    `a note explaining the variance is required.`
  );
}

/** Minimal client shape this helper needs -- callers pass `prisma` or a `$transaction` tx. */
type RegisterBlockClient = Pick<Prisma.TransactionClient, "register">;

/**
 * Apply (or re-affirm) the register-level block for an escalation-tier
 * variance. Idempotent -- safe to call every time a CLOSED/RECONCILED
 * till is found to have an escalation-level variance, even if the
 * register is already blocked. Records WHICH till and WHEN in
 * `blockReason` since there's no separate escalation-log table
 * (kept additive/minimal per the task -- see docs/domains/pos.md).
 *
 * No-op when the classification doesn't call for a block.
 */
export async function applyRegisterVarianceBlock(
  client: RegisterBlockClient,
  params: {
    registerId: number;
    tillId: number;
    variance: number;
    classification: TillVarianceClassification;
  },
): Promise<void> {
  if (!params.classification.blocksRegister) return;

  const direction = params.variance >= 0 ? "overage" : "shortage";
  await client.register.update({
    where: { id: params.registerId },
    data: {
      blockedAt: new Date(),
      blockReason:
        `Till #${params.tillId} closed with a $${Math.abs(params.variance).toFixed(2)} ${direction}, ` +
        `exceeding the $${TILL_VARIANCE_ESCALATION_THRESHOLD.toFixed(2)} escalation threshold. ` +
        `New till opens are blocked on this register until a manager clears it ` +
        `(POST /api/registers/[id]/unblock).`,
    },
  });
}
