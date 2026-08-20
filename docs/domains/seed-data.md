# Synthetic Demo Seed

`app/prisma/seed/demo/` generates a complete, SYNTHETIC dataset that looks like it was
created natively through the application — not imported from anywhere. This is what a
fresh `holt` clone (or a test/demo database) gets instead of an empty schema or the real
customer dataset (which can never ship in this public repo).

## Why this exists

1. **holt is open-source.** A real customer's orders and payments cannot ship in a public
   repo. Without a synthetic seed, anyone cloning holt gets an empty database and no way
   to see the system work.
2. **The existing real dataset came through the importer** (see
   `docs/domains/import-pipeline.md`), so it carries the source system's artifacts —
   non-standard payment-type strings, zero payments linked to a till, no journal entries
   at all. It is good for testing the importer and useless for testing the register or
   the ledger.
3. **Nothing else exercises the full native chain end to end.** This seed does, and
   becomes a permanent regression asset: run it, then run
   `generateSalesJournal()` against it, and you have proof the chain from a POS payment
   to a balanced GL entry actually works.

## Quick start

```bash
cd app
export DATABASE_URL="postgresql://user:pass@localhost:5435/holt_seed_demo?connection_limit=20&pool_timeout=10"
npm run seed:demo                    # small "ci" volume (default)
npm run seed:demo -- --scale=demo    # larger, demo-sized volume
npm run seed:demo -- --reset         # wipe an existing seeded DB and reseed
```

`DATABASE_URL` must point at a database you created for this purpose — see
"Target-database safety" below. The script refuses to run without a safe target.

## What it generates, in dependency order

| Step | Module                 | What lands in the DB                                                                                                                                                                            |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `org.ts`               | `Organization` + `AppSettings` (branding, currency/timezone, feature flags on)                                                                                                                  |
| 2    | `accounting.ts`        | Full chart of accounts (`GLAccount`), `AccountGroup` per department, **every** `SystemGLMapping` row the journal generator can look up, CT `TaxDistrict`/`TaxGroup`/`TaxRule`/`TaxExemptReason` |
| 3    | `locations.ts`         | 2 `StoreLocation`s + 1 warehouse, their `StockLocation`s (incl. one `holdsCommittedStock` staging bay, deliberately not named "Customer…"), 2 `Register`s per store                             |
| 4    | `staff.ts`             | `StaffMember` + linked `User` across all 6 real roles, with working local-login passwords                                                                                                       |
| 5    | `catalog.ts`           | `Department` → `Category` → `Type` taxonomy, invented `Vendor`s, `Product`s with cost AND retail                                                                                                |
| 6    | `customers.ts`         | `Customer` + `CustomerAddress`, a trade/tax-exempt slice                                                                                                                                        |
| 7    | `commissionPlan.ts`    | `CommissionPlan` + `CommissionPlanTier` (two plans — see "Commission model" below)                                                                                                              |
| 8    | `salesOrders.ts`       | `SalesOrder` + `OrderLineItem` + `Invoice` + `Payment` + `Till`/`TillCount`, ~18 months                                                                                                         |
| 9    | `purchasing.ts`        | `PurchaseOrder` + `PurchaseOrderItem` + `ReceivingRecord`                                                                                                                                       |
| 10   | `consignment.ts`       | A GENERIC consignment `Vendor` + `ConsignmentReceipt`/`ConsignmentItem`/`ConsignmentPaymentBatch`                                                                                               |
| 11   | `inventory.ts`         | `InventoryPosition` across floor / back stock / warehouse bulk / committed staging                                                                                                              |
| 12   | `service.ts`           | `ServiceCase` + `ServiceCaseNote` and the three operator-editable lookup tables                                                                                                                 |
| 13   | `operations.ts`        | `Ticket` + `TicketMessage` (Helpdesk), `TimeEntry` + `StaffShift` (Time)                                                                                                                        |
| 14   | `commissionPayouts.ts` | Real `CommissionPayout` rows via `lib/runCommissionPayouts.ts`'s `commitPayoutsForPeriod`                                                                                                       |
| 15   | `journal.ts`           | Real `JournalEntry`/`JournalEntryLine` rows via `lib/journalEntry.ts`'s `generateSalesJournal`                                                                                                  |

Everything is realistic-but-clearly-fake: invented names, `@example.com` emails, made-up
CT-area addresses, invented furniture-trade vendor names. No real people, no real
vendors, no data copied from any real dataset — only the _shape_ of a real furniture
retailer's numbers (see "Distribution choices" below).

## Commission model: tiers, not rules

The task that produced this seed was written against a rebase onto `origin/main` with two
PRs "merging right now": a declarative commission RULE engine
(`CommissionPlanRule`/`CommissionRuleTier` with basis/accumulator/tierMode) and
configurable imports. **As of that rebase (`feat/demo-seed-data` on top of `origin/main` @
`35aecb2`), neither had landed on `main`** — `grep -c "CommissionPlanRule\|CommissionRuleTier"
prisma/schema.prisma` returns 0. The rule engine exists only on the still-open
`origin/feat/commission-rule-engine` branch (merge-base `35aecb2`, one commit ahead: "feat(commission):
declarative rule engine"). Configurable imports exists only on `origin/feat/configurable-importers`,
also unmerged, and doesn't touch the schema in any way relevant to this seed.

So `commissionPlan.ts` seeds the **current** model: `CommissionPlan` + `CommissionPlanTier`,
exactly what `lib/commissionPlans.ts` and `lib/runCommissionPayouts.ts` consume today. Two
plans are created:

- **"Standard Design Team"** (the default) — marginal tiers at 3%/4%/5%/6%/7%, thresholds
  scaled down from `lib/commissionTiers.ts`'s `DEFAULT_COMMISSION_TIERS` (tuned for a
  $750k–$2M/yr real store) to a $0–$600k range this seed's synthetic volume can actually
  reach and cross mid-year.
- **"Senior Design Partner"** — richer tiers (4%/5.5%/7%/8.5%), assigned to the two most
  senior seeded designers, demonstrating the per-staff plan-override path.

If/when the rule-engine branch merges, `commissionPlan.ts` (and the "senior plan" bit of
`index.ts`) is what to convert to `CommissionPlanRule`/`CommissionRuleTier`.

## Distribution choices

All shaped by a single seeded PRNG (mulberry32, see `rng.ts`) — no `Math.random()`
anywhere in the seed. Measured _shape only_ from a real furniture retailer; no actual
data is copied.

### Order value — heavily right-skewed

Modeled as a piecewise log-linear interpolation across quantile control points
(`rng.ts`'s `sampleOrderValue`), not a plain log-normal — a single log-normal can't be
tuned to match a median, a p95, AND a mean simultaneously (3 constraints, 2 parameters).
Control points: `(u=0 → $8, 0.25 → $38, 0.50 → $107, 0.75 → $410, 0.95 → $5,545, 0.99 →
$11,000, 0.999 → $30,000, 1.0 → $65,000)`. A fat tail above p95 (0.5% of orders reaching
into the tens of thousands) is what pulls the mean up to the target despite the low
median — exactly how a real long tail behaves. Verified at N=300k synthetic draws: p25
$37.88, p50 $106.96, p75 $409.40, p95 $5,526.91, mean $1,007.44 (targets: $38 / $107 /
$410 / $5,545 / ~$1,033). An actual seed run (ci scale, N=420 orders) measured p25
$41.87, p50 $102.30, p75 $429.21, p95 $5,335.08, mean $1,128.21 — within normal sampling
noise at that N.

### Line items per order — mean 2.5

Weighted discrete distribution: 1 item 30%, 2 items 25%, 3 items 20%, 4 items 15%, 5
items 10% → E[count] = 2.50 exactly.

### Monthly seasonality

Relative order-count weights by calendar month (Jan 1097 … Dec 2459, December ≈3.5×
February), applied per calendar month regardless of which year it falls in within the
18-month window, so the pattern repeats. See `config.ts`'s `MONTHLY_SEASONALITY`.

### Payment mix by row count

Target: 85% card, 4% cash, 3% gift card, 2% store credit, 6% refunds (of all Payment
rows, not orders). Achieved by drawing the base tender independently per order from
`{CARD:85, CASH:4, GIFT_CARD:3, STORE_CREDIT:2}` (sum 94), then flagging a refund on
`INVOICED_SHARE × REFUND_PROBABILITY_GIVEN_INVOICED = 0.70 × 0.0911 ≈ 6.38%` of _orders_
— which, once refund rows are added on top of one row per order, lands refund ROWS at
`0.0638 / 1.0638 ≈ 6.0%` of all payment rows (see `orderPlan.ts` for the derivation).
Measured at ci scale: 85.3% / 3.6% / 2.5% / 2.5% / 6.25% (N=448 payment rows). Measured
at demo scale (N=6,384 rows): 85.0% / 4.2% / 2.9% / 2.0% / 6.0% — very close to target at
the larger N, as expected.

### Invoiced vs. deposit-only orders

~70% of orders get an `Invoice` row at time of sale (immediate/floor purchases), so
`generateSalesJournal` recognizes real Sales/COGS/Inventory/Tax that day. The other ~30%
stay un-invoiced (special orders awaiting delivery) and book purely as "Pmt On Acct" —
matching `docs/domains/accounting.md`'s own worked sample, where deposits dwarf same-day
revenue on a typical day. `InvoiceLineItem` rows are deliberately NOT created:
`generateSalesJournal` only checks `invoices.length > 0`, never their contents, and
skipping them lets `OrderLineItem` rows batch through `createMany` instead of one round
trip per line (meaningful at demo scale — 6,000 orders × ~2.5 lines each).

### Helpdesk tickets and time

The last two dark nav sections. Both are small domains with their own top-level
entry that rendered an empty screen on a fresh clone, seeded together because
neither justifies its own module and both answer the same question — does this
part of the product do anything?

**Tickets** are the no-login customer support surface, and every seeded ticket
carries a `publicToken`, because that token IS the authorization for
`pages/api/tickets/public/[token].ts`. Seeding tickets without tokens would
leave that whole path unexercised while looking populated. Messages are seeded
**both internal and customer-visible** in equal number: the public endpoint
filters internal notes out, and a ticket with only public messages cannot
demonstrate that it does.

**Time entries** are billable-consultancy shaped (`isBillable`, `billedAt`) —
the Akritos deployment's case rather than the furniture one. A mix of billed and
unbilled is what makes a "what can I invoice" view non-empty.

**Shifts** include exactly one still open (`clockOut: null`). A board where
nobody is clocked in cannot show its own primary state.

Measured: 18 tickets (13 open) with 18 internal / 18 public messages, 60 time
entries with 2,895 unbilled minutes, 9 shifts with 1 open.

### Service cases

The Service nav section is six pages and every one was empty on a fresh clone,
because `ServiceCase` and its three lookup tables had no rows. A furniture
retailer's after-sale problems are not a side feature; a demo that cannot show
one is not showing the product.

The lookup tables are seeded as **config, not constants**. `ServiceCaseType`,
`ServiceCaseStatus` and `ServiceCasePriority` are operator-editable rows with
`isActive`/`sortOrder`, so the seeded vocabulary (Warranty Claim, Delivery
Damage, Missing Parts, …) is a starting point a deployment edits — nothing in
`src/` references any of those names.

The status mix is shaped, ~65% closed: a queue where every case is New exercises
no filter, and one where every case is Closed shows an empty default view.
Measured on a seeded database: 24 cases — 7 New, 1 In Progress, 4 Waiting on
Vendor, 5 Resolved, 7 Closed — with 48 internal notes, because a case detail page
is mostly a timeline and a timeline with one row does not look like one.

Still dark after this: Helpdesk (`Ticket`) and Time (`TimeEntry`, `StaffShift`)
are each their own nav section with no seeded rows.

### On-hand stock

`InventoryPosition` was empty until this was added, which left the Inventory
Health report rendering nothing, the Buyers report with no on-hand column, and
the committed-stock split with no rows to split.

The distribution is shaped to give those surfaces signal rather than a uniform
pile — a uniform pile makes every report look right and tests nothing:

| where                                | what it exercises                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Showroom floor + back stock          | the normal case, spread across both showrooms                                                                         |
| Warehouse bulk (~⅓ of catalog)       | depth, the "held in quantity" case                                                                                    |
| Committed staging (25 positions)     | sold-but-undelivered stock on the bay whose `holdsCommittedStock` is true, carrying the `salesOrderId` it is held for |
| ~15% of products, no position at all | keeps "never stocked" distinguishable from "stocked but zero"                                                         |

The committed slice matters beyond filling a table. `lib/inventory/allocation.ts`
and `reports/buyersReport.ts` must exclude that stock from AVAILABLE, and the
**flag** is how they should find it — not by matching a location name against
`Customer%`, which is one deployment's naming convention
(`docs/tenant-literal-sweep.md`). Seeded data now makes the correct behaviour
observable and the literal-matching behaviour visibly wrong.

Measured on a seeded database: 261 positions, 1,178 units — 1,122 available and
56 committed across 25 orders, with 70 units qualifying as dead stock.

**Deliberately not modelled:** uncosted units. Inventory Health buckets stock
whose product has a null or zero `baseCost`, and this catalog costs every
product, so that KPI reads zero. Seeding a fake uncosted product to make a tile
non-empty would invent a data-quality problem the demo does not have.

### Refunds — sales-in-reverse, not a hand-waved Payment row

Refunds are modeled on invoiced orders only, as a same-day mirrored NEGATIVE
`OrderLineItem` (the exact "sales-in-reverse" shape `lib/journalEntry.ts`'s
`resolveReturnBookingPath` books) plus a second `Payment` row (`isRefund: true`, positive
`paymentAmount` — `processRefund`'s real sign convention) **and a native `Return`
record**.

That last part changed. This seed originally created no `Return` row, deliberately,
"matching how every imported historical return looks". That contradicted the seed's own
purpose: it generates data that looks like it was created NATIVELY through the
application, and a native refund without a `Return` is the IMPORTED shape. The
consequence was that the entire returns domain — the warehouse queue, the pickup
schedule, the return detail pages — was empty on a freshly seeded database, and
`lib/journalEntry.ts`'s B3 classified-return path was never exercised by any seeded row.

Returns are now seeded with a deliberate disposition mix, roughly 50% `RESTOCKED`
(`LIKE_NEW`), 20% `WRITTEN_OFF` (`MAJOR_DAMAGE`), 30% `RECEIVED` and uninspected. The
mix is the point: `RESTOCKED` and `WRITTEN_OFF` are decided facts that book differently
(a write-off debits the department's shrinkage GL instead of inventory), while an
uninspected return falls through to the default-restock ASSUMPTION. Seeding only
classified returns would leave that default path untested.

Verified on a seeded database: 28 returns (12 restocked, 8 written off, 8 uninspected),
journal entries still balanced, and one journal line landing on a shrinkage account —
the B3 write-off path, previously unreachable from seeded data.

**What this does NOT light up**, stated because it is the obvious assumption: the
Unclassified Returns report (`lib/reports/unclassifiedReturns.ts`) queries orders with
`status = "RETURNED"` and finds their negative lines. This seed models a refund as a
negative line on the ORIGINAL order, so it produces zero `RETURNED` orders and that
report stays empty — before and after this change. A native uninspected `Return` is
unclassified in every sense that matters, and that report cannot see it; whether the
report should is a question about the report, not the seed. Restricting refunds to invoiced orders is deliberate: an un-invoiced order's
line items never reach `buildJournalLines` (they take the deposit-only branch), so a
mirrored negative line there would be inert. This is what keeps the generated journal
genuinely balanced on refund days _without_ leaning on the Over/Short line to paper over
an un-reversed sale — which is the exact failure mode this seed exists to avoid (see
"Target: no unmapped payment types" below).

### Till sessions and variance discipline

One `Till` per (register, calendar day) that has orders. Expected cash is tracked
directly from the CASH-tender payments/refunds created for that session (mirrors
`paymentService.ts`'s `calculateTillExpected` bucket-only-cash logic). Actual cash is
`expected + variance`; variance is small noise (±$3) for the vast majority of sessions,
except three DELIBERATELY forced sessions spread through the timeline that each land
above one of `lib/tillVariance.ts`'s three thresholds:

| Tier       | Threshold | Seeded variance |
| ---------- | --------- | --------------- |
| NOTE       | > $5      | −$12.50         |
| MANAGER    | > $20     | +$47.20         |
| ESCALATION | > $100    | −$162.40        |

The ESCALATION session is placed near the END of the window (second-to-last till
session) and its register is left blocked as of the seed's reference date — calling the
REAL `applyRegisterVarianceBlock()`/`classifyTillVariance()` from `lib/tillVariance.ts`,
not a re-implementation, so the `Register.blockReason` text matches production exactly.
The very last till session of all is left `OPEN` (no close), as if "today" hasn't ended
yet.

## Target-database safety (rule 59)

CLAUDE.md rule 59: _"`fbc_test_db` is the only database tests may write. `saybrook`,
`holt_saybrook`, and `akritos` hold restored or seeded data and must never be written by
a test or script."_ This seed writes thousands of rows outside a transaction — more
dangerous than a test run against the wrong database, since there's no
TRUNCATE-and-retry safety net. `guard.ts`'s `assertSafeSeedTarget()` enforces:

- **Hard-blocked, no override, ever:** `fbc_test_db` — owned exclusively by the Jest
  integration harness (`jest.integration.setup.ts`); seeding into it would corrupt every
  integration test run until someone noticed.
- **Blocked unless `--force-unsafe-db` / `HOLT_SEED_FORCE_UNSAFE_DB=1`:** `saybrook`,
  `holt_saybrook`, `akritos`, `fbc_dev_db` — real dev/restored/curated data.
- Anything else (e.g. a scratch database like `holt_seed_demo`) is allowed.

The guard runs before the shared `@/lib/prisma` singleton is even imported, so a refused
target never gets so much as a connection pool constructed against it.

## Re-running: idempotent-by-refusal, not per-row upsert

Given the volume and the number of interlinked entities without natural unique keys
(`SalesOrder`, `Payment`, `OrderLineItem`, `Product`, ...), per-row upsert idempotency
would be its own large project. Instead: on startup, the script checks for the
`Organization` it creates (slug `holt-home-rug-co`). If found and `--reset` was NOT
passed, it refuses and exits 1 rather than half-seed on top of existing data. If found
and `--reset` WAS passed, it `TRUNCATE ... RESTART IDENTITY CASCADE`s every table (the
same table list `src/lib/testing/withTestDb.ts` uses for the integration-test harness,
imported directly — one source of truth for "every table," not two lists that can drift)
and reseeds from scratch. Two consecutive `--reset` runs with the same volume/date
produce byte-identical row counts and journal totals (verified — see below).

## Determinism

Every run with the same `--scale` and `--as-of` (or `HOLT_SEED_AS_OF`) produces
byte-identical data: one fixed root RNG seed (`config.ts`'s `ROOT_SEED_STRING =
"holt-demo-seed-v1"`), sub-streams derived deterministically per concern (`rng.ts`'s
`subRng`) so adding a new random draw in one module doesn't reshuffle another module's
sequence.

**The date window is anchored to a fixed constant, not `new Date()`.** True determinism
("two runs produce identical data") is impossible if any input is the live clock — the
window would silently drift a day at a time and break reproducibility for anyone
re-running the seed later. `config.ts`'s `seedWindow()` defaults to `2026-08-01` (today,
as of when this seed was authored) and spans 18 months back from there.
`HOLT_SEED_AS_OF=YYYY-MM-DD` (or `--as-of=`) overrides the anchor for a freshly-dated
dataset later — the default is what keeps a run today and a run five years from now
producing the same rows.

Verified directly: two consecutive `npm run seed:demo -- --reset` runs at ci scale
produced identical output — same 420 orders, 448 payments (28 refunds), 362 closed tills
and 1 open, identical journal totals to the penny for all 6 sampled days.

## Timezone

`generateSalesJournal(date, ...)` computes its day window from `businessDayRange()`
against `AppSettings.timezone` — the deployment's **business** day. Every payment
timestamp this seed writes is constructed with `Date.UTC(...)`, so a seeded payment near
either end of a UTC day can land in the adjacent journal whenever the configured
timezone is not UTC. `DEFAULT_APP_SETTINGS.timezone` is `America/New_York`, so that is
the default case, not the exotic one.

`npm run seed:demo` sets `TZ=UTC` at the process-env level in the script itself, and
`index.ts` also sets `process.env.TZ = "UTC"` as its first statement. Note what that
does and does not buy now: it pins the seed's own `Date` construction, but it no longer
governs the journal window, which reads app settings rather than the process timezone.

This section previously said the window used `setHours` — **local** process time. That
was true until the business-day fix, and it was why `TZ=UTC` mattered so much: the
journal silently followed whatever timezone the host happened to have.

## Volume knob

|                                          | `ci` (default)                      | `demo`                                  |
| ---------------------------------------- | ----------------------------------- | --------------------------------------- |
| Flag / env                               | `--scale=ci` / `HOLT_SEED_SCALE=ci` | `--scale=demo` / `HOLT_SEED_SCALE=demo` |
| Orders                                   | 420                                 | 6,000                                   |
| Customers                                | 180                                 | 1,400                                   |
| Products                                 | 160                                 | 500                                     |
| Designers                                | 6                                   | 10                                      |
| Purchase orders                          | 40                                  | 260                                     |
| Consignment items                        | 30                                  | 140                                     |
| Measured runtime (local Docker Postgres) | ~4s                                 | ~40s                                    |

`ci` is sized for fast, disposable runs in CI or local iteration. `demo` is sized so
dashboards, reports, and the commission tier ladder all have enough volume to look real,
while still finishing in under a minute on a laptop.

## Verification checklist

Run against a scratch database (never a shared/dev/prod one — see "Target-database
safety" above):

```bash
export DATABASE_URL="postgresql://user:pass@localhost:5435/holt_seed_demo?..."
npx prisma migrate deploy   # or db push, on a fresh database
npm run seed:demo
```

Then check:

- [ ] Row counts across every entity (the script prints a summary; or query directly —
      see the table above for what to expect at each scale).
- [ ] `generateSalesJournal` produced BALANCED entries — the script itself asserts this
      (it throws if `assertBalanced` fails) and prints `debits=X credits=X balanced=true`
      for each sampled day. "Journal warnings: none" confirms no payment type or
      account-group leg fell through unmapped.
- [ ] No `Payment.paymentType` value outside the `METHOD_DISPLAY`
      (`src/lib/paymentMethodDisplay.ts`) set — e.g.
      `SELECT DISTINCT "paymentType" FROM "Payment";` should only ever show `Cash`,
      `Card`, `Check`, `Gift Card`, `Store Credit`, `Wire`, `ACH`, `Finance`, `Other`.
- [ ] At least one `Till` with `|variance|` above each of the three thresholds (see
      table above) — `SELECT id, variance, notes FROM "Till" WHERE variance IS NOT NULL
AND abs(variance) > 5 ORDER BY abs(variance) DESC;`
- [ ] At least one `CommissionPayout` with `lockedAt IS NOT NULL`.
- [ ] `npx tsc --noEmit` clean, `npx jest --selectProjects unit` green, `npm run
validate` 0 errors (note: `npm run lint`/`format:check` only scan `src/`, not
      `prisma/` — the seed's own tsconfig, `prisma/seed/tsconfig.seed.json`, is what
      `npx tsc --noEmit -p` that file checks; the root `npx tsc --noEmit` also picks up
      everything under `prisma/seed/demo/` via its `**/*.ts` include pattern).

When done, drop the scratch database — this seed is for testing/demo, not a database to
keep around.

## What was deliberately left out, and why

- **The AR ledger (`CustomerLedgerEntry` / `Customer.openArBalance`).** Not in the task's
  explicit generation list, and it's a parallel subsystem to the JE pipeline (per
  `docs/domains/accounting.md`: "Distinct from the JE pipeline above"). Populating it
  only for the subset of flows this seed touches (payments, refunds) without also
  covering sales/adjustments would leave it in a WORSE, half-consistent state than not
  touching it at all — every seeded `Customer.openArBalance` stays at its schema default
  rather than drifting from a partial implementation.
- **`InvoiceLineItem` rows.** `generateSalesJournal` never reads them (only
  `invoices.length > 0`), and skipping them lets order-line creation batch through
  `createMany`. See "Invoiced vs. deposit-only orders" above.
- **`Return` records.** Every refund in this seed takes the
  `UNCLASSIFIED_DEFAULT_RESTOCK` booking path (no `Return` row), matching how every
  _imported_ historical return looks today — see `docs/domains/returns.md`. Generating
  classified `RESTOCKED`/`WRITTEN_OFF` `Return` rows to exercise the B3 write-off branch
  would be a reasonable follow-up but wasn't in scope here.
- **`prisma/seed/tax.ts` was not reused directly.** Its `new PrismaClient()` (no driver
  adapter) throws under Prisma 7 — `PrismaClientInitializationError: PrismaClient needs
to be constructed with a non-empty, valid PrismaClientOptions` — a pre-existing issue
  unrelated to this change (confirmed by running it standalone against a live database).
  `accounting.ts` seeds the same CT/6.35%/3-exempt-reason data directly through this
  seed's adapter-backed client instead of importing a script that currently can't run.
