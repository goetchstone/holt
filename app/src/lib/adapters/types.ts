// /app/src/lib/adapters/types.ts
//
// The source-adapter seam.
//
// A "source system" is whatever a deployment ran BEFORE holt, and keeps
// running alongside it: a legacy POS, an ERP, a spreadsheet a bookkeeper
// emails every morning. holt pulls from it on a schedule and writes the
// results into its own models.
//
// WHY THIS INTERFACE EXISTS
//
// The Ordorite adapter (lib/adapters/ordorite/) was swappable in *practice* --
// one entry point, one call site -- but there was no TYPE saying so, no
// registry, and nothing a second adapter could implement. "Replaceable" was a
// property you could verify only by reading 5,000 lines and noticing that
// nothing else imported them. That is not a seam; it is a coincidence that
// held so far.
//
// The shape here is deliberately the same as lib/payments/ (PaymentProvider +
// a flat registry with a switch): a second implementation is a registration,
// not an architecture discussion. Both are "one active per deployment, chosen
// by an operator, resolved at the call site."
//
// WHAT AN ADAPTER OWNS, AND WHAT IT DOES NOT
//
// It owns TRANSPORT and TRANSLATION: how to reach the source, how to recognise
// what it sent, how to turn that into holt rows. It does NOT own holt's
// domain rules. When source semantics leak past this boundary -- a stock
// location naming convention read by allocation code, a rewrite-chain notion
// baked into commission -- that is the bug CLAUDE.md rule 61 names, and the
// fix is to move the fact behind this line, not to widen the interface.

/**
 * Result of one import run. Shaped by the Ordorite orchestrator because it was
 * the first implementation, and kept general enough that a second adapter does
 * not have to lie: an adapter that has no notion of "emails" reports zero and
 * describes what it did in `message`.
 */
export interface ImportRunSummary {
  runId: string;
  dryRun: boolean;
  /** Source-side work units consumed (emails, files, API pages). */
  emailsProcessed: number;
  /** Consumed but deliberately not imported (already-seen, empty, filtered). */
  emailsSkipped: number;
  imports: { filename: string; importType: string; status: string; recordCount: number }[];
  errors: string[];
  message?: string;
}

/**
 * Can this adapter run right now? Deliberately separate from `runImport` so
 * the admin page can show "Gmail credentials missing" WITHOUT triggering an
 * import, and so a cron can fail fast with an operator-readable reason instead
 * of a stack trace from four frames inside a Google client.
 *
 * MUST NOT throw. An adapter that cannot even determine its own readiness
 * reports `ready: false` with the reason.
 */
export interface SourceAdapterReadiness {
  ready: boolean;
  /** Operator-readable, and specific: name the setting that is missing. */
  reason?: string;
}

export interface SourceAdapter {
  /** Stable id. Persisted in AppSettings.sourceAdapterId — renaming is a migration. */
  id: string;
  /** Shown in the adapter picker. */
  label: string;
  /** One line: what this connects to, and how. */
  description: string;
  /**
   * Module flag that must be enabled for this adapter to be selectable, or
   * null for adapters that need none. Keeps the existing per-edition module
   * gating working instead of introducing a second, competing switch.
   */
  moduleFlag: string | null;
  /** Never throws. See SourceAdapterReadiness. */
  checkReadiness(): Promise<SourceAdapterReadiness>;
  /** Pull whatever is waiting and import it. May throw; the caller alerts. */
  runImport(opts: { dryRun: boolean; createdBy: string }): Promise<ImportRunSummary>;
}
