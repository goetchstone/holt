// /app/src/lib/serviceCaseLastAction.ts
//
// Pure helper for the ServiceCase list view's "Last Action" column.
//
// Computes: max(case.created, latest note.created)
//
// Intentionally does NOT include `case.updated`. Prisma's `@updatedAt`
// bumps that column on every re-import (the sheet-import runner UPDATEs
// the case row even when nothing semantically changed), which collapses
// every imported row's lastActionAt to today and masks the real signal.
//
// The operator wants to see "when did service activity (opening, or
// a note) last happen on this case" — that's the signal this helper
// captures. User-reported 2026-05-27.

export interface LastActionInput {
  caseCreated: Date;
  /** Optional — the most-recent note's `created`, if any. */
  latestNoteCreated?: Date | null;
}

export function computeLastActionAt(input: LastActionInput): Date {
  const stamps: number[] = [input.caseCreated.getTime()];
  if (input.latestNoteCreated) stamps.push(input.latestNoteCreated.getTime());
  return new Date(Math.max(...stamps));
}

/**
 * Truncate the latest-note text for inline preview on the cases list.
 *
 * Origin: owner direction 2026-05-28 — "maybe we see the last comment on
 * the cases page too?" The cases list shows `lastActionAt` as relative
 * time ("3 days ago"); this helper produces the matching one-line text
 * preview rendered below the timestamp so the operator can see what
 * the last activity was at a glance.
 *
 * Rules:
 *   - Collapses every whitespace run (including newlines) to a single
 *     space so multi-line CSR comments render cleanly in a table cell.
 *   - Truncates to `maxChars` and appends `…` when over the limit.
 *   - Trims leading/trailing whitespace.
 *   - Returns `null` when the input is null / empty / whitespace-only
 *     so the UI can skip rendering the row instead of showing an empty
 *     string.
 */
export function summarizeNoteText(text: string | null | undefined, maxChars = 100): string | null {
  if (!text) return null;
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= maxChars) return collapsed;
  // Try to break on a word boundary inside the last 20% of the budget
  // so we don't chop a word in half. Fall back to a hard cut.
  const softFloor = Math.max(1, Math.floor(maxChars * 0.8));
  const lastSpace = collapsed.lastIndexOf(" ", maxChars);
  const cutAt = lastSpace >= softFloor ? lastSpace : maxChars;
  return collapsed.slice(0, cutAt) + "…";
}

/**
 * Render the `title` attribute for the last-comment preview row.
 * Returns `undefined` when there's no comment text, the bare text when
 * there's no author, and `"author: text"` otherwise. Extracted from
 * the JSX so the nested-ternary stays out of the render path.
 */
export function buildLastActionTitle(
  author: string | null | undefined,
  text: string | null | undefined,
): string | undefined {
  if (!text) return undefined;
  if (!author) return text;
  return `${author}: ${text}`;
}
