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

**Cost accepted:** the imported POS returns carry no restock/writeoff flag,
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
from one that does not exist. `FEATURES` is now derived from the module
manifest (`lib/modules/registry.ts`, see `docs/domains/modules.md`), which
also adds a `category` so niche/single-tenant modules stay hidden from the
Settings toggle grid even before anyone flips them on — but the flag
contract itself (key, default, 404-on-off) is unchanged.

**Source:** `app/src/lib/featureCatalog.ts`, `app/src/lib/modules/registry.ts`

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

**Source:** [`app/osv-scanner.toml`](../app/osv-scanner.toml)

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

## 13. Deployment facts are config, never code

**Rejected:** hardcoded mapping literals (`AXPER_TO_STORE_LOCATION`,
per-vendor payment code maps), and the obvious alternative of a
database-only admin UI with no file representation.

**Why:** a fact about *a* deployment compiled into *the* product means every
deployment that adds a store forks a TypeScript file. But database-only
configuration is not reviewable, not diffable, and not reproducible across
environments. So: a checked-in YAML/JSON file is the authoring and review
surface, database rows are the runtime store, and an admin GUI is a second
door onto the same rows that exports back to a file. Both doors share one zod
schema, so they cannot drift.

The boundary that makes this safe to accept from a pull request, an upload, or
a form: **a preset selects behaviour from a fixed catalog and can never supply
behaviour.** It may name a `runnerKey` that already exists in the compile-time
registry; it may not define what that runner does. No expression language, no
conditionals, no computed values — the transform vocabulary is six fixed keys.
A config DSL is a remote code execution surface wearing a config file's
clothes.

**Cost accepted:** two surfaces to keep in sync (mitigated by the shared
schema and a YAML/JSON parity test), and a reconcile-to-desired-state apply
that deletes rows a file no longer mentions — which is correct for GitOps and
surprising the first time you see it.

**Source:** [`docs/domains/config-presets.md`](domains/config-presets.md)

---

## 14. The sale always wins; the discrepancy becomes back-office work

**Rejected:** blocking a sale when stock is short, and requiring a manager
override to oversell.

**Why:** a furniture store sells floor models, special orders, and things
arriving next week. Inventory is also routinely wrong in small ways — a
mis-tagged item, a mis-counted bin. If a cashier has scanned it, it is in front
of them and the customer is standing there. Refusing the sale to protect a
number is the wrong trade every time. So `allocate` commits whatever exists,
records the shortfall, and never throws.

But "never block" is only half the rule. The discrepancy is real and somebody
should see it, so it lands in `InventoryException` -- one open row per order
and product, which closes itself when the order comes to hold what it needs,
grouped with a suggested fix in Reports > Oversold -- rather than a toast the
cashier dismisses. Made-to-order lines are excluded, because a
queue full of the normal case is a queue nobody reads — the same reasoning that
rate-limits error alerts in `errorRecorder.ts`.

**Cost accepted:** on-hand can go negative in effect, and the queue needs
somebody to actually work it. Both are better than a register that argues with
a customer.

**Source:** [`docs/domains/inventory.md`](domains/inventory.md)

---

## 15. It has to start, and CI has to prove it

**Rejected:** trusting lint, typecheck and 2,985 unit tests as evidence that
the application works.

**Why:** none of them ever started the app. A missing env var, a bad migration,
or a module that throws on import passed green. Separately, a clone could not
reach a running system at all — four independent walls, each discoverable only
by hitting it. `npm run setup` collapses the path to one command and
`scripts/smoke.sh` proves it end to end: boot, ready, a real NextAuth login as
a seeded user, an authenticated page, and an API read that fails if the
database is migrated but not seeded.

The smoke test earned this entry immediately: enabling a production build to
boot over http surfaced that `NODE_ENV=production` sets a `__Secure-` cookie
while `getToken` reads the plain name from the http scheme — valid session,
307 from every guarded page. A build-only check calls that green.

**Cost accepted:** a slower CI job, and a documented `ALLOW_INSECURE_NEXTAUTH_URL`
escape hatch — narrowed to loopback so it cannot become "we turned the check
off in prod".

**Source:** [`app/scripts/smoke.sh`](../app/scripts/smoke.sh)

---

## 16. "No source system" is an adapter, not a null

**Decided:** every deployment has a `SourceAdapter`, and the shipped default is
a real one named `none` that imports nothing and says so.

**Rejected:** treating "this deployment doesn't import from anywhere" as an
absent configuration — a null adapter id, a disabled module, an unreachable
route.

**Why:** before the seam, the only answer to "where does data come from" was
the Ordorite adapter. A deployment that had never heard of Ordorite still got
its import route, its admin page and its failure modes, and the honest state
"we key everything natively" was indistinguishable from "Ordorite,
misconfigured." A cron pointed at such a deployment failed nightly and paged
whoever owned the alert, for working exactly as intended.

Making it an adapter also collapses the branching: no caller asks whether a
source exists. `getActiveSourceAdapter()` always returns something with
`runImport` and `checkReadiness`, and the no-op case reports success with a
message rather than an error.

The same reasoning sets the module-off behaviour: a configured adapter whose
module flag is off resolves to `none`, because switching a module off is how an
operator disables a feature and it would be perverse for that to start throwing
at 06:10. An id the build does not know still throws — that is a wrong image,
and silently importing nothing is the worst available response.

**Cost accepted:** one more `AppSettings` column and a migration that backfills
from the `legacyPosImport` flag, plus a deprecated `/api/automations/gmail-import`
alias kept alive until every deployed crontab is repointed.

**Source:** [`docs/domains/source-adapters.md`](domains/source-adapters.md),
[`app/src/lib/adapters/index.ts`](../app/src/lib/adapters/index.ts)

---

## 17. `StaffRole` and `StaffMember.roleId` coexist for a release

**Rejected:** dropping the `StaffRole` enum in the same change that introduced
`Role` / `RolePermission`, and making `StaffMember.roleId` required.

**Why:** 335 Pages Router API routes gate on the enum through
`requireAuthWithRole([...])`. Dropping it means converting all 335 in one
change, which is a flag day: every route's authorization changes at once, the
diff is unreviewable, and any single mistake is a hole nobody can see among the
other 334. The nullable FK is what lets a route move on its own — `requireAuthWithRole`
and `requirePermission` read the same staff row, apply the same impersonation
and bootstrap rules, and disagree about nothing except which question they ask.
A route converts, its tests prove it, and the other 334 are untouched.

Nullable rather than required for the same reason at the row level: a staff
member created by a code path written before the column exists gets
`roleId = null`, and `requirePermission` falls back to
`permissionsForBuiltInRole(staffMember.role)`. The alternative — a required
column — makes every staff-creation path a prerequisite of the first
permission check, which is the flag day again, one layer down.

The migration backfills `roleId` for every existing staff member by joining
`Role.key = StaffMember.role::text`, so the two representations agree on day
one and nothing changes for anyone.

**Cost accepted:** two ways to say what someone is, for one release. That is a
real cost — the enum can be edited without the FK following, and vice versa —
so the correspondence is a tripwire rather than a convention:
`__tests__/rolePermissionSchema.test.ts` fails if the eight `BUILT_IN_ROLES`
keys and the eight `StaffRole` values ever stop being the same set in either
direction, and the migration itself `RAISE`s rather than leaving a staff member
unlinked. Removing the enum is its own later change, after the sweep.

**Also decided here:** the `"*"` wildcard is `Role.grantsAllPermissions`, a
boolean, not 45 `RolePermission` rows. Materialising it would freeze the
Owner's grants at seeding time, so the next release that adds a permission
would silently leave the Owner without it — a 403 whose cause is a data
migration nobody ran.

**Enforced by:** `__tests__/rolePermissionSchema.test.ts` (both-directions
tripwire, migration scan), `__tests__/permissionDecision.test.ts` (the
impersonation and bootstrap rules survive the move),
`__tests__/integration/rbacFoundation.integration.test.ts` (real DB).

**Source:** [`docs/domains/staff-auth.md`](domains/staff-auth.md),
[`app/src/lib/auth/permissionCatalog.ts`](../app/src/lib/auth/permissionCatalog.ts)

---

## 18. Holt owns its stock; the POS import is a client of the ledger

**Rejected:** a per-store "import mode" flag that hands a store's stock to the
POS file, and letting the import write positions directly.

**Why:** Holt is standalone. On a live site the POS stock file is a one-time
opening load; the owner's daily import exists for testing. So the import is
one more writer through `lib/inventory/ledger.ts` like a receipt or a sale:
`planImportSync` turns the file into one physical target per place (aliased
rows summed, zero rows honoured, products a covered place no longer lists set
to zero) and `applyImportSync` sets free stock to physical minus what is
already committed to orders. A sale's commitment survives the file, the
journal records every change, and a second run writes nothing. A store-level
mode switch would have been a setting that exists only for the testing setup,
and two writers with different rules for one balance.

**Cost accepted:** while the daily test import runs, a place the file covers is
reset to the file each day, natively received stock included. Floor flows are
tested on `holt_demo` or with the import paused.

**Enforced by:** `__tests__/importSync.test.ts`,
`__tests__/integration/stockImportSync.integration.test.ts`, the single-writer
tripwire (`stockWriterTripwire.test.ts`) and the suite-wide ledger drift check.

**Source:** [`docs/domains/inventory.md`](domains/inventory.md)

---

## 19. A return never holds up the customer

**Rejected:** a return status machine where putting the piece back
(`RESTOCKED`) or writing it off (`WRITTEN_OFF`) is the step that finishes the
return.

**Why:** owner direction, 2026-10-16: the customer's return is processed and
done; what happens to the piece is the store's job. So RECEIVED puts the piece
into the store's returns place (owned, not for sale) and records where; the
return can be inspected and closed at once. A per-store returned-stock queue
lists every piece still waiting, and putting it back or writing it off is
recorded on the return (`restockedAt` / `writtenOffAt`) apart from its status.
The journal generator classifies a return by that recorded disposition first.
A store that wants returns sellable at once points its returns place at a
sellable place; the place's type is the whole setting.

**Cost accepted:** a closed return can still have a piece in the queue, so
"closed" no longer means "dealt with" for stock. The queue, and its count on
the warehouse dashboard, is where that shows.

**Enforced by:** `__tests__/integration/stockReturns.integration.test.ts`.

**Source:** [`docs/domains/returns.md`](domains/returns.md),
[`app/src/lib/inventory/returnStock.ts`](../app/src/lib/inventory/returnStock.ts)

---

## 20. A native return books as its own order

**Rejected:** negative lines (or an edited quantity) on the original order.

**Why:** the original order's recognition is keyed to its own invoice date.
Negative lines on it would reverse the sale on the day the sale was recognised,
not the day the goods came back, and every revenue report would quietly rewrite
that earlier day. Imported POS returns already book as a separate RETURNED
order of negative lines (the B3 path), so a native return does the same
(`lib/returns/bookReturn.ts`): one negative line for what came back, the
restocking fee as a positive line, an invoice dated the return day when the
original was invoiced, and refunds written against it. The original order is
never rewritten; what it still owes is paid first, from the return, as store
credit spent on it.

**Cost accepted:** a return is two orders, the original and its own, and
reports that list orders show both (a RETURNED order is in
`SALES_REVENUE_STATUSES`, rule 47). A return booked against an original that is
invoiced only later is not reversed in the journal; tracked in
`docs/domains/returns.md`.

**Enforced by:** `__tests__/integration/returnMoney.integration.test.ts` (the
return day's journal balances with no plug), `returnOrderEditProblem` on every
order and line edit route.

**Source:** [`docs/domains/returns.md`](domains/returns.md) "Returns money".

---

## 21. Holt counts by place; the store-grain count stays for the cutover

**Rejected:** replacing the store-grain count (`PhysicalInventoryCount`,
`Reconciliation`) with the place count, and counting natively at store grain.

**Why:** every unit has a place, so a count has to say which place it speaks
for. Without that, posting it cannot know which place's stock is wrong. A count
of one place says either "this is everything here" (PLACE: not counted means
not there) or "these products, nothing else" (PRODUCTS). Counting needs
`inventory.count`. Posting changes the books, so it needs `inventory.adjust`,
and moves the difference as ADJUST movements. The store-grain flow compares
Holt with the POS (snapshot, scan, variance, reconcile) while a store is cut
over. Retiring it now would remove that check before the cutover is done.

**Cost accepted:** two count flows. The old one keeps whole-number columns, so
it truncates a part roll (tracked in `ROADMAP.md` → "Handheld floor").

**Enforced by:** `__tests__/countDifference.test.ts`,
`__tests__/integration/stockCount.integration.test.ts`.

**Source:** [`docs/domains/inventory.md`](domains/inventory.md) → "The handheld floor"

---

## 22. Boxes are evidence, never a quantity

**Rejected:** stock per box, and receiving a manufacturer's box UPC as a unit.

**Why:** owner design goal: item quantity is the only quantity. A sofa that
ships in three boxes is one unit, and `Product.boxesPerUnit` is the only box
fact stored. A box label's scan proves part of a unit is here. Whatever does
not make a whole unit is an incomplete set: one unit, owned, held in quarantine
with a note naming the missing boxes. A manufacturer's UPC repeats on every
box, so a multi-box product is counted only through Holt's own box labels.

**Cost accepted:** a unit missing a box counts as one unit owned (in
quarantine). On-hand reads one where the floor has part of a sofa; the box note
is where that shows.

**Enforced by:** `__tests__/boxes.test.ts`,
`__tests__/integration/handheldReceive.integration.test.ts`, and
`stockPick.integration.test.ts` (an incomplete set is never loaded).

**Source:** [`app/src/lib/inventory/boxes.ts`](../app/src/lib/inventory/boxes.ts)

---

## 23. A part delivery is not the handover

**Rejected:** recording the order as delivered (`deliveredAt`, FULFILLED) at the
first stop that delivered anything; and a FAILED stop status (removed
2026-08-25).

**Why:** `deliveredAt` is the handover fact (`lib/fulfilment/handover.ts`). A
commission plan that counts on delivery windows on it (`lib/commissionSales.ts`),
and the order turns FULFILLED with it. Recording it while a sofa is still in the
warehouse pays commission and closes the order early. So a part delivery moves only the units
that went and raises `fulfilledQty`, and the last units are the handover. A
stop that could not be done is an attempt, not an outcome. It comes off the
run, its appointment goes back in the dispatch pool, and the reason goes on the
order.

**Cost accepted:** an order delivered in parts counts as delivered when its
last piece arrives, not piece by piece.

**Enforced by:** `__tests__/integration/stockDelivery.integration.test.ts`,
`__tests__/integration/handover.integration.test.ts`.

**Source:** [`app/src/lib/fulfilment/stops.ts`](../app/src/lib/fulfilment/stops.ts)

---

## 24. A vendor's lead time dates a PO; an unknown one dates nothing

**Rejected:** a default lead time (a "typical" six weeks, say) for a vendor
nobody has set one for, so that every PO carries an expected date.

**Why:** an expected date is a promise a buyer plans against and a customer is
quoted from. A default would put a confident, invented date on every PO raised
against a vendor nobody has set up, and those POs would read as on time until
the day they read as late. With no lead time on file the PO has no date, which
the Delivery Planner shows as "No ESD" -- exactly the row a buyer has to chase.

**Cost accepted:** a deployment that never fills in lead times sees no expected
dates on special-order POs until vendors confirm them.

**Enforced by:** `__tests__/vendorLeadTime.test.ts`,
`__tests__/integration/specialOrderLeadTime.integration.test.ts`.

**Source:** [`app/src/lib/vendorLeadTime.ts`](../app/src/lib/vendorLeadTime.ts)

---

## 25. A run's truck is a place of the run's own, not the vehicle's

**Rejected:** one place per vehicle, persistent, labelled like any other place;
and leaving loaded units at the loading bay on the books until they are
delivered.

**Why:** a loaded unit is on the truck, and a stop that could not be done
brings it back on the truck. At the bay on the books, it read as there while
it was on the road. A vehicle is the obvious owner of that place, but a place
belongs to one store and a vehicle moves between sites, and a vehicle's runs
overlap on the books: tomorrow's run can be loaded before today's is closed.
A place per vehicle would mix their loads. Then "is this run's truck empty?"
or "what does this run unload?" would have to be worked out from the journal,
since a failed stop leaves the run. With a place per run (one per store it
loads at), each of those questions is just the stock at the run's own places.
So loading moves the bay's units aboard, a delivery draws from the truck
first, a failed stop's units stay aboard, and the run is not completed until
they are unloaded to a bay.

**Cost accepted:** a truck place is made for every run that loads, and retired
(inactive) when the run completes, so the table grows by about one row per
run. People never see them in Warehouse > Locations. A failed delivery left
aboard overnight for the next day's run on the same vehicle is unloaded and
loaded again on the books.

**Enforced by:** `__tests__/integration/stockTruck.integration.test.ts`.

**Source:** [`app/src/lib/fulfilment/truck.ts`](../app/src/lib/fulfilment/truck.ts)

---

## 26. Stock is valued at an average landed cost; the split is the store's

**Decided 2026-10-30 (owner, GAP-02).**

- **One cost.** Each product keeps an average landed cost: the running average
  of its receipts, each at its PO line's unit cost plus its share of the PO's
  charges (freight, duty, crating).
- **What reads it.** It values stock and is the cost a new sale takes. Catalog
  cost (`baseCost`) stays the vendor's price, which retail is figured from and
  a PO orders at.
- **The split.** How a charge is split across lines (by value, by quantity, or
  by cubic volume) is the store's choice in Settings, by value unless set
  otherwise. The buyer can pick another split for one charge.

**Rejected:**

- **Charges on receipts only.** Margins would not include freight.
- **Cost layers (FIFO).** A layer per receipt, consumed in order, is more exact
  but far heavier than a store's books need.
- **Overwriting `baseCost` with landed cost.** Retail is figured from
  `baseCost`, so freight would leak into prices.
- **A fixed split.** How freight is billed differs by vendor and store; the
  owner wants it configurable (`docs/domains/purchasing.md`).

**Cost accepted:**

- A charge entered after the goods sold has no stock to land on. The amount is
  reported back and does not restate those sales.
- Taking a receipt back reverses its units out of the average at the cost they
  came in at. When later moves make that arithmetic impossible, the average
  stands.

**Enforced by:** `__tests__/integration/landedCost.integration.test.ts`,
`__tests__/lib/purchasing/landedCostShared.test.ts`.

**Source:** [`app/src/lib/purchasing/landedCost.ts`](../app/src/lib/purchasing/landedCost.ts),
[`app/src/lib/purchasing/landedCostShared.ts`](../app/src/lib/purchasing/landedCostShared.ts)

---

## 27. A session ends by its own expiry, set from the last activity

**Decided 2026-10-31 (GAP-27).** The idle time is the store's: Settings →
Automatic sign-out, 5 to 720 minutes or off. It defaults to 15 minutes, the
strict choice (owner: "This should be some sort of config").

- **Enforced by the token.** The session JWT's `exp` is set to its
  `lastActiveAt` plus the idle time plus a 2-minute grace. Every reader refuses
  an expired token, so no gate checks the idle time itself.
- **Activity is a person.** `lastActiveAt` moves at sign-in, and when the
  browser reports typing, tapping or the mouse (at most once a minute). A
  background request never moves it.
- **The browser warns.** A minute before the time runs out it asks "Still
  there?", then signs out and returns to the same screen after sign-in.

**Rejected:**

- **An idle check in each gate.** That means checks in requirePage,
  requirePermission, requireAuthWithRole, the tRPC procedures and every route
  that reads the session itself, and a gate added later would need to remember
  one. Rule 42 is about exactly this: a guard on one path is no guard.
- **NextAuth's sliding `maxAge` alone.** Every request re-issues the token, and
  screens poll (notifications, the home page, the Up Board). A screen left open
  would keep itself signed in forever.
- **A server-side session table.** It would mean a database read on every
  request, and a second source of truth beside the JWT.
- **A lock screen asking for a PIN instead of signing out.** Not asked for, and
  heavier. Sign-out is what "automatic logoff" means.

**Cost accepted:**

- The browser and the server keep separate clocks. The grace keeps the server
  later than the browser, so the warning always gets its minute.
- A screen left open as a display is signed out too. Such a store chooses a
  longer time or turns sign-out off.
- Lowering the time takes effect at each session's next request, not at once.

**Enforced by:** `__tests__/integration/idleLogoff.integration.test.ts`,
`__tests__/lib/auth/idleLogoff.test.ts`.

**Source:** [`app/src/lib/auth/sessionToken.ts`](../app/src/lib/auth/sessionToken.ts),
[`app/src/lib/auth/idleLogoff.ts`](../app/src/lib/auth/idleLogoff.ts),
[`app/src/components/auth/IdleLogoff.tsx`](../app/src/components/auth/IdleLogoff.tsx)

---

## 28. A quote commits only the floor stock it holds; an order commits everything

**Decided 2026-11-01 (owner, GAP-16).** "We can put it on a quote and part of
the quote if it is floor stock can be hold until x date, and again a config
would set the max allowed because who am I to tell anyone how to run their
business."

- **On hold is a quote line.** Staff hold a floor-stock line of a quote for its
  customer through a day they choose. While held, its units are committed to
  the quote, so nobody else sells them. There is no separate hold record:
  the commitment is the ledger's existing owner, the sales order.
- **Nothing else on a quote commits.** A line with no hold, or one whose day
  has passed, commits nothing. Before this, every quote committed every line
  with no end.
- **An order commits everything.** A quote becoming an order (its first payment,
  or a status change) commits every line through one function,
  `promoteQuoteToOrder`.
- **The store sets the longest hold** (`AppSettings.quoteHoldMaxDays`, 0 to 365
  days; 0 = quotes hold nothing). It ships at 3, the strict end.
- **What isn't stocked never commits.** A category with `trackInventory` off
  has no stock, so asking for some would only raise a false shortfall (GAP-21).
  A made-to-order one-off product was in this bullet too until 2026-11-02;
  it is now an item like any other (DECISIONS 34).

**Rejected:**

- **A separate hold record beside the stock.** A second home for "these units
  are spoken for" would drift from the ledger, and every reader of free stock
  would need to subtract it (principle 6).
- **Quotes committing everything, with an expiry.** A quote would still keep
  stock it never meant to hold for days. And a hold would be the default, where
  the owner described it as something staff choose.
- **A fixed hold length.** How long a store holds a piece is its own call.

**Cost accepted:**

- A register sale commits at its first payment, seconds after it is written.
  Another register can sell the last unit in between; the later sale records a
  shortfall, as any oversale does.
- A hold ends with the hourly sweep, so a piece goes back on sale within the hour
  after its last day ends, not to the minute.

**Enforced by:** `__tests__/integration/quoteHolds.integration.test.ts`,
`__tests__/lib/sales/quoteHoldsShared.test.ts`.

**Source:** [`app/src/lib/sales/quoteHolds.ts`](../app/src/lib/sales/quoteHolds.ts),
[`app/src/lib/sales/quoteHoldsShared.ts`](../app/src/lib/sales/quoteHoldsShared.ts),
[`app/src/lib/inventory/orderInventorySync.ts`](../app/src/lib/inventory/orderInventorySync.ts)

---

## 29. A floor sample is a place, not a flag on a unit

**Decided 2026-11-01 (GAP-15).** A store marks the places its samples sit in as
`DISPLAY`, a type in `lib/inventory/locationTypes.ts`. Stock there is owned and
counted but not free, so nothing draws it. The one exception is a take-with sale
at its own store, which draws it last: the customer carrying the sample out.

- **Stock is kept by place, not by unit** (`lib/inventory/ledger.ts`). A sample
  is the piece in a display, and moving it out of the display is how it becomes
  stock to sell. That is an ordinary move, recorded in the journal.
- **The store chooses its displays.** A sales floor whose pieces are stock to
  sell, such as lamps and rugs, stays `FLOOR` and behaves as before.

**Rejected:**

- **Making every `FLOOR` place behave this way.** That is stricter, but floor
  accessories would stop counting as sellable until a store re-typed those
  places.
- **A per-unit sample flag.** It would need a column on every stock row and a
  rule in every reader of free stock. A place type is already read by the one
  free-stock predicate.

**Cost accepted:** a sample sold for delivery needs a move out of display first.
The register has no "sell this sample" choice yet (ROADMAP GAP-15).

**Enforced by:** `__tests__/integration/stockSetAside.integration.test.ts`,
`__tests__/allocationScope.test.ts`.

**Source:** [`app/src/lib/inventory/locationTypes.ts`](../app/src/lib/inventory/locationTypes.ts),
[`app/src/lib/inventory/allocation.ts`](../app/src/lib/inventory/allocation.ts)

---

## 30. A service checklist is copied onto a case, not linked to it

**Decided 2026-11-01 (owner chose task checklists, GAP-11).** A checklist is
the steps a kind of service job takes, set up by the store in Settings ›
Service. Applying one to a case copies each step into one of the case's tasks,
due its days after today on the store's calendar. From then on the tasks are
the case's own.

- **Editing a checklist changes no case already given it.** A case's tasks are
  the record of what that job needed. A checklist edited next month shouldn't
  rewrite them.
- **The task remembers its checklist** (`ServiceTask.checklistId`), only so a
  case isn't given the same one twice. Deleting the checklist clears it.

**Rejected:**

- **Tasks that follow the checklist live.** Tasks already ticked off or
  re-dated would change under the people working them.
- **Applying by case type automatically.** In the option the owner chose, staff
  apply one. A case type and a job don't line up one to one either. It is in
  ROADMAP as a later choice.
- **Emails from a case** (the other reading of "templates"). The owner chose
  checklists. `ServiceEmail` stays unused, in ROADMAP.

**Cost accepted:** a step fixed in a checklist isn't fixed on cases already
given it. Staff edit those tasks by hand.

**Enforced by:** `__tests__/integration/serviceChecklists.integration.test.ts`.

**Source:** [`app/src/lib/service/checklists.ts`](../app/src/lib/service/checklists.ts)

---

## 31. An item can have more than one vendor; a purchase order has one

**Decided 2026-11-01 (owner, GAP-22).** The roadmap asked for "distributor
records, for a line bought through another company". The owner: the store
doesn't tell the brand from the company it buys through, and its buyers "do not
even know what a distributor is". Instead, "an item could have multiple
vendors", and "a po is always linked to a single source", which may be a brand
or a company selling several.

- **The item's own vendor** (`Product.vendorId`) stays as it is: the vendor for
  pricing, price books and sales reports.
- **Its other vendors** are `ProductSource` rows, each with that vendor's item
  number and cost.
- **A PO's vendor may order an item** that is its own or that lists it as
  another vendor, under that vendor's number and at its cost. One function
  decides it, `buyingTerms`, and every path that puts a product on a PO asks it.

**Rejected:**

- **A distributor as its own kind of record** (a vendor "bought through"
  another, or a separate "sent to" on the PO). It names a difference the store
  doesn't make, and each brand's POs would still be split by brand.
- **One PO ordering from several vendors at once.** The owner: one source per
  PO. (A PO to a company that sells several lines may still hold items whose
  own vendors differ; it is ordering them all from that one company.)
- **Moving an item's own vendor to whoever it is bought from.** Pricing, price
  books and sales reports read the own vendor, and would move with it.

**Cost accepted:** special-order POs are still raised to each item's own
vendor; routing one through another vendor isn't built (ROADMAP GAP-22).

**Enforced by:** `__tests__/integration/productSources.integration.test.ts`.

**Source:** [`app/src/lib/purchasing/productSourcesShared.ts`](../app/src/lib/purchasing/productSourcesShared.ts)

---

## 32. A merged vendor's name stays behind; a clash refuses rather than guesses

**Decided 2026-11-02 (GAP-22).** Not put to the owner as a question; the #79
report described the plan (keep the old name for imports, refuse clashes,
naming each) before this was built.

Duplicate vendors come from imports that spell a vendor two ways, so merging
two must keep the import from making the duplicate again.

- **The merged vendor's name becomes an earlier name** (`VendorAlias`) of the
  vendor kept. Every lookup of a vendor by name goes through one module,
  `lib/vendors/vendorByName.ts`, which finds the kept vendor by it. A vendor's
  own name wins over an earlier one, and the vendor screen won't add a vendor
  under an earlier name.
- **Everything filed under the merged vendor moves**, in one transaction, and
  the vendor is deleted. `VENDOR_REFERENCES` lists every table that names a
  vendor and what a merge does with it.
- **It refuses rather than choose** when both vendors hold a record the
  database keeps one of per vendor (a style number, a price list's name), when
  an item would list a vendor twice, when only one takes consignment, and when
  a commission rule names the merged vendor. Each refusal names what clashes.
  Same-named collections fold together, since a collection is only a name.
- **The kept vendor keeps its details and pricing**, and takes from the merged
  one only details it lacks (contact, terms, lead time, minimum order, code);
  the merged vendor's notes are added to its own.

**Rejected:**

- **Rewriting the import files' names or making every import "fuzzy".** A file
  spells what the old system spelled. One lookup that knows the earlier names
  covers every import.
- **Choosing one of two clashing records** (keeping the kept vendor's style
  1010 and dropping the other's). Each carries prices and history; dropping one
  silently changes what an item costs.
- **Moving or nulling a commission rule for the merged vendor.** Moving it
  widens it to the kept vendor's items; nulling it (the foreign key's SET NULL)
  widens it to every vendor. Either changes what someone earns without anyone
  deciding to.
- **An undo.** The merged vendor is gone. Forgetting an earlier name (vendor
  screen, admin.data) is the way back for imports: the next one that spells it
  makes a new vendor.

**Cost accepted:** most clashes have no screen to renumber, rename or remove
one of the pair yet (styles, price lists, price dimensions, fabrics, programs,
components; option groups do, on the pricing options screen), so those merges
stay refused until one exists (ROADMAP GAP-22).

**Enforced by:** `__tests__/integration/vendorMerge.integration.test.ts`,
`__tests__/vendorMergeCoverage.test.ts` (every table naming a vendor is listed),
`__tests__/vendorNameLookups.test.ts` (no vendor found or made by name
elsewhere).

**Source:** [`app/src/lib/vendors/mergeVendor.ts`](../app/src/lib/vendors/mergeVendor.ts),
[`app/src/lib/vendors/vendorByName.ts`](../app/src/lib/vendors/vendorByName.ts)

---

## 33. A scanned reorder files each vendor's lines on its open draft PO

**Decided 2026-11-02 (GAP-19), by the owner.** Asked how POs should come out
of a buyer scanning items to reorder, and what to do when the vendor already
has a draft for the store, the owner chose "a draft per vendor" and "add to
that draft".

- **Scan anything, one PO per vendor.** Each scanned item goes to its own
  vendor, or to another vendor it is bought from (DECISIONS 31) when the buyer
  picks one on that line. Saving files each vendor's lines on its own PO,
  because a PO has one vendor.
- **The vendor's newest open draft for the store takes them.** An item already
  on that draft adds to its line, which keeps its cost; anything else is a new
  line at what the item costs from that vendor. A draft that was sent, has had
  goods received against it, is a vendor return, or ships elsewhere is left
  alone, and a new draft is made instead. A line raised for a customer's order,
  or a cancelled (zero) line, is never added to.
- **The buyer still sends it from the desk.** The handheld writes drafts only;
  the PO screen reviews, prints and emails them as for any draft.

**Rejected:**

- **Choosing the vendor first, one scanning session per PO.** It refuses
  every item the vendor doesn't sell, so a walk down a floor of mixed vendors
  is several walks.
- **A new draft every session.** A reorder list built over several walks
  would be several drafts for one vendor, to be combined by hand.

**Enforced by:** `__tests__/integration/scanOrder.integration.test.ts`.

**Source:** [`app/src/lib/purchasing/scannedOrder.ts`](../app/src/lib/purchasing/scannedOrder.ts)

---

## 34. What isn't stocked is its category's call; a made-to-order item is an item

**Decided 2026-11-02 (GAP-21), by the owner.** Asked what receiving does with an
item whose category doesn't track inventory, and what happens when a category is
switched off while it holds stock, the owner chose "record it, stock nothing"
and "allow it, stock stays visible". On made-to-order pieces: "an item is an
item no matter if it was speciall made to order or not"; a custom one is on a
PO until it arrives, and if its order was cancelled "it is stock like anything
else".

- **Not stocked means one thing: a category with Track Inventory off.** Its
  items never go on the books. The ledger refuses units arriving from outside
  for one (`postMovement`, `NotStockedError`), so no path can add them.
- **Receiving records it and stocks nothing.** The receipt counts toward the PO
  line so the PO closes, and says so itself (`ReceivingRecord.intoStock`), so
  taking it back takes nothing out whatever the category says later (rule 60).
- **Switching a category off keeps the stock it has.** Counts, hand edits and
  the import can take it down, never up; nothing removes it on its own.
- **A made-to-order item is an item.** It allocates like any other: short on the
  Oversold report until its PO arrives committed to the order, and a spare one
  is stock a sale takes. `Product.madeToOrder` stays as a record of where the
  product came from, read by nothing in stock.

**Rejected:**

- **Refusing to receive an item that isn't stocked.** The PO line could never
  close without cancelling it or changing the item's category.
- **Refusing to switch a category off while it holds stock.** Moving an item
  with stock into such a category would have to be refused too, on every path
  that sets a product's category, the product import among them.
- **Made-to-order lines never drawing stock (2026-11-01 to 2026-11-02).** It
  kept custom orders off the Oversold report, but a piece whose customer
  cancelled after it arrived could never sell down: a sale of it took nothing,
  and it sat on the books until counted out.

**Enforced by:** `__tests__/integration/unstockedItems.integration.test.ts`,
`inventoryOrderWiring.integration.test.ts` and `quoteHolds.integration.test.ts`.

**Source:** [`app/src/lib/inventory/stocked.ts`](../app/src/lib/inventory/stocked.ts)

---

## 35. An order's disclaimer is a copy of the store's; its flags are the store's own

**Decided 2026-11-03 (GAP-07), by the owner.** Offered the store's own flags and
disclaimers, set up in Settings, as the recommended options, the owner answered
"Yes configurations". No fixed set of either ships.

- **A disclaimer on an order is a copy.** Adding one copies its text onto the
  order (`SalesOrderDisclaimer.text`), as a service checklist is copied onto a
  case (30). It is what the customer was given. Rewording the
  store's disclaimer next month changes no order that has it; deleting it
  leaves the text.
- **It changes only before handover.** While the order is a quote or an order.
  After that it is what the customer took the goods under.
- **A flag is a live label.** Renaming or recolouring the store's flag changes it
  on every order, because a flag says what the order needs now ("Call before
  delivery"), not what was agreed. One that orders carry is switched off, never
  deleted, so they keep it.

**Rejected:**

- **Disclaimers that follow the store's text live.** A disclaimer reworded after
  a sale would reprint the customer's invoice with words they never saw.
- **Typed per order.** The owner chose the store's list. A typed one-off can be
  added later as its own disclaimer, if a store asks.
- **A fixed set of flags.** Every store's words differ ("Balance due on
  delivery", "White glove").

**Enforced by:** `__tests__/integration/invoiceTools.integration.test.ts`.

**Source:** [`app/src/lib/sales/orderDisclaimers.ts`](../app/src/lib/sales/orderDisclaimers.ts),
[`app/src/lib/sales/orderFlags.ts`](../app/src/lib/sales/orderFlags.ts)

---

## 36. A copied order is the same goods at today's prices

**Decided 2026-11-03 (GAP-07), by the owner** ("Today's prices", the recommended
option). Duplicating an order makes a new quote.

- **Today's prices.** A catalog item at its retail now. A custom or configured
  item is its own product, made at the price it was sold at, so that is its
  price.
- **No discount comes across.** A copied discount would be one nobody approved
  under the store's discount policy (GAP-06, pos.md "Discounts and manager
  approval"). Staff give it again, and the policy decides.
- **The goods and who they are for, nothing that happened.** Lines, options,
  notes, the customer, the store and the delivery come across. Payments, holds,
  flags, disclaimers, order notes and history don't. A "Sold as-is" disclaimer
  or a "Balance due" flag belongs to the sale it was put on.
- **Priced by the register's own functions.** A copy is the same cart rung up
  today, to the cent, tax and the zone's delivery fee included.

**Rejected:**

- **Prices as written.** It would carry each line's discount past the policy.
- **Copying flags and disclaimers.** They describe the original sale, not the
  goods.

**Enforced by:** `__tests__/integration/invoiceTools.integration.test.ts`
("duplicating an order").

**Source:** [`app/src/lib/sales/duplicateOrder.ts`](../app/src/lib/sales/duplicateOrder.ts)

---

## 37. A split sale records its shares; splitting it is a reassignment

**Decided 2026-11-03 (GAP-07).** "Choosing the split share at the POS", built on
the owner's standing rules: how a store runs this is configuration, and policy
ships at its strictest (memory, 2026-10-29 and 2026-10-30).

- **The order records the share.** `SalesOrder.splitPercent` is the salesperson's
  share of a split sale, 1-99; the partner gets the rest. It is written when the
  split is made, from the store's `AppSettings.defaultSplitPercent` (50 to
  start) unless staff choose another. A change to the default moves no sale
  already split, so a payout locked last month and recomputed today agree
  (rule 60's reasoning: route by what was recorded, not by what is configured
  now).
- **One rule credits it.** `creditShare` in `lib/commissionSplit.ts`; nothing
  else in the code knows what a split is worth.
- **Splitting is a reassignment.** It moves commission, so at the register and
  on a quote it takes "Reassign salesperson", the permission that already
  governed changing it on the order. Managers hold it by default; a store grants
  it to other roles.

**Rejected:**

- **Reading the store's default live for every split order.** Changing the
  setting would rewrite every past split's credit, under payouts already locked.
- **A nullable share meaning "the default".** Two meanings for one column; the
  column defaults to 50 instead, which is what every split before it was.
- **Anyone at the register may split.** A split moves commission between two
  people; the strict default is the reassign permission, and the store can widen
  it.
- **Both partners credited 100%.** Some businesses do it, but it is a different
  rule (credit is not shared), not a share. Not asked for.

**Enforced by:** `__tests__/integration/splitShare.integration.test.ts`, and the
`SalesOrder_splitPercent_range` / `AppSettings_defaultSplitPercent_range` CHECKs.

**Source:** [`app/src/lib/commissionSplit.ts`](../app/src/lib/commissionSplit.ts)

---

## 38. A handover recorded by mistake is undone by reversing its own record

**Decided 2026-11-03 (GAP-07).** Offered "a permission, managers by default,
refused once commission on the order is paid out" as the recommended option,
the owner answered "Yes configurations", read as yes to it. The order reopens,
its units come back where they left from, still committed to it, and the
delivery goes back to the dispatch pool.

- **A handover records what it changes.** `OrderHandover`: the dispatch status
  and each open line's fulfilled quantity before it, and its stop. Every unit
  it moves points back at it (`StockMovement.orderHandoverId`). The undo
  reverses exactly that, and the record keeps who undid it and why.
- **Only the latest handover.** A part delivery before it was its own stop,
  confirmed as it happened.
- **A truck's units go to a loading bay.** A finished run's truck places leave
  service, so a unit that left from one comes back where an unloaded truck
  puts it.
- **The status buttons can't reopen a handed-over order.** Only the undo can,
  so the stock always comes back with it.

**Rejected:**

- **Reopening by status.** That is what the buttons did. It left the goods
  off the books while the order read as open.
- **Reversing every delivery on the order.** It would bring back units a
  correct part delivery left with the customer.
- **Finding the handover's movements by time or reason.** Part deliveries move
  the same products with the same reason. A recorded link can't be mistaken.
- **Undoing handovers recorded before the record existed.** There is nothing
  to say what they moved. They are refused, and a count corrects the stock.

**Enforced by:** `__tests__/integration/undoHandover.integration.test.ts`.

**Source:** [`app/src/lib/fulfilment/undoHandover.ts`](../app/src/lib/fulfilment/undoHandover.ts)

---

## 39. Customer messages are the store's to switch on and word; Holt only decides when they're due

**Decided 2026-11-03 (GAP-13).** Offered the recommended options (each message
on or off with its own wording, the order link in every message, one opt-out
for all of them, the review invitation a store-set number of days after
handover), the owner chose all four, then added "All configurations": every
choice about how a message behaves belongs to the store.

- **Every message starts off.** A store switches on the ones it wants, and
  only events after that send. Turning a feature on must not mail every
  customer about last month.
- **The kinds are code; the store's row only configures them** (rule 62). The
  event, its timing rule and its placeholders are fixed per kind. Wording is
  plain text with placeholders the kind can fill, checked when it's saved.
- **Each event is recorded once, sent or not.** The row is the dedupe and the
  history. A skipped message says why, and is not retried when the customer
  adds an email later.
- **A late message isn't sent at all.** A reminder goes on its day or not, and
  nothing goes more than a week late. Old news by email is worse than none.
- **Its own settings, not the service desk's Email Templates.** Those are a
  library staff pick from by hand on a service case. These are tied to an event
  and carry timing, so they don't fit the same table.

**Rejected:**

- **A hook in each write path** (receiving, dispatch, handover) that queues
  the email. Each path would need the same opt-out, dedupe and on/off checks
  (rule 42), and the timed messages (the reminder, the review invitation) have
  no write to hook at all. One scan of recorded facts covers every path,
  including ones not written yet.
- **On by default with the suggested wording.** It would mail a deployment's
  customers the moment it upgrades, in words nobody there chose.
- **A store-written template language.** Conditionals in a stored string are
  logic in config (rule 62).

**Enforced by:** `__tests__/integration/customerMessages.integration.test.ts`,
`__tests__/lib/messages/customerMessages.test.ts`, and the unique
`CustomerMessage.dedupeKey`.

**Source:** [`app/src/lib/messages/due.ts`](../app/src/lib/messages/due.ts),
[`docs/domains/email.md`](domains/email.md)

---

## 40. Holt texts only with consent on record, and a STOP belongs to the number

**Decided 2026-11-04 (GAP-12).** The owner asked for texting through a third party,
Twilio first, behind a provider seam, and for store-facing choices to be settings
with strict defaults ("All configurations").

- **Consent is a recorded fact, and strict by default.** `Customer.smsConsentAt` and
  `smsConsentBy`, ticked on the customer form. A phone number on a record isn't
  consent, so nobody is texted without it, and every message starts as email.
- **A STOP is on the number, not the customer** (`SmsOptOut`). That's what the
  provider blocks. Customers share numbers, and the phone is free text typed on each
  record, so a per-customer flag would miss the next record with that number.
- **Accepted isn't delivered.** SENT means Twilio took it. Delivery reports set
  `deliveredAt` or turn the row FAILED, because an unregistered US number's texts are
  accepted, then blocked (error 30034), and a store would otherwise never find out.
- **Each message's text has its own wording.** A text can't be an email with the markup
  off: it's billed by length.
- **Every text says how to opt out,** unless the store's own wording does.
- **No fallback between channels.** A message set to text, for a customer who hasn't
  agreed, doesn't quietly become an email. It's recorded as not sent, with the reason,
  on the order page, and staff can act on that.

**Rejected:**

- **Twilio's SDK.** Twilio's docs advise it for validating signatures. Holt sends one
  REST call and checks one HMAC, as the Square webhook already does, and the SDK is a
  large runtime dependency for that. The check is pinned to the worked example Twilio
  publishes, and to its SDK's handling of repeated parameters.
- **A column for a normalized phone on the customer.** Nothing else needs it, and it
  would be a second home for the number (rule 6). A number is read into E.164 when it's
  used.
- **Filling in a default country** for a number with no country code. It's only read as
  North American where the store's locale says so (rule 63).

**Enforced by:** `__tests__/integration/smsProvider.integration.test.ts`,
`__tests__/lib/sms/sms.test.ts`, and CHECKs holding queued and opted-out numbers to
E.164.

**Source:** [`app/src/lib/sms/consent.ts`](../app/src/lib/sms/consent.ts),
[`docs/domains/sms.md`](domains/sms.md)

---

## 41. A reorder point is a level per store, and a draft doesn't count toward it

**Decided 2026-11-04 (GAP-14).** No owner question was needed: it's a store's own
number, and off until set, as "All configurations" says.

- **Per product per store.** Each store or warehouse stocks for itself, so a level
  across all stores together would call a store fine because another has plenty.
- **Free stock plus sent POs, against the level.** The rows are the allocator's free
  stock and stock POs to this store. A customer's special-order line doesn't count: it
  is spoken for, and counting it would hide the shortage it creates.
- **A draft doesn't count, but isn't suggested twice.** A draft isn't on its way, and
  one left unsent shouldn't silence the warning. The item stays listed until the PO
  goes, showing what's on the draft, and only what the draft doesn't cover is
  suggested.
- **Below the level, not at it.** "Keep at least 3" is satisfied by 3.
- **Ordering reuses the scanned-order filing** (`saveScannedOrder`), so a list and a
  scanner can't file lines two ways.
- **One daily list, by the existing cron.** A message per item would train people to
  ignore it, and a list only goes when something is low.

**Rejected:**

- **Fields on `Product`.** They can't say different numbers for different stores.
- **A nullable store for a chain-wide level.** It's a nullable column in a unique key
  (rule 64), for a level nobody has asked for.
- **Counting drafts as on order,** as the Buyers report does. That report describes
  stock; this one tells someone to act, and an unsent draft is what they'd act on.

**Enforced by:** `__tests__/integration/lowStock.integration.test.ts`,
`__tests__/lib/purchasing/lowStockShared.test.ts`, and CHECKs holding the level and
least order above zero.

**Source:** [`app/src/lib/purchasing/lowStock.ts`](../app/src/lib/purchasing/lowStock.ts),
[`docs/domains/purchasing.md`](domains/purchasing.md)

---

## 42. How old stock is, and what it was worth, read back from the journal (2026-11-04)

**Decided:** Age comes from the stock journal, assuming the oldest sold first, so
what's still here is the newest in. It's counted from when units came onto the books,
and a move between places doesn't restart it. An opening balance or import is reported
as "at least" that old, and units no arrival accounts for are reported as having no
record, in no bucket. Value on a past day is the journal's quantity at today's cost,
labeled as that on the screen. A day before the journal gets no number.

**Why:** the journal is the one record that says when stock moved, and it's already
checked against the balance after every integration test. Nothing records which unit
is which, or what a product cost last year, so these are the strongest claims the
evidence supports. A confident number that's wrong by a believable margin would
survive indefinitely (principle 2), so each report says where its claim stops.

**Rejected:**

- **Age from the last sale.** That's Inventory Health's dead stock, a different
  question. It stays as it is. A sofa received last week that has never sold is dead
  by that measure and new by this one.
- **Age from purchase order lines.** It misses returns, counts and opening stock, and
  it would be a second idea of what's on hand beside the ledger (rule 6).
- **A cost history, added now to value past days.** It can only start from today, so
  it wouldn't answer any past date yet. It's recorded in `ROADMAP.md`.
- **Allowing `occurredAt` on `postMovement`.** A route that could date movements could
  rewrite what the books held on any past day. The seed gets its own named function,
  and a tripwire keeps it out of `src/`.

**Enforced by:** `__tests__/integration/inventoryReports.integration.test.ts`, which
holds Inventory Value to Inventory Health as of today, and Aged Stock plus committed
units to the same units on hand; `AGE_EFFECT`, a `Record` over every journal reason;
`__tests__/stockWriterTripwire.test.ts`.

**Source:** [`app/src/lib/reports/agedStock.ts`](../app/src/lib/reports/agedStock.ts),
[`app/src/lib/reports/inventoryValue.ts`](../app/src/lib/reports/inventoryValue.ts)

---

## 43. A tag's price is what the register charges, and cost goes on it only in code (2026-11-04)

**Decided:** A sale tag's price is the product's retail, and its was price is a field on
the product. A tag's coded cost uses letters the store picks, and prints nothing until it
has. A law tag's wording is the store's template, with a text field on the product for the
part that varies. Printing while receiving is one at a time unless a person chooses
otherwise, remembered per person. A tag named for a store prints only at that store.

**Why:** a tag is a promise to a customer. If it could show a price the register doesn't
charge, the two would disagree on the showroom floor, so there's only one price. The owner
said to make printing one at a time or in a batch the user's choice, and that they prefer
one at a time so they can match products (2026-10-29). What the law asks a tag to say
depends on where the store is, so it's a deployment fact (rule 61).

**Rejected:**

- **Typing a sale price when printing.** The tag would promise a price the register doesn't
  know. Scheduled sale prices that drive tags remain GAP-06.
- **A built-in law tag.** Holt doesn't know each state's law, and would be wrong for
  someone. The demo's template is a sample.
- **A remembered default in the browser.** It wouldn't follow a person to the next device.
- **Falling back to any printer loaded with the size.** The tag would come out in another
  building, where nobody is matching it to a piece.
- **Fetching a picture from another address.** A tag could be made to call out to one.

**Enforced by:** `__tests__/integration/tags.integration.test.ts`, which reads the bytes a
stand-in printer receives over TCP; `__tests__/tagFields.test.ts`; CHECKs on the key, the
was price, the photo size and the print mode.

**Source:** [`app/src/lib/labels/productTag.ts`](../app/src/lib/labels/productTag.ts),
[`docs/domains/printing.md`](domains/printing.md)

---

## 45. What a salesperson keeps belongs to the client, and a note isn't contact (2026-11-05)

**Decided (GAP-36):** salespeople keep what they know about a client on a `ClientProfile`,
one per customer, and in notes that follow the client.

- **A note isn't contact.** Writing down "summer home on the lake" doesn't mean anyone
  reached them. Notes never move days-since-contact or clear a due follow-up. Every reader
  of "last contact" skips them (`lib/interactionSources.ts`).
- **A client note follows the client; a manager's note stays on its quote.** `NOTE` shows on
  all their quotes, and `MANAGER_NOTE` is about the quote it was written on.
- **Assigning a client sets `primaryDesignerId` and nothing else.** Who an order was credited
  to is history, and commission reads it.
- **The form's lists are the store's**, in Settings, with suggestions to start from. An answer
  already on a client survives its choice being removed, because a store tidying a list
  shouldn't blank out or block saving a client's record.
- **Warehouse, Dispatch, Installer and Marketing can read a customer but not this.** A
  client's budget and how likely they are to close aren't needed to deliver a sofa. It takes
  `customer.write` or `sales.lead`.
- **Service charges are found by what they are**, the order's `deliveryFeeLineItemId` or a
  product's `serviceType`, not by a line's name.

**Rejected:**

- **Fixed budget, room and timeline lists.** They were measured on one store (rule 61).
- **Opening `GET /api/interactions` to `customer.read`** so the Notes tab could use it. That
  gives every interaction in the store to roles that have no use for them. The tab reads a
  client's history from its own route, under its own gate.
- **Telling service lines from goods by matching "delivery" or "labor"** in the line's name.
  That only works where a store happens to name them so, and misses the rest silently.
- **A second profile for a client's second project.** One per client for now. It's recorded as
  open in `ROADMAP.md`.

**Enforced by:** `__tests__/integration/clientBookRoutes.integration.test.ts`, with a test
that reaches last contact past four notes and one for each role that's kept out;
`__tests__/integration/pipelineClienteling.integration.test.ts`; the CHECK on
`closeLikelihood`.

**Source:** [`app/src/lib/clientProfile.ts`](../app/src/lib/clientProfile.ts),
[`app/src/lib/interactionSources.ts`](../app/src/lib/interactionSources.ts),
[`app/src/lib/clientAssign.ts`](../app/src/lib/clientAssign.ts)

---

## Adding an entry

When a decision is argued and settled — especially when an alternative was
rejected for a reason that will not be obvious later — add it here, and put the
enforcement where it belongs. An entry earns its place if a competent person
could plausibly undo the decision by accident.
