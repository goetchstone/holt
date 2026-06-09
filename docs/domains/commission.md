# Commission Payouts

Owner-confidential. Every page and endpoint described here is gated to
**SUPER_ADMIN** at both the API layer (`requireAuthWithRole(["SUPER_ADMIN"], …)`)
and the UI layer.

Origin: owner direction 2026-05-27 — *"they are currently using a
google sheet that someone is hand entering in the data so we can
probably do better … date, daterange, sales amount, ytd, comm tier,
comm rate, comm, salesperson … lock it in so that won't let you undo
once locked in … SUPER_ADMIN can edit with an audit comment."*

## What this domain owns

Two surfaces, both at `/admin/reports/commission-tiers`:

1. **Live preview** (`Live Preview` tab). Pre-existing. Picks any
   date range, computes per-designer YTD + marginal commission in
   memory, never writes to the DB. Used for "what does this period
   look like right now?" exploration. Backed by
   `GET /api/admin/reports/commission-tiers` (still in place).
2. **Locked payouts** (`Locked Payouts` tab, added 2026-05-27). Same
   math, but the operator presses *Generate Payouts* with a custom
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

| Column | Type | Notes |
|---|---|---|
| `staffMemberId` | Int FK | Designer/manager the payout is for. |
| `periodStart`, `periodEnd` | DateTime | Inclusive endpoints; pay periods are not necessarily month-aligned. |
| `periodSalesAmount` | Decimal | `max(0, ytdAtEnd − ytdAtStart)`. Stored so historical math is auditable even if SalesOrder data shifts later. |
| `ytdSalesAtStart`, `ytdSalesAtEnd` | Decimal | YTD-before and YTD-through the period (Jan 1 anchor). |
| `tierBreakdown` | JSONB | Array of `{tierLabel, rate, sliceAmount, sliceCommission}` — which tiers the slice spanned. |
| `commissionAmount` | Decimal | Total commission paid; operator can override before commit. |
| `tierDefinitionSnapshot` | JSONB | Frozen copy of `CommissionTier` rows at generation time. Re-rendering a locked payout reads THIS, not the live `CommissionTier` table, so retroactive tier edits never rewrite history. |
| `lockedAt`, `lockedBy` | DateTime?, String? | Both null while draft; both set the instant the row is locked. |
| `paidOn` | DateTime? | When the check actually cut. Editable. |
| `notes` | String? | Free-form operator note (e.g. *"Year-end true-up"*). |
| `created/updated/createdBy/updatedBy` | audit | Standard. |

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

| File | Role |
|---|---|
| `app/prisma/schema.prisma` | Both new models live at the bottom of the file with a doc comment. |
| `app/prisma/migrations/20260527_commission_payouts/migration.sql` | Schema + indexes. |
| `app/src/lib/commissionTiers.ts` | Pre-existing. `calculateMarginalCommission()` does the slice-by-slice math; reused by both surfaces. |
| `app/src/lib/commissionSales.ts` | Pre-existing (extracted from the live-preview endpoint). `sumDesignerSales(staffId, matchNames, from, toExclusive)` — shared between live and locked. Aliases + FK + the POS-string OR; 0.5× for splits; ORDER/FULFILLED/RETURNED. |
| `app/src/lib/commissionPayout.ts` | Pure helper `computePayoutForRange(input)` — caller hands in pre-summed YTD-start + YTD-end + tier list; returns the row-shape draft. Used by both preview and commit. |
| `app/src/lib/runCommissionPayouts.ts` | Orchestrator. Three entry points: `previewPayoutsForPeriod`, `commitPayoutsForPeriod`, `editPayout`. **Chain continuity**: when a prior LOCKED payout exists for the same designer with `periodEnd < periodStart`, this period's `ytdAtStart` reads from THAT row's frozen `ytdSalesAtEnd`, not from a live recompute. |
| `app/src/lib/commissionDrift.ts` | `computeLockedPayoutDrift({staffMemberId?, includeClean?})` — for each locked payout, compares the frozen `ytdSalesAtEnd` against a live recompute. Non-zero results are surfaced on the UI Drift banner so SUPER_ADMIN can decide whether to claw back via edit or accept the variance. |
| `app/src/lib/commissionPeriodOverlap.ts` | Pure helper `findOverlappingPayoutPeriods(start, end, existing)` — date-range overlap detection that allows exact-match re-runs but refuses partial / contained / containing / boundary-touch overlaps. Backs the period-overlap guard in `commitPayoutsForPeriod`. |
| `app/src/pages/api/admin/reports/commission-payouts/index.ts` | GET (list with filters) + POST (`?action=preview` and `?action=commit`). |
| `app/src/pages/api/admin/reports/commission-payouts/[id].ts` | GET (single + audit log) + PATCH (edit-with-audit). |
| `app/src/pages/api/admin/reports/commission-payouts/drift.ts` | GET — returns drift rows for every locked payout (or one designer's). SUPER_ADMIN only. |
| `app/src/components/commission/LockedPayoutsTab.tsx` | UI for the Locked Payouts tab — date pickers, generate flow, preview panel, payout history table, expandable rows, edit drawer, **DriftBanner** (quiet when clean, loud-red when not). |
| `app/src/pages/admin/reports/commission-tiers.tsx` | Wraps the existing live-preview content into a `LivePreviewSection` sub-component and adds the tab switcher. |
| `app/__tests__/commissionPayout.test.ts` | 6 pure unit tests for `computePayoutForRange`. |
| `app/__tests__/integration/runCommissionPayouts.integration.test.ts` | 22 real-DB tests covering preview + commit + edit + lock semantics + chain continuity (5 scenarios: late-return inside next period, late-return inside locked period, no-prior-lock fallback, ignores-DRAFT, year-boundary reset). |
| `app/__tests__/integration/commissionDrift.integration.test.ts` | 8 real-DB tests covering drift detection (no-lock empty, no-drift empty, late-the return prefix-inside-period flagged, cancellation flagged, backdated-sale positive drift, designer filter, includeClean, DRAFT-rows-ignored). |

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

| Event | Live YTD | Locked YTD | What happens |
|---|---|---|---|
| Period 1 (5/1–5/15): Alice sells $750k | 750k | — | LOCK → frozen `ytdSalesAtEnd = 750k`, commission = $22,500 |
| Period 2 starts. Alice sells $100k on 5/20 | 850k | 750k | (no preview yet) |
| 5/22: customer returns $50k (5/3 sale, the return prefix) | 800k | 750k | Live recompute of period-1 range now shows 700k — but the lock still says 750k |
| Period 2 preview/commit (5/16–5/31) | | | `ytdAtStart = 750k` (FROM LOCK, not 700k from live), `ytdAtEnd = 800k` live → $50k slice × 4% = $2,000 commission. Total YTD commission = $22,500 + $2,000 = $24,500 — matches marginal-on-cumulative-YTD against current $800k YTD. |
| Drift report | | | Period 1 row shows `lockedYtdAtEnd = 750k, liveYtdAtEnd = 700k, drift = -$50k`. Operator reviews. |

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

Once any payout exists for a date range (draft OR locked), generating a NEW pay period whose dates overlap that range is **refused**. Origin: owner direction 2026-05-27 — *"once we have a payperiord drafted or locked we should not be able to generate new data against it."*

**The rule** (pure helper `lib/commissionPeriodOverlap.ts:findOverlappingPayoutPeriods`):

| Existing | New request | Allowed? |
|---|---|---|
| 5/1–5/15 (any state) | 5/1–5/15 | ✅ Exact match — idempotent re-run; row UPDATEs in place |
| 5/1–5/15 | 5/16–5/31 | ✅ Adjacent, no overlap |
| 5/1–5/15 | 5/10–5/25 | ❌ Partial overlap |
| 5/1–5/15 | 5/12–5/14 | ❌ Contained inside |
| 5/12–5/14 | 5/1–5/15 | ❌ Containing |
| 5/1–5/10 | 5/10–5/25 | ❌ Boundary day shared |

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
committing (e.g. *"add $500 bonus per Tom"*).

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

`runCommissionPayouts.ts:loadTiers()` reads `CommissionTier` from the
DB (falling back to `DEFAULT_COMMISSION_TIERS` only when the table is
empty — i.e. dev DBs). Same source the live-preview tab reads, so the
two tabs cannot diverge as long as the operator hasn't edited tiers
between previewing live and committing locked.

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

| State of existing row | Action |
|---|---|
| No existing row | INSERT new draft (or locked, if `lockNow=true`). |
| Existing DRAFT row | UPDATE in place — commission, sales, breakdown all refresh from the current SalesOrder data. |
| Existing LOCKED row | SKIP. Result counts it in `payoutIds` but doesn't touch the row. Operator must unlock-via-PATCH first. |

This is the safety net for the operator: a forgotten import, a late
return, an the return prefix backdated to inside the period — all the operator
has to do is press *Generate Payouts* again and the draft rows pick
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

- **No historical backfill.** Owner direction 2026-05-27: *"Fuck no."* The Google Sheet history doesn't move into the ERP. Going forward only.
- **No SUPER_ADMIN scope below SUPER_ADMIN.** Managers cannot view this tab at all. If a workflow case ever requires manager visibility (read-only), add an explicit role parameter to the API and a separate read-only tab variant — don't expand `requireAuthWithRole` casually.
- **No printable payslip view.** Operator copies numbers into the existing payroll-export process by hand. If/when payroll automates, the row data + audit history is all the input needed. **Partially addressed 2026-05-29**: designers now have a self-service `/reports/pay-period-sales` statement (sales only, bi-weekly, CSV export) so they stop hand-copying into Google Sheets. Commission $ still SUPER_ADMIN-only.

## Pay-period confirmation + attribution lock (Slice 2)

Owner direction 2026-05-29: *"the designer should have a confirm the numbers button … It should lock any salesperson changes for the period … a real ledger … we already sent bad numbers last payperiod with David."* Manager view shows confirmed status; "ready for review" once every active designer has confirmed.

### Decisions (owner-confirmed 2026-05-29 — do not re-litigate)

1. **Per-designer lock, manager-reopenable.** A designer confirming period P freezes ONLY their own attribution for orders dated in P. A MANAGER / SUPER_ADMIN can reopen a confirmation with an audit reason (mirrors the commission unlock-with-audit pattern); it re-locks on re-confirm.
2. **Can only confirm a period that has ENDED.** Confirmation is rejected while `periodEnd >= today`. You cannot lock a period that's still in progress.
3. **Rewrites are dated the rewrite day, NOT backdated.** A rewrite/return of a locked-period order, performed later, lands in the CURRENT (open) period — it can never mutate a locked past period. This is WHY the model is clean: combined with decision #2, there is no "late activity poisons a locked period" path. The lock only ever freezes existing attribution on already-closed periods.

### Model — `PayPeriodConfirmation`

| Column | Notes |
|---|---|
| `staffMemberId` FK | The designer who confirmed. |
| `periodStart`, `periodEnd` | DateTime, inclusive — the bi-weekly window (`lib/payPeriod.ts`). |
| `confirmedAt`, `confirmedBy` | Set on confirm. |
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

A designer who reviews their statement and finds it wrong needs a way to say so instead of confirming. Owner: *"There also needs to be a way to communicate an issue if there is one."*

The flag is the **opposite signal of a confirmation**: confirming says "these are right, lock them"; reporting an issue says "these are wrong, don't pay yet — fix them first."

### Model — `PayPeriodIssue`

Kept **separate** from `PayPeriodConfirmation` deliberately: an issue does NOT lock the period, so folding it into the confirmation row would have meant making `confirmedAt`/`confirmedBy` nullable and rippling into the lock logic (`isAttributionLocked` keys off active confirmations only). A separate table leaves the attribution-lock path untouched.

| Field | Meaning |
|---|---|
| `staffMemberId`, `periodStart`, `periodEnd` | Which designer + bi-weekly window the flag is against. |
| `note` | What the designer says is wrong (required). |
| `reportedBy`, `reportedAt` | Audit of who raised it and when. |
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
