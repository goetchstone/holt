# CLAUDE.md — Holt

Holt is an open-core business management platform for furniture and home-goods
retailers: catalog and multi-dimensional pricing, inventory and consignment,
sales and purchasing, service dispatch, scheduling, customer intelligence, and
reporting. One codebase serves a public storefront/CMS at `/` and the
authenticated back-office at `/app`. **Holt is its own system of record** —
import adapters (`src/lib/adapters/`) bring external data in; they don't own the
truth.

## The agent layer

Per `docs/FRAMEWORK.md`, this file is the **constitution**: short numbered rules,
read every session. Detail lives elsewhere, and this file points at it rather
than repeating it.

| Layer | Where | When to read |
|---|---|---|
| Constitution | this file | every session |
| Domain runbooks | `docs/domains/*.md` | before working in that domain |
| Decisions already settled | `docs/DECISIONS.md` | before proposing a structural change |
| Procedures | `.claude/skills/*/SKILL.md` | at the moment they apply |
| Hard gates | `.claude/hooks/*.sh` | enforced automatically |
| Rule provenance + conflicts | `docs/RULE-PROVENANCE.md` | when a rule's origin matters |

**Numbering has gaps.** Rules were reconstructed from citations across the repo;
where no citation resolved to a number, nothing was invented. Five numbers have
conflicting citations — see `docs/RULE-PROVENANCE.md`.

## Rules

### Engineering standards

1. **KISS.** Prefer the straightforward solution over the clever one.
5. **LTS only** for every runtime and dependency. Pre-release only to close an
   active CVE with confirmed exposure — document it, revert on the next GA.
   Majors get their own planned session.
6. **One source of truth per concept.** Shared logic lives in `src/lib/`.
7. **Shared client/server contracts live in one file** and are imported by both
   sides, so contract drift is a compile error rather than a runtime 400.

### Code quality and testing

11. **Surface backend error messages** via `getErrorMessage(err, fallback)`,
    never a generic "Failed to X."
12. **Tests exercise actual behaviour.** Real-DB integration tests are the
    default behind Prisma. Source-text tripwires are for "someone removed the
    guard" classes only. See also rule 57.
13. **Restoration migrations derive values from a column the corruption didn't
    touch** — never from a memo. → `docs/domains/import-pipeline.md`
14. **Test the logic, not the wrapper.** Branching logic belongs in pure
    helpers in `lib/`; handlers shrink to auth, Prisma, and error handling.

### Money and reporting invariants

The highest-consequence cluster in the codebase. Detail and worked examples:
→ `docs/domains/reporting.md`, `docs/domains/accounting.md`

33. **Exclude cancelled lines from every sum and count** —
    `lineItemStatus: { not: "CANCELLED" }`. No exceptions.
37. **Business-rule definition catalogs live in exactly one file**; every
    consumer imports from it.
40. **Status is a broad hammer.** Fix a bad import at the import boundary; never
    patch a reporting symptom by mutating status on good rows.
41. **Ground defaults and thresholds in production data**, and hand-classify the
    near-boundary cases before shipping — an aggregate-only check hides cases
    that split both ways.
42. **A safety guard is one shared function on every mutation path that needs
    it.** Present on one path and missing on another is no guard at all.
    → `docs/domains/commission.md`
47. **Revenue queries include RETURNED orders** —
    `status: { in: SALES_REVENUE_STATUSES }`. Sister rule to 33: that one
    governs `lineItemStatus` (cancelled out), this governs `SalesOrder.status`
    (returned in).
51. **Never use a naked `not:`/`notIn:` on a nullable column** — three-valued
    logic drops NULL rows silently. Use `OR: [{ col: null }, { col: { not: X } }]`.
60. **Route by recorded fact, not current config.** Refunds and webhooks resolve
    the processor from the payment's stored `processorType`, never from whichever
    provider is active now.

### Imports and legacy data

→ `docs/domains/import-pipeline.md`, `docs/domains/imports-overview.md`

31. **Zero-quantity source rows are cancelled lines.** Every aggregation decides
    explicitly whether to include them. Default: exclude.
39. **PO receiving-status recalculation excludes zero-quantity lines from both
    numerator and denominator** — otherwise a lingering zero-qty line traps a PO
    at `RECEIVED_PARTIAL` forever. Corollary of 31.
    → `docs/domains/purchasing.md`

### Session and workflow discipline

→ `docs/WORKFLOW.md`, and the `pre-pr` / `pre-commit` skills

18. **Ship the simplest fix to the reported symptom.** Bundle prevention layers
    only when asked; spawn the rest.
19. **Runbooks are pinned against source**, not plausibility — cite source
    opened this session or write `[NEEDS VERIFICATION]`.
36. **Read before working, update after learning.** Read the domain runbook
    before touching a domain; update it before closing the session.
45. **Trace before refactoring shared infrastructure.** A "mechanical" change to
    auth, payments, import runners, or uploads carries a `grep -rn` for callers
    in the PR.
48. **Every scan finding ends in one of three states:** fixed, tripwire-tested,
    or explicitly won't-fix with rationale. Never silent-ignore.
49. **Self-heal as you go.** Fixed a bug shape → grep for it elsewhere.
    Mechanical sweep → fix every site in the same PR with one regression test.
50. **Deferred work goes into a tracked plan**, never a verbal promise. The PR
    body says where.

### Dependencies and CI hygiene

Full playbook: → `.claude/skills/dependency-sweep/SKILL.md`

52. **Verify dependency and lockfile changes with `npm ci`, never `npm
    install`.** CI installs clean from the lockfile; an incremental install
    hides breakage that only appears on a clean one.
53. **Never blanket-override a package with incompatible major lines.** Use
    version-scoped (`pkg@1`) or path-scoped (`minimatch@10>brace-expansion`)
    overrides.
54. **A CVE suppression needs an expiry and a re-verified reason.** On expiry,
    re-verify the rationale against the *current* tree before renewing.
55. **Sweep CVEs before starting a merge train.** New advisories turn the gate
    red for reasons unrelated to any pending PR.

### Verification and honesty

56. **Verify claims against code, not docs.** Docs drift; source cannot lie
    about its own current state.
57. **Prefer behavioural tests over source-text tripwires** where the behaviour
    is testable. Tripwires stay correct for "this guard must exist everywhere"
    invariants — the failure mode is using one where a real assertion was
    possible.
58. **Report unverifiable work as unverified.** If a claim can't be exercised in
    this environment, say so rather than implying it was tested.

### Data safety

59. **`fbc_test_db` is the only database tests may write.** `saybrook`,
    `holt_saybrook`, and `akritos` hold restored or seeded data and must never
    be written by a test or script. The `DATABASE_URL must contain 'test'` guard
    in `src/lib/testing/withTestDb.ts` is a floor, not a substitute for pointing
    at the right database.

## Stack and gates

Next.js 16 (App Router; Pages Router retained for `auth/login` and
`src/pages/api/**` REST), tRPC for typed reads/writes, TypeScript, PostgreSQL 17,
Prisma, NextAuth, Tailwind, Jest (`unit` + `integration`), Docker Compose.
Architecture detail: → `docs/ARCHITECTURE.md`

Every code PR must pass **Lint/Typecheck/Format/Test**, **Semgrep**, and the
**osv-scanner** CVE scan. Coverage is a combined unit + integration gate.
**Never push to `main`** — every change goes through a branch and PR.
→ `docs/CI-OPERATIONS.md`, `docs/WORKFLOW.md`

## Tenancy

Single-organization per deployment: one database only ever holds one tenant's
rows, so the cross-tenant IDOR class does not apply to retail-core models. The
real boundaries are role gates on mutations, capability tokens on public
surfaces, and the deployment perimeter. → `docs/TENANCY.md`
