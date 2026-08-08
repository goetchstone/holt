# Commission Payouts

Owner-confidential. Every page and endpoint described here is gated to
**SUPER_ADMIN** at both the API layer (`requireAuthWithRole(["SUPER_ADMIN"], …)`)
and the UI layer.

Origin: owner direction 2026-05-27 — _"they are currently using a
google sheet that someone is hand entering in the data so we can
probably do better … date, daterange, sales amount, ytd, comm tier,
comm rate, comm, salesperson … lock it in so that won't let you undo
once locked in … SUPER_ADMIN can edit with an audit comment."_

## Commission plans (per-salesperson structures, 2026-06-11)

Owner: _"we need to be able to set different commission structures and assign
them to different sales people."_ A **CommissionPlan** is a named set of
marginal YTD tiers in the exact `CommissionTier` row shape
(`label, minYtdSales, maxYtdSalesExclusive|null, rate, sortOrder`), validated
by the same bracket rules (contiguous, ascending, only the last tier
unbounded). `StaffMember.commissionPlanId` assigns one; NULL means default.

**Tier resolution chain** (`lib/commissionPlans.ts:resolvePlanTiersForStaff`),
used identically by payout generation AND the live calculator so the two can
never price a designer differently:

1. the staff member's assigned plan (if it has tier rows)
2. the `isDefault` plan
3. the **legacy `CommissionTier` table** — a restored legacy dataset lands its
   tier rows here and computes IDENTICALLY until plans are created (this is
   the compatibility guarantee; pinned by the parity test in
   `commissionPlans.integration.test.ts`)
4. **nothing** — an empty tier set, meaning no commission

Step 4 used to be `DEFAULT_COMMISSION_TIERS`: one employer's 3%-to-7%
schedule, compiled into source. A deployment that had configured no plan was
therefore silently commissioned on those rates, and `runCommissionPayouts`
**persisted** the result into payout rows — nothing failed and nothing warned.
Owner's direction: _"if there is no commission plan then there is nothing to
report on."_ An unconfigured deployment now resolves to an empty tier set,
`resolveTier` returns `null`, and callers render `"No plan configured"` rather
than a rate nobody chose. `DEFAULT_COMMISSION_TIERS` survives only as the
seed's reference values (`prisma/seed/demo/commissionPlan.ts` scales them) and
as rule-engine test fixtures; it is unreachable from any request path.

Steps 3+4 otherwise match the pre-plans `loadTiers()` helper, which no longer
exists (the Stage 1 rule engine replaced it). The migration
(`20260611_commission_plans`) also converts an existing `CommissionTier` set
into a default **Standard** plan, idempotently — safe to re-run after a
restore. No code writes `CommissionTier` anymore; the plans endpoint replaced
the whole-set tier editor.

**Snapshot**: every payout row now freezes `commissionPlanId` +
`commissionPlanName` alongside `tierDefinitionSnapshot`, so history records
who was paid under which structure even if the plan is later deleted (FK
nulls; the denormalized name keeps rendering). Rows generated before plans
existed have NULL — render "—".

**Mid-year plan switch semantics** (deliberate, pinned by test): chain
continuity carries YTD **dollars** — the next period's `ytdSalesAtStart`
still reads the prior LOCKED payout's frozen `ytdSalesAtEnd` regardless of
plan. A switch therefore never re-prices locked history; the new plan's
brackets simply price all subsequent slices from the carried YTD position.
A high-YTD designer moved to a flat plan gets the flat rate immediately;
moved to a bracketed plan, they enter at whatever bracket their carried YTD
falls in.

**Eligibility is unchanged** by plans: payout generation still selects
`role IN [DESIGNER, MANAGER] AND isActive`; the team/HR read views still
filter `isDesigner`. Plan assignment only changes the _rate structure_,
never _who gets generated_.

**Admin surfaces**: plans CRUD + per-plan tier editor live on the
commission-tiers page (Live Calculator tab); assignment is a dropdown on
Admin → Staff (the staff PATCH carries `commissionPlanId`). Plans endpoint:
`/api/admin/reports/commission-tiers/tiers` (GET list / POST create / PUT
replace-tiers / PATCH rename-or-setDefault / DELETE — refuses for the default
plan or while staff are assigned).

## Rule model (Stage 1, 2026-08-01)

Owner direction: generalize the single-axis `CommissionPlanTier` band
(YTD revenue only, one flat rate per bracket) into a declarative RULE model
that can eventually express per-department/category/vendor rates,
margin-based commission, per-unit amounts, and goal-based plans — "if I sell
cell phones I may have certain plans where you need to reach a goal then you
get commission paid, and it may be retroactive, it may only be on new once
the goal is met, it depends on the company." Stage 1 builds the foundation
(rules, the engine, migration, snapshotting) with every existing plan
producing byte-identical payouts. Splits, spiffs, draws, and caps are
explicitly LATER stages — the model is shaped to fit them, but none of that
is built yet.

### New models

- **`CommissionPlanRule`** — one row per rule within a plan. `planId`,
  `label`, `sortOrder`, `isActive`.
  - SCOPE (all nullable — `NULL` matches everything for that dimension):
    `departmentId` → `Department`, `categoryId` → `Category`, `vendorId` →
    `Vendor`, `storeLocationId` → `StoreLocation` (the store the sale was
    written at, matching `SalesOrder.storeLocationId`), `productTypeId` →
    `Type` (the `Product.typeId` relation — "productType" in the original
    brief).
  - `basis` (`CommissionRuleBasis`): `REVENUE` (`OrderLineItem.netPrice`,
    today's behavior) | `MARGIN` (`netPrice` minus the resolved line cost —
    see "MARGIN's cost source" below) | `UNITS` (`orderedQuantity`).
  - `accumulator` (`CommissionAccumulator`): `YTD` (resets Jan 1; chains
    across locked periods — the generalization of today's only behavior) |
    `PERIOD` (resets every pay period, no cross-period carry) |
    `PER_TRANSACTION` (resets per `SalesOrder` — this codebase's
    transactional unit — no cross-order or cross-period carry).
  - `tierMode` (`CommissionTierMode`): see "Tier modes" below.
- **`CommissionRuleTier`** — one band within a rule. `ruleId`, `label`,
  `minAmount`, `maxAmountExclusive` (`null` = unbounded top tier), `rate`
  (percentage, 0..1) OR `perUnitAmount` (flat $/unit — exactly one of the
  two is set per tier, validated by
  `lib/commissionRuleEngine.ts:validateRuleTiers`).
- **`CommissionPlan.countsWhen`** (`CommissionCountsWhen`): `WRITTEN` |
  `DELIVERED` | `COLLECTED`. Default `WRITTEN` — today's (only implemented)
  behavior: `orderDate` + `SALES_REVENUE_STATUSES`. **`DELIVERED` and
  `COLLECTED` are stored but NOT wired into the engine in Stage 1** — this
  codebase has no reliable "delivered date" or "paid/collected date"
  commission basis defined yet. A plan can declare the intent; selecting
  either value today has no effect on how sales are counted. This is an
  honest, stated boundary, not a silent gap — wiring them up is later-stage
  work once the owner defines what "delivered" and "collected" mean for
  commission purposes (whole-order fulfillment? per-line delivery? payment
  received in full vs. deposit?).
- **`CommissionPayout.ruleEngineVersion`** (`Int`, default `1`) —
  discriminates the JSON shape of `tierBreakdown`/`tierDefinitionSnapshot`.
  See "Snapshot — old and new shapes" below.

`CommissionPlanTier` and the existing plan CRUD / tier editor are **kept,
untouched** — see "Backwards compatibility" below for how they stay
authoritative for plans that haven't been given real rules.

### Rule precedence — first-match-wins, not most-specific-wins

Rules within a plan are tried in ascending `sortOrder`; the FIRST rule whose
scope matches a given sale line claims it. A line matched by no active rule
earns **zero** commission under that plan — visible (`unmatchedAmount` on
the engine result), never an error.

**Why first-match-wins was chosen over most-specific-wins:** "most
specific" has no principled definition across five INDEPENDENT scope
dimensions. A rule scoped to `{departmentId}` and a rule scoped to
`{storeLocationId}` both matching the same sale are not orderable by
"specificity" without an arbitrary, implicit per-dimension priority ranking
baked into the engine — exactly the class of inconsistent-guard-ordering bug
this codebase's rule 42 (SO-39275 postmortem) warns against. First-match-wins
makes precedence explicit, visible ADMIN DATA (`sortOrder`) instead of
implicit engine logic, mirroring how `CommissionPlanTier`'s bracket ordering
already works. Convention for plan authors: put narrow/exception rules at a
LOWER `sortOrder` (tried first), the catch-all (all-null scope) rule LAST.
Every migrated legacy plan is exactly one catch-all rule, so this never
comes up for existing data.

### Tier modes — precedence and math

Three modes, all applied to a rule's `[basisAtStart, basisAtEnd)` window for
the accumulator's current period:

1. **`MARGINAL`** (default — today's only behavior). Each band pays its own
   rate on the dollars/units WITHIN that band. Crossing $750k mid-period
   earns part at 3%, part at 4%. Self-contained per period — no
   cross-period "recognized" carry beyond the accumulator's own
   `basisAtEnd`.
2. **`RETROACTIVE`**. Crossing into a new band re-rates the WHOLE
   accumulated amount at the new band's rate, INCLUDING everything below
   it — "hit $750k and all $750k pays 4%, not just the excess." Implemented
   via a carried `cumulativeRecognizedCommission` (frozen inside each
   locked payout's snapshot): each period computes `owed = rate(basisAtEnd)
× basisAtEnd` and pays `max(0, owed − priorRecognized)`. This ALGEBRA
   never needs to touch a locked prior period — the increment technique
   makes the "whole amount re-rates" property hold in AGGREGATE across
   periods automatically (see the worked example below).
3. **`THRESHOLD`**. No commission below the lowest tier's `minAmount` (the
   "goal"); once reached, pays MARGINALLY on amounts from the goal forward
   only — mathematically identical arithmetic to `MARGINAL`
   (`marginalOverlapSum`, reused rather than duplicated — rule 6/7), the
   distinguishing property is that a `THRESHOLD` rule's tiers conventionally
   start ABOVE $0.

**Deferred vs. catch-up — the distinction the owner drew, and how one engine
mechanism covers both:**

- **DEFERRED (the primary shape for goal-based plans).** While a rule's
  accumulated basis is below its lowest tier's `minAmount`, it earns
  nothing. Those zero periods are CORRECT history, not an error — nothing
  about them needs correcting once the goal is later reached. This is what
  `RETROACTIVE` (tiers starting above $0) and `THRESHOLD` both do by
  construction: `RETROACTIVE(x) = 0` and `MARGINAL overlap = 0` when `x` is
  below every tier.
  - `RETROACTIVE` with a deferred (above-$0) tier = **retroactive scope**:
    once qualified, ALL qualifying YTD sales recognize AT ONCE, in the
    period where qualification happened (`priorRecognized` was $0 the whole
    deferred window, so the full re-rated amount lands as new commission).
  - `THRESHOLD` = **prospective scope**: once qualified, only sales FROM the
    qualification point forward earn — the marginal overlap above the goal.
    The dollars that got the designer TO the goal stay unpaid, "merely
    counted toward qualifying."
  - Which one a plan wants is a policy choice per rule — `tierMode` IS that
    choice; there is no separate flag.
- **CATCH-UP (the secondary, edge-case shape).** Only arises when a rule's
  lowest tier starts AT $0 (nothing is deferred — some rate is paid from the
  first dollar) and a LATER period crosses into a HIGHER band. The dollars
  already paid in an earlier LOCKED period were correct at the time; the
  crossing means MORE is now owed on that same money. The engine NEVER
  mutates the locked row — it computes the uplift
  (`newOwed − priorRecognized`) and attributes it entirely to the CURRENT
  period, with the breakdown entry's `priorRecognized` /
  `cumulativeRecognizedAfter` / `isCatchUp: true` fields making the
  provenance legible ("this period recognizes $15,000 of uplift on top of
  $21,000 already paid, because $900k total now qualifies for the higher
  band").
  - **Worked example** (`lib/commissionRuleEngine.ts`'s
    `retroactiveOwedAt`/`applyTierMode`, pinned by
    `__tests__/commissionRuleEngine.test.ts` and the real-DB test in
    `__tests__/integration/commissionRuleEngine.integration.test.ts`):
    tiers `[0–750k @ 3%, 750k+ @ 4%]`. Period 1: $700k sold, locked,
    commission = 3% × 700k = **$21,000**. Period 2: $200k more lands
    (YTD $900k, crossing the band). `owed = 4% × 900k = $36,000`;
    `priorRecognized = $21,000` (read from period 1's frozen snapshot, NOT
    recomputed); period 2's NEW commission = `$36,000 − $21,000 =
$15,000`. Total paid across both periods = `$21,000 + $15,000 =
$36,000`, EXACTLY `4% × $900,000` — the retroactive property holds in
    aggregate, and period 1's row was never written to.

**`THRESHOLD` needs a defined qualifying window** — it's measured over
whatever `accumulator` the rule uses (`YTD` = the calendar year;
`PERIOD` = just that pay period). A threshold never met yields **$0
cleanly** every period — no error, no special-casing — because the overlap
between `[basisAtStart, basisAtEnd)` and a tier bracket that starts above
`basisAtEnd` is empty by construction.

### Backwards compatibility — how it's guaranteed, and the test that proves it

**Guarantee:** every existing `CommissionPlanTier` set is converted 1:1 into
an equivalent single `CommissionPlanRule` (scope = all, `basis = REVENUE`,
`accumulator = YTD`, `tierMode = MARGINAL`) — mathematically identical to
`calculateMarginalCommission`. Two mechanisms keep it that way, not just at
migration time but for the life of Stage 1:

1. **One-time data migration**
   (`prisma/migrations/20260801_commission_rule_engine/migration.sql`, SQL
   appended below the machine-generated schema diff, same idempotent
   `INSERT ... SELECT ... WHERE NOT EXISTS` pattern `20260611_commission_plans`
   established) converts every plan's existing tiers into a rule labeled
   `"All sales (YTD, marginal) — auto-synced from tiers"`.
2. **Sync-on-write.** The pre-existing tier editor
   (`lib/commissionPlans.ts:replacePlanTiers`/`createPlan`, backing the
   commission-tiers page's Live Calculator tab — UNCHANGED as a user-facing
   surface) now ALSO keeps that same auto-managed rule's `CommissionRuleTier`
   rows in sync, in the SAME transaction, every time an admin edits tiers.
   It finds-or-creates by that exact label, so the rule's `id` (and
   therefore its `ruleKey`, `id:<n>`) stays STABLE across edits — load-
   bearing for chain continuity, which is keyed by `ruleKey`. Without this,
   a plan migrated once would freeze its rule at whatever the tiers looked
   like at migration time; an admin editing tiers afterward would see the
   UI update but the change would silently never affect an actual
   commission run again. `resolvePlanRulesForStaff`
   (`lib/commissionRules.ts`) prefers a plan's persisted, ACTIVE
   `CommissionPlanRule` rows; if a plan somehow has tiers but no synced
   rule (a seed script bypassing the API, for instance), it derives an
   equivalent rule on the fly as a safety net — never silently blank.

**The proof test:** `__tests__/commissionRuleEngine.test.ts`'s "golden-path
equivalence" suite runs `calculateMarginalCommission` (the OLD engine)
against the default tier set for seven scenarios (single-tier, multi-tier
crossings, the full 5-tier span, a shrinking/returns window, a zero-sales
window), derives an equivalent `CommissionRuleDef` via
`deriveRuleFromLegacyTiers`, runs the SAME scenario through
`computeRuleEnginePayout` (the NEW engine), and asserts the commission
dollar amount matches EXACTLY and the breakdown — projected down to
`{tierLabel, rate, sliceAmount ↔ salesInTier, sliceCommission ↔
commission}` — matches EXACTLY, in the same order. The new engine's
breakdown entries are a strict superset (additional fields like `ruleId`,
`basis`, `accumulator`, `tierMode` for the richer cases); for a migrated
legacy plan those extra fields are simply absent (`undefined`, which
`toEqual` treats as equivalent to absent), so this is genuinely the SAME
shape for the case that matters, not a coincidental subset match. A parallel
real-DB integration test (`runCommissionPayouts.integration.test.ts`'s
existing 22 scenarios, re-run unchanged through the new engine) pins the
same dollar figures end to end.

### MARGIN's cost source — reused, not reinvented

`MARGIN` basis needs `netPrice − cost`. The three-step cost-fallback
cascade (`li.cost` if nonzero → `product.baseCost × orderedQuantity` if
line cost is zero → `retail / 2` imputation as the last resort) already
existed in TWO places: privately in
`lib/reports/salesExplorerQuery.ts:baseLineCost` and
`lib/reports/salesBySalespersonReport.ts:resolveLineCost` (plus a THIRD,
inline copy in that same file's `lineToItem`). All three were extracted
2026-08-01 into one canonical export,
**`lib/marginMath.ts:resolveLineCost`** (paired with the pre-existing
`imputeMissingCost` for the final retail/2 step) — the Sales Explorer and
Sales-by-Salesperson report call sites now import the shared function
instead of keeping their own copy, and
`lib/commissionSales.ts:loadDesignerSaleRows` (the rule engine's sale-row
loader) uses the SAME function for its `MARGIN`-basis figure. One
definition of margin, three call sites.

### The engine — pure, no Prisma

`lib/commissionRuleEngine.ts:computeRuleEnginePayout(rules, saleRows,
periodContext)` is a pure function (rule 14 — no Prisma inside it). The
DB-touching orchestration —
`lib/commissionRules.ts:resolvePlanRulesForStaff` (loads + resolves a
designer's rules, generalizing `resolvePlanTiersForStaff`'s 4-step chain to
5 steps: assigned plan's rules → assigned plan's tiers derived on the fly →
default plan (same two-step) → legacy `CommissionTier` table, derived → no
rule at all) and
`lib/commissionSales.ts:loadDesignerSaleRows` (row-level sale data: revenue,
margin, units, and every scope dimension, per line item — the row-level
sibling of the pre-existing `sumDesignerSales`, sharing its exact matching
rules: FK + alias + POS-string OR, 0.5× split multiplier, the cancelled-line
filter) — lives in `lib/runCommissionPayouts.ts`, which stays the single
orchestrator for preview/commit/edit.

**`ytdSalesAtStart`/`ytdSalesAtEnd`/`periodSalesAmount` mean what they
always meant.** These three columns are computed by the SAME, UNTOUCHED
`computeDesignerYtdSums` function as before Stage 1 — a designer-level,
REVENUE-basis YTD total, independent of how many rules a plan has or what
bases they use. A plan with a MARGIN or UNITS rule tracks that rule's OWN
accumulator separately, inside `tierDefinitionSnapshot`'s `ruleState` (see
below) — it does not change what these three legacy columns mean. This is a
deliberate Stage 1 boundary: the columns stay simple and backward-compatible
for display; a rule's own basis-specific accumulator lives in the richer
snapshot.

**Chain continuity, generalized per rule.** The pre-existing designer-level
mechanism (`computeDesignerYtdSums`: a locked payout's frozen
`ytdSalesAtEnd` seeds the next period's `ytdAtStart`; `ytdAtEnd` is ALWAYS a
LIVE recompute over the full YTD range) is now duplicated at the RULE level
by `computeDesignerRuleState` (`lib/runCommissionPayouts.ts`), reading
`RulePriorState[]` from the most recent locked payout's snapshot. The same
"ytdAtEnd is always live" property holds per rule — critical, because a
naive "frozen start + this period's own slice" implementation would MISS a
return/rewrite dated inside an already-locked prior period that lands after
the lock (this was caught by
`runCommissionPayouts.integration.test.ts`'s existing late-return scenario
during Stage 1 development and is now an explicit doc comment on
`computeRuleForYtdOrPeriod`). A prior lock from BEFORE the rule engine
shipped (`ruleEngineVersion = 1`, no `ruleState` to read) bridges via
`lib/commissionPayout.ts:bridgeLegacyLockToRuleState`, mapping the old
row's scalar `ytdSalesAtEnd`/`commissionAmount` onto the designer's current
primary rule.

### Snapshot — old and new shapes

`CommissionPayout.tierBreakdown` and `.tierDefinitionSnapshot` stay the
SAME two JSON columns (rule 4's "preserve the snapshot/lock/audit
machinery" — untouched structurally). `ruleEngineVersion` (default `1`)
discriminates their shape:

|                          | `ruleEngineVersion = 1` (every pre-existing row)                                       | `ruleEngineVersion = 2` (rows generated by the rule engine)                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tierBreakdown`          | bare `PayoutBreakdownEntry[]` array: `{tierLabel, rate, sliceAmount, sliceCommission}` | `{schemaVersion: 2, entries: RuleBreakdownEntry[], unmatchedAmount}` — richer entries carry `ruleId`, `basis`, `accumulator`, `tierMode`, and (RETROACTIVE/THRESHOLD only) `priorRecognized`/`cumulativeRecognizedAfter`/`isCatchUp`/the qualifying window dates                                              |
| `tierDefinitionSnapshot` | bare `TierDefinitionSnapshot[]` array                                                  | `{schemaVersion: 2, rules: RuleDefSnapshot[], ruleState: RulePriorState[]}` — `ruleState` is the NEW carry-forward chain-continuity data the old scalar-column model didn't need (one implicit rule needed only `ytdSalesAtEnd`; N rules each need their own `basisAtEnd` + `cumulativeRecognizedCommission`) |

Type guards `isRuleSnapshotEnvelope`/`isRuleBreakdownEnvelope`/
`isLegacyArrayShape` (`lib/commissionPayout.ts`) let any reader branch on
shape without needing `ruleEngineVersion` in hand. The admin UI
(`src/components/commission/PayoutsTab.tsx`) was updated to render BOTH
shapes — old rows unchanged, new rows via `breakdownEntries()` extracting
`.entries` — and to display a UNITS-basis tier's `perUnitAmount` when
`rate` is `null` rather than showing `NaN%`. This was the one UI change
Stage 1 required (preventing a crash on newly-generated payouts); no new
rule-configuration UI was built — see "Known limitations" below.

### Migration

`prisma/migrations/20260801_commission_rule_engine/migration.sql`. Schema
portion generated via `prisma migrate diff --from-schema <pre-edit
schema.prisma> --to-schema prisma/schema.prisma --script` (additive only:
2 new columns with defaults, 2 new tables, 4 new enums; every scope FK is
`ON DELETE SET NULL`, matching `CommissionPayout.commissionPlanId`'s
existing "widen scope / null out, never block a delete" convention). Data
portion hand-appended, idempotent, converts every plan's tiers into the
auto-synced rule described above.

### Known limitations — the honest boundary of Stage 1's rule shape

Stated plainly, per the owner's request, rather than left implicit:

- **`countsWhen: DELIVERED | COLLECTED` are not implemented.** Stored on the
  plan; the engine only ever counts `WRITTEN` (order date). A plan owner
  who wants commission counted on delivery or payment-in-full needs a later
  stage that defines what those events mean in this schema and threads a
  new sale-row date source through `loadDesignerSaleRows`.
- **No rule-editor UI.** Stage 1 is API/engine/migration only. Rules are
  configured today via direct DB writes (or the auto-sync from the
  pre-existing flat-tier editor, which can only ever produce a single
  scope-all rule). A plan with genuinely distinct multi-dimensional rules
  (department-specific rates, a MARGIN-basis rule alongside a REVENUE-basis
  one, etc.) requires manual `CommissionPlanRule`/`CommissionRuleTier` rows
  until a later stage builds the editor.
  - **A plan mixing a synced flat-tier set AND hand-built extra rules is
    not a supported shape yet.** `resolvePlanRulesForStaff` prefers a
    plan's persisted ACTIVE rules wholesale once any exist — it does not
    merge "the auto-synced flat rule" with "additional hand-built rules"
    on the same plan. To configure a plan with genuinely different rules
    today, its `CommissionPlanTier` rows must be empty (a fresh plan, or
    one whose tiers were deliberately cleared) so the sync path never
    fires.
- **Splits, spiffs, draws, and caps are not built.** The scope/basis/
  accumulator/tierMode axes are designed so these later stages can slot in
  (e.g., a split could apply as a post-processing multiplier on the
  engine's per-rule commission; a spiff as an additional PER_TRANSACTION
  rule; a draw/cap as a floor/ceiling clamp on the top-level
  `commissionAmount`) — but none of that logic exists yet. Building it is
  explicitly OUT of Stage 1 scope.
- **PER_TRANSACTION's "transaction" is one `SalesOrder`.** A multi-line
  order is one transaction; there is no sub-order transactional grouping.
- **RETROACTIVE's `priorRecognized` carry does not reconcile a manual
  `commissionAmount` override.** If a SUPER_ADMIN hand-edits a locked
  payout's total `commissionAmount` (via the existing edit-with-audit
  flow), the per-rule `cumulativeRecognizedCommission` carried forward
  still reflects the ENGINE-COMPUTED figure, not the override. Reconciling
  a whole-row override down to per-rule attribution is a later-stage
  concern; today an override and a RETROACTIVE rule's catch-up math can
  drift apart the same way overrides already can drift from the DRIFT
  banner's live recompute (`lib/commissionDrift.ts`) — visible, not
  silent, and resolved the same way (SUPER_ADMIN reviews, decides).
- **`unmatchedAmount` is informational only.** A sale matching no active
  rule earns $0 and is NOT surfaced anywhere in the admin UI yet (it's on
  the pure engine's result and the `tierBreakdown` envelope, but no page
  renders it as a warning). An admin who scopes rules too narrowly and
  accidentally excludes real sales would need to notice a lower-than-
  expected `periodSalesAmount` vs. `commissionAmount` gap rather than
  getting an explicit alert.

### Files (Stage 1 additions)

| File                                                             | Role                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/commissionRuleEngine.ts`                                    | Pure engine: types, scope matching (`matchRule`/`scopeMatches`), tier validation, `marginalOverlapSum`/`retroactiveOwedAt`/`tierContaining`, `computeRuleEnginePayout`, `deriveRuleFromLegacyTiers`. No Prisma. |
| `lib/commissionRules.ts`                                         | DB layer: `resolvePlanRulesForStaff` (the 5-step resolution chain).                                                                                                                                             |
| `lib/commissionSales.ts`                                         | Extended with `loadDesignerSaleRows` (row-level sibling of `sumDesignerSales`).                                                                                                                                 |
| `lib/commissionPayout.ts`                                        | Extended with `computeRulePayoutForRange`, the snapshot envelope types, `bridgeLegacyLockToRuleState`, and the shape-guard functions. `computePayoutForRange` (the old function) is untouched.                  |
| `lib/commissionPlans.ts`                                         | `replacePlanTiers`/`createPlan` extended with `syncLegacyMirrorRule`.                                                                                                                                           |
| `lib/marginMath.ts`                                              | Extended with the extracted `resolveLineCost` (the shared cost-fallback cascade).                                                                                                                               |
| `lib/runCommissionPayouts.ts`                                    | `previewPayoutsForPeriod` now resolves + computes via rules; `computeDesignerYtdSums` is untouched; `computeDesignerRuleState` is new.                                                                          |
| `src/components/commission/PayoutsTab.tsx`                       | Renders both `tierBreakdown` shapes.                                                                                                                                                                            |
| `prisma/migrations/20260801_commission_rule_engine/`             | Schema + data migration.                                                                                                                                                                                        |
| `__tests__/commissionRuleEngine.test.ts`                         | Pure-engine unit tests, including the golden-path equivalence suite.                                                                                                                                            |
| `__tests__/integration/commissionRuleEngine.integration.test.ts` | Real-DB tests: department scope, MARGIN basis, RETROACTIVE catch-up (asserts the locked row is byte-identical before/after), THRESHOLD deferred, sync-on-write, unmatched-rule zero.                            |

## What this domain owns

Two surfaces, both at `/admin/reports/commission-tiers`:

1. **Live preview** (`Live Preview` tab). Pre-existing. Picks any
   date range, computes per-designer YTD + marginal commission in
   memory, never writes to the DB. Used for "what does this period
   look like right now?" exploration. Backed by
   `GET /api/admin/reports/commission-tiers` (still in place).
2. **Locked payouts** (`Locked Payouts` tab, added 2026-05-27). Same
   math, but the operator presses _Generate Payouts_ with a custom
   pay-period range, reviews a preview, and commits the row set. Once
   `lockedAt` is set, the row is frozen — re-running the period
   doesn't overwrite it; only an explicit SUPER_ADMIN edit (with an
   audit reason) can change a locked row.

## Schema

Two tables (migration `20260527_commission_payouts`):

### `CommissionPayout`

One row per `(staffMemberId, periodStart, periodEnd)` — the unique
constraint lets the orchestrator upsert idempotently when an operator
re-previews + re-commits the same period.

| Column                                | Type               | Notes                                                                                                                                                                                   |
| ------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staffMemberId`                       | Int FK             | Designer/manager the payout is for.                                                                                                                                                     |
| `periodStart`, `periodEnd`            | DateTime           | Inclusive endpoints; pay periods are not necessarily month-aligned.                                                                                                                     |
| `periodSalesAmount`                   | Decimal            | `max(0, ytdAtEnd − ytdAtStart)`. Stored so historical math is auditable even if SalesOrder data shifts later.                                                                           |
| `ytdSalesAtStart`, `ytdSalesAtEnd`    | Decimal            | YTD-before and YTD-through the period (Jan 1 anchor).                                                                                                                                   |
| `tierBreakdown`                       | JSONB              | Array of `{tierLabel, rate, sliceAmount, sliceCommission}` — which tiers the slice spanned.                                                                                             |
| `commissionAmount`                    | Decimal            | Total commission paid; operator can override before commit.                                                                                                                             |
| `tierDefinitionSnapshot`              | JSONB              | Frozen copy of `CommissionTier` rows at generation time. Re-rendering a locked payout reads THIS, not the live `CommissionTier` table, so retroactive tier edits never rewrite history. |
| `lockedAt`, `lockedBy`                | DateTime?, String? | Both null while draft; both set the instant the row is locked.                                                                                                                          |
| `paidOn`                              | DateTime?          | When the check actually cut. Editable.                                                                                                                                                  |
| `notes`                               | String?            | Free-form operator note (e.g. _"Year-end true-up"_).                                                                                                                                    |
| `created/updated/createdBy/updatedBy` | audit              | Standard.                                                                                                                                                                               |

### `CommissionPayoutEdit`

One row per changed FIELD per edit. So if a SUPER_ADMIN bumps
`commissionAmount` from $3,000 → $3,500 AND sets `paidOn` AND adds a
note in one PATCH, that's THREE audit rows, all stamped with the same
`reason` + `editedBy` + `editedAt`. Surfaces in the edit drawer as a
chronological list.

`payoutId` has `ON DELETE CASCADE` — deleting the parent payout takes
its audit log with it. Don't delete locked payouts (the API doesn't
expose a delete endpoint at all; this is a defensive constraint
inside the DB, not a user-facing operation).

## Files

| File                                                                 | Role                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/prisma/schema.prisma`                                           | Both new models live at the bottom of the file with a doc comment.                                                                                                                                                                                                                                                     |
| `app/prisma/migrations/20260527_commission_payouts/migration.sql`    | Schema + indexes.                                                                                                                                                                                                                                                                                                      |
| `app/src/lib/commissionTiers.ts`                                     | Pre-existing. `calculateMarginalCommission()` does the slice-by-slice math; reused by both surfaces.                                                                                                                                                                                                                   |
| `app/src/lib/commissionSales.ts`                                     | Pre-existing (extracted from the live-preview endpoint). `sumDesignerSales(staffId, matchNames, from, toExclusive)` — shared between live and locked. Aliases + FK + the POS-string OR; 0.5× for splits; ORDER/FULFILLED/RETURNED.                                                                                     |
| `app/src/lib/commissionPayout.ts`                                    | Pure helper `computePayoutForRange(input)` — caller hands in pre-summed YTD-start + YTD-end + tier list; returns the row-shape draft. Used by both preview and commit.                                                                                                                                                 |
| `app/src/lib/runCommissionPayouts.ts`                                | Orchestrator. Three entry points: `previewPayoutsForPeriod`, `commitPayoutsForPeriod`, `editPayout`. **Chain continuity**: when a prior LOCKED payout exists for the same designer with `periodEnd < periodStart`, this period's `ytdAtStart` reads from THAT row's frozen `ytdSalesAtEnd`, not from a live recompute. |
| `app/src/lib/commissionDrift.ts`                                     | `computeLockedPayoutDrift({staffMemberId?, includeClean?})` — for each locked payout, compares the frozen `ytdSalesAtEnd` against a live recompute. Non-zero results are surfaced on the UI Drift banner so SUPER_ADMIN can decide whether to claw back via edit or accept the variance.                               |
| `app/src/lib/commissionPeriodOverlap.ts`                             | Pure helper `findOverlappingPayoutPeriods(start, end, existing)` — date-range overlap detection that allows exact-match re-runs but refuses partial / contained / containing / boundary-touch overlaps. Backs the period-overlap guard in `commitPayoutsForPeriod`.                                                    |
| `app/src/pages/api/admin/reports/commission-payouts/index.ts`        | GET (list with filters) + POST (`?action=preview` and `?action=commit`).                                                                                                                                                                                                                                               |
| `app/src/pages/api/admin/reports/commission-payouts/[id].ts`         | GET (single + audit log) + PATCH (edit-with-audit).                                                                                                                                                                                                                                                                    |
| `app/src/pages/api/admin/reports/commission-payouts/drift.ts`        | GET — returns drift rows for every locked payout (or one designer's). SUPER_ADMIN only.                                                                                                                                                                                                                                |
| `app/src/components/commission/LockedPayoutsTab.tsx`                 | UI for the Locked Payouts tab — date pickers, generate flow, preview panel, payout history table, expandable rows, edit drawer, **DriftBanner** (quiet when clean, loud-red when not).                                                                                                                                 |
| `app/src/pages/admin/reports/commission-tiers.tsx`                   | Wraps the existing live-preview content into a `LivePreviewSection` sub-component and adds the tab switcher.                                                                                                                                                                                                           |
| `app/__tests__/commissionPayout.test.ts`                             | 6 pure unit tests for `computePayoutForRange`.                                                                                                                                                                                                                                                                         |
| `app/__tests__/integration/runCommissionPayouts.integration.test.ts` | 22 real-DB tests covering preview + commit + edit + lock semantics + chain continuity (5 scenarios: late-return inside next period, late-return inside locked period, no-prior-lock fallback, ignores-DRAFT, year-boundary reset).                                                                                     |
| `app/__tests__/integration/commissionDrift.integration.test.ts`      | 8 real-DB tests covering drift detection (no-lock empty, no-drift empty, late-the return prefix-inside-period flagged, cancellation flagged, backdated-sale positive drift, designer filter, includeClean, DRAFT-rows-ignored).                                                                                        |

## Chain continuity — why this matters

The hard truth about commission lock-it-in: locking period N freezes the row, but the underlying SalesOrder data is alive. A return / rewrite / cancellation / late quote-promotion / designer reassignment can land AFTER the lock with an order date INSIDE the locked period, and that mutation moves the live YTD sum for the same date range out from under the locked row.

Without protection, the next period's preview would re-read live data for its `ytdAtStart`, see a smaller number than the prior period's `ytdAtEnd`, and silently double-pay (or under-pay) commission on the same dollars.

**The fix** (`computeDesignerYtdSums` in `runCommissionPayouts.ts`):

1. Look for the most recent LOCKED payout for this designer with `periodEnd < periodStart` AND `periodEnd >= yearStart` (year-anchor reset every Jan 1).
2. If found, use THAT row's frozen `ytdSalesAtEnd` as this period's `ytdAtStart`. Don't re-query.
3. If not found, fall back to a live sum (first-ever period, or fresh dev DB).
4. `ytdAtEnd` is always live — it's the period being computed.

**Result**: Alice's YTD commission is continuous across periods. A late-landing return doesn't refund her commission silently; it surfaces as drift on the admin Drift banner and the operator decides what to do.

### Worked example

| Event                                                     | Live YTD | Locked YTD | What happens                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Period 1 (5/1–5/15): Alice sells $750k                    | 750k     | —          | LOCK → frozen `ytdSalesAtEnd = 750k`, commission = $22,500                                                                                                                                                                           |
| Period 2 starts. Alice sells $100k on 5/20                | 850k     | 750k       | (no preview yet)                                                                                                                                                                                                                     |
| 5/22: customer returns $50k (5/3 sale, the return prefix) | 800k     | 750k       | Live recompute of period-1 range now shows 700k — but the lock still says 750k                                                                                                                                                       |
| Period 2 preview/commit (5/16–5/31)                       |          |            | `ytdAtStart = 750k` (FROM LOCK, not 700k from live), `ytdAtEnd = 800k` live → $50k slice × 4% = $2,000 commission. Total YTD commission = $22,500 + $2,000 = $24,500 — matches marginal-on-cumulative-YTD against current $800k YTD. |
| Drift report                                              |          |            | Period 1 row shows `lockedYtdAtEnd = 750k, liveYtdAtEnd = 700k, drift = -$50k`. Operator reviews.                                                                                                                                    |

## Drift detection

The Drift banner on the Locked Payouts tab calls `GET /api/admin/reports/commission-payouts/drift`, which runs `computeLockedPayoutDrift()`. The endpoint is **SUPER_ADMIN-only**.

For each locked payout:

```
drift = sumDesignerSales(yearStart, lockedRow.periodEnd) - lockedRow.ytdSalesAtEnd
```

Rows with `|drift| ≤ $0.01` are excluded by default (`includeClean=true` to see them anyway). Banner stays hidden when nothing has drifted.

**Two valid responses to non-zero drift:**

1. **Accept the variance.** The cash already went out; the chain stays continuous because period N+1's `ytdAtStart` reads from period N's frozen `ytdSalesAtEnd`. Nothing needs to change.
2. **Claw back.** SUPER_ADMIN clicks `Review / Edit` on the drift row, unlocks (or directly edits while still locked), changes `commissionAmount`, and saves with an audit reason. Every change writes a `CommissionPayoutEdit` row.

The Drift banner does NOT block work — it's informational only. The operator chooses.

## Period-overlap guard

Once any payout exists for a date range (draft OR locked), generating a NEW pay period whose dates overlap that range is **refused**. Origin: owner direction 2026-05-27 — _"once we have a payperiord drafted or locked we should not be able to generate new data against it."_

**The rule** (pure helper `lib/commissionPeriodOverlap.ts:findOverlappingPayoutPeriods`):

| Existing             | New request | Allowed?                                                 |
| -------------------- | ----------- | -------------------------------------------------------- |
| 5/1–5/15 (any state) | 5/1–5/15    | ✅ Exact match — idempotent re-run; row UPDATEs in place |
| 5/1–5/15             | 5/16–5/31   | ✅ Adjacent, no overlap                                  |
| 5/1–5/15             | 5/10–5/25   | ❌ Partial overlap                                       |
| 5/1–5/15             | 5/12–5/14   | ❌ Contained inside                                      |
| 5/12–5/14            | 5/1–5/15    | ❌ Containing                                            |
| 5/1–5/10             | 5/10–5/25   | ❌ Boundary day shared                                   |

The check is GLOBAL (every active designer's row scanned), runs **server-side** in `commitPayoutsForPeriod` before any write, throws `OverlappingPeriodError` with the conflicting rows attached. The API endpoint translates that to HTTP **409 Conflict** with a structured `overlappingPayouts: [...]` array so the UI can show exactly which rows collide.

**UI flow**:

- Preview computes the overlap report alongside the drafts. The preview panel shows a red banner listing each conflicting row (designer + dates + draft/LOCKED badge) whenever there's a collision.
- The "Save as Draft" and "Save & Lock" buttons are DISABLED while a collision is visible. Hover tooltip says "Resolve the overlapping payout(s) above first."
- The operator's options: pick a different range, delete the conflicting draft row, or unlock-and-edit-with-audit the conflicting locked row.

**Why this matters**: without the guard, an overlapping range would write a NEW row that double-counts the overlap days AND breaks the chain-continuity lookup (which expects "most recent locked period BEFORE this one" to be unambiguous). The `@@unique([staffMemberId, periodStart, periodEnd])` index only catches EXACT duplicates — date-range overlap was a separate hole this closes.

## API contract

### `GET /api/admin/reports/commission-payouts`

Query params (all optional): `staffMemberId`, `from` (YYYY-MM-DD),
`to` (YYYY-MM-DD), `includeDrafts` (default false — locked-only).

Returns `{ payouts: [...] }` sorted by `periodEnd DESC` then
`commissionAmount DESC`. Capped at 500 rows.

### `POST /api/admin/reports/commission-payouts?action=preview`

Body: `{ startDate, endDate }` (both YYYY-MM-DD). No DB writes.
Returns `{ payouts: PreviewedPayout[] }`. Each row carries the
computed `commissionAmount`, `periodSalesAmount`, `ytdSalesAtStart`,
`ytdSalesAtEnd`, and `tierBreakdown` + `tierDefinitionSnapshot` so
the UI can render the per-row drilldown without a second roundtrip.

### `POST /api/admin/reports/commission-payouts?action=commit`

Body: `{ startDate, endDate, overrides?, lockNow }`.

`overrides` is an array of `{ staffMemberId, commissionAmount?,
notes?, paidOn? }` — the operator can hand-edit any draft row before
committing (e.g. _"add $500 bonus per Tom"_).

`lockNow: true` stamps `lockedAt` + `lockedBy` in the same
transaction; otherwise the rows write as DRAFT and can be re-committed
later. Already-locked rows are SKIPPED in a re-commit — to change a
locked row, use the per-row PATCH endpoint.

### `GET /api/admin/reports/commission-payouts/drift`

Query params (all optional): `staffMemberId`, `includeClean=true`.
Returns `{ rows: LockedPayoutDriftRow[] }`. Each row carries
`payoutId`, `displayName`, `periodStart`, `periodEnd`,
`lockedYtdAtEnd`, `liveYtdAtEnd`, `drift` (signed), and
`lockedCommissionAmount`. Banner consumes this directly.

### `GET /api/admin/reports/commission-payouts/[id]`

Returns `{ payout: { …row, edits: [...] } }`. `edits` is the audit
log ordered `editedAt DESC`.

### `PATCH /api/admin/reports/commission-payouts/[id]`

Body: `{ reason, commissionAmount?, notes?, paidOn?, lockedAt? }`.
`reason` is REQUIRED — the API rejects empty/whitespace with a 400.
One audit row written per field that actually changed.

To lock or unlock, pass `lockedAt: <ISO timestamp string>` (locks)
or `lockedAt: null` (unlocks). Both transitions write an
audit entry with `fieldChanged: "lockedAt"`. The unlock-and-re-lock
cycle is fully traceable — `lockedBy` is automatically stamped from
`editedBy` on lock and cleared on unlock in the same DB write.

## How the math reuses the existing engine

`runCommissionPayouts.ts` resolves pricing through
`resolvePlanRulesForStaff` (`lib/commissionRules.ts`), the 5-step rule chain
documented above — it yields no rule at all when nothing is configured, with
no built-in fallback. Same resolution the live-preview tab reads, so the two
tabs cannot diverge as long as the operator hasn't edited tiers between
previewing live and committing locked.

> Superseded: this section used to describe a `loadTiers()` helper on
> `runCommissionPayouts.ts` reading `CommissionTier` directly. That function
> no longer exists — the Stage 1 rule engine replaced it with
> `resolvePlanRulesForStaff`.

`computeDesignerYtdSums(staff, periodStart, periodEndExclusive)` calls
`sumDesignerSales` twice in parallel: once with `[YearStart, periodStart)`
for the YTD-at-start, once with `[YearStart, periodEndExclusive)`
for the YTD-at-end. The slice between them is the period's revenue;
`calculateMarginalCommission` walks that slice tier-by-tier and
returns the breakdown.

The period is "expanded by one day" inside `previewPayoutsForPeriod`
because the UI date picker treats the end date as INCLUSIVE
(operator picks `5/31` and means "through end of 5/31"). The
SalesOrder query uses `lt: periodEndExclusive` so the inclusive
behavior is correct.

## Re-commit semantics

The operator can re-preview + re-commit the same period as many
times as they like before locking. On each commit:

| State of existing row | Action                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| No existing row       | INSERT new draft (or locked, if `lockNow=true`).                                                       |
| Existing DRAFT row    | UPDATE in place — commission, sales, breakdown all refresh from the current SalesOrder data.           |
| Existing LOCKED row   | SKIP. Result counts it in `payoutIds` but doesn't touch the row. Operator must unlock-via-PATCH first. |

This is the safety net for the operator: a forgotten import, a late
return, an the return prefix backdated to inside the period — all the operator
has to do is press _Generate Payouts_ again and the draft rows pick
up the new data. Locked rows stay frozen.

## Verification checklist

Before changing any commission-payout code:

- [ ] Read this file + `staff-auth.md` (SUPER_ADMIN gating)
- [ ] Confirm `requireAuthWithRole(["SUPER_ADMIN"], …)` is on every endpoint touched
- [ ] If touching the math, the same diff must update both `commissionPayout.test.ts` (pure) AND `runCommissionPayouts.integration.test.ts` (real-DB)
- [ ] Edit-with-audit invariants: `reason` empty → 400; every changed field → one `CommissionPayoutEdit` row; no-op edit → 0 audit rows + no row mutation
- [ ] Lock semantics: re-commit on locked row SKIPs without overwriting; lock/unlock both write audit rows; lockedBy follows editedBy on every lock transition
- [ ] `Decimal` vs `Number` comparison: `normalizeForDiff` in the orchestrator coerces both to string before comparing, so a re-submit of the same numeric value doesn't false-positive an audit row
- [ ] **Chain continuity**: when changing `computeDesignerYtdSums`, the integration tests under `chain continuity across locked periods` must still pass — period N+1's `ytdAtStart` MUST read from the most recent locked row, MUST fall back to live when there's no prior lock, MUST ignore DRAFT prior rows, and MUST reset at year boundary
- [ ] **Drift**: when changing `computeLockedPayoutDrift`, the integration tests under `commissionDrift.integration.test.ts` must still pass — DRAFT rows are excluded, sub-tolerance rows are excluded by default, the year-anchor matches the orchestrator's

## Known gaps

- **No historical backfill.** Owner direction 2026-05-27: _"Fuck no."_ The Google Sheet history doesn't move into the ERP. Going forward only.
- **No SUPER_ADMIN scope below SUPER_ADMIN.** Managers cannot view this tab at all. If a workflow case ever requires manager visibility (read-only), add an explicit role parameter to the API and a separate read-only tab variant — don't expand `requireAuthWithRole` casually.
- **No printable payslip view.** Operator copies numbers into the existing payroll-export process by hand. If/when payroll automates, the row data + audit history is all the input needed. **Partially addressed 2026-05-29**: designers now have a self-service `/reports/pay-period-sales` statement (sales only, bi-weekly, CSV export) so they stop hand-copying into Google Sheets. Commission $ still SUPER_ADMIN-only.

## Pay-period confirmation + attribution lock (Slice 2)

Owner direction 2026-05-29: _"the designer should have a confirm the numbers button … It should lock any salesperson changes for the period … a real ledger … we already sent bad numbers last payperiod with David."_ Manager view shows confirmed status; "ready for review" once every active designer has confirmed.

### Decisions (owner-confirmed 2026-05-29 — do not re-litigate)

1. **Per-designer lock, manager-reopenable.** A designer confirming period P freezes ONLY their own attribution for orders dated in P. A MANAGER / SUPER_ADMIN can reopen a confirmation with an audit reason (mirrors the commission unlock-with-audit pattern); it re-locks on re-confirm.
2. **Can only confirm a period that has ENDED.** Confirmation is rejected while `periodEnd >= today`. You cannot lock a period that's still in progress.
3. **Rewrites are dated the rewrite day, NOT backdated.** A rewrite/return of a locked-period order, performed later, lands in the CURRENT (open) period — it can never mutate a locked past period. This is WHY the model is clean: combined with decision #2, there is no "late activity poisons a locked period" path. The lock only ever freezes existing attribution on already-closed periods.

### Model — `PayPeriodConfirmation`

| Column                                     | Notes                                                                                                                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `staffMemberId` FK                         | The designer who confirmed.                                                                                                                  |
| `periodStart`, `periodEnd`                 | DateTime, inclusive — the bi-weekly window (`lib/payPeriod.ts`).                                                                             |
| `confirmedAt`, `confirmedBy`               | Set on confirm.                                                                                                                              |
| `reopenedAt`, `reopenedBy`, `reopenReason` | Set when a manager reopens. An ACTIVE (locking) confirmation is one with `reopenedAt IS NULL`. Reopen + re-confirm cycle is fully traceable. |

Unique on `(staffMemberId, periodStart, periodEnd)` — re-confirm after reopen UPDATEs the same row (clears the reopen fields).

### The lock — ONE guard, FIVE enforcement points

Pure helper `lib/payPeriodLock.ts`: `isAttributionLocked(orderDate, designerIds, activeConfirmations)` → true when any of the given designers has an active confirmation whose `[periodStart, periodEnd]` contains `orderDate`. Every attribution-mutation path calls the SAME guard (rule 42 — a guard on one runner but not another is how SO-39275 recurred):

1. `pages/api/sales/orders/[id]/salesperson.ts` — single-order reassign. Refuses 409 if the order's current OR target designer is locked for the order's date.
2. `pages/api/admin/sales/bulk-update-salesperson.ts` — bulk reassign. Same guard per row.
3. `pages/api/reports/pipeline-reassign.ts` — pipeline reassign. Same guard.
4. `runSalesImport` (`lib/importRunners.ts`) — preserves the `salesperson` STRING for orders dated in a locked period. Uses `isOrderLockedByNameOrFk` so it matches by the `salesperson` STRING **or** the FK.
5. `backfillSalesPersonFk` (`lib/salesPersonFkBackfill.ts`) — skips setting the FK on locked-period orders so a name that now resolves differently can't move a locked order.

**Honest layering note (verified 2026-05-29 with a real-DB test).** The pre-existing `correctedOrders` preserve in `runSalesImport` (any order with a non-null `salesPersonId` keeps its `salesperson` string on re-import) ALREADY protects the realistic case: after the post-import FK-backfill sweep runs, confirmed-period orders almost always have their FK set, so the import won't re-attribute them regardless of this lock. The NEW import lock (#4) is therefore **belt-and-suspenders** — its incremental coverage is FK-NULL orders matched by NAME to a confirmed designer (orders the sweep never resolved, e.g. an ambiguous name). The genuinely load-bearing NEW enforcement is the three reassignment-endpoint guards (#1–#3), which let a manager ACTIVELY change a locked order — something `correctedOrders` does not stop. Tests pin both: `payPeriodConfirmationLock.integration.test.ts` forces the FK NULL to prove the name-based import lock fires in isolation, and asserts the guard throws-while-locked / passes-after-reopen.

### Manager / designer surfaces

- Designer statement (`/reports/pay-period-sales`): "Confirm these numbers" button — enabled only when the period has ended and the designer hasn't already confirmed. Confirmed badge + timestamp after.
- Manager section (privileged, same page): per-designer confirmed/not grid for the period + "ready for review" banner when all active designers have confirmed + a reopen action (audit reason required).
- Commission $ stays on the SUPER_ADMIN commission-tiers surface — NOT exposed here.

## Report-an-issue flag (Slice 3, owner direction 2026-05-29)

A designer who reviews their statement and finds it wrong needs a way to say so instead of confirming. Owner: _"There also needs to be a way to communicate an issue if there is one."_

The flag is the **opposite signal of a confirmation**: confirming says "these are right, lock them"; reporting an issue says "these are wrong, don't pay yet — fix them first."

### Model — `PayPeriodIssue`

Kept **separate** from `PayPeriodConfirmation` deliberately: an issue does NOT lock the period, so folding it into the confirmation row would have meant making `confirmedAt`/`confirmedBy` nullable and rippling into the lock logic (`isAttributionLocked` keys off active confirmations only). A separate table leaves the attribution-lock path untouched.

| Field                                        | Meaning                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `staffMemberId`, `periodStart`, `periodEnd`  | Which designer + bi-weekly window the flag is against.                        |
| `note`                                       | What the designer says is wrong (required).                                   |
| `reportedBy`, `reportedAt`                   | Audit of who raised it and when.                                              |
| `resolvedAt`, `resolvedBy`, `resolutionNote` | Set when a manager resolves it. `resolvedAt IS NULL` ⇒ the issue is **OPEN**. |

Indexes on `(staffMemberId, periodStart, periodEnd)` and `(resolvedAt)`. No unique constraint — but the report path is **idempotent while open**: `reportPayPeriodIssue` returns the existing open row instead of stacking a duplicate (one open issue per designer+period at a time).

### Behavior

- **Designer** (`/reports/pay-period-sales`): when the period is NOT confirmed and has no open issue, the statement shows a "Report an issue" button beside "Confirm these numbers". Reporting is allowed **at any time** (no period-ended gate — unlike confirm — so a designer can flag a problem mid-period). After reporting, the banner shows "issue pending review" + the note; the Confirm/Report buttons hide until the manager resolves it.
- **Manager** (privileged grid, same page): a row with an open issue shows "⚠ issue reported" + the note in red and a "Resolve issue" action. Resolving clears the flag (optional resolution note); the designer can then confirm. An open issue **blocks** the grid's "ready for review" all-clear even if every other designer has confirmed.
- Resolving does NOT itself lock — confirming still does. The manager's job on an issue is to fix the underlying numbers (rewrite / reassignment) and resolve, then the designer confirms.

### Files

- `lib/payPeriodIssue.ts` — pure helpers (`isIssueOpen`, `findOpenIssue`, `summarizeOpenIssues`); unit-tested in `__tests__/payPeriodIssue.test.ts`.
- `lib/payPeriodConfirmationService.ts` — `reportPayPeriodIssue`, `resolvePayPeriodIssue`, `getOpenIssueSummary`; `listPeriodConfirmationStatus` extended to attach `openIssue` per row and gate `readyForReview` on zero open issues.
- `pages/api/reports/pay-period-sales/report-issue.ts` (designer, self or privileged-on-behalf), `pages/api/admin/reports/pay-period-confirmations/resolve-issue.ts` (MANAGER / ADMIN / SUPER_ADMIN).
- Real-DB test: `__tests__/integration/payPeriodIssue.integration.test.ts` (report idempotency, grid surfacing + ready-for-review block, resolve clears).

### Team scope (deferred)

The manager grid currently shows **all** active designers to any MANAGER / ADMIN / SUPER_ADMIN. Owner confirmed 2026-05-29 NOT to scope by store, because **a manager can manage more than one store** — store-scoping would be wrong. A proper team model (a manager → many designers, possibly spanning stores) is deferred to a later PR; until then, all-designers visibility stands.

## Team commission view (2026-05-29) — TABLED, SUPER_ADMIN-only

Built as a manager view-only surface, then **re-gated to SUPER_ADMIN-only the same day** (owner: "gate all the commission shit to super-admin only, no one sees the recent work on the pay week reports or any of that… tabled until management discovers oh wait you were right"). The code is intact and parked — to restore broader access later, widen the `roles` on the page/card/endpoint.

- **Page** `/reports/commission` ("Team Commission") — **SUPER_ADMIN only**. Read-only grid of LOCKED payouts per designer per period (designer, pay period, period sales, commission $, paid date + total). No tier config, no preview/commit/edit — those stay on the SUPER_ADMIN `/admin/reports/commission-tiers` surface.
- **Endpoint** `GET /api/reports/commission-payouts` — **SUPER_ADMIN only**. Calls the shared `listCommissionPayouts({ designersOnly: true, includeDrafts: false })` so it returns only **locked** payouts for **flagged designers** (never drafts, never non-designers). Decimals serialized to numbers.
- **Shared query** `lib/commissionPayoutList.ts` — one `findMany` used by BOTH this endpoint AND the SUPER_ADMIN `handleList` (the commission-tiers Locked Payouts tab), so the two surfaces can't diverge on filtering. Real-DB test: `__tests__/integration/commissionPayoutList.integration.test.ts`.

### Pay-period statement + confirm/issue ledger — also TABLED (SUPER_ADMIN-only)

The whole pay-period statement surface (`/reports/pay-period-sales`, the confirm/lock + report-an-issue ledger, and the manager confirmation grid) is **SUPER_ADMIN-only as of 2026-05-29** — page AND every API (`pay-period-sales`, `confirm`, `report-issue`, and the `pay-period-confirmations/{index,reopen,resolve-issue}` endpoints). Hidden until management adopts it.

**The attribution-LOCK enforcement is unaffected** — `runSalesImport`'s preserve, the reassignment guards, and `backfillSalesPersonFk`'s skip all still honor any ACTIVE `PayPeriodConfirmation` regardless of who can view the report. In practice no NEW confirmations form while tabled (only SUPER_ADMIN can confirm), but any that already exist keep enforcing. Restoring the report is a `roles` widen on the pages + endpoints — no data/migration change.

## The `isDesigner` staff flag (2026-05-29)

`StaffMember.isDesigner` (Boolean, default false; migration `20260529c_staff_is_designer` backfills true for existing role=DESIGNER) controls who appears on **designer-based** sales + commission reports — independent of the auth `role`, so a selling MANAGER can be included and an ex-designer excluded. Toggle on the staff admin page (`/admin/staff`). Surfaces filtering on it:

- `listPeriodConfirmationStatus` (pay-period confirm/issue grid) → `where: { isDesigner: true, isActive: true }`.
- The designer pickers on `/reports/pay-period-sales` + `/reports/sales-by-salesperson` → `GET /api/staff?isDesigner=true`.
- The manager team-commission view → `designersOnly: true`.

Integration-test seeds that expect a designer on these surfaces must set `isDesigner: true` (not just `role: "DESIGNER"`) — see `payPeriodIssue` / `payPeriodConfirmationLock` seeds.
