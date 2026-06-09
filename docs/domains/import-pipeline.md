# the POS Import Pipeline

Automated daily ingestion of the POS reports via Gmail API. Reports are emailed as CSV attachments, fetched by the orchestrator, parsed, and processed by domain-specific runner functions.

## Flow

```
the POS -> email CSV -> Gmail "Automations" label
  -> orchestrator fetches -> gmailReportRouter matches filename -> runner processes
  -> label moved to "Automations/Processed"
```

Manual alternative: upload CSV via `/admin/import/POS-automation.tsx`.

## Cron Automation (Synology NAS)

The pipeline runs daily at 6:10 AM via Synology Task Scheduler.

**Script:** `scripts/auto-import.sh` -- sends a POST to `/api/automations/gmail-import` with a Bearer token.

**Task Scheduler setup:**

- Task: `the POS Daily Import`
- User: `root`
- Schedule: Daily at 06:10
- Command: `cd /path/to/holt && export $(grep AUTO_IMPORT_API_KEY app/.env.local) && ./scripts/auto-import.sh >> logs/auto-import.log 2>&1`

**Auth:** Uses `AUTO_IMPORT_API_KEY` from `app/.env.local` as a Bearer token. The endpoint also accepts NextAuth sessions for manual triggers from the admin UI.

**Monitoring:** Check `/admin/import/automated` for last run results, or `logs/auto-import.log` on the NAS for curl output.

## Report-to-Runner Map

| Filename Pattern | Import Type | Runner | Key Data |
|---|---|---|---|
| `Prior_Day_Sales_Data_Export` | sales | `runSalesImport` | Orders, line items, returns |
| `Daily_Quote_Report` | quotes | `runQuotesImport` | Open quotes |
| `Customer_Deposits_Export` | deposits | `runDepositsImport` | Customer deposits |
| `SH_Stock_by_Item` | stock | `runStockByItemImport` | Inventory positions |
| `Inbound_Items` | purchase-orders | `runPurchaseOrdersImport` | PO items with POR# |
| `Prior_Day_POR_Export` | purchase-orders | `runPurchaseOrdersImport` | PO items with POR# |
| `Prior_Day_Payments_Export` | payments | `runPaymentsImport` | Payment transactions |
| `Prior_Day_Invoice_Export` | invoices | `runInvoicesImport` | Invoices (handles order rewrites) |
| `Company_Customers` OR `Company_Prior_Day_Customers` | customers | `runCustomerImport` | Customer records |
| `Prior_Day_Received_Items` | received-items | `runReceivedItemsImport` | Goods in, creates ReceivingRecords |
| `Company_Inbound_Items` | inbound-items | `runInboundItemsImport` | Confirmed PO items with ESD |
| `Prior_Day_Temp_Items` OR `Prior_Day_Temp_Purchase_Orders` | temp-items | `runTempItemsImport` | Draft PO items |
| `SH_Purchase_Order_Line_Export` | po-lines | `runPOLineExportImport` | PO line details |
| `SH_Item_Export` | products | `runProductsImport` | Daily product master (~100K rows, Active=yes only) |

**Route order matters.** `Company_Inbound_Items` must be matched before the generic `Inbound_Items` pattern in `gmailReportRouter.ts`.

**2026-05-20 renames** (owner-side the POS export config change):

- `Company_Customers` → `Company_Prior_Day_Customers` (scopes to prior-day-only data)
- `Prior_Day_Temp_Items` → `Prior_Day_Temp_Purchase_Orders` (clearer naming on the POS's side)

Router regexes (`gmailReportRouter.ts`) match both old and new names so a fallback to the legacy filename still routes correctly. Tests pin both forms.

## Rewrites -- what the payments really mean

the POS lets a store "rewrite" an existing order to correct line items, swap products, or adjust totals. The rewrite gets a suffix (`SO-38971` → `SO-38971 - A`, can go through `- B`, `- C`, `- D`). For each rewrite the POS also emits an **accounting return** with the store-coded return prefix (`SR-38971` (a store-coded return prefix)). The three orders form a chain.

**All three stay ACTIVE in our database.** Daily sales totals then match the POS:

- Base: +$base_total on its original date
- Return: −$base_total on its own date (nets the base in same-period reports)
- Rewrite: +$rewrite_total on its own date

The one place this goes wrong is **payments**. the POS's payment CSV includes a row on the rewrite with `paymentType = "Gift Card"` for the exact amount of the base's original card deposit, and **no `Gift Card Barcode` / `Gift Card Code` fields**. That row is the POS's export of an *internal credit-note transfer* -- the base's deposit becoming a credit note on the return, then applied to the rewrite. We do not import credit notes as their own record; the transfer shows up only through the rewrite's "Gift Card" row.

**`runPaymentsImport` skips that phantom row.** Detection: `isRewriteOrder(orderno)` + `paymentType === "Gift Card"` + no gift-card barcode/code. Real POS gift-card redemptions always carry a barcode or code, so they are unaffected. The `phantomTransfersSkipped` counter on the result surfaces how many were skipped per import.

**Worked example** (from PO 5733 Cheshire data, 2026-04-22 investigation):

```
SO-1652           base, 2026-04-19, total $8,159.00
  Payment: Card Connect  $4,339.00 (real deposit)
SR-12... (or similar)  accounting return, 2026-04-22, line items = -$8,159.00
  Payments: none (it's an accounting entry, not a refund)
SO-1652 - A       rewrite, 2026-04-22, total $7,809.01
  Payment CSV row:  Gift Card  $4,339.00  -- SKIPPED by runPaymentsImport

Customer balance over the chain:
  total_due  = 8159 + (-8159) + 7809.01 = $7,809.01
  total_paid = 4339 (only the real card; the phantom is skipped)
  balance    = $3,470.01  (owed by customer)
```

Daily sales by store (Cheshire):

- 2026-04-19: +$8,159 (base contributes its full amount)
- 2026-04-22: −$8,159 (return) + $7,809.01 (rewrite) = −$349.99 delta on this date

This matches the POS's own "Sales by Store" report. **Don't try to `status = CANCELLED` your way out of a double-count symptom** -- CLAUDE.md rule 40 and the 2026-04-21 / 2026-04-23 failure log capture why.

**Historical cleanup.** Migration `20260423_uncancel_rewrite_bases` reverses the prior `20260421_cancel_rewrite_bases`, un-cancels 722 bases + 607 returns, and deletes phantom Gift Card rows from rewrites in production. Post-deploy: click "Recalculate Levels" on the Customers page so cached `lifetimeSpend` and `customerLevel` reflect the restored orders.

### Same-day rewrites — the dropped-line edge case (post-failure 2026-05-12)

The "all three stay ACTIVE, daily sales reconcile naturally" rule is true for cross-day rewrites. **Same-day rewrites have a quirk**: when the customer modifies an order before close-of-business, the POS's accounting return only credits items the customer KEPT, not items they DROPPED. The dropped items dangle in the base as `lineItemStatus = ACTIVE` with no offset, and double-count daily sales.

**Worked example** (SO-1726, Cheshire, Brian Tenerow, 2026-05-09):

| Order | Lines | Net |
|---|---|---|
| `SO-1726` base | 5 (cushion×3, sofa×1, delivery, lounges×2, delivery×1) | $4,298 |
| `SR-010045` return | 3 (cushion×-3, sofa×-1, delivery×-1) | -$3,189 |
| `SO-1726 - A` rewrite | 3 (cushion×3, sofa×1, delivery×1) | $3,189 |

Naive sum: `4298 + (-3189) + 3189 = 4298`. Cheshire 5/9 total: $4,298 (base) + $117 (three cash sales) = **$4,415**.

the POS shows: rewrite only, $3,189 + $117 = **$3,306**.

The $1,109 delta = lounges + extra delivery (base lines 4 & 5). the POS never returned them.

**Fix** (`lib/sameDayRewriteCleanup.ts` + post-import sweep in `runSalesImport`):

After every sales import, find every rewrite whose `orderDate` matches its base's `orderDate`. For each such pair, **also look up the same-day return-prefixed accounting return** (prefix-swap: the sale prefix→the return prefix, the sale prefix→the return prefix, the sale prefix→the return prefix). Apply the combined heuristic below to decide which base lines to cancel.

**Combined heuristic** (recalibrated 2026-05-15 after the SO-39618 over-cancellation incident — single-axis lineNumber-only was too aggressive):

A base line is "dropped" iff **all three gates** agree:

1. `lineNumber > max(rewrite.lineNumber)` — positional check. Protects unchanged base lines that the POS left in place (e.g. SO-39618's Vidya duvet at line 1 / shams at line 2, where lines 1–2 are within the rewrite's footprint of 2).
2. No available return line matches `partNo` AND `orderedQuantity = -base.qty` — consumption-based. Each return claims one base line; subsequent base lines with the same partNo can't re-claim it. When a return match is found, the corresponding rewrite line for the same partNo is also consumed (the rewrite is the re-billing leg of the same credit cycle).
3. No available rewrite line matches `partNo` (after pairing in step 2). Catches price-adjustment rewrites without a refund cycle.

```text
Pure detection:
  findDroppedBaseLineIds({ baseLines, rewriteLines, returnLines })
    -> base line IDs that fail ALL three gates

Post-import wiring (per rewrite imported):
  1. Look up the rewrite + base (same orderDate)
  2. Look up the same-day return-prefixed return by prefix-swap
  3. Run findDroppedBaseLineIds against the triple
  4. updateMany cancel the resulting line IDs
```

**Two canonical shapes the test set must keep green:**

| Case | Pattern | Helper output |
|---|---|---|
| SO-1726 (drop) | Customer dropped 2 lounge chairs + extra delivery. No returns for them. Rewrite has 3 lines. | Lines 4, 5 cancelled (beyond footprint + no return + paired rewrite already consumed) |
| SO-39618 (credit-cycle keep) | Customer kept 3 items via 3-way credit cycle + 2 unchanged base lines + 1 MRC sticky fee. | Only MRC cancelled (lines 1–2 in footprint, lines 3–5 consume returns) |

**Backfill**: migration `20260512_cancel_same_day_rewrite_dropped_lines` cancelled 71 historical lines across 191 same-day pairs. Daily reconciliation against the POS has matched on those historical days post-backfill, so those cancellations align with the POS's accounting view of the chain.

**Hotfix**: migration `20260515_restore_over_cancelled_lines` uncancels the four lines on SO-39618 that the 5/12 single-axis heuristic wrongly cancelled. Net OS 5/14: $20,169.17 → $24,493.48 (exact the POS match). Idempotent (second run = 0 rows).

**Return-lookup structural fix** (added 2026-05-22 after SO-39876, supersedes the broken `swapToReturnPrefix` lookup). The companion **50% safety guard** that originally shipped with this fix was **REMOVED later the same day** — it produced 12 false-positive uncancellations at the exact 50% boundary (1-of-2 drops misclassified as price-tweaks). Migration `20260522d_recancel_wrongly_restored_drops` reversed those 12 cases. Going forward, the operator flag `SalesOrder.skipSameDayRewriteCleanup` is the sole escape hatch for price-tweak shapes. See post-failure log 2026-05-22 (afternoon) for the full story. Root cause of SO-39876 + 29 similar historical incidents: `cleanupOneRewriteChain` looked up the same-day accounting return by `swapToReturnPrefix(baseOrderno)` (e.g. `"SO-39876"` → `"SR-39876"`). the POS's accounting-return ordernos use an INDEPENDENT numeric sequence: SO-1726's return is `SR-010045`, SO-39876's is `SR-013572`, SO-38847's is `SR-013491`. The numbers don't mirror the base order's number. Audit query 2026-05-22: 193 of 195 same-day rewrites have a matching same-day return when looked up by `(customerId, orderDate, prefix-pattern)`; the broken swap found 2. The runner ran with `returnLines = []` in ~99% of same-day rewrites, so gate 2 of `findDroppedBaseLineIds` was perpetually trivially satisfied and cancellation decisions fell back to position + rewrite-partNo alone. SO-1726 came out right by coincidence (dropped items were at high lineNumbers AND had partNos absent from the rewrite); SO-39876 didn't. Fix: (1) replace the orderno-swap lookup with `loadSameDayReturnLines({customerId, orderDate, prefix})` — proper join by customer and date with `orderno startsWith` the OA prefix. (2) Add a 50%-safety guard: if the heuristic would cancel `>=50%` of the base's ACTIVE lines, log a warning and skip. SO-1726 (drop) cancels 2 of 5 (40%) → passes. SO-39876 (price-tweak) would cancel 2 of 4 (50%) → skipped. Backfill migration `20260522b_restore_over_cancelled_price_tweak_rewrites` runs the new heuristic against historical data, restoring 29 lines / $13,948.04 across 16 base orders (8 historical days, 2025-05-02 through 2026-05-21). True-drop SO-1726-shape cancellations are NOT touched (24 such lines remain across 19 pairs).

**Operator override — `SalesOrder.skipSameDayRewriteCleanup`** is the SOLE escape hatch for the rare price-tweak rewrite shape after the 50% guard was removed (PR #322, 2026-05-22 afternoon). When TRUE on a base order, `cleanupOneRewriteChain` short-circuits entirely. PR #320's migration `20260522_skip_same_day_rewrite_cleanup_flag` adds the column and sets it TRUE on SO-39876 specifically. Going-forward UI: a future admin button on the sales order page can flip the flag without SQL. For now, set the flag via migration on a per-incident basis when the heuristic over-cancels.

**Drop vs price-tweak — the canonical discriminator** (PR #322 audit, 2026-05-22): when investigating whether a same-day-rewrite cancellation is correct, the reliable signal is **unit-price equality on matched partNos**:

- **Drop case**: rewrite re-bills kept items at the SAME unit price as the base (just re-instating items after the customer credit-cycled them). Lines on the base that DON'T appear in the rewrite are genuine drops → cancel them.
  - Worked example: SO-39006 (2026-05-13) — base has BAT-MB01 ($180) + BAT-MU01 ($1,100). Rewrite has BAT-MB01 ($180, identical unit price). The unmatched base line (BAT-MU01) is the dropped lounge chair → CANCEL.
  - Worked example: SO-1726 (2026-05-09) — 3 kept items on base, return, and rewrite at identical prices. Beyond-footprint base lines are dropped lounges → CANCEL.
- **Price-tweak case**: rewrite re-bills matched partNo at a DIFFERENT unit price than the base. Unmatched base lines are kept-unchanged → leave ACTIVE.
  - Worked example: SO-39876 (2026-05-21) — base SC-C312P at $510.00, rewrite SC-C312P at $510.01 (penny tweak). Other base lines are kept-unchanged. Operator flag preferred.
  - Worked example: SO-9254 — base NOUR-TACOMA $3,763, rewrite $3,010 (price adjustment of $753). Lines not in the rewrite stay active.

Audit SQL pattern (when investigating future same-day-rewrite incidents):

```sql
SELECT MAX(ABS(
  (bli."netPrice"/NULLIF(bli."orderedQuantity",0))
  - (rli."netPrice"/NULLIF(rli."orderedQuantity",0))
))::numeric(10,4) AS max_unit_price_delta
FROM "OrderLineItem" bli, "OrderLineItem" rli
WHERE bli."salesOrderId" = :base_id
  AND rli."salesOrderId" = :rewrite_id
  AND bli."partNo" = rli."partNo" AND bli."partNo" IS NOT NULL;
```

`delta = 0` → drop case (cancellation correct). `delta > 0` → price-tweak (set operator flag, leave lines active). `NULL` (no partNo overlap) → drop-and-swap (cancellation correct).

**Why this signal isn't in the runner's auto-cancellation logic**: the `findDroppedBaseLineIds` helper only sees partNo + qty + lineNumber today, not netPrice. Adding it is a future enhancement (Slice 6.14 maybe); for now the heuristic does the right thing on drops (which is the vast majority of cases) and the operator flag handles price-tweaks. Per CLAUDE.md rule 41's threshold-boundary expansion: when introducing the unit-price discriminator to the helper, audit the existing 30+ historical same-day-rewrite cancellations and verify the new logic agrees with each one before shipping.

**Known small gap** (documented, accepted): "sticky fee" partNos like MRC that the POS keeps active on base orders without any return/rewrite signal still get cancelled by the positional gate when they happen to land beyond the rewrite's footprint. ~$16 / MRC-occurrence. Surfaces immediately via daily reconciliation. A future config-driven `NEVER_CANCEL` partNo list could close this.

**Cross-day rewrites are unaffected.** The base + rewrite must share `orderDate` to qualify; the existing return-nets-the-rewrite invariant still holds for cross-day chains.

**Tripwires**:

- `__tests__/sameDayRewriteCleanup.test.ts` — 13 A-grade tests pinning both canonical shapes plus paired consumption, return-only, rewrite-only, lineNumber footprint, null-partNo conservative path
- `__tests__/importRunners.regression.test.ts` — `findDroppedBaseLineIds` must be imported into the runner; `cancelSameDayRewriteDroppedLines` must exist + be called; the base lookup must include both `orderno` AND `orderDate`
- Follow-up (not yet shipped): real-DB integration test exercising `runSalesImport` against a fixture CSV of the base + rewrite + the return prefix triple, asserting the cancellations match the helper's output

## Quote line-item reconciliation

`runQuotesImport` reconciles line items on every re-import, **including** when the order already exists in our DB. For each CSV row at index `i`:

- `lineNumber = i + 1`
- If an `OrderLineItem` already exists at that `lineNumber` for the order: **update** its fields
- Else: **create** a new `OrderLineItem`
- Any existing `OrderLineItem` whose `lineNumber > orderLines.length` is marked `lineItemStatus = "CANCELLED"` (orphan cleanup, mirrors `runSalesImport`)

This is what makes line-item edits in the POS -- adding rows, removing rows, changing prices/quantities -- actually flow through. The runner had an early-exit bug from 2026-03-26 to 2026-04-28 that updated only `quoteCode`/`quoteDate` and skipped the line-item loop entirely; SO-38985 was the surfacing report (failure log 2026-04-28). Tripwire test in `__tests__/importRunners.regression.test.ts` + behavior tests in `__tests__/importRunners.quotesReconcile.test.ts` guard against the regression.

Quote CSVs do NOT carry barcode / POR / VAT / productId -- those only land on a line once the quote becomes a sale and `runSalesImport` populates them. So the field set in `buildLineData()` is intentionally narrower than the sales runner's. Manually-relinked `productId` on an existing line is preserved across re-imports because Prisma treats `undefined` as "skip" in update payloads.

## Buyer-draft auto-link (Slice 5, 2026-05-12)

`runStockByItemImport` runs a post-import sweep that closes the buyer-drafts loop:

- For each EXPORTED `BuyerDraftItem` with `fulfilledProductId IS NULL` AND non-empty `barcode`
- Look up `Upc.upc = draft.barcode` (one Product can have multiple UPCs — Marjan rugs especially)
- If a matching Product is found: set `fulfilledProductId`, stamp `fulfilledAt = now`, flip status to FULFILLED
- Result's `buyerDraftsAutoLinked` counter reports how many drafts were linked

Pure planning helper `lib/buyerDraftAutoLink.ts:planAutoLinks` separates the matching logic from the I/O. 9 A-grade tests in `__tests__/buyerDraftAutoLink.test.ts`. See `docs/domains/buyer-drafts.md` "Slice 5 — Auto-link via Stock-by-Item" for the broader context.

The sweep runs OUTSIDE the per-batch transaction — idempotent, and a single failure shouldn't roll back the stock import.

## the POS CSV Quirks

- **No order statuses.** the POS does not export order status. Statuses are derived by `deriveSalesOrderStatus()`. See `docs/domains/sales-orders.md`.
- **`@` means empty.** `safeString()` returns undefined for the `@` character, which the POS uses as a placeholder.
- **Column name inconsistency.** Same field appears as `Orderno`/`orderno`, `Barcode No`/`barcode_no`, `Part No`/`part_no` across reports. All runners check both cases.
- **Payment modes are decimals.** `"27.00"` not `"27"`. `resolvePaymentMode` strips trailing `.0+`.
- **Daily exports only show active data.** Completed POs, old sales, and closed orders drop off the exports. Historical data requires one-time manual imports.
- **Multiline CSV fields.** Product descriptions in `grove_purchaseinvoicelines` wrap across multiple lines. Standard CSV parsers handle this but grep/awk do not.
- **BATCH_SIZE = 50.** Sales import processes 50 orders per transaction to avoid timeout.
- **Invoice Memo references base order.** Invoice Memo field contains the base order number (e.g., `SO-38549`), not the rewrite suffix (`SO-38549 - A`). The invoice import tries rewrite suffixes `- D` through `- A` before falling back to the base order number.
- **RS-prefix returns.** `isReturnOrder()` now detects RS-prefix orders (Returns store) as returns in addition to A-suffix store codes.
- **Auto-create products from imports.** the POS does not export a daily product file, but `findProduct()` in `importHelpers.ts` accepts `{ autoCreate: true }` to create a minimal Product record when a part number is not found. Applied to 5 runners: sales, PO import, received items, inbound items, PO line export. The auto-created product uses part number, name, vendor, and cost from the CSV row.
- **Customer ZIP+4 codes.** the POS customer addresses include ZIP+4 format (e.g., `06475-1234`). Any code matching ZIPs to delivery zones must strip to 5 digits first. The orders-by-zone API already does this.
- **Payment.status is always NULL.** All 44K Payment records imported from the POS have `status = NULL`. Queries using `status != 'VOIDED'` exclude all records because Postgres NULL comparison returns unknown. Use `OR: [{ status: null }, { status: { not: "VOIDED" } }]`.
- **Staff-email customer merging — fixed 2026-05-05** (PR #210/#211). Salespeople sometimes typed their own email when entering customers in the POS, and `findOrCreateCustomer`'s email-match clustered every later customer with that email into the FIRST record. ~138 customers across ~20 records affected at audit time. `isUntrustedMergeEmail(email)` now blocks any company-domain email (configured via the `COMPANY_EMAIL_DOMAIN` env var) from matching at import time. Recovery tool at `/admin/tools/customer-unmerge` un-merges existing damage by uploading the customer CSV and repointing per external id. See `docs/domains/customer-intelligence.md` "Customer-Merge Gotcha" for full details.
- **Email-collision pre-flight on customer create — fixed 2026-05-07** (Phase 0.6.3). `findOrCreateCustomer`'s create branch now does a pre-flight `findUnique({ where: { email } })` before `prisma.customer.create()`. If the email is already on another Customer row (e.g. a real shared email between two unrelated parties — name match check above already rejected the merge), the new customer is created with `email = NULL` instead of crashing the order with a `Unique constraint failed` error. Operator can reconcile via the merge-customers admin tool. The PR #214 marketing-donation-incident comment block described this protection but the actual `findUnique` call was missing — Phase 0.6.3 integration tests caught the gap.
- **Daily Quote Report has UNIT prices, not line totals** (2026-05-07 incident). The `Sellingprice Exvat` column in the Daily Quote Report is the per-unit price. The `netprice` column in the Daily Sales Report is the line total (unit × qty). Same the POS, two reports, different conventions. Before the PR #224 fix, `runQuotesImport`'s `reconcileExistingQuoteOrder` overwrote `OrderLineItem.netPrice` with `Sellingprice Exvat`, treating it as a line total — which silently broke every multi-qty line on every promoted order that re-appeared in the quote CSV. The fix: skip reconciliation entirely for non-QUOTE-status orders. **The vatAmount column survived all of this damage** (the POS calculates it at sale time and the runner doesn't touch it), so `vatAmount = netPrice × vatRate` is the canonical recovery path for any historic line that got corrupted — see `prisma/migrations/20260507_correct_sbom39275_v3/migration.sql` for the worked example, and CLAUDE.md rule 13 for the general principle ("restoration migrations derive target values from a column the corruption didn't touch").
- **Customer-stub name late-hydration — fixed 2026-05-16.** `findOrCreateCustomer` creates a placeholder Customer row when a sales CSV provides a `Cuscode` but no `Customer` (name) value — the comment block at line 132 explains why ("placeholder-create unblocks the sales→customer-import race"). The original implementation only late-updated `phone` when an existing stub got a new value; `firstName` / `lastName` stayed NULL forever, leaving 73 anonymous Customer rows accumulated in prod as of 2026-05-16. The fix adds a mirror branch right after the phone update: when an existing customer has NULL firstName/lastName AND the incoming CSV provides a `customerName`, fill in the NULL halves only (never overwrite an existing name). Self-heals through both the sales-import path AND the `runCustomerImport` path (both call `findOrCreateCustomer`). The 73 historical stubs catch up automatically on the next nightly customer-import once the cuscode reappears.
- **Rewrite-truncated CSVs** (2026-05-05, SO-39275 second hit). Once the POS creates a rewrite (`<orderno> - A`), the daily CSV permanently exports only the lines that "stayed" on the base — items that "moved" to the rewrite no longer appear in the base's section. Our `runSalesImport` orphan-cleanup interpreted "DB has 29, CSV has 17" as line removals and silently re-cancelled them on every run. Fix (PR #209): orphan-cleanup is now SKIPPED when a sibling rewrite exists. See `docs/domains/sales-orders.md` "Orphan Line Cleanup" for the freeze rule.

## Key Files

- `lib/gmailClient.ts` -- Gmail API client
- `lib/gmailReportRouter.ts` -- filename-to-runner dispatch
- `lib/importRunners.ts` -- all runner functions (~2000 lines)
- `lib/importHelpers.ts` -- pure utility functions (safeString, safeFloat, deriveSalesOrderStatus, etc.)
- `pages/api/automations/gmail-import.ts` -- pipeline orchestrator
- `scripts/auto-import.sh` -- cron script for Synology Task Scheduler

## Verification Checklist

- [ ] `npm test -- importHelpers` passes
- [ ] New report types added to both `gmailReportRouter.ts` REPORT_ROUTES and this runbook table
- [ ] New import endpoints have corresponding UI buttons
- [ ] Import transactions use `TX_TIMEOUT.LONG` for large datasets
- [ ] Runner handles both capitalized and lowercase CSV column names
- [ ] Runner is idempotent -- safe to process the same CSV twice

## Test Coverage

Covered: `safeString`, `safeFloat`, `safeDate`, `deriveSalesOrderStatus`, `isReturnOrder`, `derivePOStatus`, `parseDateFlexible`

Gaps: `findProduct()` and its `autoCreate` behavior have no tests.

---
Last verified: 2026-04-09 | Cron automation confirmed working, invoice rewrite matching added
