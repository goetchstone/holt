# Sales & Orders

Sales orders are imported from the POS daily via `Prior_Day_Sales_Data_Export`. the POS does not send order statuses -- they are derived during import.

## Order Number Convention

The order number encodes the store and transaction type:

| Prefix | Store | Suffix | Meaning |
|--------|-------|--------|---------|
| SB | Main Store | OM | Merchandise sale |
| SB | Main Store | OA | Return/credit |
| GT | Glastonbury | OM | Merchandise sale |
| GT | Glastonbury | OA | Return/credit |
| CH | Cheshire | OM | Merchandise sale |
| CH | Cheshire | OA | Return/credit |
| BB | Business to Business | OM | Merchandise sale |
| WS | Web Sales | OM | Merchandise sale |
| RS | Returns store | -- | Small set, 13 orders. RS-prefix detected as returns by `isReturnOrder()` |

**M = sale, A = return.** This is the primary return detection method.

### Order Rewrites

Orders with `- A`, `- B` after the number (e.g., `SO-38549 - A`) are **order rewrites** (replacements), NOT split shipments or returns. The rewrite replaces the original order entirely. Suffixes go up to `- D` in production data. The base order number is the version without the suffix.

**Invoice matching**: Invoice Memo references the base order number, not the rewrite. The invoice import tries suffixes `- D` through `- A` before falling back to the base. This is necessary because the active order in the system is the latest rewrite.

**All three orders in a rewrite chain stay ACTIVE.** When the POS creates a rewrite it also records an accounting RETURN (`the return prefix`/`the return prefix`/`the return prefix` prefix) that negates the base, plus a payment row on the rewrite with `paymentType = "Gift Card"` representing the internal credit-note transfer of the base's deposit. The base, the return, and the rewrite all remain in ACTIVE statuses (ORDER/FULFILLED/RETURNED) in our DB -- daily sales totals then match the POS on every date:

- Base: +$base_total on its original date
- Return: −$base_total on its own date (nets on same-period reports)
- Rewrite: +$rewrite_total on its own date

For balance/payment math, the "Gift Card" row on the rewrite is phantom (it's the same money as the base's card deposit re-exported as a credit-note application). The payments import runner `runPaymentsImport` skips it: condition is `isRewriteOrder(orderno)` + `paymentType === "Gift Card"` + no `Gift Card Barcode`/`Gift Card Code` on the row. Real POS gift-card redemptions always carry a barcode or code and are unaffected. See `docs/domains/import-pipeline.md` "Rewrites -- what the payments really mean" for the worked example.

Detection helpers:

- Rewrite pattern: `isRewriteOrder()` matches `/\s*-\s*[A-D]$/`
- Base extraction: `rewriteBaseOrderno()` strips the suffix

**Do NOT cancel rewrite bases or returns.** The 2026-04-21 `cancelSupersededBases()` approach (and the `20260421_cancel_rewrite_bases` migration) were REVERTED on 2026-04-23 via `20260423_uncancel_rewrite_bases` -- the cancellation was fixing the phantom-payment symptom at the wrong layer and broke daily-sales date distribution across all store reports. CLAUDE.md rule 40 captures the general principle: status is a broad hammer; fix imports at the import boundary, not by mutating data after the fact.

## Status Derivation

`deriveSalesOrderStatus()` in `lib/importHelpers.ts` determines status using these checks in order:

1. Explicit "cancelled" in Status CSV field -> CANCELLED
2. Explicit "return"/"returned" in Status CSV field -> RETURNED
3. Order number has R/CR prefix -> RETURNED
4. Order number has A-suffix store code (return prefixes) -> RETURNED
5. Negative net total across all line items -> RETURNED
6. Default -> ORDER

**the POS does not send statuses.** Do not look for or expect a status field in the CSV.

## Orphan Line Cleanup

When an order is reimported with fewer line items than a prior import, the sales runner marks lines with `lineNumber > maxLine` as `lineItemStatus = CANCELLED` (since 2026-04-25; was `delete` before but a FK to InvoiceLineItem made deletes fail mid-batch). This prevents ghost duplicates. Quote imports can seed lines that the sales import later overwrites — this is expected.

**Reactivation** (PR #201, 2026-05-02): When a CSV provides a row at a `lineNumber` that already has an existing CANCELLED line with NULL `cancelReason` (= orphan-cancelled, not user-cancelled), the runner resets it to ACTIVE. This handles line-count oscillation across re-imports where a CSV temporarily shrinks then grows back to its real size.

**Rewrite-freeze exception** (PR #209, 2026-05-05; tightened 2026-05-07): Orphan-cleanup is **skipped entirely** for any order whose sibling rewrite (`<orderno> - A` / `- B` / `- C` / `- D`) already exists in the DB. After the POS splits an order into base + rewrite, the daily CSV permanently exports only the lines that "stayed" on the base — the items that "moved" now appear in the rewrite's CSV section. Without the freeze, every subsequent re-import would silently re-cancel the moved lines, dropping the base order's value from daily-by-store reports (the POS's own daily report still attributes the full pre-rewrite value to the original date because the rewrite chain is netted on the rewrite's date by the the return prefix accounting return). The check: `!isRewriteOrder(orderno) && (await tx.salesOrder.findFirst({ where: { orderno: { startsWith: \`${orderno} - \` } } })) !== null`. Per-line UPDATE still runs, so a manual re-import of a corrected CSV refreshes values; the reactivation guard from PR #201 still brings back any line the new CSV provides. See failure-log entries 2026-05-05 and 2026-05-07 (SO-39275 first and second hits — the second was caused by the QUOTE runner having its own un-frozen orphan-cleanup; both runners now have the freeze).

**Quote runner — promoted-order guard** (post-failure log 2026-05-07): the Daily Quote Report from the POS includes EVERY order that ever had a quoteCode, including ones that have since been promoted to `status=ORDER`. Before 2026-05-07, `reconcileExistingQuoteOrder` reconciled line items for any order in the quote CSV regardless of status — and the quote CSV's `Sellingprice Exvat` column is a UNIT price (not a line total). This produced two bugs simultaneously: (1) multi-qty line totals on promoted orders got overwritten with unit prices, and (2) the quote runner's orphan-cleanup ran without the rewrite-freeze, re-cancelling lines on rewrite-base orders every auto-import. SO-39275's $7,819 OS gap recurred because of this. Fix: `runQuotesImport` now skips `reconcileExistingQuoteOrder` when `existing.status !== "QUOTE"`. The Sales runner is authoritative for promoted orders; the quote runner stays out. The freeze guard was also added to `reconcileExistingQuoteOrder` itself as defense in depth.

## Status Reconciliation (2026-04-08)

Order statuses were reconciled using the POS `Customer_Deposits_Export` file as the source of truth for which orders are genuinely open:

- 495 orders confirmed as ORDER (matching the POS deposits)
- ~3,651 A-suffix/RS-prefix orders marked RETURNED
- Remaining orders with invoices promoted to FULFILLED
- Orders not in deposits and without invoices left as ORDER for manual review

The status derivation logic handles the daily feed going forward. The one-time reconciliation fixed historical data.

## Salesperson Correction Preservation

If `SalesOrder.salesPersonId` is set (manual correction from split import or reassignment), the daily sales import skips updating the `salesperson` string field to avoid overwriting the correction. Detected via `correctedOrders` set in `runSalesImport()`.

## Per-line-item salesperson splits — NOT SUPPORTED (manual workaround required)

**Our schema cannot represent splitting an individual line item between two salespeople.** Verified 2026-05-22 against `schema.prisma`:

| Field | Lives on | Supports |
|---|---|---|
| `salesPersonId` + `salesperson` (string) | `SalesOrder` only | Single owner per order |
| `splitWithId` | `SalesOrder` only | One additional person — order is 50/50 between the two |
| `salesPersonId` on `OrderLineItem` | **DOES NOT EXIST** | — |

Line items inherit the order's salesperson(s). A single order is owned by one person OR split 50/50 between two — that's the whole envelope, not per-line.

### The the POS case that broke this assumption

SO-39837: managers in the POS have started splitting **a single line item** within an order (e.g. "only the live edge table is split between David and Julia, the rest of the order is David's"). the POS allows this. Our schema does not.

**No code or schema change for this** — owner direction 2026-05-22: *"we are not making changes for nonsense, they would need to write the one order into two different ones for us to split it in the ERP."* The split-per-line workflow on the POS's side is operational nonsense from the ERP's perspective, and the salespeople were directed to use the POS — so the workaround is on the operator/manager.

### Manual workaround for managers

When the POS has a single-line-item split that needs to land in our ERP correctly, the manager must restructure it in the POS as **two separate orders**:

- **Order A** (original orderno): everything EXCEPT the split line(s). Salesperson = the primary owner.
- **Order B** (new orderno): ONLY the split line(s). Salesperson = primary, `splitWith` = secondary. Order-level 50/50 split now correctly represents the line-level split because Order B contains only that one line.

After the manager does this, the daily sales import ingests both orders with normal semantics — Order A goes 100% to David, Order B goes 50/50 David + Julia. The ERP-side commission math + designer-credit reports work because the split is now at order level (which we DO support).

### What our import does today when it sees the unsupported shape

If the SO-39837 shape lands in our DB unchanged (single order with `splitWith` set but ALSO some line items belonging only to one person), we'd attribute the WHOLE order 50/50 — which over-credits Julia on the non-table lines AND under-credits David. **The data would be wrong.** That's why the manual workaround is required: the manager must split the order in the POS first.

There's no automated detection for this pattern on our side — the import has no signal that a single line is meant to be split. The manager catches it at the operational level. If we ever need to detect it, the path would be a Sonar-style "this order has a split flag but only some lines are split" report, but per owner direction that's also nonsense work we're not building.

## The Cancelled Line Rule

**Every query that sums line item amounts MUST filter `lineItemStatus: { not: "CANCELLED" }`.** Cancelled lines from orphan cleanup or manual cancellation must never inflate totals.

Files that currently enforce this: `sales-summary.ts`, `salesperson-detail.ts`, `monthly-performance.ts`, `designer-dashboard.ts`, `sales-performance.ts`, `windfall-sales.ts`.

## Key Files

- `lib/importHelpers.ts` -- `deriveSalesOrderStatus()`, `isReturnOrder()`, `RETURN_STORE_SUFFIX`
- `lib/importRunners.ts` lines 47-362 -- `runSalesImport()`
- `lib/paymentService.ts` -- `computeBalance()`, `postPayment()`
- `pages/api/sales/` -- 18 API endpoints

## B2B Proposals

`Proposal`, `ProposalLineItem`, `ProposalItemImage` models. Builder at `/sales/proposals` (MANAGER/ADMIN only). User-entered cost + retail pricing. Image upload per line item. PDF generation via jsPDF. Convert to SalesOrder via `/api/proposals/[id]/convert-to-order`. Proposal number format: `BP-YYMMDD-NNN`.

## Pipeline Page

Quote cards show:

- Customer name + **Lead Score badge** (all roles — HOT/WARM/COOL/NEW) + Wealth Tier badge (ADMIN/MARKETING only)
- Order number, store, salesperson, quote date
- Urgency badge (days since last contact or quote creation)
- Line item summary and last interaction

`daysBetween()` uses `Intl.DateTimeFormat.formatToParts` for Eastern timezone. Null dates default to 0 ("Today"). Payment links and Customer Portal hidden from designers (MANAGER/ADMIN only).

Pipeline API (`api/sales/pipeline/index.ts`) computes lead score per customer and conditionally includes/omits `wealthTier` in the response based on session role (server-side enforcement — never leak wealth even if client hides it).

## MANAGER_NOTE Interactions

Managers can add `MANAGER_NOTE` source interactions to quotes from the Pipeline Opportunity report drilldown. Notes appear in the order's interaction history.

## Quote Archive + Replacement Link

`SalesOrder.pipelineArchivedAt`, `pipelineNote`, `archiveReason`, and `replacedByOrderId` work together to remove duplicate/outdated quotes from pipeline counts and conversion denominators without deleting them.

Archive via `PATCH /api/sales/pipeline/[id]` with `{ archived: true, reason, replacedByOrderId?, note? }`. Reasons: Updated Quote, Duplicate, Customer Passed, Stale, Lost to competitor, Customer unresponsive, Other. When `reason` is "Updated Quote" or "Duplicate" the UI presents a dropdown of other active quotes on the same customer; the selected one is stored in `replacedByOrderId`.

Archived quotes:

- Default-hidden on pipeline (toggle "Include archived" to see them)
- Excluded from `quoteCount` / `totalValue` staff metrics
- Show as greyed cards with "Replaced by SO-1234 →" pill when the link is set

Designers can archive their own quotes. Managers/Admins can archive any.

## Duplicate Quote Detection

Pipeline API flags probable duplicates via `lib/duplicateQuotes.ts`. Two active quotes on the same customer are flagged when either:

- 50%+ of distinct part numbers overlap (Jaccard-style: shared / max)
- Totals within 10% of each other AND both ≥ $100

Response includes `possibleDuplicateOf: { id, orderno }[]` per quote. UI shows a yellow "Possible duplicate of …" badge on cards. Archived quotes are excluded from detection (intentional — once you've decided something is a duplicate, stop flagging it).

## OrderLineItem.netPrice Invariant

`OrderLineItem.netPrice` stores the **line total** (unit price × quantity), not the unit price. Both the POS imports and POS creation follow this model. `computeBalance()` in `lib/paymentService.ts` is the canonical total calculation — always prefer it over re-implementing the formula. If you need the unit price, divide: `netPrice / orderedQuantity`.

## paymentService → CustomerLedger atomic wiring (Phase 0.5.4, 2026-05-12)

`recordPayment` and `processRefund` in `lib/paymentService.ts` now call `appendEntry` from `lib/customerLedger.ts` **inside the same `$transaction`** as the Payment row write. Three things commit together or not at all:

1. `Payment.create` (or the refund payment row)
2. `CustomerLedgerEntry.create` with signed amount (PAYMENT = negative, REFUND_ISSUED = positive — see `signForType`)
3. `Customer.openArBalance` update via `appendEntry`'s atomic balance-bump

**CustomerId resolution order**: `input.customerId` → `SalesOrder.customerId` → null. When both are null (true walk-in cash sale on an unlinked order), the Payment writes but the ledger entry is skipped — the ledger is per-customer; a row with no customer is meaningless. Tested as the third assertion in `paymentServiceLedger.integration.test.ts`.

**Why this matters**: the AR ledger backfill (`POST /api/admin/customer-ledger/backfill`) re-derives every customer's balance from the source-of-truth Payment + SalesOrder + OrderLineItem rows. Before this wiring, every new payment recorded after the backfill ran would silently desync `Customer.openArBalance` from the ledger (the backfill catches up, the live writes drift). The daily AR-drift cron (Phase 0.5.5, next up) would then surface noise that wasn't a real bug — just a missing wire.

**Tests** (B-grade integration, `__tests__/integration/paymentServiceLedger.integration.test.ts`): 7 cases covering payment + ledger atomic, customerId resolution from order, walk-in skip, refund REFUND_ISSUED positive sign, full-refund status transition, payment failure rolls back Payment row too.

## Verification Checklist

- [ ] `npm test -- importHelpers` passes
- [ ] Any line item aggregation filters `lineItemStatus: { not: "CANCELLED" }`
- [ ] Return detection handles return-prefixed patterns (not just R/CR prefix)
- [ ] Order rewrite suffixes (`- A`, `- B`) are not mistakenly treated as returns
- [ ] Invoice import tries rewrite suffixes before base order number
- [ ] Salesperson corrections (salesPersonId set) are preserved on reimport

## Test Coverage

Covered: `deriveSalesOrderStatus`, `isReturnOrder` (R/CR prefix), `isRefundPayment`

Gaps: `isReturnOrder` for return-prefixed patterns (RETURN_STORE_SUFFIX regex)

---
Last verified: 2026-04-17
