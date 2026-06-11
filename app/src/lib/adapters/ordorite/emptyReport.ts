// /app/src/lib/adapters/ordorite/emptyReport.ts
//
// An Ordorite daily report with no activity (no temp POs, no receipts that day)
// arrives as an essentially-empty CSV — literally `""\n`. Papa.parse returns
// zero rows AND an `UndetectableDelimiter` error (it can't infer a delimiter
// from an empty file). The Gmail import orchestrator must treat that as a
// no-op SKIP, not a fatal parse error: a fatal error blocks the whole email
// from being marked Processed, so every attachment is re-fetched forever and
// the inbox piles up. Origin: 2026-06-05 — Temp/Received/POR reports failed
// daily (6/1-6/5) with "Unable to auto-detect delimiting character".

interface PapaErrorLike {
  code?: string;
}

/**
 * True when a parsed CSV is an empty/no-activity report that should be skipped
 * rather than treated as a failure. That means zero data rows AND no parse
 * errors other than the benign `UndetectableDelimiter` warning Papa emits on
 * empty input. Any other parse error (real malformation) is NOT skippable and
 * must stay fatal.
 */
export function isSkippableEmptyReport(rowCount: number, papaErrors: PapaErrorLike[]): boolean {
  if (rowCount > 0) return false;
  return papaErrors.every((e) => e.code === "UndetectableDelimiter");
}
