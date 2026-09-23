# CLAUDE.md — Holt

Holt is an open-core business management platform for furniture and home-goods
retailers: catalog and multi-dimensional pricing, inventory and consignment,
sales and purchasing, service dispatch, scheduling, customer intelligence, and
reporting. One codebase serves a public storefront/CMS at `/` and the
authenticated back-office at `/app`. **Holt is its own system of record** —
import adapters (`src/lib/adapters/`) bring external data in; they don't own the
truth.

## The agent layer

Per `docs/FRAMEWORK.md`, this file is the **constitution**, read every session.
Detail lives elsewhere, and this file points at it rather than repeating it.

| Layer | Where | When to read |
|---|---|---|
| Constitution | this file | every session |
| Domain runbooks | `docs/domains/*.md` | before working in that domain |
| Decisions already settled | `docs/DECISIONS.md` | before proposing a structural change |
| Procedures | `.claude/skills/*/SKILL.md` | at the moment they apply |
| Hard gates | `.claude/hooks/*.sh` | enforced automatically |
| Rule provenance + conflicts | `docs/RULE-PROVENANCE.md` | when a rule's origin matters |
| How rules change | `.claude/skills/improve-rules/SKILL.md` | when the ledger has accumulated |

## How to read this file

**Principles are the spine; rules are the instances.** Each principle names a
way this system fails, general enough that you can recognise a NEW instance
before it ships. Beneath it sit the numbered rules that earned it — each one a
specific incident, stated in the exact operational terms that make it
checkable.

Read the principles to know what to look for. Read the rule under it for what
to actually write. **The rule text is the enforceable one** — where a principle
and a rule seem to differ, the rule wins, because the rule is what the hooks,
tripwires and code comments cite.

**Numbers are permanent.** 203 files cite rules by number; rule 33 alone is
cited 65 times. A number is never reused, never renumbered, and never removed
while anything cites it — a rule that stops earning a constitutional slot is
demoted to its runbook with the number preserved so the citation still
resolves. Numbering has gaps because rules were reconstructed from citations
and nothing was invented to fill them. Five numbers have conflicting citations
— see `docs/RULE-PROVENANCE.md`.

**Rules earn their place by surviving incidents** (`docs/FRAMEWORK.md`). A rule
with no incident behind it is a preference, and preferences do not belong here.
That is also the test for adding one — see "Changing this file" at the end.

## Principles

### 1. NULL is an escape hatch, not a value

A nullable column is neither equal nor unequal to anything, so a row holding
NULL escapes a negative filter and never matches a unique key. Any predicate or
key touching a nullable column must name NULL explicitly, or it silently means
something other than what it reads as.

**How it hides:** the code says what you meant. It compiles, it reads correctly,
and only the database disagrees. On the read side the total is merely low; on
the write side an operation meant to converge instead inserts a fresh row every
run.

51. **Never use a naked `not:`/`notIn:` on a nullable column** — three-valued
    logic drops NULL rows silently. Use `OR: [{ col: null }, { col: { not: X } }]`.
64. **Never upsert through a compound unique key containing a nullable column.**
    Postgres treats NULLs as DISTINCT in a unique index unless it is declared
    `NULLS NOT DISTINCT` — none of ours are. So the constraint does not prevent
    duplicate rows, and the upsert never matches: it creates another row every
    time. Use `findFirst` + increment-or-create with an explicit `col: null`.
    `InventoryPosition`'s key has two nullable columns and shipped with exactly
    this bug in both `allocate` and `release`; free stock would have multiplied
    on every cancel. **Tell:** if you need `null as unknown as number` to make
    an upsert compile, the operation is invalid, not the types.

### 2. An aggregate must declare its population

A row's presence in a table is not a claim that it counts. Every sum, count and
status recalculation states which rows it includes — in numerator and
denominator alike — or it silently answers a different question than the one
asked. Note the two directions are opposite and both are errors: cancelled
lines must come **out**, returned orders must stay **in**.

**How it hides:** the number stays plausible. Nothing in the system knows the
right answer to compare against, so a total that is confidently wrong by a
believable margin survives indefinitely.

The highest-consequence cluster in the codebase. Detail and worked examples:
→ `docs/domains/reporting.md`, `docs/domains/accounting.md`

31. **Zero-quantity source rows are cancelled lines.** Every aggregation decides
    explicitly whether to include them. Default: exclude.
33. **Exclude cancelled lines from every sum and count** —
    `lineItemStatus: { not: "CANCELLED" }`. No exceptions.
39. **PO receiving-status recalculation excludes zero-quantity lines from both
    numerator and denominator** — otherwise a lingering zero-qty line traps a PO
    at `RECEIVED_PARTIAL` forever. Corollary of 31.
    → `docs/domains/purchasing.md`
40. **Status is a broad hammer.** Fix a bad import at the import boundary; never
    patch a reporting symptom by mutating status on good rows.
41. **Ground defaults and thresholds in production data**, and hand-classify the
    near-boundary cases before shipping — an aggregate-only check hides cases
    that split both ways.
47. **Revenue queries include RETURNED orders** —
    `status: { in: SALES_REVENUE_STATUSES }`. Sister rule to 33: that one
    governs `lineItemStatus` (cancelled out), this governs `SalesOrder.status`
    (returned in).

### 3. A guard on one path is no guard

An invariant that must hold at more than one site is only as strong as the site
you forgot. Enumerate the set mechanically — callers, mutation paths, models,
routes — put the invariant in one shared function, and add a check that fails
when the enumeration and reality disagree.

**How it hides:** the reported path gets fixed and the duplicate-shaped path
does not, so the symptom returns days later through a different route and reads
as a new bug. No test catches it, because the uncovered site is the one nobody
listed.

42. **A safety guard is one shared function on every mutation path that needs
    it.** Present on one path and missing on another is no guard at all.
    → `docs/domains/commission.md`
45. **Trace before refactoring shared infrastructure.** A "mechanical" change to
    auth, payments, import runners, or uploads carries a `grep -rn` for callers
    in the PR.
49. **Self-heal as you go.** Fixed a bug shape → grep for it elsewhere.
    Mechanical sweep → fix every site in the same PR with one regression test.
65. **Anything countable gets a manifest and a tripwire.** When the repo has a
    set of things that must stay covered — every model seeded, every migration
    guard applied, every route gated — do not rely on noticing. Write down the
    complete set with each item classified, and add a check that fails when
    reality disagrees. The pattern is always the same three parts:

    - **A manifest that is exhaustive.** Every member of the set appears, with a
      status. An item that is deliberately excluded carries a **reason**, and
      the check enforces that the reason exists. "Skipped" without a reason is
      indistinguishable from "forgotten", which is the failure this prevents.
    - **A check that fails in BOTH directions.** Something claimed covered that
      isn't is a regression. Something covered that the manifest still lists as
      outstanding is a stale manifest, and it lies about how much work is left.
      Both must fail, or the manifest drifts in whichever direction is unwatched.
    - **A gate that runs unattended.** In CI, on a real artifact. A check nobody
      runs is a comment.

    Prove the tripwire in both directions before trusting it: reintroduce the
    problem, watch it fail, restore, watch it pass. A tripwire only ever seen
    passing is not evidence — see rule 56.

    Existing instances to copy: `prisma/seed/coverage.ts` +
    `__tests__/seedCoverage.test.ts` + `npm run seed:coverage`;
    `prisma/testing/db-guards.sql` + `__tests__/dbGuardsCoverage.test.ts`;
    `__tests__/schemaNormalization.test.ts` (text-beside-its-own-FK columns, each
    accepted pair carrying the measurement that justified it);
    `__tests__/fixtures/ungated-read-api-routes.txt`;
    `__tests__/clientDataTripwire.test.ts` (patterns base64-encoded — a guard
    listing a real company's identifiers in plaintext is itself the leak).

    A ratchet beats a cleanup. Where the debt is real but removing it is not
    worth it today, freeze the set and require a written argument to grow it —
    the schema-normalization test accepts thirteen existing pairs and fails on
    the fourteenth. Where a set is split into
    units of work, name them — a named unit is delegable; "the rest of the gap"
    is not.

### 4. Verify with an instrument that can disagree

A check counts as evidence only if it was structurally capable of failing for
the real reason. A mock returns what you stubbed; an incremental install is not
the clean tree CI builds; a source-text scan agrees as long as the text is
there. Each is a proxy — fine where the proxy is the point, wrong where it
stands in for the thing that ships.

**How it hides:** green. The signal you look at cannot contradict you, so
confidence rises exactly as the evidence stops meaning anything.

Note this does not demote tripwires generally — rule 65 requires them for
coverage sets. The failure is using one where a real assertion was possible,
and never proving it can fail.

12. **Tests exercise actual behaviour.** Real-DB integration tests are the
    default behind Prisma. Source-text tripwires are for "someone removed the
    guard" classes only. See also rule 57.
14. **Test the logic, not the wrapper.** Branching logic belongs in pure
    helpers in `lib/`; handlers shrink to auth, Prisma, and error handling.
52. **Verify dependency and lockfile changes with `npm ci`, never `npm
    install`.** CI installs clean from the lockfile; an incremental install
    hides breakage that only appears on a clean one.
57. **Prefer behavioural tests over source-text tripwires** where the behaviour
    is testable. Tripwires stay correct for "this guard must exist everywhere"
    invariants — the failure mode is using one where a real assertion was
    possible.

### 5. A claim is exactly as strong as its evidence

Never stronger than what was verified, never weaker than what is already known.
This governs messages on screen, lines in runbooks, and sentences in a PR body
alike.

**How it hides:** the claim is the only artifact, and it does not drift when
reality does. Nobody gets a signal that it went false — they just act on it.

11. **Surface backend error messages** via `getErrorMessage(err, fallback)`,
    never a generic "Failed to X." (The under-claiming direction: a catch that
    renders "Failed to save" discards a backend message that said precisely
    what was wrong.)
19. **Runbooks are pinned against source**, not plausibility — cite source
    opened this session or write `[NEEDS VERIFICATION]`.
56. **Verify claims against code, not docs.** Docs drift; source cannot lie
    about its own current state.
58. **Report unverifiable work as unverified.** If a claim can't be exercised in
    this environment, say so rather than implying it was tested.

### 6. One home per fact

A fact with two homes has one home and one copy, and the copy is wrong in
whichever direction nobody looked.

**How it hides:** both copies were right when written. Drift is invisible until
the two are compared, and nothing compares them.

6. **One source of truth per concept.** Shared logic lives in `src/lib/`.
7. **Shared client/server contracts live in one file** and are imported by both
   sides, so contract drift is a compile error rather than a runtime 400.
37. **Business-rule definition catalogs live in exactly one file**; every
    consumer imports from it. (Specialisation of 6 and 7 for enum-like
    catalogs — `permissionCatalog`, the runner registry,
    `SALES_REVENUE_STATUSES`.)

### 7. Deployment facts are configuration

Anything true of one deployment and not of the product is data, not code. This
is the rule the codebase violates most often and most quietly, because a
hardcoded literal works perfectly for the deployment it was written for.

**How it hides:** it is correct — for one tenant. The second deployment does not
error; it silently routes to the wrong runner, classifies an ordinary order as a
return, or imports nothing and logs "skipped".

→ `docs/domains/import-pipeline.md`, `docs/domains/imports-overview.md`,
`docs/domains/config-presets.md`

61. **Deployment facts are config, not code.** Store names, vendor payment
    codes, column mappings — anything true of one deployment and not the
    product — belongs in a `config/` preset or a database row, never in a
    literal in `src/`. If you are about to add a `Record<string, string>` of
    real-world names, you want a preset.
62. **Config selects behaviour; it never supplies it.** A preset may name a
    `runnerKey` from the compile-time registry. It may not carry an
    expression, a conditional, or a computed value — that is an RCE surface
    wearing a config file's clothes. When a mapping needs logic, it needs a
    runner, and a runner goes through review.
63. **Applying a preset is idempotent and declarative.** Compute the diff
    before writing; a second apply must write nothing. A preset is desired
    state, so a mapping deleted from the file is deleted from the database.

    **Unconfigured must fail closed, not guess.** A permissive default is a
    deployment fact you invented. `[A-Z]{2,}` as a store code classified `SOFA1`
    and `MEGA1234` as returns; `.+_` as a report prefix routed
    `Deleted_Customers.csv` into the customer master. Where there is no safe
    universal value, match nothing and say so.

### 8. Irreversible paths fail closed

Destructive and unrecoverable operations refuse by default and require an
explicit, separately-named opt-in. Allowlist, never blocklist: a blocklist of
known-dangerous cases fails open for the one nobody thought of, which is always
the one that costs someone their data.

**How it hides:** it works every time you run it correctly. The failure needs
one unfamiliar input — a database name nobody listed, a processor that has since
been switched — and by then it has already happened.

13. **Restoration migrations derive values from a column the corruption didn't
    touch** — never from a memo. → `docs/domains/import-pipeline.md`
59. **`fbc_test_db` is the only database tests may write**, and the demo seed
    writes only a database whose NAME says it exists to be seeded (`holt_demo`,
    `holt_seed_demo`, `ci`). The token seed/demo/scratch/sandbox/sample/ci must
    be delimited by `_` or the ends of the name, so `holt-demo`, `demo2` and
    `holt_samples` are all refused — near-misses are refused on purpose, since
    a name that only nearly says "scratch" is exactly the one that turns out to
    hold something. Every other database is assumed to hold restored, curated or
    live local data and needs an explicit `--force-unsafe-db`; the integration
    test database is refused even with it. Allowlist, not blocklist: a blocklist
    of known-dangerous names fails open for the one nobody thought of, which is
    always the one that costs someone their data. The `DATABASE_URL must contain
    'test'` guard in `src/lib/testing/withTestDb.ts` is a floor, not a substitute
    for pointing at the right database. Enforced by
    `prisma/seed/demo/guard.ts`, tested in `__tests__/seedTargetGuard.test.ts`.
60. **Route by recorded fact, not current config.** Refunds and webhooks resolve
    the processor from the payment's stored `processorType`, never from whichever
    provider is active now.

### 9. Nothing leaves the session unaddressed

Every finding, every deferral, every learning ends somewhere durable. The
alternative is not "we'll get to it" — it is silently dropped, and nobody knows
the difference.

**How it hides:** intent feels like completion. A verbal "I'll sweep the rest"
and a tracked plan are indistinguishable at the end of a session and completely
different a week later.

**18 vs 49 — which wins.** 18 says ship the simplest fix to the symptom; 49 says
fix every site of a bug shape in one PR. They pull opposite ways on the same PR
and 50 is the resolution: fix the reported symptom now, sweep only what the same
PR can prove, and the unswept sites go into a tracked plan — never a verbal
promise. Scope of the fix is 18's call; scope of the *record* is 50's, and 50 is
not optional.

18. **Ship the simplest fix to the reported symptom.** Bundle prevention layers
    only when asked; spawn the rest.
36. **Read before working, update after learning.** Read the domain runbook
    before touching a domain; update it before closing the session.
48. **Every scan finding ends in one of three states:** fixed, tripwire-tested,
    or explicitly won't-fix with rationale. Never silent-ignore.
50. **Deferred work goes into a tracked plan**, never a verbal promise. The PR
    body says where.

### 10. Own the version state you depend on

You are responsible for the tree that ships, not the one that resolved on your
machine. A suppression without an expiry is a permanent decision made by
someone who thought it was temporary.

**How it hides:** it resolves locally. The gate is green until an unrelated PR
turns it red for reasons that have nothing to do with that PR.

Full playbook: → `.claude/skills/dependency-sweep/SKILL.md`

5. **LTS only** for every runtime and dependency. Pre-release only to close an
   active CVE with confirmed exposure — document it, revert on the next GA.
   Majors get their own planned session.
53. **Never blanket-override a package with incompatible major lines.** Use
    version-scoped (`pkg@1`) or path-scoped (`minimatch@10>brace-expansion`)
    overrides.
54. **A CVE suppression needs an expiry and a re-verified reason.** On expiry,
    re-verify the rationale against the *current* tree before renewing.
55. **Sweep CVEs before starting a merge train.** New advisories turn the gate
    red for reasons unrelated to any pending PR.

### 11. Keep it simple

Prefer the simplest thing that fully does the job: the plain function before the
abstraction, an existing pattern before a new mechanism, the smallest complete
change. Complexity earns its place by being necessary, not merely possible — an
unasked-for knob, a premature abstraction, a layer "for later" is weight every
later reader carries for no return.

Simple is measured against the *correct* design, though — the one the package,
the plan, or the nearest existing pattern specifies — never against the effort of
reaching it. A lighter substitute chosen to dodge that design (an env var where
an `AppSettings` key and a Settings field were specified, a hardcoded default
where configuration was) is not the simple choice; it is the incomplete one, and
it ships a second, wrong system someone reworks later. Under-building and
over-building are one mistake seen from two sides.

**How it hides:** "to keep it simple" and "to avoid a migration" are how
under-building dresses as discipline. A migration, a settings field, a shared
helper are the ordinary cost of the correct design — pay it, and keep everything
around it plain.

66. **Build the specified design, the simplest way faithful to it.** When a
    package names a design — an `AppSettings` key plus a Settings field, a sibling
    route's permission, a shared helper — implement that one, copying the nearest
    existing pattern rather than inventing machinery or substituting a lighter
    stand-in. A schema migration is a normal cost, never a reason to route around
    the specified design. Checked in `.claude/skills/pre-pr`.

## Retired

**1. KISS.** Retired 2026-08-26 for zero citations, no origin link, and no
enforcement home in a skill, hook or tripwire — a preference, not something an
incident taught. **Reinstated 2026-09-23 as principle 11 (rule 66)** by owner
decision after the VAL-04 incident: a specified `AppSettings` + Settings-UI
design shipped as env vars "to avoid a migration" (`docs/RULE-FEEDBACK.md`,
2026-09-23). The return supplies exactly what the retirement faulted — an
incident, and an enforcement home in `.claude/skills/pre-pr` — and frames KISS as
simplest-*faithful*, so it no longer contradicts the doctrine that rules are
incident-taught and enforced. The number 1 stays retired; the principle returns
under a new number, never the old one.

## Changing this file

A rule enters only by surviving an incident, and it enters through
`.claude/skills/improve-rules/SKILL.md` — an observer pass that runs over
accumulated evidence, not a decision made mid-task while the incident is still
warm. That distance is the point: deciding in the moment is how this file
reached 65 numbers with gaps and five conflicting citations.

The bar for a proposed change:

- **Cite the incident.** A commit SHA, a PR number, or a ledger entry. No
  citation, no rule.
- **Say where it is enforced.** Skill (persuasive), hook (hard gate) or tripwire
  (backstop) — per `docs/FRAMEWORK.md` §3. A rule with no enforcement home is a
  wish.
- **Prefer strengthening a principle to adding a number.** Most new incidents
  are new instances of a failure mode already named here. A new number is for a
  failure mode that is genuinely new.
- **One change per PR.** The improver proposes a single focused edit so it can
  be judged on its own.

Retirement runs the same way and needs the same evidence: a rule whose code path
is gone, whose guard has never fired, or which no longer has citations. Demote
it to its runbook with the number preserved so existing citations still resolve;
delete a number only when nothing cites it.

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
