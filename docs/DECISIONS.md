# Decisions

Why the codebase is shaped the way it is.

**Read this before proposing a structural change.** Most entries here record a
question that was already argued, decided, and paid for. Re-opening one is
sometimes right — the world changes — but do it knowing what the original
trade was, not by accident.

Each entry gives the decision, the alternative that was rejected, the reason,
the cost accepted, and where the decision is *enforced* (a doc is a suggestion;
a trigger, a hook, or a tripwire test is a decision that cannot be un-made by
forgetting).

---

## 1. One organization per deployment; no shared-database multi-tenancy

**Rejected:** one database serving many tenants, scoped by `organizationId`.

**Why:** every deployment runs its own database, so the cross-tenant IDOR class
simply cannot occur — there is no foreign tenant's row to reach. The real
security boundaries here are role gates on mutations, capability tokens on
public surfaces, and the deployment perimeter.

**Cost accepted:** each customer needs its own instance and its own backups.
Shared-DB SaaS would first require `organizationId` on ~40 retail-core models
plus scoping on every query — a large, all-or-nothing migration.

**Enforced by:** architecture (separate databases). Models born in the
white-label layer (CMS, bookings, tickets, invoices) *do* carry
`organizationId`, so the door stays open without retrofitting the newer work.

**Source:** [`docs/TENANCY.md`](TENANCY.md)

---

## 2. Returns are sales in reverse, not shrinkage

**Rejected:** booking returns as inventory loss.

**Why:** a return reverses a sale — debit Sales and Tax, credit Cash — and then
either restocks the item or writes it off. Treating every return as shrinkage
misstates both revenue and inventory.

**Cost accepted:** the ~12k imported POS returns carry no restock/writeoff flag,
so they book on a **named default** (restock) rather than a real disposition.
That assumption is made visible rather than silent: an *Unclassified Returns*
report lists every return booked on the default so an accountant can adjust it.

**Enforced by:** three named code paths (`CLASSIFIED_RESTOCK`,
`CLASSIFIED_WRITEOFF`, `UNCLASSIFIED_DEFAULT_RESTOCK`) — greppable, not an
implicit fallthrough — plus real-DB tests in `generateSalesJournal`.

**Source:** [`docs/domains/returns.md`](domains/returns.md),
[`docs/domains/accounting.md`](domains/accounting.md)

---

## 3. Voided-order reversal journal entries: deliberately not built

**Rejected:** auto-generating a reversing JE when a posted day turns out wrong.

**Why:** the daily-summary model already handles voids and returns natively via
the sign-flip in decision #2. The remaining case — "Day 1's JE was wrong, we
noticed on Day 5" — is rare and requires accounting judgment. The right tool is
the accountant entering a correcting journal entry in QuickBooks, not an
auto-generated guess.

**Cost accepted:** a manual step in a rare case.

**Why it's here:** this is the entry most likely to be "helpfully" re-added.
Don't. It was dropped on purpose, 2026-04-28.

**Source:** [`docs/domains/accounting.md`](domains/accounting.md) gap table (B2)

---

## 4. Cut over by parallel run and measured drift, not by big bang

**Rejected:** flipping from the legacy POS to Holt on a chosen date.

**Why:** the cutover criterion is *evidence*, not a calendar — Holt and the
legacy system both process the same days, and `scripts/parallel-run-compare.cjs`
compares daily revenue, tax, cash and order counts. **Zero drift over a
sustained window** is what earns the switch.

**Cost accepted:** running two systems in parallel for weeks, and building the
comparison tooling before getting any user-visible benefit from it.

**Enforced by:** the comparison script exits non-zero on drift, so the criterion
is machine-checkable rather than a judgement call.

**Source:** [`docs/DEPLOYMENTS.md`](DEPLOYMENTS.md)

---

## 5. Reporting invariants are enforced by tests, not discipline

**Rejected:** documenting the rules and trusting reviewers to apply them.

**Why:** three bugs kept recurring across reports — totals inflated by cancelled
lines; rows silently dropped because a `not:` filter on a nullable column skips
NULLs; `netPrice` (a line total) multiplied by quantity. Each was found in
production more than once.

**Cost accepted:** new aggregation code must follow a house pattern that is
occasionally more verbose than the obvious query.

**Enforced by:** `__tests__/reports.cancelledLineFilter.test.ts` scans every
aggregation site and fails CI when a filter is missing. The rule cannot be
forgotten, only deliberately removed.

**Source:** [`docs/domains/reporting.md`](domains/reporting.md)

---

## 6. Payment immutability lives in the database, not the application

**Rejected:** guarding deletes in application code.

**Why:** a completed payment is a financial record. Application guards are
bypassed by scripts, migrations, and console access; a database trigger is not.

**Cost accepted:** a rule that lives outside the TypeScript codebase, so it is
less discoverable — mitigated by an integration test that exercises the trigger
directly.

**Enforced by:** Postgres trigger, covered by
`__tests__/integration/paymentDeleteImmutability.integration.test.ts`.

**Source:** [`docs/domains/accounting.md`](domains/accounting.md) (B6)

---

## 7. Buyer drafts link to real POs by empirical join, not a stored foreign key

**Rejected:** persisting a draft→PO foreign key when the order is placed.

**Why:** the POS splits a partial receive into a fresh PO with no parent
reference, so a stored link goes stale the moment a receive splits. One draft PO
can span N real POs and vice versa; the empirical `productId` join expresses
both directions without a schema change.

**Cost accepted:** the link is recomputed rather than looked up, and it is a
heuristic rather than a guarantee.

**Note:** the *historical* import direction is different — it is 1:1 and uses a
real unique FK, because idempotency there wants an exact indexed lookup. Same
domain, opposite decision, for a documented reason.

**Source:** [`docs/domains/buyer-drafts.md`](domains/buyer-drafts.md) (Slice 6.7)

---

## 8. Feature modules ship off by default

**Rejected:** every deployment getting every module.

**Why:** Holt is one codebase serving different businesses. A furniture retailer
should not see email-authentication tooling; a services firm should not see
consignment. Twelve modules default to `false` and are enabled per organization.

**Cost accepted:** every new module needs a flag and a gate, and features are
invisible until someone turns them on.

**Enforced by:** `lib/featureCatalog.ts` — flags default `false`, and gated
routes 404 rather than render, so an unconfigured module is indistinguishable
from one that does not exist.

**Source:** `app/src/lib/featureCatalog.ts`

---

## 9. Payments resolve by recorded fact, not current configuration

**Rejected:** routing all processor calls to whichever provider is active.

**Why:** two different questions get asked. *"Who should take this new payment?"*
is an operator choice. *"Who handled this existing payment?"* is history, read
off the payment row. If an organization switches processors, every previously
captured payment must still refund through the processor that actually took the
money.

**Cost accepted:** two resolvers instead of one, and an unrecognised processor
throws instead of falling back — a loud failure rather than a wrong refund.

**Enforced by:** `getActiveProvider()` vs `getProviderForPayment()`, with tests
that switch the active provider and assert historical payments do not follow.

**Source:** `app/src/lib/payments/`

---

## 10. The legacy archive is deliberately inert

**Rejected:** importing legacy records into the live tables.

**Why:** archived history should be readable without being reachable. It carries
no foreign keys into live data and is loaded once, so no live query can
accidentally join it and no live write can corrupt it.

**Cost accepted:** archived data cannot participate in current reporting.

**Source:** [`docs/domains/legacy-archive.md`](domains/legacy-archive.md)

---

## 11. CVE suppressions expire

**Rejected:** permanent ignore entries for advisories that do not apply.

**Why:** a suppression is a claim about the world ("we install a patched build
from the vendor's CDN, so the version string is misleading"). Claims go stale.
Every entry in `osv-scanner.toml` carries an `ignoreUntil`, so an expired
suppression *blocks a push* and forces someone to re-verify the reasoning
against the current tree.

**Cost accepted:** periodic re-review work, and occasional surprise when an
expiry lands mid-task.

**Proof it works:** on 2026-07-24 the xlsx suppressions expired and blocked a
push. Re-verification confirmed the rationale still held; the entry was extended
with the re-review recorded. The alternative — a permanent ignore — would have
silently carried a stale claim indefinitely.

**Source:** [`osv-scanner.toml`](../osv-scanner.toml)

---

## 12. Rules live where they cannot be forgotten

**Rejected:** a long document of conventions.

**Why:** three enforcement strengths, matched to the rule. A **skill** is a
reminder ("comments explain why, not what"). A **hook** is a gate ("don't push
with failing checks"). A **tripwire test** is a CI failure ("this aggregation
must filter cancelled lines"). Putting a hard rule in a soft place means it gets
read once and forgotten.

**Cost accepted:** enforcement has friction, and occasionally blocks work that
was actually fine.

**Source:** [`docs/FRAMEWORK.md`](FRAMEWORK.md)

---

## Adding an entry

When a decision is argued and settled — especially when an alternative was
rejected for a reason that will not be obvious later — add it here, and put the
enforcement where it belongs. An entry earns its place if a competent person
could plausibly undo the decision by accident.
