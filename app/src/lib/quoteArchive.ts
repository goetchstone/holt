// /app/src/lib/quoteArchive.ts
//
// Single source of truth for quote archive reasons.
// Both the pipeline UI (ArchiveModal) and the PATCH endpoint
// (/api/sales/pipeline/[id]) must import from here. Do NOT
// duplicate this list anywhere else — drift between client and
// server produced GitHub #111 (archive chip accepted in UI but
// rejected 400 by API, with a generic "Failed to archive" toast).

export const ARCHIVE_REASONS = [
  "Updated Quote",
  "Duplicate",
  "Customer Passed",
  "Stale",
  "Lost to competitor",
  "Customer unresponsive",
  "Budget constraint",
  "No longer interested",
  "Converted to order",
  "Other",
] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

// Reasons that should prompt the user to pick a replacement quote.
export const REPLACEMENT_REASONS: ReadonlySet<ArchiveReason> = new Set([
  "Updated Quote",
  "Duplicate",
]);

export function isValidArchiveReason(value: unknown): value is ArchiveReason {
  return typeof value === "string" && (ARCHIVE_REASONS as readonly string[]).includes(value);
}

/**
 * Pure validator: reasons in REPLACEMENT_REASONS ("Updated Quote", "Duplicate")
 * MUST come with a replacedByOrderId, otherwise we end up with the SO-38985
 * shape -- archived as "Updated Quote" with no link, invisible from any
 * pipeline, hard to recover. Server-side enforcement; the UI may also
 * enforce client-side but the source of truth is the API.
 *
 * Returns { ok: true } when the pair is acceptable, otherwise an error
 * payload suitable for a 400 response. Keeping it pure so the unit test
 * suite covers it without spinning up the endpoint harness.
 */
export function validateArchiveReplacementRequirement(
  reason: string | undefined | null,
  replacedByOrderId: number | null | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!reason || !isValidArchiveReason(reason)) return { ok: true };
  if (!REPLACEMENT_REASONS.has(reason)) return { ok: true };
  if (replacedByOrderId === null || replacedByOrderId === undefined) {
    return {
      ok: false,
      error: `replacedByOrderId is required when archiving with reason "${reason}". Pick the quote that replaces this one (or change the reason to "Customer Passed", "Stale", "Other", etc.).`,
    };
  }
  return { ok: true };
}
