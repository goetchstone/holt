// /app/src/lib/dailyReconciliationDisplay.ts
//
// Pure presentation helpers for the reconciliation panel on the journal
// entries admin page. Extracted so the math-of-display (header text,
// CSS class selection, drift highlighting) is unit-testable without
// React Testing Library or a DOM. The JSX itself stays in the page.

import type { DailyReconciliationResult } from "./dailyReconciliation";

export const RECONCILIATION_CATEGORIES = ["revenue", "tax", "cost", "cash"] as const;
export type ReconciliationCategory = (typeof RECONCILIATION_CATEGORIES)[number];

/**
 * Headline text for the reconciliation result panel. "Balanced" if the
 * pure helper said so, otherwise a warning count with grammar-correct
 * pluralization.
 */
export function reconciliationHeader(
  r: Pick<DailyReconciliationResult, "balanced" | "warnings">,
): string {
  if (r.balanced) return "✓ Balanced — JE matches source data";
  const noun = r.warnings.length === 1 ? "warning" : "warnings";
  return `✗ Drift detected (${r.warnings.length} ${noun})`;
}

/**
 * Tailwind class string for the outer panel based on balance state.
 * Green = balanced, amber = drift detected.
 */
export function reconciliationPanelClass(balanced: boolean): string {
  return balanced
    ? "border-green-300 bg-green-50 text-green-900"
    : "border-amber-400 bg-amber-50 text-amber-900";
}

/**
 * Tailwind class for a drift cell. Red + bold when the drift on this
 * category exceeds the penny tolerance, empty string otherwise so the
 * normal cell styling applies.
 *
 * NOTE: tolerance is hard-coded to 0.01 here to match the gate in
 * `compareReconciliation`. If the constant ever moves, this stays in
 * lockstep -- exported so tests can verify the boundary.
 */
export function driftCellClass(driftAmount: number, tolerance: number = 0.01): string {
  return Math.abs(driftAmount) > tolerance ? "text-red-700 font-semibold" : "";
}

// Re-export so the page only has one import for display concerns.
export type { DailyReconciliationResult } from "./dailyReconciliation";
// Tolerance is referenced by tests; pull it through for symmetry.
export { RECONCILIATION_TOLERANCE } from "./dailyReconciliation";
