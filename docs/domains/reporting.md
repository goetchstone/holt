# Reporting

Sales dashboards, salesperson reports, consignment summaries, tax reports. All reports aggregate order line item data and must follow consistent filtering rules.

## The Cancelled Line Rule

**Every query that sums or counts line item amounts MUST include `lineItemStatus: { not: "CANCELLED" }`.** No exceptions. Cancelled lines from orphan cleanup or manual cancellation inflate totals if not filtered. This is CLAUDE.md rule 33.

## The Nullable-Column NULL Trap

Postgres uses three-valued logic. Any comparison against NULL evaluates to UNKNOWN, not FALSE. UNKNOWN propagates through OR/AND/NOT. WHERE clauses drop UNKNOWN rows silently. **A naked `not:` or `notIn:` filter on a nullable column will silently drop every row where that column is NULL.**

This bug class has hit the codebase three times so far:

| Field | Bug | Resolution |
|---|---|---|
| `Payment.status` | 2026-04-17: `status: { not: "VOIDED" }` excluded 44K legacy NULL rows from till reconciliation. | CLAUDE.md gotcha. Use `OR: [{ status: null }, { status: { not: "VOIDED" } }]`. |
| `OrderLineItem.productName` | 2026-05-05: `where.NOT = { OR: [{ productName: { equals: 'Delivery Charge' } }, ...] }` silently dropped 172 ACTIVE rows ($91K) where productName was NULL — Julia Filippone SO-1660 line 2. | Restructured `buildLineItemWhere` in `lib/salesBySalesperson.ts` to `AND: [{ OR: [{ productName: null }, { AND: [per-name not-equals clauses] }] }]`. Tripwire tests in `__tests__/salesBySalesperson.helpers.test.ts`. |
| `OrderLineItem.lineItemStatus` | Schema declares non-nullable but 67K legacy rows hold NULL — same trap latent. | Migration `20260505_backfill_lineitem_status_nulls` UPDATE-sets all NULLs to `'ACTIVE'`. Schema and data now agree, no code-level guard required. |

**Canonical pattern for any new filter on a nullable column:**

```typescript
// equality where NULL should be treated as "matches" (rare):
{ OR: [{ col: null }, { col: "X" }] }

// inequality where NULL should pass through (common — "exclude rows
// equal to one of these specific values"):
{ OR: [{ col: null }, { col: { not: "X" } }] }

// for a list of values to exclude, wrap the per-value not-equals in AND:
{ OR: [{ col: null }, { AND: [
  { col: { not: "A" } },
  { col: { not: "B" } },
] }] }
```

**Never use:**

```typescript
{ NOT: { OR: [{ col: { equals: "A" } }, { col: { equals: "B" } }] } }   // NULL rows dropped
{ col: { notIn: ["A", "B"] } }                                          // NULL rows dropped
{ col: { not: "X" } }                                                   // NULL rows dropped
```

If you find yourself writing one of those, check whether the column is nullable. The schema is the source of truth (`?` after the type means nullable in Prisma).

## The netPrice = Line Total Rule

**`OrderLineItem.netPrice` stores the LINE TOTAL, never the unit price.** Do NOT multiply `netPrice` by `orderedQuantity` in report calculations — that inflates totals for any multi-qty line item (rug pads by the sq ft, labor hours, etc.).

Correct: `SUM(netPrice) + SUM(vatAmount)` for an order total.
Wrong: `SUM(netPrice * orderedQuantity) + SUM(vatAmount)` — the 2026-04-17 bug that affected every balance display and 5 reports.

To get unit price, divide: `netPrice / orderedQuantity`.

**`OrderLineItem.cost` follows the SAME invariant: it is the LINE cost (already
multiplied by quantity), never the unit cost.** All readers sum it raw —
`journalEntry.ts` (COGS/Inventory postings), `dailyReconciliation.ts`,
`grossMargin.ts`, `topSellers.ts`, `buyersReport.ts`, `salesBySalespersonReport.ts`.
Write paths must multiply per-unit sources by quantity before storing
(`create-from-cart.ts`, `line-items.ts` add — both resolve a per-unit
`baseCost`), and the qty-edit endpoint scales `cost` proportionally with the new
quantity. Bug history (2026-06-10): the POS wrote unit cost while every reader
assumed line cost, and the designer dashboard compensated by multiplying ×qty —
both wrong, fixed together; tripwire `__tests__/designerDashboardCost.test.ts`.

Files that enforce this (audit regularly):

- `pages/api/dashboard/sales-summary.ts`
- `pages/api/reports/salesperson-detail.ts`
- `pages/api/reports/monthly-performance.ts`
- `pages/api/reports/designer-dashboard.ts`
- `pages/api/reports/sales-performance.ts`
- `pages/api/exports/windfall-sales.ts`

Files to audit (may aggregate without filtering):

- `pages/api/reports/detailed-sales.ts`
- `pages/api/reports/sales-daily.ts`
- `pages/api/reports/tax-summary.ts`

## Order Status Filter

Sales reports include orders with status: ORDER, FULFILLED, RETURNED. Exclude QUOTE and CANCELLED.

Non-merchandise part numbers excluded from revenue totals: `DELIVERY CHARGE`, `HD-FREIGHT`, `LABOR-HD`.

### Canonical constant — `SALES_REVENUE_STATUSES`

Use `import { SALES_REVENUE_STATUSES } from "@/lib/salesOrderRevenue"` for any aggregation that asks "what did this customer / campaign / segment / department actually generate in revenue?" The constant is exactly `["ORDER", "FULFILLED", "RETURNED"]`. Negative netPrice rows on RETURNED orders (accounting-return the return prefix rows) are what NET out the rewrite chain (base + return + rewrite). Filtering to just `["ORDER", "FULFILLED"]` silently double-counts every rewritten sale by the full base amount.

**User-reported origin** (2026-05-13): Barbara Germano's Mailchimp Campaign Impact line showed "2 Orders for $88,624" when her actual net spend was $61,922. The missing $26K was a single the return prefix return that the report's WHERE clause filtered out via `status: { in: ["ORDER", "FULFILLED"] }`. Fix swept five surfaces in one PR (Mailchimp list + detail endpoints, Wealth Insights, three customerLeveling raw-SQL sites).

**Legitimate narrower filters** — these are NOT bugs and intentionally exclude RETURNED:

| Surface | Filter | Why |
|---|---|---|
| `lib/opportunityTiles.ts` | `["ORDER", "FULFILLED"]` | "Does the customer OWN this product today?" — returned items came back, so they don't own them. |
| `pages/api/dispatch/*` | `"ORDER"` | Dispatch boards filter active orders awaiting fulfillment. |
| `pages/api/purchasing/needs-ordering.ts` | `"ORDER"` | Purchasing pipeline — RETURNED orders don't need PO matching. |
| `pages/api/consignment/import/backfill-from-POS.ts` | `["ORDER", "FULFILLED"]` | Marks consignment items SOLD only when there's a positive sale. A returned consignment item should NOT be flagged SOLD just because an the return prefix row references it — return-detection elsewhere reverts it to ON_FLOOR. |

Each narrower-filter site has an inline comment explaining the choice so future grep audits can distinguish "intentionally narrower" from "forgot RETURNED."

**Tripwires**:

- `__tests__/reports.salesRevenueStatusFilter.test.ts` — source-text (B-) lists every revenue-aggregation surface and asserts each one uses the canonical constant or includes all three status values inline.
- `__tests__/integration/mailchimpAttributionRewriteChain.integration.test.ts` — real-DB (B) pins the actual money math against a fixture replicating Barbara Germano's rewrite chain.

After deploying this fix (post-2026-05-13), run `POST /api/customers/recalculate-levels` once to update `Customer.lifetimeSpend` for every customer who had a rewrite or return in their history.

## Role Filtering

- MANAGER sees all reports
- DESIGNER sees: Designer Dashboard and Sales by Salesperson (server scope-locks the latter to their own data — they verify their numbers there). Pay Period Sales + Team Commission are **SUPER_ADMIN-only as of 2026-05-29** (tabled — owner-only until management adopts them; code parked). Monthly Performance and Salesperson Detail are also hidden from the nav (pages/APIs kept in the repo).
- **Who counts as a "designer" on designer-based reports** is the `StaffMember.isDesigner` flag, NOT the auth `role` (2026-05-29). It's set on `/admin/staff` and drives the designer pickers (`GET /api/staff?isDesigner=true`), the pay-period confirm/issue grid, and the Team Commission view. A selling MANAGER can be flagged in; an ex-designer flagged out — without touching their login role.
- Non-manager salesperson reports filter to the caller's own data (enforced in API)
- Report page cards use the `roles` prop on `CardGridPageLayout` to hide cards per role

### Canonical auth shape for report API endpoints

**Use `requireAuthWithRole(["MANAGER", "ADMIN", "SUPER_ADMIN"], handler)` from `lib/auth/requireAuth.ts`** — NOT a hand-rolled `getServerSession` + cast to `session.user.role`. The NextAuth session shape **does not include `role`** — the field lives on `StaffMember` and is queried by `userId`. Any handler that reads `session.user.role` directly gets `undefined` and 403s every authenticated user.

The helper also bakes in:

- SUPER_ADMIN auto-grant for ADMIN-required endpoints (it's strictly more privileged)
- Impersonation-cookie handling (`sh-impersonate`)
- The first-user bootstrap safeguard (if no privileged user exists, the role check is skipped so the first admin can promote themselves)

Bug class hit prod 2026-05-28 on `/api/reports/traffic`. Source-text tripwire `__tests__/reportApiAuthShape.test.ts` now walks every file under `pages/api/reports/` and fails the suite if any of them reads `session.user.role` directly OR has no recognizable auth guard (`requireAuthWithRole`, `requireAuth`, `withAuth`, or bare `getServerSession`).

Endpoints that only need auth-without-role (e.g. designer dashboards filtering to the caller's own data) can use `getServerSession(req, res, authOptions)` directly with a manual 401 — that's also caught by the tripwire as a valid guard.

## Salesperson Detail Drilldown

Four levels: Month -> Customer -> Order -> Line Items. Split sales (50/50) show half amounts at every level. The `splitWithId` field on SalesOrder indicates a split.

## Sales by Salesperson (HR comp)

Report at `/reports/sales-by-salesperson` for HR's compensation structure. Date-range totals with retail / cost / margin and a group-by toggle (salesperson / department / customer). Multi-select department + multi-select salesperson filters. Drill down to line items, export either view to CSV.

### Math

- Pure helpers in `lib/marginMath.ts` — `aggregateMargin`, `applySplit`, `formatMarginPct`, `imputeMissingCost`.
- `applySplit` halves BOTH retail and cost so margin % stays correct across partners. `aggregateMargin` uses `retail !== 0` (not `> 0`) so return-day rows with negative retail still produce a meaningful margin %.
- **`imputeMissingCost` (added 2026-04-29 / PR #160)** — when a line has non-zero retail but cost = 0 (the common shape for auto-created products without a vendor cost feed), treat its cost as `retail / 2` so margin reads as 50 % rather than the misleading 100 %. Sign-preserving (returns get the same treatment), idempotent on already-populated lines, idempotent on fully-zero lines. Apply BEFORE `applySplit` and `aggregateMargin` — it's a data-cleaning step. Order doesn't actually matter (split halves both sides) but data-cleaning-first is the convention.

### Filtering and bucketing — match by name OR id

The the POS sales import only populates `SalesOrder.salesperson` (string), never `SalesOrder.salesPersonId` (FK). Verified 2026-04-29: 863 of 878 April orders had NULL `salesPersonId`. Any salesperson-aware filter or bucketing MUST match both:

- Use `applySalesPersonFilter(orderWhere, { ids, names })` from `lib/salesBySalesperson.ts`. It emits one OR clause per name (Prisma `in` is case-sensitive on string columns; each name uses `equals` + `mode: "insensitive"`).
- Use `effectiveStaffId(order, idByLcName)` in `bucketBySalesperson` — when the FK is null but the name matches a known staff `displayName`, route the order into the same `sp-${id}` bucket as FK-linked rows. Without this, unlinked + linked orders for the same person split across two rows and the report grossly understates totals (PR #162 root cause).
- For drilldowns: `narrowSalesperson` in `pages/api/reports/sales-by-salesperson/items.ts` handles three group-key shapes: `sp-${id}` ORs in a `(salesPersonId IS NULL AND salesperson = displayName insensitive)` clause; `sp-name-${name}` is scoped to FK-null only (so bucket and drilldown stay consistent); `sp-unassigned` matches both fields null.

If you build a new salesperson-aware report, copy this pattern. Filtering only by FK silently drops ~98 % of orders.

### Non-merchandise filter (HR comp vs. accounting view)

`buildLineItemWhere(departmentNames, includeNonMerch = false)` excludes `DELIVERY CHARGE`, `HD-FREIGHT`, `LABOR-HD` by default — the comp convention used by Monthly Performance. When the user toggles "Include delivery / freight / labor" on the report (PR #161), `includeNonMerch = true` and the partNo filter is dropped, so totals reconcile to Detailed Sales. The CSV export header records which mode produced the file. The cancelled-line filter (rule 33) is unconditional — never optional.

### Role gate

- `resolveSalesPersonFilter(session, requestedIds)` returns both `resolvedIds` AND `resolvedNames` (looks up displayNames for the requested staffIds). The names are passed to `applySalesPersonFilter`.
- Designers are auto-locked to their own `staffId` + `displayName` server-side. ADMIN / MANAGER / MARKETING see all. Non-staff users get an empty response (returned as 200 with empty rows, not a 403).

### Tests and tripwires

- `__tests__/marginMath.test.ts` — A-grade pure-helper coverage of `aggregateMargin`, `applySplit`, `imputeMissingCost`, `formatMarginPct`. 21 tests.
- `__tests__/salesBySalesperson.helpers.test.ts` — A-grade coverage of `buildLineItemWhere` (8 tests) + `applySalesPersonFilter` (5 tests, the new shape).
- `__tests__/reports.cancelledLineFilter.test.ts` — rule-33 tripwire follows the `buildLineItemWhere` import path to the helper file and asserts the filter there. Explicit pin test on the helper itself so deletion fails loudly rather than silently weakening every endpoint that delegates to it.

### Cross-report sanity check (lesson learned 2026-04-29)

Any new report that aggregates sales totals must be cross-validated against an existing report (Monthly Performance / Detailed Sales) for at least one known salesperson before declaring done. The 2026-04-29 reconciliation bug shipped through three rounds of feature work because no one ran the new report side-by-side with Monthly Performance for a known name. A two-number diff would have caught the issue in 30 seconds. **Document the comparison in the PR body.**

### Reconciling against the POS's Salesperson Monthly Sales Table (lesson learned 2026-04-30)

Our Sales by Salesperson report and the POS's "Salesperson Monthly Sales Table" do NOT use the same attribution model. When a user reports "the totals don't match the POS," investigate before treating it as a bug:

| Behavior | the POS monthly table | Our HR report |
|---|---|---|
| Split orders (`splitWithId` set) | **100 % to primary**, 0 to partner | **50 / 50** between primary and partner (per HR comp convention) |
| Late reassignments (lead transfer, designer change) | Reflected immediately in their report | Shows the attribution at time of last import; updates next nightly run |
| Register-only attributions (e.g. `OSRegister1`) | Not in their table | Appear as their own rows in our report |

So differences fall into three predictable buckets:

1. **Paired deltas equal to half a known split-order total** — the POS's primary-only attribution. Confirmed example 2026-04-30: SO-1671 ($4,694, Felicia/Julia) produced an exact ±$2,347 swing.
2. **Paired deltas equal to a non-split order total** — late reassignment. Confirmed example: SO-3638 ($1,089) shows Bridgette as primary in our DB but Shannon Martin in the POS's table.
3. **Small unpaired residuals (<$100)** — register-row attributions the POS's table doesn't include.

Procedure for any "totals are off" report (use `psql` against a fresh prod backup):

1. Pull the POS CSV side-by-side and compute per-name deltas (full-outer-join on lower-trimmed name).
2. For each non-zero delta, look for a paired equal-magnitude opposite delta on another name.
3. Run a query for split orders + recent solo orders for those two names to identify the specific orderno producing the swing.
4. If every delta resolves to one of the three buckets above, **it is not a bug** — close as "attribution model difference, no fix needed." If a delta does NOT resolve to one of those buckets, dig further (could be a real cancelled-line / FK-resolution bug).

This procedure was applied 2026-04-30 to a user-reported April month-to-date discrepancy. All deltas resolved cleanly: no bug. The HR-side 50/50 split is the documented contract; report users compare against Detailed Sales (which doesn't apply the split) when they need a number that matches the POS.

## Key Files

- `pages/api/reports/` -- 23 report API endpoints (includes pipeline-detail, pipeline-reassign, sales-by-salesperson)
- `pages/api/dashboard/sales-summary.ts` -- home page dashboard
- `pages/reports/` -- 23 report pages
- `components/report/` -- shared report components (KpiCard, ReportSection, ReportTable with `render` prop for JSX cells)

## Verification Checklist

- [ ] Any new report aggregating line items filters `lineItemStatus: { not: "CANCELLED" }`
- [ ] Order status filter includes ORDER, FULFILLED, RETURNED (not QUOTE, CANCELLED)
- [ ] Non-merchandise partNos excluded from revenue totals
- [ ] New reports accessible to DESIGNER have the `roles` prop set correctly
- [ ] Split sales properly halve amounts (check `splitWithId`)

## Test Coverage

Covered: `designerDashboardDates.test.ts` (date range logic)

Gaps: No test verifies that report endpoints include the cancelled-line filter. A CI grep check would catch regressions.

## Available Reports

Roles below reflect the **card visibility** on `/reports` (governed by `CardGridPageLayout.roles` in `src/pages/reports/index.tsx`). Server APIs may have stricter or laxer gates (see "Per-Report Notes" below). When the two diverge, the API gate is the authoritative limit on data exposure.

ALL = visible to every signed-in user (Designer, Manager, Admin, Marketing). Designers always get card access for sales-attribution reports because they need to see their own numbers (server-side scope-locks them to self).

| Report | Path | Card Roles | Server Gate | What it shows |
|---|---|---|---|---|
| Designer Dashboard | `/reports/designer-dashboard` | ALL | session-only (designer scope-locked to self) | YoY snapshot for one salesperson: Sales / Quotes / Conversion / Avg Quote / House Calls. Furniture / Window / Rugs / Home Shop split + All Sales line. |
| Monthly Performance | `/reports/monthly-performance` | ALL | session-only (designer scope-locked) | Per-salesperson month-over-month vs goals, bonus calculation, quotes + converted count + open quote $ pipeline. |
| Salesperson Detail | `/reports/salesperson-detail` | ALL (hidden from nav 2026-05-29) | session-only (designer scope-locked) | 4-level drilldown for one salesperson + year: month → customer → order → line item. Splits at 50%. Card hidden from the reports hub per owner direction; page/API retained. |
| Sales by Salesperson | `/reports/sales-by-salesperson` | ALL | session-only (designer scope-locked) | HR comp report — date-range $ + cost + margin + qty. Group by salesperson / department / customer. CSV export. |
| Pay Period Sales | `/reports/pay-period-sales` | **SUPER_ADMIN only** _(tabled 2026-05-29)_ | role-gated (page + all APIs) | _Tabled — hidden from everyone but the owner until management adopts it; code parked, not deleted._ Designer's own sales for a **bi-weekly pay period** — order detail + period total + YTD-through-period. Split orders credited 50×. CSV export. Privileged roles pick any designer. **Sales only — no commission $** (commission stays on the SUPER_ADMIN surface). Period math: `lib/payPeriod.ts` (anchor `PAY_PERIOD_ANCHOR_ISO` = 2026-05-03, owner-confirmed 14-day windows); totals reuse `sumDesignerSales` so they match the commission engine. Confirm/lock ledger shipped (Slice 2): designer "Confirm these numbers" freezes their attribution for the period; manager grid + reopen. Report-an-issue flag shipped (Slice 3): designer flags wrong numbers (non-locking) → manager resolves. Both documented in `docs/domains/commission.md`. |
| ~~Monthly Performance~~ | _hidden 2026-05-29_ | — | — | Hidden from the hub per owner direction (superseded by Pay Period Sales + the commission surface). Page + API kept in-repo (`/reports/monthly-performance`) in case it's revived. |
| Team Commission | `/reports/commission` | **SUPER_ADMIN only** _(tabled 2026-05-29)_ | role-gated (page + API) | _Tabled — owner-only until management adopts it; code parked, not deleted._ Locked commission payouts per designer per pay period (designer, period, period sales, commission $, paid). Read only — tier config + commit/lock stay on the SUPER_ADMIN `/admin/reports/commission-tiers` surface. Backed by `GET /api/reports/commission-payouts` → `lib/commissionPayoutList.ts` with `designersOnly`. |
| Detailed Sales | `/reports/detailed-sales` | MANAGER, ADMIN | session-only | Filterable in-depth table by store + date range + dept; drill-down to item + line. CSV export, store filter, department filter. |
| Gross Margin | `/app/reports/gross-margin` | MANAGER, ADMIN | MANAGER+ADMIN | Revenue, cost, margin $, and margin % for a date range, grouped by department or vendor. Cancelled lines excluded; rows at 90%+ margin are flagged as probable missing product cost, not real profit. Engine: `lib/reports/grossMargin.ts` (DB GROUP BY). |
| Inventory Health | `/app/reports/inventory-health` | MANAGER, ADMIN | MANAGER+ADMIN | On-hand valuation (units × cost) by department/vendor plus dead-stock aging (on-hand with no recent sales) — where working capital is tied up. Engine: `lib/reports/inventoryHealth.ts`. See `docs/domains/inventory.md`. |
| PO Sell-Thru | `/app/reports/po-sell-thru` | MANAGER, ADMIN | MANAGER+ADMIN | Pick POs by number → per-frame sell-through, margin, and realized retail since each line's receive date. Engine: `lib/reports/poSellThru.ts` + pure windowing in `lib/reports/poSellThrough.ts`; frame math reuses `lib/buyPerformance.ts`. |
| Comparative Sales | `/reports/comparative-sales` | MANAGER, ADMIN | session-only | Two date periods by store with $ + % variance. Optional dept filter. **Axper foot traffic per period** (visitors + traffic variance; conversion % = orders ÷ visitors shown only with no dept filter). MS-A + MS-B summed into Main Showroom via `getStoreLocationName`. Persisted-traffic only — no live pull. |
| Weekly Summary | `/reports/weekly-summary` | MANAGER, ADMIN | session-only | Week-over-week: defaults to the last complete Sunday-aligned week, compares to the same week last year (−364 days, weekday-aligned so holidays line up). Columns: This Week / Last Year / vs LY $ / vs LY %; the Company pivot adds Visitors + **Conversion %** (this + last year). Labelled "vs LY" (not "YoY", which read like a year's worth of data). **Conversion % = sales transactions (ORDER/FULFILLED) ÷ door visitors, whole-store — NOT affected by the department filter** (door traffic isn't dept-specific); `transactionsByStore` in `weekly.ts`. Goal/variance columns dropped from this report 2026-05-29 (kept in the legacy `/reports/dashboard`). Department filter is a `MultiSelectDropdown`. Calls `/api/dashboard/weekly?wow=1`; date math `lib/weekOverWeek.ts`, rows `lib/weeklySummaryRows.ts`, traffic `lib/storeTraffic.ts`. |
| Mailchimp Campaign Impact | `/reports/mailchimp` | ADMIN, MARKETING | session-only | Every campaign ranked by attributed revenue (purchases within 30 days of open or click), broken down by department. |
| Mailchimp Activity Log | `/reports/mailchimp/activity` | ADMIN, MARKETING | session-only | Subscriber-level Mailchimp activities (opens, clicks, bounces). |
| Customer Report | `/reports/customers` | ADMIN, MARKETING | ADMIN+MARKETING | Server-side paginated contact list with order history, spend, level, balance. |
| Tax Summary | `/reports/tax-summary` | ADMIN | session-only | Tax collected by period and store, sourced from invoices. |
| Till Reconciliation | `/reports/till-reconciliation` | ADMIN | session-only | End-of-day drawer counts and variances. |
| Wealth Insights | `/reports/wealth-insights` | ADMIN, MARKETING | ADMIN+MARKETING | Windfall tiers, lifestyle signals, top customers. MANAGER removed 2026-04-17 (failure log). |
| Consignment Summary | `/reports/consignment-report` | ADMIN | ADMIN | Inventory counts + vendor obligations across all consignment items by status + vendor. |
| Pipeline Opportunity | `/reports/pipeline-opportunity` | MANAGER, ADMIN | MANAGER+ADMIN | Open quotes + orders by salesperson with conversion rates. Drilldown to quotes, manager notes, reassign inactive. |
| Opportunities | `/reports/opportunities` | MANAGER, MARKETING, ADMIN | tile-dependent: MARKETING+ADMIN see wealth tiles; MANAGER+MARKETING+ADMIN see all tiles | Customer lists worth emailing this week (dormant VIPs, big wallets with small baskets, second-home owners, missing-pieces, etc.). |
| Buyers Report | `/reports/buyers` | ADMIN | ADMIN | On hand, on order, sold for date range. Pivot by department or vendor. Merchant-decision view. MANAGER removed 2026-05-29 (owner direction). |
| Stale Quote Cleanup | `/reports/stale-quotes` | ADMIN | ADMIN | Old quotes by age and value, for follow-up or closure. |
| Balance Due Aging | `/reports/balance-aging` | ADMIN | ADMIN | Unpaid balances on ORDER-status orders by age bucket. Excludes QUOTE. |
| Open PO Gaps | `/reports/po-gaps` | ADMIN | ADMIN | POs missing expected delivery date or vendor acknowledgement number. |

### Internal endpoints (no card; called by other pages)

| Endpoint | Used by | Purpose |
|---|---|---|
| `/api/reports/sales-daily` | Dashboard widget | Daily totals by date + store |
| `/api/reports/factsalesday` | Dashboard widget | Daily by department |
| `/api/reports/sales-performance` | Internal report | KPI dashboard |
| `/api/reports/monthly-percentages` | Comparative report | Month-over-month % changes |
| `/api/reports/open-orders` | Several pages | List of currently-open orders |
| `/api/reports/get-departments` | Filter dropdowns | Distinct department names with line-item activity |
| `/api/reports/dormant-customers` | Opportunities tile + standalone | High-value customers who stopped buying |
| `/api/reports/cross-sell` | Opportunities tile | Furniture buyers missing complementary categories |
| `/api/reports/pipeline-detail`, `/api/reports/pipeline-reassign` | Pipeline Opportunity drilldown | Per-quote detail + manager reassign |
| `/api/reports/buyers/{positions,summary}` | Buyers Report | Per-vendor / per-dept rollup |

## Per-Report Notes

### Designer Dashboard / Monthly Performance / Salesperson Detail / Sales by Salesperson

These four salesperson-aware reports are subject to the **designer self-lock**: when a non-privileged caller (DESIGNER, REGISTER, INSTALLER, WAREHOUSE) hits the API, `resolveSalesPersonFilter` in `lib/salesBySalesperson.ts` substitutes their own staffId for any requested ids — they cannot view another salesperson's numbers via direct API call or URL parameter.

**Split-order partner protection** (PR #217, 2026-05-05): when a designer view is locked, the bucketing logic also drops the _partner_ row of split orders so the partner's name + half-revenue never leaks. Privileged roles still see both buckets.

**Calculation**: `SUM(OrderLineItem.netPrice)` over orders in `[ORDER, FULFILLED, RETURNED]`, `lineItemStatus != CANCELLED`, excluding the 5 canonical delivery/freight productNames. For split orders, both primary and split-partner get 50%. See `lib/salesBySalesperson.ts` and the four "rules" sections at the top of this doc.

### Detailed Sales

Pivot by department or vendor; drill from dept row → supplier rows → line items. Default date range: yesterday. Store filter, department multi-select, vendor multi-select. CSV export at `/api/reports/detailed-sales/export`. Drill items at `/api/reports/detailed-sales/items`.

**Margin fallback chain** (added 2026-04-30 for line-cost-zero data): line.cost → product.baseCost × qty → retail/2 (50% imputation). See `imputeMissingCost` in `lib/marginMath.ts`.

### Customer Report

Server-side paginated (50/page) — page numbers are query-param-driven so a customer search is bookmarkable. Includes `customerLevel`, `lifetimeSpend`, `creditBalance`. Wealth fields conditionally included server-side based on session role (ADMIN/MARKETING only).

### Wealth Insights

Reads `WindfallEnrichment` directly. Multi-select filters: tier (ULTRA_HIGH / VERY_HIGH / HIGH / AFFLUENT) × signal booleans (recentMover, recentMortgage, etc.) × customerLevel × customerGroup. CSV export.

### Opportunities

Tiles are pure helpers in `lib/opportunityTiles.ts`. Each tile produces a customer list backed by a Prisma where-clause. Wealth-bearing tiles (Big Wallet Small Basket, Second-Home Owners) hard-gated at the tile-resolver level: ADMIN/MARKETING only. MANAGER sees the page and the non-wealth tiles, but the wealth ones return 404 for MANAGER. The Missing Pieces tile loads ProductPairing data at request time (async `buildWhere`).

### Buyers Report

Two pivot modes (Department / Vendor). Pivot helper in `lib/buyersRollup.ts`. Each row drills down: dept → category → type → product (or vendor → category → type → product). Period is configurable; default last 90 days.

### Pipeline Opportunity

Open quotes (status QUOTE) by salesperson. Conversion = `convertedCount / (convertedCount + quoteCount)` where converted are non-QUOTE statuses originating from a quote. Manager notes attach via `MANAGER_NOTE` interactions. Reassign-inactive moves stale quotes to a different salesperson.

### PO Sell-Thru

Manager picks real POs by number (comma-separated, up to 50) and gets a per-frame
table of ordered vs received vs sold. The defining behavior is **per-line
receive-date windowing**: each PO line's sell-through clock starts at that
line's earliest `ReceivingRecord.receivedDate` and runs to today — a frame with
no receipts shows no sales by design. Pure windowing math in
`lib/reports/poSellThrough.ts` (pre-windows sales, then hands them to
`computePerformance` from `lib/buyPerformance.ts` so the frame rollup /
stock-vs-special split / margin engine is reused untouched). Data assembly in
`lib/reports/poSellThru.ts`:

- Sales filter: `lineItemStatus != CANCELLED` + `SALES_REVENUE_STATUSES`
  (RETURNED included so rewrite chains net out).
- Stock vs special: products literally on the selected POs are stock; other
  frame-mate variants (customer-spec orders) count as special and don't drive
  the status badge.
- Consignment vendors are excluded **by relation** (`vendor:
  { consignmentReceipts: { none: {} } }`), never by vendor name — keep it
  white-label.
- Realized retail = soldRevenue / (baseRetail × qty) over priced units only;
  rows with missing line cost fall back to an assumed 50% margin and the UI
  marks them "(est)".

Tests: `__tests__/poSellThrough.test.ts` (windowing + realized retail +
input parsing).

### Balance Due Aging

Filters `status: { in: ["ORDER"] }` — FULFILLED orders are paid in full by definition; QUOTE not yet a sale; CANCELLED out. Buckets: 0–30 / 31–60 / 61–90 / 91+ days. Uses `computeBalance()` per order so the cancelled-line + netPrice rules are inherited automatically.

### Mailchimp Campaign Impact

30-day attribution window from each customer's **first** engagement with that campaign. Two modes via `lib/campaignAttribution.ts`:

- **last-touch** (default in both endpoints): each purchase credited to the single most recent engagement within window. Summed revenue = true sales. Use this for revenue rollups.
- **shared**: per-campaign non-exclusive credit. Use for conversion-rate comparisons across campaigns.

`excludeNewCustomerDays = 60`: drops customers whose `firstOrderDate` falls in the 60 days before a campaign's first engagement (would otherwise inflate the next campaign's numbers with walk-ins added to the list on first purchase).

### Designer Dashboard (special case: Sales-by-Salesperson HR view ≠ the POS Salesperson Monthly)

the POS credits 100% of split orders to the primary; we split 50/50. So three valid delta categories when reconciling to the POS's table:

- (a) paired equal-magnitude deltas = half a known split-order total
- (b) paired equal-magnitude deltas = a non-split order's total = late reassignment (the POS reflects immediately, our DB has the snapshot)
- (c) small unpaired residuals = register-row attributions the POS's table omits

Documented in CLAUDE.md gotcha "Reconciling against the POS's Salesperson Monthly Sales Table." Confirmed against April 2026 data — every delta resolved cleanly to one of those three buckets.

## Customer Levels in Reports

Customer levels (1=Occasional, 2=Frequent, 3=High Value, 4=VIP, Dormant) appear as a column on:

- Customer Report — text label in the Level column, server-side paginated (50/page)
- Wealth Insights — clickable level filter section alongside tier and signal filters. All three filter types are multi-select (combine tier + level + signal). CSV export includes level.

Levels are computed by `lib/customerLeveling.ts` with department-group-aware windows. See CLAUDE.md customer leveling gotcha for details.

## Pipeline Opportunity Report

Pipeline = open quotes only (not confirmed orders). Clickable salesperson rows expand to show individual quotes with: quote #, customer, date, age, value, items, last contact, and last note. Tap a quote row to expand its line items inline. Each drilldown has its own CSV export.

**Manager Notes**: Managers can add MANAGER_NOTE interactions to any quote from the drilldown. Select a quote, type a note, submit. The note appears in the Note column and on the order's interaction history (visible to the designer).

**Inactive Toggle**: Shows former employees with orphaned pipeline. Reassign panel lets managers bulk-move all quotes/orders from inactive to active staff.

**Archived Toggle**: Excludes archived quotes by default. Check "Include archived quotes" to see them.

**APIs**: `GET /api/reports/pipeline-opportunity`, `GET /api/reports/pipeline-detail?salesperson=Name`, `POST /api/reports/pipeline-reassign`

## ReportTable Render Prop

`ReportColumn<T>` now supports a `render` prop that returns JSX (links, badges). Takes priority over `format()` for display; `format()` still used for CSV export and sorting. Sorting uses raw row values, not formatted strings.

## Pipeline Date Handling

`daysBetween()` in the pipeline API uses `Intl.DateTimeFormat.formatToParts` to extract year/month/day in `America/New_York` timezone. Do NOT use `toLocaleDateString` + string concatenation — it produces unparseable strings on Node.js. The urgency badge on pipeline quote cards defaults to 0 ("Today") when both `daysSinceContact` and `daysSinceCreated` are null.

## Opportunities Hub

Marketing-director dashboard at `/reports/opportunities`. A single page replaces the old Dormant Winback + Cross-Sell reports and adds six new data-driven segments, plus a seasonal Christmas segment.

**Role gating:** MANAGER / MARKETING / ADMIN.

**Architecture:** every tile is defined in one file — `app/src/lib/opportunityTiles.ts`. Each tile provides a Prisma `CustomerWhereInput` builder, plain-English copy, and a rough per-customer revenue estimate. CLAUDE.md rule 37: the tile list lives in one place; both API endpoints and the UI import from there.

**Endpoints:**

- `GET /api/reports/opportunities` — returns `{ asOf, tiles: [{ id, title, description, count, estPotential }] }`. Counts only, parallel queries, fast.
- `GET /api/reports/opportunities/[tileId]` — returns the row list (Customer + lead score + optional wealth tier). Role-aware: wealth fields omitted server-side for non-ADMIN/MARKETING, same convention as pipeline/customer-detail endpoints.

**Tiles:**

| id | Title | Filter in plain words |
|---|---|---|
| `big-wallets` | Big wallets, small baskets | HIGH+ wealth tier, lifetime < $2k, has ≥1 order |
| `second-home` | They have a second home | multiPropertyOwner, lifetime < $5k |
| `landlord` | Landlord special | rentalPropertyOwner, lifetime < $5k |
| `boat-crowd` | Boat and lake house crowd | boatOwner, lifetime ≥ $500 |
| `single-department` | Bought one thing, never came back for the rest | departmentCount = 1, lifetime ≥ $500 |
| `welcome-back` | Welcome back — finish the set | First order in last 90 days |
| `life-event` | Something big changed in their life | recentMover OR recentMortgage OR liquidityTrigger |
| `dormant-vips` | Come back soon | peak ≥ 3, current ≤ 1, no order in 12+ months |
| `christmas-lapse` (Oct–Dec only) | Christmas crowd is missing | customerGroup = CHRISTMAS, lastOrderDate < Sept 1 of current year |

**Adding a tile:**

1. Append an `OpportunityTile` object to `OPPORTUNITY_TILES` in `app/src/lib/opportunityTiles.ts`.
2. Add a test case to `app/__tests__/opportunityTiles.test.ts` asserting the filter shape.
3. That's it — the hub page and both API routes pick it up automatically.

**Seasonal gating:** a tile can expose `shouldShow(now): boolean` to hide itself outside a date window. Use this for segments that only matter part of the year. The `christmas-lapse` tile is the canonical example (visible Oct–Dec).

**What's intentionally NOT in the hub yet:**

- **Mailchimp API segment creation** — punted; CSV export is the MVP. User uploads to Mailchimp via their existing audience-import flow.
- **Campaign dedup / log** — Ship 2 will add a `CampaignTarget` table so each tile shows "last sent to this segment: N days ago" and export dedupes.
- **Product-pairing / Missing Pieces tile** — Ship 3 will add a `ProductPairing` admin page where the user configures "bought X, didn't buy Y within N days" rules; the new tile reads from that table.

**Retired cards:** the Reports index no longer surfaces Dormant Customer Winback or Cross-Sell Opportunity. The pages still respond at their old URLs (for bookmarks) with a banner at the top pointing to `/reports/opportunities`.

### Ship 2 — Campaign log + dedup (`CampaignTarget`)

One row per (tile, customer, send event). Powers two features:

1. **Per-tile "last sent" subline** on the hub. Each tile's `lastSentAt` is the max `sentAt` for that tile across all rows. UI thresholds:
   - `null` → "Never sent" (sh-gray)
   - Within 7 days → "Sent N days ago" (amber — avoid re-sending)
   - Older → "Last sent N days ago" (sh-gray)

2. **30-day dedup on the drill list** (default on). When the toggle is checked, customers with any `CampaignTarget` row for this tile within the last 30 days are excluded from the candidate list server-side via `where.id = { notIn }`. Toggle off to see them faded with a "sent Nd ago" chip.

**Logging a send:** the user explicitly confirms via the "Mark N as sent" button on the drill. CSV-click alone does NOT log -- the user might cancel an export or download for review without actually sending. `POST /api/reports/opportunities/[tileId]/log-send` with `{ customerIds, notes? }` records one row per ID. Capped at 10,000 IDs per call. `sentBy` is the session email.

**Pure helper:** `lib/campaignDedup.ts` exports `filterOutRecentlySent()` and `buildDaysSinceLastSentMap()`. The `[tileId].ts` drill endpoint uses `buildDaysSinceLastSentMap` to attach `daysSinceLastSent` to each row regardless of the dedup state.

**Indexes:** `(tileId, sentAt DESC)` for the hub counts, `(customerId, tileId, sentAt DESC)` for future per-customer audits ("which campaigns has this customer been on?").

**No historical backfill.** Log starts fresh the day the migration deploys.

### Ship 3 — Product pairings + Missing Pieces tile

**`ProductPairing` model** (migration `20260424_product_pairing`): defines "bought X, should buy Y" rules. Each row has a from-department/category and a to-department/category plus a window in days. A customer matches when they bought the from-side in the last `windowDays` and have NEVER bought the to-side.

Hardcoding pairings would rot with the merchandise mix, so rules live in a table that managers/admins edit via the admin UI.

**Admin UI:** `/admin/setup/product-pairings` (ADMIN/MARKETING). Standard list + modal CRUD. Dropdowns for from/to department, cascading dropdowns for category (populated based on selected department). Window defaults to 60 days. Leaving a category blank means "any category in this department." Seed rules on fresh installs: Bedroom → Bedding, Furniture → Home Acc/Rugs, Outdoor Furniture → Home Acc.

**Missing Pieces tile:** `lib/opportunityTiles.ts` exports `buildMissingPiecesWhere(pairings, now)` — a pure function that turns a list of pairing rules into a `CustomerWhereInput` with one `OR` clause per rule. Each clause is `salesOrders.some({ lineItems.some({ product in from dept/cat }) }) AND NOT salesOrders.some({ lineItems.some({ product in to dept/cat }) })`.

**Async tile signature:** the Missing Pieces tile reads `ProductPairing.findMany()` at request time, so its `buildWhere` is async. The `OpportunityTile.buildWhere` type was widened from `(now) => CustomerWhereInput` to `(now) => CustomerWhereInput | Promise<CustomerWhereInput>`. All existing sync tiles are unchanged; both API endpoints already `await` the call.

**Validation helper:** `lib/productPairingValidation.ts::validateProductPairingInput()` is a pure function the admin API endpoints use to sanitize CRUD payloads. Rejects missing names, identical from/to (same dept + cat), windowDays outside 1-730. 10 unit tests.

## Buyers Report

Merchant pivot dashboard at `/reports/buyers` (MANAGER/ADMIN). One screen that shows **on-hand + on-order + sold** for a user-selected date range. Drills **four levels deep**:

- Department pivot: **Department → Category → Vendor → Part #**
- Vendor pivot: **Vendor → Department → Category → Part #**

Click any non-leaf row to drill in one level; click a breadcrumb to step back out. Leaf rows navigate to `/products/[id]` so the buyer can act on the SKU without leaving the flow. KPI cards and the Attention Panel **re-scope to wherever the user has drilled** — so "On Hand", "Sold $", "Margin", and the opportunity/dead-money lists all answer the question the buyer is currently looking at, not the whole store.

Built to answer the three questions a buyer asks every time they look at a vendor: _"how much do we have, how much is coming, how much did we sell?"_ — and the two buyer fears behind them: _"are we missing sales from understocking?"_ and _"how much dead money is sitting on the floor?"_ Those two fears get their own always-visible Attention Panel (below).

**Architecture:** one endpoint, one page, pure roll-up helper.

- `lib/buyersRollup.ts::buildBuyersRollup(facts, pivot, weeksInRange)` — pure reducer, no database access. Takes flat per-product facts and produces the 4-level tree via a `pivotPath()` function + recursive accumulation. Derived metrics (sell-through %, weeks supply, margin %) computed here with explicit null handling for the divide-by-zero cases. NULL dept/category/vendor at any level bucket into "(unassigned)" at that level. Leaf nodes have `productId` set; non-leaves have `productId === null`. `flattenLeaves(node)` returns just the product-level descendants — used for the Attention Panel, CSV export, and future per-product reports.
- `api/reports/buyers/summary.ts` — parallel raw SQL for (1) on-hand from `InventoryPosition` (excludes `salesOrderId IS NOT NULL`), (2) on-order as `SUM(orderedQuantity) − SUM(quantityReceived)` across open-status POs, **floor-stock only** (excludes `PurchaseOrder.salesOrderId IS NOT NULL` and `PurchaseOrderItem.orderLineItemId IS NOT NULL`), (3) sold qty + $ + cost + costEstimated from `OrderLineItem` honoring the cancelled-line rule and the netPrice-is-line-total invariant. Merges per productId, loads Product metadata **including `productNumber` and `name` for leaf rendering**, hands to the reducer.

**UI** (top to bottom):

1. **Filter bar** — date range, pivot, saved-view chips, Run.
2. **Breadcrumb** — `All › Furniture › Sofas › Wesley Hall`. Each crumb clickable.
3. **KPI strip** — On Hand / On Order / Sold Qty / Sold $ / Margin. Re-scopes to drilled context.
4. **Attention Panel** — two side-by-side cards, always visible when data is loaded:
   - **Opportunity — running thin**: top 5 leaves with `weeksSupply < 2 AND soldQty > 0`, sorted by soldQty desc. The "reorder now" list.
   - **Dead money — sitting too deep**: top 5 leaves with `onHand > 0 AND soldQty = 0`, sorted by soldCost desc. Shows total tied-up dollars for the scope.
   Both cards scope to the current drilled context, not just global.
5. **Saved view chips** — All / Top sellers / Dead stock / Running low / New, not moving. Client-side recursive filters.
6. **Data table** — one level at a time (flat, no inline expansion). Click-to-drill. Leaf row click → `/products/[id]`.

**CSV export** dumps all leaf products under the current scope with breadcrumb path recorded in the `Scope` column. Buyers want rollups on screen, raw leaf rows in Excel.

### Metric invariants

- **Sell-through %** = `soldQty / (soldQty + max(onHand,0) + max(onOrder,0))` — one decimal, bounded at 100%. Returns 0 when there's nothing to divide by.
- **Weeks supply** = `onHand ÷ (soldQty ÷ weeksInRange)` — null when there's no stock or no sales velocity.
- **Margin %** = `(soldTotal − soldCost) / soldTotal` — null when nothing was sold.
- **Sold Cost waterfall** (per line, then summed per product): `li.cost > 0 → li.cost`; else `p.baseCost > 0 → p.baseCost × orderedQuantity`; else `li.netPrice ÷ 2` as a last-resort **estimate**. Any product whose lines hit the retail/2 branch flips `costEstimated = true`, which rolls up through every node it contributes to. The UI marks margin with `*` and shows a legend under the table.
- **Date range defaults** to last 90 days. `weeksInRange` is rounded to whole weeks; minimum 1 to avoid divide-by-zero.
- **Product count at non-leaf cells** sums 1 per contributing fact (each distinct product). At leaf cells it's always 1.

### Ship 2.5 additions (shipped 2026-04-24)

**Customer Stock column** — splits `InventoryPosition` into floor stock (`salesOrderId IS NULL`, column: On Hand) and customer-allocated stock (`salesOrderId IS NOT NULL`, column: Cust Stock). Single SQL using conditional `SUM(CASE WHEN ... THEN qty ELSE 0 END)`. Customer-allocated units aren't in the buyer's "available to sell" number but remain visible as a signal: `onHand=0, customerStock=3` means "people keep buying this, should we keep a floor sample?"

**Hidden demand Attention Panel** — third card (alongside Running Thin and Dead Money) surfaces leaves with `onHand = 0 AND (customerStock > 0 OR specialSoldQty > 0)`. Sorted by demand intensity. Direct "stock a floor sample" signal.

**New defaults** — date range now trails 365 days (from 90), pivot defaults to `vendor` (from `department`). 365d gives a full-season comparison for every category; vendor pivot matches buyer mental models (they work with vendor reps, not internal depts).

### Ship 2 additions (shipped 2026-04-24)

**Stock Sold vs Special Sold columns** — `soldQty` / `soldTotal` split into per-row `stockSoldQty`+`stockSoldTotal` and `specialSoldQty`+`specialSoldTotal`. SQL classifies each line via a `LEFT JOIN LATERAL` against `PurchaseOrderItem`. **A line is "special" iff the `PurchaseOrderItem` is on a `PurchaseOrder` whose `salesOrderId = li."salesOrderId"`** AND either (a) `poi.orderLineItemId = li.id` (direct link) OR (b) `poi.externalPorNo = li.porNumber` AND the POR is non-empty. The **same-SO requirement is load-bearing** — without it, the POS-reused POR strings false-matched across totally unrelated orders, classifying ~87% of Womens Apparel as "special" when the real rate is ~3% (issue #168, fixed 2026-05-16 — see `__tests__/integration/buyersStockSpecialClassifier.integration.test.ts` for the pin). Same-SO gate also applies to the parallel POR-chain exclusion in `positions.ts` (with an additional `productId` gate there because the exclusion runs before any salesOrderId link exists). Inverted business meaning per department type:

| Dept type | Expected ratio | Signal when Special is HIGH | Signal when Stock is HIGH |
|---|---|---|---|
| Furniture / Windows (special-order-first) | Special >> Stock normal | Frame is selling — keep showing it | Rare, notable floor turn |
| Traditional stock (Home Acc, Bedding, Bath, Children's, Floral, Prints, Mirrors, Tabletops, Lamps) | Stock >> Special normal | **Emerging trend** — stock deeper | Good — stock bet paid off |

**Frame rollup (data-driven)** — `lib/frameRollup.ts`, 16 tests. No hardcoded vendor registry. At query time:

1. Strip the `<vendorPrefix>-` (everything before first `-`) from each SKU.
2. If the vendor's remaining vendorSkus have no hyphen substructure → vendor is flat, no rollup.
3. Otherwise compute `avg configs per root` (root = vendorSku with last segment removed). If ≥ 1.5 AND ≥ 5 products → vendor is "configurable" → collapse SKUs sharing the same root into a single frame leaf.
4. Frame-leaves have `productId = null` + `productCount = variant count` (not a real product to navigate to). "(N variants)" badge rendered next to the name.

Self-adapts to new vendors. Toggle-gated ("Roll up frames" checkbox in the filter bar; defaults OFF). Threshold tunable via `MIN_CONFIGS_PER_ROOT` in the lib.

**Department hint banner** — when drilled to a recognized department, a contextual banner appears above the KPI strip:

- **Christmas**: "Active season Oct 1 – Jan 31" + one-click **Apply season range** button (last completed season).
- **Outdoor / Patio / Garden**: "Active season Apr 1 – Aug 31" + Apply button.
- **Apparel / Women's / Men's / Accessories / Jewelry**: informational only — PO receipts not imported workflow caveat + the three-peak sales rhythm (Dec/May/Aug).
- **Rugs**: points to the forthcoming Rugs Buying Guide (Ship 3) and notes on-hand/on-order is the wrong model for consignment.

All season windows are data-backed (CLAUDE.md rule 41); the hypotheses documented inline so future tuning has a baseline.

### Ship 3/4 watchlist

- **Rugs Buying Guide** (Ship 3) — new page `/reports/rugs-buying-guide` with size/quality pivots + heatmap + trending + trip-prep export. Pure helper `lib/rugsBuyingGuide.ts`. Data from `ConsignmentItem` (size, quality, year, saleDate) — no schema change.
- **Arrival-cohort badge + weekly velocity sparkline** (Ship 4) — "received 45 days ago" chip per row + 12-week sparkline. Turns every row from a static number into a readable trend-with-context.
- **Cost backfill job** — nightly batch copying `li.cost` from the most recent sale of a SKU onto `Product.baseCost` so new sales inherit the known cost. Shrinks the retail/2 estimated-margin footprint without waiting for receive events.
- **Stockout tracking** (Ship 4 roadmap) — daily `InventoryDailySnapshot` cron enables "days out of stock in last 90" per product.
- **Configuration distribution report** (Ship 5) — under a frame-leaf, break down which fabric/grade/color combos actually sell. Guides "what should the next floor sample be."

---
Last verified: 2026-04-24 (Buyers Report Ship 2 — stock/special split, data-driven frame rollup, dept hint banner)
