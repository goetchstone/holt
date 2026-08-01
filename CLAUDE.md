# CLAUDE.md — Holt

## Project Overview

Holt is an open-core business management platform for furniture and home-goods
retailers: product catalog and multi-dimensional pricing, inventory and
consignment, sales and purchasing, service dispatch, staff scheduling,
customer intelligence, and reporting. One codebase serves two surfaces — a
public storefront/CMS at `/` and the authenticated back-office at `/app` — and
runs two ways: self-hosted (one organization, one Docker Compose stack) or
multi-tenant SaaS (one organization per customer, centrally hosted). Holt is
its own system of record — there is no upstream POS/ERP it defers to; import
adapters (`src/lib/adapters/`) bring legacy/external data IN, they don't own
the truth.

## How this file relates to the rest of the agent layer

Per `docs/FRAMEWORK.md`: this file is the **constitution** — short, numbered
rules with origins, read every session. Domain detail lives in
`docs/domains/*.md` (read the relevant one before working in that domain).
Activatable procedures live in `.claude/skills/*/SKILL.md`. Hard gates live in
`.claude/hooks/*.sh`, wired by `.claude/settings.json`. Don't duplicate domain
knowledge here — a pointer to the runbook is enough.

**On the numbering below**: this file did not exist as a committed artifact
before this pass — dozens of code comments, tests, and runbooks across the
repo cite `CLAUDE.md rule N` for specific N, but the file itself had never
been committed, so nobody since could read what N actually said. Every rule
below was reconstructed by grepping the repo for its citation context and
cross-checking against `/Users/goetch/work/furniture-configurator/CLAUDE.md`
(the mature sibling constitution Holt derives much of its house style from).
Numbers are preserved exactly as cited — **the list has gaps** where a
neighboring number was never cited anywhere, so nothing was invented to fill
it. A few rules carry a **Conflict** note: two places in the repo cite the
same number for two different ideas. Both readings are named; the text below
is the better-evidenced one, and the gap is flagged for owner review rather
than silently guessed. Full evidence trail for every rule is in the PR
description, not repeated here — keep this file short per the framework's
own guidance.

## Rules

### Engineering Standards

1. **KISS.** Prefer the straightforward solution over the clever one.
   _(Reconstructed — carried over from FC's rule 1; no surviving holt
   citation actually resolves to CLAUDE.md, see PR notes.)_

5. **LTS only is the default state for every runtime and dependency.**
   Never beta/canary/RC/pre-release except to close an active CVE with
   confirmed exposure — document and revert on the next LTS/GA. Majors get
   their own planned session.
   _Origin: FC rule 5. Evidenced: `.github/dependabot.yml`._

6. **Reusable code — one source of truth per concept.** Extract shared
   logic into `src/lib/`; don't duplicate business logic across routes.
   _Origin: FC rule 6. Evidenced: `src/lib/auth/roleDecision.ts`._

7. **Shared client/server contracts live in one place.** Any constant,
   enum, or value list used by both client and server is defined once in
   `src/lib/` and imported by both — contract drift is a compile error, not
   a runtime 400.
   _Origin: FC rule 7 (near-verbatim). Evidenced in 10+ files, e.g.
   `src/lib/integrationCatalog.ts`, `ticketContract.ts`._

### Code Quality & Testing Discipline

11. **Surface backend error messages to the user** via
    `getErrorMessage(err, fallback)`, not a generic "Failed to X."
    _Origin: FC rule 11. Evidenced: `BookingView.tsx`._

12. **Tests must exercise actual behavior.** Real-DB integration tests are
    the default behind Prisma. Source-text tripwires are acceptable only
    for "someone removed the filter" bug classes — never ship a
    mocked-Prisma test as final.
    _Origin: FC rule 12. Evidenced: `__tests__/invoiceAuthoring.test.ts`.
    **Conflict**: `customerLedgerBackfill.test.ts` cites rule 12 for a
    narrower, unrelated claim ("zero-amount events skipped"); kept as code
    comment there instead. Sharpened by rule 57 below._

13. **Restoration migrations derive target values from a column the
    corruption didn't touch — never from a memo.**
    _Origin: FC rule 13 (FC's own `docs/FRAMEWORK.md`, reused verbatim as
    holt's, self-cites this). Evidenced: `docs/domains/import-pipeline.md`.
    **Conflict**: `apiResponse.test.ts` (structured logging) and
    `imports-overview.md` ("gotcha rule 13", barcode non-uniqueness) also
    cite 13 for unrelated ideas — kept as domain-runbook notes instead;
    flagged for owner review._

14. **Test the logic, not the wrapper — lift handler logic into pure
    helpers.** Branching logic (coercion, validation, shaping) belongs in
    testable `lib/*.ts`; handlers shrink to auth + Prisma + error handling.
    _Origin: FC rule 14. Evidenced overwhelmingly (30+ files), e.g.
    `buyerDraftRequestBody.ts`, `timeEntries/duration.ts`._

### Import & Legacy Data Discipline

31. **Zero-quantity source rows are cancelled lines.** Any aggregation,
    count, or import must decide explicitly whether to include or exclude
    `orderedQuantity = 0` rows. Default: exclude.
    _Origin: adapted from FC's Legacy Migration rule (Ordorite →
    generalized "legacy source"). Evidenced: `historicalPoImport.ts` +
    tests, `docs/domains/buyer-drafts.md`._

39. **PO receiving-status recalculation must exclude zero-quantity lines
    from both numerator and denominator** — otherwise a lingering zero-qty
    line traps a PO at `RECEIVED_PARTIAL` forever. Corollary of rule 31.
    _Origin: evidenced directly and repeatedly —
    `src/lib/adapters/ordorite/runners.ts:2902`, `shared.ts:558`,
    `docs/domains/purchasing.md` (all cite the same incident, GitHub #113,
    pre-squash numbering). FC's sibling covers this under a different
    internal number — holt's numbering diverged here._

### Session & Workflow Discipline

18. **Ship the simplest fix to the reported symptom.** Bundle prevention
    layers only when asked. 3+ "also does" items for a single-symptom
    report → ship item 1, spawn the rest.
    _Origin: FC rule 18. Evidenced: `docs/domains/imports-overview.md`,
    `time-tracking.md`._

19. **Domain runbooks must be pinned against source**, not a guess about
    what's plausible — cite source opened this session or write
    `[NEEDS VERIFICATION]`.
    _Origin: FC rule 19. Evidenced: `docs/domains/imports-overview.md`._

36. **Read before working, update after learning.** Read CLAUDE.md + the
    relevant domain runbook before touching that domain; update the
    runbook before closing the session.
    _Origin: FC rule 36. Evidenced: `docs/WORKFLOW.md`,
    `.github/pull_request_template.md`, `session-start-check.sh`._

45. **Trace before refactoring shared infrastructure.** A "mechanical"
    change to auth/payments/import runners/uploads needs a `grep -rn` for
    callers in the PR, proving the surface is disjoint or tested.
    _Origin: FC rule 45. Evidenced: `docs/WORKFLOW.md`,
    `.github/pull_request_template.md` ("## Trace (Rule 45)")._

48. **Every scan finding has exactly three terminal states: fixed,
    tripwire-tested, or explicitly won't-fix with rationale.** No
    silent-ignore. Local gate evaluated before every push, docs-only
    included.
    _Origin: FC rule 48. Evidenced: `docs/domains/buyer-drafts.md`,
    `.github/pull_request_template.md` ("## Sonar / scans (Rule 48)")._

49. **Self-heal as you go.** Fixing a bug shape → grep for it elsewhere.
    Mechanical sweep → fix all sites in the same PR with one shared-helper
    regression test. Non-mechanical → ship the targeted fix, spawn tasks
    for the rest.
    _Origin: FC rule 49 ("Self-heal as you go"). Evidenced verbatim:
    `.markdownlint.json` header ("per CLAUDE.md rule 49
    self-heal-as-you-go"). **Conflict**: `detailedSalesVendorPivot.test.ts`
    cites 49 for an unrelated claim (vendor join required on pivot select);
    kept as a `docs/domains/reporting.md` note instead._

50. **Deferred work goes into a tracked plan — never just verbal.** A
    spawned task chip or `ROADMAP.md` entry; the PR body says where.
    _Origin: FC rule 50. Evidenced: `balanceAging.integration.test.ts`._

### Money & Reporting Invariants

33. **Reports/aggregations must exclude cancelled lines** —
    `lineItemStatus: { not: "CANCELLED" }` on every sum/count. No
    exceptions.
    _Origin: FC rule 33 (near-verbatim). Evidenced massively, 50+ files
    across `src/lib/reports/*` and `docs/domains/reporting.md`._

37. **A catalog of business-rule definitions (report tiles, dashboard
    segments) lives in exactly one file**; every consumer imports from it.
    _Origin: holt-only evidence, no distinct FC counterpart (specialization
    of rule 6/7). Evidenced: `src/lib/opportunityTiles.ts`,
    `docs/domains/reporting.md`._

40. **Status is a broad hammer — don't fix reporting symptoms by mutating
    status.** A status field is read by many reports at once; fix a bad
    import at the import boundary, don't patch the symptom by mutating
    good rows.
    _Origin: FC rule 40 (near-verbatim). Evidenced: `sales-orders.md`,
    `import-pipeline.md`, `docs/WORKFLOW.md`._

41. **Defaults and thresholds must be grounded in production data — and
    boundary cases hand-classified before shipping.** For any cutoff
    (percentage/ratio/count), list the near-boundary cases and classify
    each; an aggregate-only check hides cases that split both ways.
    _Origin: FC rule 41. Evidenced with an explicit same-number
    acknowledgment: `homeAccessoryOrders.ts` ("per FC's rule 41 backing").
    Also `BuyersReportView.tsx`, `docs/domains/reporting.md`._

42. **A safety guard is enforced through ONE shared function on every
    mutation path that needs it** — present on one runner, missing on
    another, is no guard at all.
    _Origin: evidenced directly — `payPeriodLockGuard.ts`,
    `docs/domains/commission.md` ("rule 42 — a guard on one path but not
    another is how SO-39275 recurred"); present unnumbered in FC's
    Cross-Cutting Money Invariants. **Note**: FC's own sequential numbering
    would place a different rule (import-runner behavior tests) at 42;
    holt's repeated direct citation is kept. Flagged for review._

47. **Revenue queries must include RETURNED orders** —
    `status: { in: SALES_REVENUE_STATUSES }` (`ORDER`, `FULFILLED`,
    `RETURNED`). Sister rule to 33: that governs `lineItemStatus`
    (cancelled OUT), this governs `SalesOrder.status` (RETURNED IN).
    _Origin: evidenced directly — `frameSalesHistory.ts`,
    `reports.salesRevenueStatusFilter.test.ts` ("sister rule to CLAUDE.md
    rule 33"); present unnumbered in FC's Money Invariants right after the
    cancelled-lines bullet. **Conflict**: FC's own `pre-pr` skill numbers a
    different rule 47 ("don't relitigate user-empirical claims"). Holt's
    direct code-level citation is kept; flagged for review._

51. **Nullable columns: never use a naked `not:`/`notIn:` filter** —
    Postgres three-valued logic drops NULL rows silently. Pattern:
    `OR: [{ col: null }, { col: { not: "X" } }]`.
    _Origin: FC rule 51 (verbatim quote match). Evidenced massively:
    `imports-overview.md` quotes it verbatim, `balanceAging.ts` + tests._

### Dependency & CI Hygiene — learned 2026-07

52. **Verify a dependency/lockfile change with `npm ci`, never `npm
    install`.** CI installs clean from the lockfile; an incremental
    install can hide a breakage that only shows on a clean install.
    _Origin: 2026-07-25 — a `minimatch` override "verified" with
    `npm install` passed locally, then failed CI with `TypeError: minimatch
    is not a function` across the whole unit suite._

53. **Never blanket-override a package with incompatible major lines.**
    Use version-scoped (`npm pkg@1`) or path-scoped (pnpm
    `minimatch@10>brace-expansion`) overrides instead.
    _Origin: same incident — `brace-expansion` 1.x exports a bare function,
    2.x+ use named exports, and `@babel/core`/istanbul call it as a
    function; a blanket override broke coverage tooling._

54. **A CVE suppression needs an expiry and a re-verified reason.**
    `osv-scanner.toml` entries carry `ignoreUntil`; on expiry, re-verify
    the rationale against the CURRENT tree before renewing.
    _Origin: 2026-07-24 — the xlsx suppressions expired and correctly
    blocked a push; re-verification confirmed `package.json` still
    installs from the patched SheetJS CDN tarball._

55. **Sweep CVEs before starting a merge train.** New advisories publish
    continuously and turn the gate red for reasons unrelated to any
    pending PR — land the sweep first, then rebase the train.
    _Origin: three separate merge trains were blocked this way in one
    session before the ordering was fixed._

### Verification & Honesty Discipline — learned 2026-07/08

56. **Verify claims against code, not docs.** Docs drift; source can't
    lie about its own current state.
    _Origin: an accounting gap table listed C1 daily reconciliation as
    "next" when `lib/dailyReconciliation.ts` had long shipped._

57. **Prefer behavioural tests over source-text tripwires where the
    behaviour is testable.** Tripwires remain correct for "this guard must
    exist everywhere" invariants (rule 12) — the failure mode is using one
    where a real assertion was possible.
    _Origin: `stripeLedgerWiring.test.ts` grepped source strings and went
    stale the moment payments moved behind a provider seam._

58. **Report unverifiable work as unverified.** If a claim can't be
    exercised in this environment, say so — don't imply it was tested.
    _Origin: TLS/certbot config couldn't be exercised without a real
    domain; the PR said so instead of implying it was tested._

### Data Safety

59. **Local database safety.** `fbc_test_db` is the only database tests
    may write. `saybrook`, `holt_saybrook`, and `akritos` hold
    restored/seeded data and must never be written by a test or script —
    `resetTestDb()`'s "DATABASE_URL must contain 'test'" guard
    (`src/lib/testing/withTestDb.ts`) is the floor, not a substitute for
    pointing at the right database.
    _Origin: this session._

60. **Route by recorded fact, not current config.** Refunds/webhooks
    resolve the processor from the payment's own stored `processorType`,
    never from whichever provider is currently active.
    _Origin: this session, the payment-provider seam work._

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16, **App Router** (Pages Router → App Router migration complete; Pages Router retained only for `auth/login` + `src/pages/api/**` REST routes) |
| API layer | tRPC (`src/server/trpc/`) for typed reads/writes from App Router views; REST (`src/pages/api/`) for exports, webhooks, uploads, cross-domain shared endpoints |
| Language | TypeScript |
| Database | PostgreSQL 17 |
| ORM | Prisma |
| Auth | NextAuth (Google OAuth, JWT sessions) |
| Styling | Tailwind CSS |
| Testing | Jest (`unit` + `integration` projects), combined coverage gate |
| Container | Docker Compose (app + PostgreSQL + Nginx) |

## CI Gates

Every code PR: **Lint / Typecheck / Format / Test** (`ci.yml`), **Semgrep**
static analysis, and **osv-scanner** dependency CVE scan (`security.yml`,
path-conditional on lockfile changes). Coverage is a **combined unit +
integration gate** (`app/scripts/test-coverage.sh` merges both Jest
projects' coverage before enforcing thresholds — a project-only threshold
erodes every time logic moves from a mocked unit test to a real-DB
integration test). See `docs/CI-OPERATIONS.md` for the full shape and
`docs/WORKFLOW.md` for the branch → PR → green → merge lifecycle. **Never
push to `main` directly** — every change, including one-line fixes, goes
through a branch + PR.

## Domain Runbooks

Read the matching runbook in `docs/domains/` before working in that domain.
The map from source path to runbook lives in `.claude/hooks/domain-map.txt`
(the `pre-pr-check.sh` hook enforces a runbook touch on substantial code
changes). Full list: `docs/domains/*.md`.

## Tenancy

Holt is **single-organization per deployment** by design — see
`docs/TENANCY.md`. A database only ever contains one tenant's rows, so the
cross-tenant IDOR class does not apply to the retail-core models. Role gates
on mutations, capability tokens on public surfaces, and the deployment
perimeter itself are the real security boundaries. Models born in the
white-label layer (CMS, Bookings, Tickets, TimeEntries, Services,
EmailQueue, authored Invoices) already carry `organizationId` and keep the
door open for shared-database SaaS mode without retrofitting.
