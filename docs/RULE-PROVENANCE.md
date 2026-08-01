# Rule provenance

Where each rule in `CLAUDE.md` came from, and which numbers are contested.

**Why this file exists separately.** The constitution is read every session, so
it stays short (per `docs/FRAMEWORK.md`: move detail out, leave the rule). This
archaeology matters when a rule's origin is in question — not on every read.

## How the rules were recovered

`CLAUDE.md` was never a committed artifact. Dozens of code comments, tests and
runbooks cite `CLAUDE.md rule N`, but the file itself was excluded by
`.gitignore`, so no one could read what N said. Each rule was reconstructed by
grepping the repo for its citation context and cross-checking against the mature
sibling constitution in the furniture-configurator repo, which Holt derives much
of its house style from.

**Numbers are preserved exactly as cited, and the list has gaps.** Where no
citation resolved to a number, nothing was invented to fill it. Missing: 2–4,
8–10, 15–17, 20–30, 32, 34–35, 38, 43–44, 46.

## Contested numbers — owner review wanted

Five numbers are cited in this repo for two different ideas. The better-evidenced
reading is what `CLAUDE.md` carries; the alternative is recorded here. If you
remember the original intent, this is the list to settle.

| # | Rule as adopted | Competing citation |
|---|---|---|
| 12 | Tests exercise actual behaviour | `customerLedgerBackfill.test.ts` cites 12 for "zero-amount events are skipped" — kept as a code comment there |
| 13 | Restoration migrations derive from an uncorrupted column | `apiResponse.test.ts` (structured logging) and `imports-overview.md` ("barcode non-uniqueness") also cite 13 — kept as runbook notes |
| 42 | One shared guard on every mutation path | The sibling repo's sequential numbering would place a different rule (import-runner behaviour tests) at 42; Holt's repeated direct citation won |
| 47 | Revenue queries include RETURNED | The sibling repo's `pre-pr` skill numbers a different rule 47 ("don't relitigate user-empirical claims"); Holt's code-level citation won |
| 49 | Self-heal as you go | `detailedSalesVendorPivot.test.ts` cites 49 for "vendor join required on pivot select" — kept as a `reporting.md` note |

**Rule 1 (KISS)** has no surviving Holt citation at all — it is carried by
convention from the sibling constitution. Delete it if you disagree; nothing
depends on it.

**Rule 37** is evidenced only in Holt, with no sibling counterpart. It reads as a
specialization of rules 6 and 7.

## Origins

Rules recovered from the sibling constitution, evidenced in this repo:

| # | Evidence in this repo |
|---|---|
| 5 | `.github/dependabot.yml` |
| 6 | `src/lib/auth/roleDecision.ts` |
| 7 | `src/lib/integrationCatalog.ts`, `ticketContract.ts`, 10+ files |
| 11 | `BookingView.tsx` |
| 12 | `__tests__/invoiceAuthoring.test.ts` |
| 13 | `docs/domains/import-pipeline.md` |
| 14 | `buyerDraftRequestBody.ts`, `timeEntries/duration.ts`, 30+ files |
| 18 | `docs/domains/imports-overview.md`, `time-tracking.md` |
| 19 | `docs/domains/imports-overview.md` |
| 33 | `src/lib/reports/*`, `docs/domains/reporting.md`, 50+ files |
| 36 | `docs/WORKFLOW.md`, `.github/pull_request_template.md` |
| 40 | `sales-orders.md`, `import-pipeline.md` |
| 41 | `homeAccessoryOrders.ts` (explicit same-number acknowledgment), `BuyersReportView.tsx` |
| 45 | `.github/pull_request_template.md` ("## Trace (Rule 45)") |
| 48 | `.github/pull_request_template.md` ("## Sonar / scans (Rule 48)") |
| 49 | `.markdownlint.json` header, verbatim |
| 50 | `balanceAging.integration.test.ts` |
| 51 | `imports-overview.md` quotes it verbatim; `balanceAging.ts` |

Rules evidenced only in Holt:

| # | Evidence |
|---|---|
| 31 | `historicalPoImport.ts` + tests, `docs/domains/buyer-drafts.md` |
| 37 | `src/lib/opportunityTiles.ts`, `docs/domains/reporting.md` |
| 39 | `adapters/ordorite/runners.ts`, `shared.ts`, `docs/domains/purchasing.md` |
| 42 | `payPeriodLockGuard.ts`, `docs/domains/commission.md` |
| 47 | `frameSalesHistory.ts`, `reports.salesRevenueStatusFilter.test.ts` |

## Rules 52–60 — learned 2026-07

Each came from a specific failure in one working session.

| # | Origin |
|---|---|
| 52 | A `minimatch` override "verified" with `npm install` passed locally, then failed CI with `TypeError: minimatch is not a function` across the whole unit suite. The incremental install had a different tree than a clean one. |
| 53 | Same incident. `brace-expansion` 1.x exports a bare function; 2.x+ use named exports; `@babel/core` and istanbul call it as a function. A blanket override broke the coverage tooling. |
| 54 | The xlsx suppressions in `osv-scanner.toml` reached their `ignoreUntil` and correctly blocked a push. Re-verification confirmed the rationale still held — `package.json` still installs from the patched SheetJS CDN tarball — so the entry was renewed with the re-review recorded. A permanent ignore would have carried a stale claim indefinitely. |
| 55 | Three separate merge trains were blocked by freshly published advisories before the ordering was fixed: sweep first, then rebase the train. |
| 56 | The accounting gap table listed C1 daily reconciliation as "next" when `lib/dailyReconciliation.ts` had long since shipped. |
| 57 | `stripeLedgerWiring.test.ts` asserted against source text and went stale the moment payments moved behind a provider seam. It was replaced with behavioural tests against a fake provider. |
| 58 | The TLS/certbot configuration could not be exercised without a real domain and certificate. The PR said so rather than implying it was tested. |
| 59 | Local databases `saybrook`, `holt_saybrook` and `akritos` hold restored production-shaped and seeded data alongside the test database. |
| 60 | The payment-provider seam: an organization switching processors must still refund historical payments through the processor that captured them. |
