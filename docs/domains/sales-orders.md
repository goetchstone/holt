# Sales & Orders

Sales orders are imported from the POS daily via `Prior_Day_Sales_Data_Export`. Status is derived during import -- but the CSV's optional `Status`/`Orderstatus` column IS read first, and two of its values are load-bearing (see Status Derivation).

## Order Number Convention

### Orders holt creates

The POS (`api/sales/orders/create-from-cart.ts`) and proposal conversion
(`api/proposals/[id]/convert-to-order.ts`) both number orders through one
function, `lib/orderNumber.ts` `nextOrderNumber()`: `<prefix>-YYMMDD-NNN`, where
YYMMDD is the business day in `AppSettings.timezone` (not the server's clock) and
NNN restarts at 001 each day. The prefix is `AppSettings.orderNumberPrefix`, set
under Settings → Numbering; unset, it is the initials of the company name
(`lib/numberingPrefix.ts` `effectivePrefix()`). Generated barcodes use
`AppSettings.barcodePrefix` the same way. Changing a prefix affects new orders
and barcodes only: existing ones keep what they were issued. Numbering takes a
transaction-scoped advisory lock on the day's stem before reading the day's
highest number, so sales finalised at the same moment get consecutive numbers.
Without it, 9 of 10 simultaneous orders failed on the unique `orderno`
(`orderNumberConcurrency.integration.test.ts`).

### Imported orders

The order number encodes the store and transaction type:

Store codes are deployment data (`LEGACY_POS_STORE_CODES`, `LEGACY_POS_RETURN_PREFIXES`); the codes
below are placeholders showing the shape.

| Prefix | Store                | Suffix | Meaning                                                                           |
| ------ | -------------------- | ------ | --------------------------------------------------------------------------------- |
| S1     | Store 1              | OM     | Merchandise sale                                                                  |
| S1     | Store 1              | OA     | Return/credit                                                                     |
| S2     | Store 2              | OM     | Merchandise sale                                                                  |
| S2     | Store 2              | OA     | Return/credit                                                                     |
| S3     | Store 3              | OM     | Merchandise sale                                                                  |
| S3     | Store 3              | OA     | Return/credit                                                                     |
| B2B    | Business to Business | OM     | Merchandise sale                                                                  |
| WEB    | Web Sales            | OM     | Merchandise sale                                                                  |
| RET    | Returns store        | --     | Small set. A configured return prefix is detected as returns by `isReturnOrder()` |

**M = sale, A = return.** This is the primary return detection method.

### Order Rewrites

Orders with `- A`, `- B` after the number (e.g., `SO-10008 - A`) are **order rewrites** (replacements), NOT split shipments or returns. The rewrite replaces the original order entirely. Suffixes go up to `- D` in production data. The base order number is the version without the suffix.

**Invoice matching**: Invoice Memo references the base order number, not the rewrite. The invoice import tries suffixes `- D` through `- A` before falling back to the base. This is necessary because the active order in the system is the latest rewrite.

**All three orders in a rewrite chain stay ACTIVE.** When the POS creates a rewrite it also records an accounting RETURN under the store's A-suffix prefix (`<store>OA` -- the base's `<store>OM` prefix with `M` swapped for `A`, `sameDayReturnPrefixFor()` at `lib/adapters/legacyPos/runners.ts:886`) that negates the base, plus a payment row on the rewrite with `paymentType = "Gift Card"` representing the internal credit-note transfer of the base's deposit. The base, the return, and the rewrite all remain in ACTIVE statuses (ORDER/FULFILLED/RETURNED) in our DB -- daily sales totals then match the POS on every date:

- Base: +$base_total on its original date
- Return: −$base_total on its own date (nets on same-period reports)
- Rewrite: +$rewrite_total on its own date

For balance/payment math, the "Gift Card" row on the rewrite is phantom (it's the same money as the base's card deposit re-exported as a credit-note application). The payments import runner `runPaymentsImport` skips it: condition is `isRewriteOrder(orderno)` + `paymentType === "Gift Card"` + no `Gift Card Barcode`/`Gift Card Code` on the row. Real POS gift-card redemptions always carry a barcode or code and are unaffected. See `docs/domains/import-pipeline.md` "Rewrites -- what the payments really mean" for the worked example.

Detection helpers:

- Rewrite pattern: `isRewriteOrder()` matches `/\s{0,8}-\s{0,8}([A-D])$/` (`lib/adapters/legacyPos/shared.ts:168`)
- Base extraction: `rewriteBaseOrderno()` strips the suffix

**Do NOT cancel rewrite bases or returns.** The 2026-04-21 `cancelSupersededBases()` approach (and the `20260421_cancel_rewrite_bases` migration) were REVERTED on 2026-04-23 via `20260423_uncancel_rewrite_bases` -- the cancellation was fixing the phantom-payment symptom at the wrong layer and broke daily-sales date distribution across all store reports. CLAUDE.md rule 40 captures the general principle: status is a broad hammer; fix imports at the import boundary, not by mutating data after the fact.

## Status Derivation

`deriveSalesOrderStatus()` in `lib/adapters/legacyPos/shared.ts` determines status using these checks in order:

1. Explicit "cancelled" in Status CSV field -> CANCELLED
2. Explicit "return"/"returned" in Status CSV field -> RETURNED
3. `isReturnOrder(orderno)` -> RETURNED. One call covering three shapes: R/CR prefix, a bare configured return prefix, and A-suffix store code (`shared.ts:208-212`)
4. Negative net total across all line items -> RETURNED
5. Default -> ORDER

**The status field in steps 1-2 is real but optional.** The runner reads `safeString(firstRow.Status) || safeString(firstRow.Orderstatus)` (`lib/adapters/legacyPos/runners.ts:273`). Only "cancelled" and "return"/"returned" mean anything; every other value, and its absence, falls through to the order-number and net-total heuristics.

**The derived status does not always win.** The runner refuses to downgrade an existing order (`runners.ts:300-311`): an existing FULFILLED or CANCELLED order keeps its status outright, and an existing RETURNED order keeps RETURNED whenever the derivation says ORDER. In every other case the derived value is written.

## Orphan Line Cleanup

When an order is reimported with fewer line items than a prior import, the sales runner marks lines with `lineNumber > maxLine` as `lineItemStatus = CANCELLED` (since 2026-04-25; was `delete` before but a FK to InvoiceLineItem made deletes fail mid-batch). This prevents ghost duplicates. Quote imports can seed lines that the sales import later overwrites — this is expected.

**Reactivation** (2026-05-02): When a CSV provides a row at a `lineNumber` that already has an existing CANCELLED line with NULL `cancelReason` (= orphan-cancelled, not user-cancelled), the runner resets it to ACTIVE. This handles line-count oscillation across re-imports where a CSV temporarily shrinks then grows back to its real size.

**Gap: same-day-rewrite drops also read as "orphan-cancelled" — found + fixed 2026-07-24.** The `!cancelReason` test above can't distinguish this section's genuine orphan-cancel from a deliberate same-day-rewrite-drop cancellation (`cleanupOneRewriteChain` in `docs/domains/import-pipeline.md` "Same-day rewrites"), because both used to write `lineItemStatus = CANCELLED` with no `cancelReason`. A base-only re-import (rewrite not in the same batch) silently reactivated dropped lines, reintroducing a double-count. Fixed by stamping `cancelReason = SAME_DAY_REWRITE_DROP_CANCEL_REASON` (`lib/adapters/legacyPos/shared.ts`) on rewrite-drops so this reactivation guard treats them as deliberate, same as a user-cancel. This section's own orphan-cleanup (above) and the quote-runner's orphan-cleanup were audited and correctly left `cancelReason`-less — see `docs/domains/import-pipeline.md` "Same-day rewrites — the dropped-line edge case" for the full incident and the backfill decision (none — historical NULL-reason cancellations aren't blindly reclassified).

**Rewrite-freeze exception** (2026-05-05; tightened 2026-05-07): Orphan-cleanup is **skipped entirely** for any order whose sibling rewrite (`<orderno> - A` / `- B` / `- C` / `- D`) already exists in the DB. After the POS splits an order into base + rewrite, the daily CSV permanently exports only the lines that "stayed" on the base — the items that "moved" now appear in the rewrite's CSV section. Without the freeze, every subsequent re-import would silently re-cancel the moved lines, dropping the base order's value from daily-by-store reports (the POS's own daily report still attributes the full pre-rewrite value to the original date because the rewrite chain is netted on the rewrite's date by the A-suffix accounting return). The check: `!isRewriteOrder(orderno) && (await tx.salesOrder.findFirst({ where: { orderno: { startsWith: \`${orderno} - \` } } })) !== null`. Per-line UPDATE still runs, so a manual re-import of a corrected CSV refreshes values; the reactivation guard from the 2026-05-02 fix still brings back any line the new CSV provides. See failure-log entries 2026-05-05 and 2026-05-07 (the rewrite-cleanup incident's first and second hits — the second was caused by the QUOTE runner having its own un-frozen orphan-cleanup; both runners now have the freeze).

**Quote runner — promoted-order guard** (post-failure log 2026-05-07): the Daily Quote Report from the POS includes EVERY order that ever had a quoteCode, including ones that have since been promoted to `status=ORDER`. Before 2026-05-07, `reconcileExistingQuoteOrder` reconciled line items for any order in the quote CSV regardless of status — and the quote CSV's `Sellingprice Exvat` column is a UNIT price (not a line total). This produced two bugs simultaneously: (1) multi-qty line totals on promoted orders got overwritten with unit prices, and (2) the quote runner's orphan-cleanup ran without the rewrite-freeze, re-cancelling lines on rewrite-base orders every auto-import. The rewrite-cleanup incident's store-day gap recurred because of this. Fix: `runQuotesImport` now skips `reconcileExistingQuoteOrder` when `existing.status !== "QUOTE"`. The Sales runner is authoritative for promoted orders; the quote runner stays out. The freeze guard was also added to `reconcileExistingQuoteOrder` itself as defense in depth.

## Status Reconciliation (2026-04-08)

Order statuses were reconciled using the POS `Customer_Deposits_Export` file as the source of truth for which orders are genuinely open:

- The open orders confirmed as ORDER (matching the POS deposits)
- The A-suffix / return-prefix orders marked RETURNED
- Remaining orders with invoices promoted to FULFILLED
- Orders not in deposits and without invoices left as ORDER for manual review

The status derivation logic handles the daily feed going forward. The one-time reconciliation fixed historical data.

## Salesperson Correction Preservation

If `SalesOrder.salesPersonId` is set (manual correction from split import or reassignment), the daily sales import skips updating the `salesperson` string field to avoid overwriting the correction. Detected via the `correctedOrders` set in `runSalesImport()` (`lib/adapters/legacyPos/runners.ts:177`). A second set, `lockedOrders` (`runners.ts:190`), suppresses the same write for existing orders dated inside a confirmed (not reopened) commission period, matched by salesperson NAME or FK; either set is enough (`runners.ts:330`).

## An order written here names its seller both ways (2026-11-27)

Who sold an order is two columns: `salesPersonId` (the staff member) and `salesperson` (their name as text). An imported order has only the name, which is why every reader matches either (below). An order written in Holt knows the staff member, and writes both through one function, `sellerColumns` (`lib/sales/orderSeller.ts`).

Four writers wrote half until 2026-11-27. The register (`create-from-cart.ts`), Duplicate order (`lib/sales/duplicateOrder.ts`) and a house call (`service/house-calls/index.ts`) wrote the name and no link; a converted proposal (`proposals/[id]/convert-to-order.ts`) wrote the link and no name. The name alone matches only until the person's display name changes, and the duplicate-quote check, which tells two designers' quotes for one customer apart by the link, could not see those quotes. The link alone left the order "Unassigned" in every list that reads the name. The other writers already wrote both: reassigning (`orders/[id]/salesperson.ts`, `reports/pipeline-reassign.ts`) and a return order (`lib/returns/bookReturn.ts`, copied from its sale). The two importers write the name the document gives.

A register session with no staff row still names its email and links nobody. Orders written before this keep what they had; nothing backfills them (the import's sweep, `lib/salesPersonFkBackfill.ts`, runs only after a sales import).

Tested in `__tests__/integration/orderSeller.integration.test.ts` (six cases through the real routes; four fail on the old writers). No test lists the writers: they were found by searching for writes of `salesperson`, so a fifth would be found the same way.

## Per-line-item salesperson splits — NOT SUPPORTED (manual workaround required)

**Our schema cannot represent splitting an individual line item between two salespeople.** Verified 2026-05-22 against `schema.prisma`:

| Field                                    | Lives on           | Supports                                               |
| ---------------------------------------- | ------------------ | ------------------------------------------------------ |
| `salesPersonId` + `salesperson` (string) | `SalesOrder` only  | Single owner per order                                 |
| `splitWithId`                            | `SalesOrder` only  | One additional person — order is 50/50 between the two |
| `salesPersonId` on `OrderLineItem`       | **DOES NOT EXIST** | —                                                      |

Line items inherit the order's salesperson(s). A single order is owned by one person OR split 50/50 between two — that's the whole envelope, not per-line.

### The POS case that broke this assumption

SO-10009: managers in the POS have started splitting **a single line item** within an order (e.g. "only the live edge table is split between Designer A and Designer B, the rest of the order is Designer A's"). The POS allows this. Our schema does not.

**No code or schema change for this** — owner direction 2026-05-22: _"we are not making changes for nonsense, they would need to write the one order into two different ones for us to split it in the ERP."_ The split-per-line workflow on the POS's side is operational nonsense from the ERP's perspective, and the salespeople were directed to use the POS — so the workaround is on the operator/manager.

### Manual workaround for managers

When the POS has a single-line-item split that needs to land in our ERP correctly, the manager must restructure it in the POS as **two separate orders**:

- **Order A** (original orderno): everything EXCEPT the split line(s). Salesperson = the primary owner.
- **Order B** (new orderno): ONLY the split line(s). Salesperson = primary, `splitWith` = secondary. Order-level 50/50 split now correctly represents the line-level split because Order B contains only that one line.

After the manager does this, the daily sales import ingests both orders with normal semantics — Order A goes 100% to Designer A, Order B goes 50/50 Designer A + Designer B. The ERP-side commission math + designer-credit reports work because the split is now at order level (which we DO support).

### What our import does today when it sees the unsupported shape

If the SO-10009 shape lands in our DB unchanged (single order with `splitWith` set but ALSO some line items belonging only to one person), we'd attribute the WHOLE order 50/50 — which over-credits Designer B on the non-table lines AND under-credits Designer A. **The data would be wrong.** That's why the manual workaround is required: the manager must split the order in the POS first.

There's no automated detection for this pattern on our side — the import has no signal that a single line is meant to be split. The manager catches it at the operational level. If we ever need to detect it, the path would be a Sonar-style "this order has a split flag but only some lines are split" report, but per owner direction that's also nonsense work we're not building.

## The Cancelled Line Rule

**Every query that sums line item amounts MUST use the shared counted-line filter** (`COUNTED_ITEM_LINE` or `COUNTED_LINE_FILTER` in `lib/salesOrderRevenue.ts`, `countedItemLineSql` / `countedLineSql` in raw SQL). Cancelled lines from orphan cleanup or manual cancellation, and replaced lines, must never inflate totals. `{ not: "CANCELLED" }` is not enough: it counts a replaced line and its replacement both (#112).

This is CLAUDE.md rule 33. Do not maintain the enforcing-file list by hand -- the report logic now lives in `src/lib/reports/*` and `__tests__/reports.cancelledLineFilter.test.ts` auto-discovers each file there whose source mentions both `salesOrder` and `lineItems` (`reports.cancelledLineFilter.test.ts:153`), accepting a Prisma clause, a raw-SQL `<>`/`!=` guard, or the shared `buildLineItemWhere` helper. That predicate leaves a hole: a raw-SQL report that never spells `lineItems` -- e.g. `lib/reports/buyersReport.ts`, whose own `lineItemStatus != 'CANCELLED'` guards sit at `buyersReport.ts:325`, `:329` and `:441` -- is never discovered, so nothing fails if its guards are deleted. The same test separately pins `pages/api/reports/factsalesday.ts`, `lib/salesBySalesperson.ts`, `lib/reports/factSalesDay.ts` and `lib/journalEntry.ts`; `__tests__/integration/cancelledLineFilter.integration.test.ts` proves the exclusion against real Postgres.

## New Quote: no tax district

New Quote (`app/(dashboard)/app/sales/quotes/new/NewQuoteView.tsx`) shows the same
amber banner as the POS when the active store resolves no tax district, so a quote
priced at 0% tax says so before it is saved (USE-08, 2026-10-27). The quote is never
blocked; see `docs/domains/pos.md` "Order creation from cart" for where the fact
comes from.

## HD proposal import: parser warnings (2026-11-21)

`/app/sales/import-hd` posts the PDF to `import-hd-proposal.ts`, which parses it
and writes the quote (`HD-{quoteNumber}`) in the same request, as read. The parser
(`lib/pricing/hdProposalParser.ts`) reads through `lib/pricing/parseBoundary.ts`: a
line cut at 1000 characters, or a number of 300 or more digits (an overflowing one
reads as 0, never `Infinity`), puts a warning on `proposal.warnings`. The route
already returns the `proposal`, and `ImportHdView.tsx` lists its warnings at the top
of the result, above the quote they describe. Whether a warning should refuse the
import is the owner's open question.

**Importing the same proposal again (2026-11-27).** The route finds the sale by
`HD-{quoteNumber}`, deletes its lines and writes the proposal's. That refreshes a
quote. It used to do the same to a sale in any status: an order with a deposit, a
delivered or returned one, a cancelled one, each got new `ACTIVE` lines at the
proposal's prices with nothing fulfilled, and whatever pointed at the old lines (PO
lines, pick lists, service appointments, returns) was unlinked. Only invoiced lines
stopped it, as a 500. Now the route looks first, and answers 409 unless the sale is
still a `QUOTE`: "HD-… is no longer a quote, so the proposal was not imported over it
and nothing was changed." Listed with the other order and PO deletes in
`__tests__/fixtures/order-and-po-deletes.txt` (purchasing.md, "Importing a vendor's
document again"); tested in `reimportsFailClosed.integration.test.ts`.

Left open: a refresh deletes every line of the quote, including one a person added
on the quote's page, and the route does not call `resyncOrderAllocation`. So stock
held for a deleted line (`OrderLineItem.holdUntil`, `lib/sales/quoteHolds.ts`) is not
released by the import. What releases it afterwards: [NEEDS VERIFICATION].

## Tax exemption on the order

Every route that creates an order from a resolved tax district writes the
customer's exemption onto it as `SalesOrder.taxExemptReasonId`, beside
`taxDistrictId`. The routes are the register's `create-from-cart`, B2B
`convert-to-order`, and the HD proposal import (`import-hd-proposal`, on both
create and re-import). The value comes from `resolveTaxDistrict()`, read from
`Customer.taxExemptReasonId` (2026-10-29, GAP-04a). The order keeps the exemption
it was sold under; clearing the customer's later does not re-tax it. A native
return copies it from its sale (`lib/returns/bookReturn.ts`).
`__tests__/taxResolutionSingleSource.test.ts` fails on a route that writes the
district without it.

**Changing a quote's customer re-rates it (GAP-04d, 2026-10-29).**
`PUT /api/sales/orders/[id]` with a new `customerId` calls `lib/tax/rerateQuoteTax.ts`
when the order is a QUOTE with no payment row (a pending card checkout counts as
money). The re-rate re-resolves the district and the exemption for the new customer,
re-rates every live line under its product's tax group, and rewrites `totalTax`.
Cancelled lines keep their rate and stay out of the sum (rule 33). An order money has
touched keeps the tax it was charged, and its customer still changes: tax on a paid
sale is a recorded fact.

**...and re-prices it for the new customer's trade tier (GAP-06 part C, 2026-11-14).**
Under the same no-payment rule, before the re-rate, `lib/sales/quoteTradePricing.ts`
`repriceQuoteTrade` moves the quote's live catalog lines to the new customer's tier
(or off the old one's). Only a line still at the price it was written at (its
`listPrice`, or the trade price it recorded) moves; a line someone typed or discounted
keeps its price, but where the new customer's price for it is higher its discount from
that price follows the store's policy and may need a manager's PIN, asked before the
change is saved. Each line keeps its `listPrice`, records the tier it now has
(`tradeTierId`, `tradeDiscountPercent`), and a moved one gets a `PRICE_CHANGE` history
entry. The response adds `repricing { repriced, kept, message }`, which the order
screen shows when the customer is linked. The tax then follows the new amounts.
Detail: `docs/domains/pricing-catalog.md` "Trade tier pricing".

## Delivery fee

**An order going out by delivery charges its zone's fee (GAP-09, 2026-10-29).**
The fee is an `OrderLineItem` with no product. `SalesOrder.deliveryFeeLineItemId`
says which line it is, the same way `Return.restockingFeeLineItemId` names a
return's fee. Nothing recognises the line by its name.
`setDeliveryFee()` in `lib/delivery/deliveryFee.ts` is the one writer. Two routes call it:
the register's sale (`create-from-cart`, body `deliveryFee`) and the order screen
(`GET`/`PUT /api/sales/orders/[id]/delivery-fee`). The line, and the rules each consumer applies to it:

- **What it charges.** Staff can change the zone's fee or remove it; the server
  charges what it is sent. `GET /api/sales/delivery-fee-quote` tells the register
  what the zone charges before a sale exists. The fee changes only while the order
  is a QUOTE or ORDER and not a native return's own order.
- **Tax.** The line is taxed the way an added line is: the order's customer and store
  decide the district. The rate comes from the group in
  `AppSettings.deliveryFeeTaxGroupId` (Admin › Settings › Sales tax), because
  whether delivery is taxed is state law. Null taxes it by the district's rules. A
  store where delivery isn't taxed picks a "Not taxed" group. A quote re-rated on a
  change of customer re-rates the fee under the same group (`rerateQuoteTax.ts`).
  Deleting that group is refused while delivery uses it.
- **Books.** The journal books the line to POS Transactions/"Delivery Fee"
  (accounting.md). A fee is refused while that mapping has no account, rather than
  booked to no account.
- **Sales credit.** Commission, Sales by Salesperson and the designer dashboard
  leave it out (`buildLineItemWhere`, `lib/salesBySalesperson.ts`), unless the report
  is asked to include delivery and freight.
- **Not goods.** The line takes no stock and isn't picked or handed over. The generic
  line route (`line-items/[lineItemId].ts`) and a new return
  (`POST /api/returns`) refuse it through `deliveryFeeLineEditProblem()`. A customer
  return link (`POST /api/sales/orders/[id]/return-link`) and the customer's own
  return request refuse it through `returnLineProblem()` (`lib/returns/returnLine.ts`,
  returns.md "The return's line"), which also refuses a line from another order, a
  cancelled or replaced line, a zero quantity and a gift card. Refunding a
  delivery fee after the order is handed over is not built (ROADMAP GAP-09).

**The printed receipt and invoice (2026-10-30).** `GET /api/print/order/[id]`
returned every line and every payment, and both prints totalled them. So a
cancelled or replaced line was printed and charged in the total, and a voided,
failed or pending payment counted as paid. It now returns only lines that are not
CANCELLED or REPLACED (rule 33), and counted payments (`countedPaymentWhere`) with
refunds negative, as the order screen counts them. It also returns each line's
`listPrice`, so the prints can show the saving (pos.md, "Discounts and manager
approval").

**A register order records its store's id (2026-10-29).** `create-from-cart`
resolved the store to tax the sale but wrote only its name on the order. So
everything that taxed the order later ignored the store's district: an added line, a
re-rated quote, the delivery fee. They fell back to `AppSettings.defaultTaxDistrictId`,
or charged 0% with none set. It now writes `storeLocationId`, and an exchange order
copies its sale's (`returns/[id]/exchange.ts`). Register orders written before this
carry no `storeLocationId`. Holt has no live deployment, so none were backfilled.

## Quote holds: what a sale commits (GAP-16 and GAP-21, since 2026-11-01)

**A quote commits only the floor stock it holds; an order commits everything.**
Every order starts as a quote (`create-from-cart` writes `status: QUOTE`), and
until 2026-11-01 it committed every line's stock the moment it was written, with
no end. So a quote nobody came back for kept its sofa off the floor
indefinitely, and nobody could hold a piece for a customer on purpose. The
owner's design (2026-11-01): "we can put it on a quote and part of the quote if
it is floor stock can be hold until x date, and again a config would set the max
allowed" (`docs/DECISIONS.md` 28).

- **The rule** is `lineCommitsStock()` in `lib/sales/quoteHoldsShared.ts`:
  an order (anything but a quote) commits every line; a quote commits a line
  only while `OrderLineItem.holdUntil` is today or later, in the store's time
  zone (`businessDayKey`, `AppSettings.timezone`). `resyncOrderAllocation`
  (`lib/inventory/orderInventorySync.ts`) applies it, so any resync of a quote
  commits its open holds and releases everything else, and `settleShortfalls`
  (`lib/reports/oversold.ts`) measures what the order needs the same way. A
  hold that ends closes its shortfall instead of leaving the quote oversold.
- **What can be held.** An active line of a catalog product drawn from stock,
  not special-ordered (`source` ORDER), not a return (`lineHoldProblem`,
  `isStockedProduct`). The day runs from today to
  `AppSettings.quoteHoldMaxDays` days from today. That is Settings › Quote
  holds, 0 to 365, where 0 means quotes hold nothing. The default is 3, the
  strict end (a CHECK in the migration and in `prisma/testing/db-guards.sql`).
  `holdDateProblem` says which rule a day breaks.
- **Setting one.** The quote builder offers "Hold until" on a floor-stock catalog
  line, and the create-from-cart body takes `items[].holdUntil`. The order screen
  holds, moves or takes off a quote line's hold through
  `PUT /api/sales/orders/[id]/line-items/[lineItemId]` `{ action: "hold",
  holdUntil }` (`setLineHold`). Each change is a `HOLD_SET` or `HOLD_ENDED`
  change-log row, and the units commit or release at once.
  `GET /api/sales/quote-hold-policy` gives the screens today and the last day
  allowed. The server decides again on every save.
- **Every way out of a quote** goes through `promoteQuoteToOrder`
  (`lib/sales/quoteHolds.ts`). It moves QUOTE to ORDER in one conditional
  statement, so two payments arriving together promote once, then resyncs, so
  every line commits. The paths are a payment (`onPaymentReceived`: the
  payments route, create-po, and the Stripe and Square webhooks) and a status
  change to ORDER or FULFILLED (`PUT /api/sales/orders/[id]`). A handover
  straight from a quote by another path (`markHandedOver` from dispatch or a
  stop) resyncs as the order it has become before consuming. An order sent back
  to a quote resyncs, so only its held lines stay committed.
- **A hold ends** after its last day. The hourly `expire-quote-holds` automation
  (`releaseExpiredHolds`; `docs/OPERATIONS.md`, "Expire Quote Holds") resyncs
  every quote still committing stock, which also releases what quotes written
  before 2026-11-01 commit. Archiving a quote, one at a time or in bulk, ends its
  holds (`endQuoteHolds`): the customer said no. Restoring it brings back the
  quote, not the holds.
- **The register.** A sale rung up with no hold now commits its stock at its first
  payment, seconds later, not when it is written. Between the two, another
  register can sell the last unit; the second sale then records a shortfall like
  any oversale (`docs/domains/inventory.md`, "Overselling is allowed").
- **What isn't stocked (GAP-21).** A product in a category with
  `trackInventory` off is never allocated: there is no stock to commit, only a
  false shortfall to raise (`lib/inventory/stocked.ts`). A configured or custom
  cart line mints a one-off product, marked `Product.madeToOrder` as a record of
  where it came from, and it is an item like any other (owner, 2026-11-02):
  short until its PO arrives committed to the order, and a spare one is stock a
  sale takes. From 2026-11-01 to 2026-11-02 it was never allocated either.
- **A custom line's vendor (GAP-22, 2026-11-02).** A configured or custom cart
  line naming a vendor files its minted product under the vendor that name
  means, an earlier name of a merged vendor included (`findVendorsByName`,
  `lib/vendors/vendorByName.ts`), else under its source product's vendor. A name
  no vendor has makes one, once: it goes into the cart's map, so a second line
  naming the same new vendor uses it. Before, the second line tried to make it
  again and the unique name failed the whole sale. The fallback "Custom" vendor
  is found the same way. `vendorMerge.integration.test.ts`.
- **Reports › On hold** (`lib/reports/onHold.ts`, `/app/reports/on-hold`, CSV at
  `/api/reports/on-hold?format=csv`) lists every open hold, soonest to end
  first. Each row shows what the quote really commits ("held 0 of 1" when the
  piece had already sold) and where it sits.
- **A transfer raised for a quote** commits the units it ships to the quote
  (`lib/inventory/transfers.ts`). If the quote doesn't hold that line, its next
  resync (an edit, or the sweep) frees them where they are: a quote owns only
  what it holds. Hold the line first, or raise the transfer once it's an order.
- **Not built** (ROADMAP GAP-16): a hold at the register, since a sale there is
  paid on the spot; telling the customer when a hold is about to end (GAP-13).
- **A layaway is an ordinary order, not a hold** (owner, 2026-11-05: "Just make payments until
  it is paid"). An order keeps its stock allocated with no end date, and each payment reduces its
  balance (`pages/api/sales/orders/[id]/payments.ts`). Run through on a seeded copy on 2026-11-05:
  one unit stayed against the order across two payments. Nothing stops an unpaid order being
  delivered. That's true of every order, and dispatch shows the balance.

## Cancelling, changing and deleting a sale (DECISIONS 51)

Source read for this section: `lib/sales/cancelOrder.ts`, `salePos.ts`, `salePosShared.ts`,
`pages/api/sales/orders/[id]/cancel.ts`, `pages/api/sales/orders/[id].ts`,
`line-items/[lineItemId].ts`, `lib/delivery/deliveryFee.ts` (2026-11-07).

**A special order has a PO** from the moment it goes ahead, however it goes ahead: a first payment, a store that
allows a sale with nothing paid, or a line added later. Floor stock doesn't, nor a cancelled or zero line
(`raiseSpecialOrderPos`). An imported PO whose lines don't name their order lines leaves that order alone.

**What the PO allows.** Acknowledged means the PO's status is Confirmed, which needs the vendor's number.

| The PO | Cancelling or changing the sale |
|---|---|
| Draft | Allowed. The PO is cancelled or follows the change |
| Sent, not acknowledged | Allowed. The PO is cancelled or follows the change, and the screen says to tell the vendor |
| Acknowledged | Someone decides: **the vendor agreed** (the PO is cancelled, or short-closed if some has arrived), or **keep the piece** (it comes in as stock to sell off the floor) |
| All here | The sale can cancel, and the piece goes back to stock |

- **That call needs `sales.cancel-acknowledged`**, which owners, administrators and managers start with.
- **A line's product and quantity** can't change once it's acknowledged: cancel the line and add what's wanted. Its
  price can, since the vendor's order is the same.
- **Keeping the piece:** a whole sale's PO becomes an ordinary stock order, so it counts as on order. A single kept
  line stays on its PO, and arrives free because its line is cancelled.

**What a cancel refuses, with the reason:** already cancelled; any of it handed over; a payment still going
through; a live invoice, because revenue and sales tax are booked from invoices, so void it first; a return or
exchange tied to it; stock moving between stores for it; out for delivery or a visit under way.

**What a cancel does:** settles the money (`payment.refund` if there is any), back the way it was paid or as credit
on the account. Then its lines are cancelled so nothing is owed, stock goes back, POs follow the table above, it
comes off the schedule and the pickup queue, draft transfers are cancelled, consignment pieces go back on the floor
(with credit owed if the vendor was paid), and open stock exceptions close. Its reason and who did it go in its
history. The status buttons can't cancel, and a cancelled sale can't be reopened: to sell it again, copy it.

**What it says, without stopping:** a locked commission payout covers its date; service cases are open; a pick list
is open.

**Around it:** a cancelled sale can't take a payment or be handed over, and its lines can't change.

**A line change that leaves the customer overpaid (DECISIONS 52).** Cancelling a line, lowering its price or
quantity, or a cheaper replacement can leave more paid than is now owed. The route answers 409 with `overpaid` and
changes nothing, and the dialog that made the change asks where the rest goes: back the way it was paid, or as credit
on the account. That needs `payment.refund`.

- **Only what's over goes back,** never the line's whole price. A $300 deposit on a $1,000 sale with a $500 line
  cancelled still owes $200, so nothing is asked.
- **It comes off the newest payment first,** and can split across payments, so the first deposit stays on the sale.
- **A change that doesn't lower the line asks nothing,** even on a sale already overpaid some other way.
- **A card goes through its processor before the line changes.** If it fails the line stays as it was, and trying
  again refunds only what's left. Credit happens in one transaction with the change.
- **A refund that didn't finish is tried again first,** whichever way the rest goes, as a whole-sale cancel does. Past
  the processor's retry window it answers 400, and someone checks the processor's dashboard.
- **Both go in the order's history,** `REFUND_ISSUED` and `CREDIT_ISSUED`, with the line, the reason and who did it.
- **The same change sent twice settles once (ledger audit 2026-11-11).** What's over is first worked out with no lock,
  to ask the store; every new refund or credit works it out again with the order's row locked (`FOR NO KEY UPDATE`),
  in its own transaction (`lib/sales/cancelOrder.ts`). A refund left PENDING by an earlier processor error is finished
  first, under its own refund lock, so it is sent once; of a change sent twice, both can write its `REFUND_ISSUED`
  history line (tracked in the roadmap). Each refund's guard (`stillOverpaid`, inside `processRefund`'s
  reserve) refuses a refund bigger than what the change still leaves over. The line change's transaction starts with
  `settleLineChange`: the line's status, quantity, price and tax must be as the request read them (a second cancel,
  replace or price change finds the line changed and answers 409, and so does a change from another tab worked out from
  the old line, which used to write a total from it: one chair at the old quantity's price), and the credit is what's
  over now, not what was read; each refund's guard makes the same check (`assertLineAsRead`), so a change whose line
  moved before its refund refunds nothing. A change landing while a card refund is with the processor is the one gap:
  the refund has gone out, and the first change is then refused (tracked); a refund destination with money still over (more came
  in meanwhile) is refused, to try again. Before this, a double click credited or refunded the overpayment twice, and
  a replace sent twice added two replacement lines. Tested in `cancelOrder.integration.test.ts` ("sent twice"), which
  fails on the code before, and with the order lock and the refund guard taken out.
- **It waits, with the reason, if the money can't be settled yet:** a payment still going through, an imported payment
  with no status, a live invoice, or a return tied to the sale. That's the same check a whole-sale cancel makes
  (`moneyProblem`). When no money moves, none of these stop the change.

**A line that's gone to the customer** can't be cancelled or replaced, and its quantity can't go below what's gone.
That comes back as a return, which puts its stock and money right. A sale handed over whole counts as all of it gone,
even if its lines recorded no quantity.

**Deleting.** Only a quote with no payment and no invoice can be deleted, by a holder of Cancel orders
(`sales.cancel`), the key the order screen shows Delete on. An audit entry is what's left.

**A sale with nothing paid** only goes ahead where the store allows it (Settings, Sales with no payment,
`AppSettings.allowSaleWithoutPayment`, off by default). That covers the status buttons, raising a PO by hand and
handing a quote over at the counter. The register offers "Go ahead with no payment" only when it's on. Taking a
payment promotes a quote whatever the setting, and a sale with nothing to pay can always go ahead.

**Not done:**

- **Holt doesn't email the vendor** when a sent PO is cancelled or changed. The screen says to tell them.
- **Lowering or removing a delivery fee doesn't settle money.** `setDeliveryFee` allows it on an open order, so it
  can leave the customer overpaid, and that's handled by hand today. It's the one other way a paid sale's total drops:
  a quote's tax is only re-rated with no money on it.
- **A single kept line isn't counted as on order**, since its PO still belongs to the sale.
- **A commission payout isn't corrected** by a cancel, and stays the owner's by hand.
- **A cash refund from cancelling** isn't tied to a till, the same as a return's refund on its screen today.
- **A delivery stop on a quote.** `completeStop` doesn't check the no-payment setting.
- **An invoice doesn't follow a line change when no money moves.** Cancelling a line on a part-paid sale with a live
  invoice goes ahead, and the invoice keeps its old amounts.
- **Setting a dispatch status to cancelled** (`dispatch.ts`) still only frees the stock. It doesn't cancel the sale.

### Taking a payment from the order (2026-11-27)

Beside Balance Due the order page offers three ways to be paid: Apply store credit, a payment link, and **Take payment at the register**, which opens the register's payment screen on this order for cash, a check, a gift card or a card on the reader (pos.md, "Taking a payment on an order written earlier"). The last is offered to someone who holds `payment.take` and `pos.operate` while the register module is on, on an order that owes something and is not cancelled. Before it, a balance could only be paid by link or store credit.

### Refunding a payment from the order (2026-11-28)

The order's payment list has a **Refund** on each payment with something left to refund, for holders of `payment.refund` (`RefundPayment.tsx`). Until this, the route existed (`orders/[id]/refunds.ts`) with no screen calling it, and money went back only through a line cancel or a return; found on the first card reader run, where the refund had to be made through the route.

- **What is offered** comes from the order route (`GET /api/sales/orders/[id]`): each payment's `method`, `viaProcessor`, and `refundable`, from `refundableByPayment` (`lib/sales/refundablePayments.ts`). That asks processRefund's own question ahead of time: only a completed payment that is not itself a refund, its amount less every refund of it that paid out or may still pay out. A refund is found by the payment it refunds, not by the order it sits on, because a return's refund is booked on the return's own order.
- **The screen** asks for the amount (what is left, by default) and a reason (required: it goes in the order's history), and says where the money goes (`refundGoesTo`, `lib/sales/refundPaymentShared.ts`): through the card processor for a payment taken through one; out of the till for cash; back onto the gift card or the customer's store credit; for anything else, only a record, with the store handing the money back the way it was taken.
- **Tills.** The refund is booked against the open till of the register this browser works at (`lib/pos/registerChoice.ts`, the key the register screen saves), when there is one. A **cash** refund is not made from this screen without one (`cashNeedsTill`, the rule the register's payment screen asks before taking cash): the screen says to choose a register and open its till. The route itself still accepts a refund with no till, as a return's refund does; whether cash may ever move with no open till is the owner's open question (pos.md).
- **The server decides.** `processRefund` caps the amount under its lock, refuses a closed till, and applies the gift card rule; the screen shows its words when it refuses and reloads the order.

Tested: `__tests__/refundPaymentShared.test.ts` (the wording, the till rule, the amount, the remembered register), a case in `cancelOrder.integration.test.ts` (the order route's figures, with a refund booked on another order counted and a failed one not), and `salesLeadsPermissionKeys.integration.test.ts` (the page offers it to a manager and not to a cashier). In a headless browser against the dev build and a seeded scratch database (2026-11-28): a $100 cash payment taken at a register with an open till was refunded from the order. The dialog said $100.00 was left and that it comes out of the till at this register; Refund with no reason was refused on the screen; with one, the order went from $1,081.11 due back to $1,181.11, the payment read REFUNDED, and the refund row carried that till and the payment it refunds. Not yet done from this screen: a card refund through the processor (the route was run against Stripe in test mode, pos.md), a part refund, and a cash refund with no till open.

### Voiding a pending payment from the order (2026-11-27)

The order page lists each payment with a **Void** on a pending one (`payment.void`). `GET /api/sales/orders/[id]` marks a payment that was sent to a register's card reader (`onCardReader`, from the row's `processorData`), and the page words the Void by it: for a reader payment it asks to cancel the card payment waiting on the reader and says a card that has already gone through is recorded instead; for a payment link it says the customer will need a new link. The route (`payments/[paymentId]/void.ts`) cancels a reader payment on the reader first (pos.md, "Card readers"). When the void is refused, the page reloads the order, so it shows what the payment has become.

## Invoice tools (GAP-07, since 2026-11-03)

Owner, 2026-11-03: flags and disclaimers are the store's own lists ("Yes
configurations"), and a duplicate is priced at today's prices. `docs/DECISIONS.md`
35 and 36.

- **Line notes.** `OrderLineItem.notes`: staff's note on a line ("legs in
  walnut"). Written through `line-items/[lineItemId]` PUT, action `note`, which
  `lib/sales/lineNotesShared.ts` `readLineNote` reads on both sides: trimmed, up
  to 500 characters, blank stored as null. Each change leaves a `LINE_NOTE`
  change-log row. A cancelled line or the delivery fee line takes none (the
  route's existing refusals); a delivered order's lines do, since a note
  changes no money. The invoice prints it under the line, and the orders list
  search (`GET /api/sales/orders?search=`) finds an order by any line's note.
- **Order flags.** `OrderFlag` is the store's list, set up in Settings › Order
  flags (`/api/order-flags`, `admin.settings`), with a colour from a fixed set of
  tones (`lib/sales/orderFlagsShared.ts`) and an optional **warn when opened**.
  `SalesOrderFlag` puts one on an order. `setOrderFlags` (`lib/sales/orderFlags.ts`)
  is the one write, through `PUT /api/sales/orders/[id]/flags` (`sales.write`).
  It refuses a switched-off flag on an order that doesn't have it, keeps one that
  does, and logs `FLAG_ADDED` / `FLAG_REMOVED`. A flag orders carry is switched
  off, never deleted. Flags change no money, so any order can carry them.
  - **Shown** as chips on the order page, the orders list (with a flag filter,
    `?flag=`), the dispatch board, a run's page and the driver's screen.
  - **Warn when opened.** The order page opens with a dialog naming the flags
    set to warn, once per visit (`openingAlerts`).
- **Disclaimers.** `OrderDisclaimer` is the store's list, set up in Settings ›
  Disclaimers (`/api/order-disclaimers`, `admin.settings`): a name staff pick by,
  and the text that prints.
  - **A copy.** Adding one to an order copies its text into
    `SalesOrderDisclaimer` (`addOrderDisclaimer`, `lib/sales/orderDisclaimers.ts`).
    Rewording or deleting the store's disclaimer changes no order that has it;
    deleting clears the link (`orderDisclaimerId`) and leaves the text.
  - **When.** An order's disclaimers change only while it is a QUOTE or ORDER
    (`disclaimerEditProblem`), and never on a native return's own order. The
    same one can't be added twice. Changes log `DISCLAIMER_ADDED` /
    `DISCLAIMER_REMOVED`.
  - **Printed** on the invoice and the receipt, above the store-wide
    `receiptFooter` (printing.md).
- **Duplicating an order.** `POST /api/sales/orders/[id]/duplicate`
  (`sales.write`) makes a new QUOTE and the order page opens it
  (`lib/sales/duplicateOrder.ts`).
  - **What comes across:** the lines that are part of the sale (ACTIVE or
    BACKORDERED, more than zero, not given back on an exchange, not the delivery
    fee; rules 31 and 33) with their options, fulfilment and notes; the
    customer, store and delivery method and address. The one copying it is its
    salesperson, as at the register. Both routes take that person's name from
    the caller's own active staff row, found by the session's User id
    (`sessionStaffMember`; staff-auth.md "Who the caller is"), as do the
    Pipeline (`sales/pipeline/index.ts`, `[id].ts`) and My Clients
    (`sales/clients/index.ts`). Until 2026-11-21 all five found it by the
    session's email.
  - **Today's prices.** A catalog item at its retail now, or at the price the
    customer's trade tier entitles them to today, which the line records
    (`catalogLinePolicies`, GAP-06 part C). A custom or configured item is its
    own product, created at the price it was sold at, so it keeps that price and
    takes no tier. No discount comes across: staff give it
    again, under the discount policy (GAP-06). The delivery fee is the zone's
    fee today, when the original charged one.
  - **What doesn't:** payments, holds, flags, disclaimers, order notes, history.
  - **Priced like a sale.** Every number goes through what `create-from-cart`
    uses (`priceCart`, `resolveTaxDistrict` / `rateForLineAmount`,
    `saleUnitCost`, `nextOrderNumber`, `setDeliveryFee`), so a copy is the same
    cart rung up today, to the cent. Like any quote that holds nothing, it
    commits no stock.
  - **Refused:** a native return's own order, and an order with no line left to
    copy.
  - The copy logs `COPIED_FROM` with the original's number.
- **The orders list's totals (fixed 2026-11-03).** `GET /api/sales/orders`
  summed every line into an order's total, cancelled ones included (rule 33),
  and every payment into what was paid: a voided card and a refund counted as
  paid. It now leaves cancelled lines out and counts payments the way every
  balance does (`computeTotalPaid`, `lib/paymentBalance.ts`).
- **Every other screen that totals an order (fixed 2026-11-11).** The same two
  mistakes, summing every line and every payment, or reading the stored
  `SalesOrder.totalPaid` (a copy only the import writes, so it never saw a payment
  taken in Holt), were still in seven places. Each now takes the register's rule,
  `computeBalance` (`lib/paymentService.ts`): only lines still owed
  (`COUNTED_LINE_STATUSES`), only payments that settled (`isPaymentExcludedFromBalance`
  leaves out PENDING, VOIDED and FAILED; a payment with no status is imported money and
  counts), and a refund is money back whatever its stored sign. Holt's own refunds are
  stored positive with `isRefund`, imported ones negative, so code that adds the stored
  amount gets one of them wrong; `signedPaymentAmount` (`lib/paymentBalance.ts`) is the
  one place that turns either into money toward the order.
  - the customer portal (`api/portal/order.ts`), which also listed cancelled and
    replaced lines and pending or voided payments to the customer;
  - the service desk's customer lookup (`api/service/customer-lookup.ts`);
  - the customer page (`api/customers/[id]` now sends each order's total and paid);
  - the order screen's paid figure (`api/sales/orders/[id]`);
  - the order screen itself: its Balance Due and 50% deposit counted only ACTIVE lines
    (now `isCountedLine`, so a backordered line counts), and its payments table showed a
    Holt refund as a positive amount (now `signedPaymentAmount`);
  - a line change on an imported order: `overpaidAfterLineChange` (`lib/sales/cancelOrder.ts`)
    left imported refunds out, read the order as overpaid and refused a plain cancel;
  - the card checkout's description (`api/portal/pay.ts`, `api/stripe/send-payment-link.ts`)
    named cancelled and replaced lines;
  - the weekly dashboard (`api/dashboard/weekly.ts`) and a lead's spend (`api/leads`), which
    counted cancelled and replaced lines, and for leads quotes and cancelled orders too
    (rules 33 and 47);
  - Open Orders' customer deposits, Balance Aging and the daily reconciliation (their
    runbooks say how).
  One order with every kind of line and payment proves each of them against the
  register: `__tests__/integration/customerTotals.integration.test.ts`. The printed
  receipt and invoice were already right: `api/print/order/[id]` filters both and signs
  refunds before the page adds them up.
- **Deleting an order takes its history with it (fixed 2026-11-03).**
  `OrderChangeLog`'s foreign key restricts, and `DELETE /api/sales/orders/[id]`
  never removed the rows, so an order with any history (a status change, a
  cancelled line, and now a flag, a note or a copy's `COPIED_FROM`) could not be
  deleted: a manager deleting a copy made by mistake got "Failed to delete
  order". The route deletes them first now.
- Choosing the split share at the register is "Split sales" below, and undoing
  a delivery "Undoing a handover".

## Split sales (GAP-07, since 2026-11-03)

A split order records its salesperson's share (`SalesOrder.splitPercent`, 1-99)
beside its partner (`splitWithId`); the partner gets the rest. The order page
shows it ("60/40 with Ben"), and its salesperson dialog
(`PUT /api/sales/orders/[id]/salesperson`, `sales.reassign`) and the bulk
corrections set it: a new split takes the store's default, a new partner keeps
the share, and a change is logged ("split 60/40 with ..."). The register and the
quote builder can split a sale too (pos.md). How every report credits it:
commission.md "Split sales".

## Undoing a handover (GAP-07, since 2026-11-03)

A handover, the goods reaching the customer, is terminal by design: it sets
`deliveredAt` and recognises the sale. One recorded by mistake is undone, not
reopened (owner, 2026-11-03; DECISIONS 38).

- **Who and where.** The order page's **Undo handover**, for holders of "Undo
  a handover" (`sales.undo-handover`). General managers and managers hold it by
  default. It asks why, then calls `POST /api/sales/orders/[id]/undo-handover`
  (`lib/fulfilment/undoHandover.ts`).
- **What it does.** It reads the handover's own record (`OrderHandover`) and
  reverses exactly that:
  - **Stock.** The units it took off the books come back committed to the
    order, where they left from (inventory.md).
  - **The order.** It reopens: `deliveredAt` is cleared, the status is ORDER,
    the dispatch status goes back to what it was, and each line's fulfilled
    quantity goes back too.
  - **Dispatch.** A delivery goes back in the dispatch pool
    (service-dispatch.md).
  - **Records.** The handover keeps who undid it and why, and the order's
    history gets HANDOVER_UNDONE.
- **Only the latest.** A part delivery before it was its own stop and stays
  delivered.
- **Refused:**
  - once commission on the order has been paid out: a paid `CommissionPayout`
    for anyone credited with the sale, for the period the sale counted in on
    their plan (the order date when written, the delivery date when
    delivered);
  - once a return against the order exists;
  - for a handover recorded before 2026-11-03, which has no record of what it
    moved.
- **The status buttons can't skip it.** A handed-over order's status
  (`orders/[id]` PUT) and dispatch status (`orders/[id]/dispatch`) no longer
  leave FULFILLED on their own: that left the goods off the books while the
  order read as open. Both answer 409 and point to Undo handover.
- **Tests:** `__tests__/integration/undoHandover.integration.test.ts`.

## Messages to the customer (GAP-13, since 2026-11-03)

The order page's **Messages to the customer** panel lists the automatic
messages Holt sent about the order: arrived, delivery scheduled, reminder,
review invitation. It also lists the ones it didn't send and why: the customer
opted out, has no email, or hasn't agreed to texts. Each shows where its email or
text stands (`GET /api/sales/orders/[id]/messages`, `sales.read`), and a text
handed to the carrier is told apart from one delivered. The panel shows nothing
until there is one. A customer's "No automatic messages" is on their record
(the customer form; `Customer.autoMessagesOptOut`). What sends each message,
and the store's settings: email.md, "Customer messages". Texts: sms.md.

The **Customer Portal** panel's **Text the link** sends the customer their link
now and says whether it went (`POST /api/portal/text-link`, `sales.write`). Staff
chose to send it, so "No automatic messages" doesn't stop it, but the rules on who
may get a text do. It's listed in the panel above.

**What the order screen offers follows the keys its routes require** (2026-11): Change salesperson `sales.reassign`, Void on a pending payment `payment.void`, the Payment Request panel `payment.take`, the Customer Portal panel `sales.write`, Delete on a quote `sales.cancel`, Undo handover `sales.undo-handover`. The page answers them (`requirePage` `also`) and passes one flag per control. The first five followed the role name on the session token before, so View as changed nothing and staff on a store's own role never saw them.

## Key Files

- `lib/adapters/legacyPos/shared.ts` -- `deriveSalesOrderStatus()`, `isReturnOrder()`, `RETURN_STORE_SUFFIX`, `isRewriteOrder()`, `rewriteBaseOrderno()`, `SAME_DAY_REWRITE_DROP_CANCEL_REASON`
- `lib/adapters/legacyPos/runners.ts` lines 134-723 -- `runSalesImport()`
- `lib/importHelpers.ts` -- source-agnostic helpers only (`safeString`/`safeFloat`/`safeDate`, `splitCustomerName`, `findOrCreateCustomer`). The sales-order logic above is no longer here
- `lib/paymentService.ts` -- `computeBalance()`, `recordPayment()`, `processRefund()` (there is no `postPayment()`), `voidPendingPayment()` (a payment that is no longer PENDING throws `VoidError`, which the void route answers with 409; `docs/ARCHITECTURE.md`, "API errors"), and `startHostedCheckout()`, the one way an order or invoice starts an online card payment (see `docs/domains/pos.md`). A pending payment out on a register's card reader is not voided or swept as a bare row: the order's Void (`payments/[paymentId]/void.ts`) cancels it on the reader first through `cancelReaderPayment`, passing its reason, and `sweepStalePendingPayments` asks the processor how it went before closing it (pos.md, "Card readers"). A payment taken with one of the store's own payment types (`tenderId`) is labelled by `lib/payments/tenders.ts`, and its refund goes back to the same tender (pos.md, "Payment types a store sets up")
- `pages/api/sales/` -- 19 API endpoints
- `lib/pos/cartPricing.ts` -- `catalogRetailPrice()`: the price a catalog product goes onto a New Quote (or POS) line at. No retail price means the line is refused, never priced from cost (see `docs/domains/pos.md`, "A product's line price")
- `lib/tillLock.ts` -- `lockOpenTill()`: a payment (`recordPaymentTx`) or refund (`processRefund`) booked against a till holds that till open until it is written, and `calculateTillExpected(tillId, db)` reads through the caller's transaction when given one (pos.md, "Closing under the till's lock")

## B2B Proposals

`Proposal`, `ProposalLineItem`, `ProposalItemImage` models. List at `/app/sales/proposals`, builder at `/app/sales/proposals/[id]` (Work B2B proposals, `sales.proposal`, which the eight `/api/proposals` routes take too: Managers by default). User-entered cost + retail pricing. Image upload per line item; the pictures, under `data/uploads/proposals/`, are read by every holder of `sales.read`, not only holders of Work B2B proposals (staff-auth.md, "Uploaded files"). PDF generation via jsPDF. Convert to SalesOrder via `/api/proposals/[id]/convert-to-order`. Proposal number format: `BP-YYMMDD-NNN`.

**Line quantity is fractional** (migration `20261022120000_draft_and_proposal_qty_decimal`, 2026-10-17). Fabric is quoted by the yard, so `ProposalLineItem.quantity` is `Decimal(12,3)`, like the `OrderLineItem.orderedQuantity` it becomes. While it was `Int`, a line of 12.5 yards was stored and ordered as 12, and a quantity that was not a number answered 500 (`draftAndProposalQtyFractional.integration.test.ts`). Now:

- **Writing.** The add and edit routes read a quantity with `parseQty` (`lib/inventory/qtyInput.ts`). A quantity that is not a number greater than zero is a 400. An add with no quantity is 1.
- **Reading.** `GET /api/proposals/[id]` and the add and edit routes send each line through `proposalLineForClient` (`lib/proposalQty.ts`), because JSON sends a Decimal as text.
- **Converting.** Convert-to-order orders the fractional quantity and prices the whole line from it.
- **PDF.** An item page shows "each × quantity = line" for every quantity but 1 (`itemPriceText` in `lib/proposalPdf.ts`). The test used to be `> 1`, so half a yard showed a whole yard's price as the line.

## Pipeline Page

Quote cards show:

- Customer name + **Lead Score badge** (the tier for everyone; the number for View marketing, `marketing.read`) + Wealth Tier badge (See wealth data, `customer.wealth`)
- Order number, store, salesperson, quote date
- Urgency badge (days since last contact or quote creation)
- Line item summary and last interaction

Days are the store's days. `daysSince()` in `pages/api/sales/pipeline/index.ts` reads the
business time zone from Settings, so a call at 22:00 reads as a day ago once it's past
midnight at the store. Until GAP-36 this was a hardcoded `America/New_York`.

Pipeline API (`api/sales/pipeline/index.ts`) computes lead score per customer. It sends `wealthTier` only to a holder of See wealth data, and the numeric `leadScore` only to View marketing, both answered by its gate's `also` (server-side enforcement — never leak wealth even if client hides it). The board shows the badge from the response's `wealthVisible`. Every salesperson's pipeline (`canViewAll`: All Staff, one salesperson's board, search across everyone's quotes) is Manage client books (`sales.clients.manage`).

## The client book (GAP-36, since 2026-11-05)

What a salesperson keeps on a client, and the screens built on it. The decisions are in
`docs/DECISIONS.md` 45. Interaction sources are in `docs/domains/interactions.md`.

**`ClientProfile`** is one row per customer: project, style, homes, brands, keywords,
rooms, residence, timeline, budget, decision maker, close likelihood (1 to 10, also a
database CHECK), expected close, next steps and the next follow-up date. `searchText` is
built from the free text when it's saved, so the pipeline's search can read it. Deleting a
customer takes the profile. `lib/clientProfile.ts` validates it, and the merge route moves
it (`fillProfileGaps`: what the kept record says stays, and the duplicate fills the blanks).

**The lists are the store's.** `AppSettings.clientProfileChoices`, under Settings > Client
profile choices. A store starts on `DEFAULT_CLIENT_PROFILE_CHOICES`, list by list, until it
sets its own. Emptying a list takes that field's choices off the form. An answer already on
a client stays valid after its choice is removed (`withSavedAnswer`), both in the form and
when saving; any other answer outside the list is refused.

**Who can do what:**

| Action | Permission | Who, by default |
|---|---|---|
| Open My Clients, log a contact or note, edit Client Info | `sales.lead` | Designers, managers |
| Open someone else's book, the clients no one owns, assign; every salesperson's Pipeline, and archiving anyone's quotes one at a time or in bulk | `sales.clients.manage` | Managers, General Manager, admins |
| Read Client Info and notes on a customer | `customer.write` or `sales.lead` | The above, plus Customer Service and Register |
| Read a customer | `customer.read` | Also Warehouse, Dispatch, Installer, Marketing, who don't get Client Info |

**Who a quote belongs to** (`lib/clientOwnership.ts`, the one match). The linked
`salesPersonId` decides. With none, the `salesperson` text must equal the person's
`displayName` or one of their `aliases`, ignoring case and stray spaces. It used to be
containment, so "Ann" could see and archive every quote written by "Anna Reyes". A name that
matches no one lands on All Staff's "No owner" card, and an alias on the staff record fixes
a POS's own spelling. With no owner by either route, the client's primary designer gets the
quote.

**My Clients** (`/app/sales/clients`, `lib/clientBookQuery.ts`) lists a salesperson's own
clients: those whose `primaryDesignerId` is them, or whose orders are credited to them.
Asking for another book without `sales.clients.manage` returns your own, not a 403, and
`?staff=unassigned` is the only value the page passes through.

**Assigning** (`pages/api/sales/clients/assign.ts`, `lib/clientAssign.ts`) sets
`primaryDesignerId` and nothing else. It never rewrites who an order was credited to, so
commission and reports don't move. Assigning everyone matching a list sends the count the
manager saw, and a different count on the server is refused. Assign options are active
Designers, Managers and Admins, the same list the Pipeline Opportunity report uses.

**On the pipeline** (`pages/api/sales/pipeline/index.ts`):

- `followUpState` (`lib/pipelineFollowUp.ts`): `scheduled` before the date, `due` from that
  day until someone is contacted, otherwise `overdue` past 7 days with no contact, or
  `current`. Staff summaries count `due` and `overdue` as overdue.
- `?search=` looks across open quotes: a `sales.clients.manage` holder's across everyone's, a salesperson's across
  their own (`lib/pipelineSearch.ts`). It reads names, the quote's own notes, a `NOTE` on
  any of the client's quotes, and Client Info.
- Filters and sorts run in the browser on what's loaded (`lib/pipelineFilters.ts`). The
  timeline, room and residence filters come from the store's lists. The value bands
  ($2,500 and $10,000) are fixed and shown in the store's currency.
- All Staff shows a "No owner" card: open quotes in nobody's pipeline, counted once per
  client, without the Cash Sale customer. It links to the assign list.
- The client panel on a card (`lib/pipelineClientQuery.ts`) shows the last purchase and
  brands bought. Service charges come out by what they are: the order's
  `deliveryFeeLineItemId`, and any product with a `serviceType`. Cancelled lines (rule 33)
  and zero-quantity lines (rule 31) are out too.

**Follow-ups (GAP-36).** `lib/pipelineFollowUp.ts`, `lib/followUpReport.ts`,
`lib/followUpReportQuery.ts`.

- **Logging a contact with no quote.** The "Log contact" button on My Clients, and the same
  window from a pipeline card (`LogContactModal`). A contact with no quote shows on all the
  client's quotes and counts as reaching them there, including All Staff's counts. A contact on
  one quote stays on that quote.
- **Whose reminder a date is** (`findFollowUpOwnerId`). The client's active primary designer,
  else whoever set the date, else whoever made their latest sale. One person, so one reminder.
- **Due or overdue.** All Staff now counts them apart: `dueCount` is a date that has arrived,
  and `overdueCount` is no date and past the 7-day limit. The pipeline's filters do too.
- **The Follow-Ups report** (`/app/reports/follow-ups`, `sales.clients.manage`). Every client
  with a date, and per salesperson what's due, what's scheduled, the open quotes behind them,
  and contacts logged over 30 days. A row's value is the open quotes' counted lines, not
  archived quotes or sales. Notes aren't contacts.

**Who gets suggested** (`isSuggestedOutreach`, `lib/clientBook.ts`). Big past clients who've gone
quiet, on My Clients under "Suggested to reach out to". **Off until a store sets a lifetime
spend** in Settings, because what counts as big is theirs to say (rule 63). No order in 12 months
and no contact in 90 days are defaults a store can change. Someone is left out with an open
quote, a follow-up date, no sale at all, or a purchase of their own: `isStaffBuyer` matches
staff by email or whole name. Each client is one person's to work: their active primary designer,
else whoever made their latest sale (`isClientTheirsToWork`). Spend comes from
`Customer.lifetimeSpend`, which `customer-level-recalc` maintains, so **a store that doesn't run
that job gets no suggestions**.

**The morning email** (`lib/followUpEmail.ts`, `followUpEmail` in `lib/email/templates.ts`). Set
an hour under Settings > Morning email and follow-ups. Off until then. The email-queue cron asks on
every run, so it goes in the first run after that hour, once a store day. Claiming the day and
queuing are one transaction, so two runs send one set and a failure tries again. It goes to active
staff in `CLIENT_OWNER_ROLES` with an address, each with their own due follow-ups, quotes waiting
and suggestions. Nobody gets an empty one, and anyone can turn theirs off on My Clients
(`StaffMember.followUpEmailOff`). There's no test send, and no record per person beyond the
email queue.

**What a quote is worth.** `COUNTED_QUOTE_LINE` (`lib/pipelineClientQuery.ts`): counted line
statuses, quantity above 0, a price, and not a gift card (a register sale is a quote until it's
paid, and a card sold on it isn't a sale; `docs/domains/pos.md` "Gift cards"). The card, All Staff, "No owner" and the report all use it.
Until GAP-36, the pipeline counted any line with a price, cancelled or not (rule 33).

**Cash Sale.** `isCashSaleCustomer` matches the customer named exactly "Cash Sale", the shape
a POS's history often lands register sales in. A store whose history uses another name has
those sales read as an ordinary client, with no harm beyond a long list. It's a name match
because nothing else marks that customer yet.

**Tests.** `__tests__/integration/clientBookRoutes.integration.test.ts` (routes, gates,
pages), `__tests__/integration/pipelineClienteling.integration.test.ts` (the queries), and
unit tests for each `lib/` file.

## MANAGER_NOTE Interactions

Managers can add `MANAGER_NOTE` source interactions to quotes from the Pipeline Opportunity report drilldown. Notes appear in the order's interaction history.

## Quote Archive + Replacement Link

`SalesOrder.pipelineArchivedAt`, `pipelineNote`, `archiveReason`, and `replacedByOrderId` work together to remove duplicate/outdated quotes from pipeline counts and conversion denominators without deleting them.

Archive via `PATCH /api/sales/pipeline/[id]` with `{ archived: true, reason, replacedByOrderId?, note? }`. Reasons are `ARCHIVE_REASONS` in `lib/quoteArchive.ts` -- the single list both the ArchiveModal and the endpoint import: Updated Quote, Duplicate, Customer Passed, Stale, Lost to competitor, Customer unresponsive, Budget constraint, No longer interested, Converted to order, Other. When `reason` is "Updated Quote" or "Duplicate" the UI presents a dropdown of other active quotes on the same customer; the selected one is stored in `replacedByOrderId`, and it is **required** for those two reasons -- `validateArchiveReplacementRequirement()` returns a 400 without it.

Archived quotes:

- Hold no stock: archiving ends the quote's holds (see "Quote holds" above)
- Default-hidden on pipeline (an "Archived" tab next to "Active" switches the view)
- Excluded from `quoteCount` / `totalValue` staff metrics
- Show as greyed cards with a "Replaced by SO-1234" link when the link is set

A salesperson (`sales.lead`) can archive their own quotes. A holder of `sales.clients.manage` can archive or restore anyone's, and can archive every open quote dated before a cutoff in bulk (`POST /api/sales/pipeline/bulk-archive`, which ends their holds too). Both were role-name checks until 2026-11, and the bulk one refused the Owner.

## Duplicate Quote Detection

Pipeline API flags probable duplicates via `lib/duplicateQuotes.ts`. Two active quotes on the same customer are flagged when either:

- 50%+ of distinct part numbers overlap (Jaccard-style: shared / max)
- Totals within 10% of each other AND both ≥ $100

**Salesperson exclusion**: when both quotes have a `salesPersonId` set AND those IDs differ, the pair is skipped before either test runs — same-customer-different-designer is a customer transfer, not a duplicate (Issue #129).

Response includes `possibleDuplicateOf: { id, orderno }[]` per quote. UI shows an amber "Possible duplicate of …" line on cards. Archived quotes are excluded from detection (intentional — once you've decided something is a duplicate, stop flagging it).

## A new line's cost (GAP-02, since 2026-10-30)

`OrderLineItem.cost` (the line total, like `netPrice`) is set when a line is
written. The unit cost comes from `saleUnitCost` / `productCost` in
`lib/purchasing/landedCostShared.ts`.

- **A catalog product** (a register or New Quote line of type PRODUCT) costs
  what it cost Holt: its average landed cost, else `baseCost`. The screens still
  send the catalog cost, and `create-from-cart.ts` no longer takes it. Before
  this the server used any cost above zero that the browser sent, so a line's
  cost (margin, commission) was whatever the screen said.
- **A configured or custom line**, which has no catalog product, carries the
  configurator's cost.
- **`POST /api/sales/orders/[id]/line-items`** (add a line) uses the cost sent,
  else the product's cost.
- **Not changed:** the reporting cascade that imputes a cost for historical lines
  with none (`lib/marginMath.ts`) still falls back to `baseCost`.

Landed cost itself is in `docs/domains/purchasing.md`. Tested in
`cartPricingEndToEnd.integration.test.ts` and `landedCost.integration.test.ts`.

## OrderLineItem.netPrice Invariant

`OrderLineItem.netPrice` stores the **line total** (unit price × quantity), not the unit price. Both the POS imports and POS creation follow this model. `computeBalance()` in `lib/paymentService.ts` is the canonical total calculation — always prefer it over re-implementing the formula. If you need the unit price, divide: `netPrice / orderedQuantity`.

**Replacing a line keeps its unit price** (fixed 2026-10-28). The order screen's Replace dialog sends only a name, part number and grade, so `PUT /api/sales/orders/[id]/line-items/[lineItemId]` with `action: "replace"` prices the new line at the original's `netPrice / orderedQuantity` times the original quantity, unless the request carries its own `quantity` (must be positive) or `unitPrice` (zero or more; `0` is honoured). Before this the route multiplied the quantity by `netPrice` itself, so replacing a 2-unit $500 line wrote a $1,000 line and doubled its tax. Pinned against real Postgres in `__tests__/integration/lineItemReplacePrice.integration.test.ts`. The replacement line is still written with `cost: 0` (not changed here): reports on the shared cost cascade (`resolveLineCost` + `imputeMissingCost`, `lib/marginMath.ts`) fall back to the product's `baseCost`, then half the retail price, while a report that reads raw `cost` sees $0.

**A replaced line can't be changed again** (since 2026-11-10). Cancelling, editing or replacing it a second time answers 400 and says to change its replacement, since a second replacement would put the item on the sale twice. Relinking it to a product still works.

**Only lines still owed count** (since 2026-10-15). `computeBalance()` skips any line whose `lineItemStatus` is not in `COUNTED_LINE_STATUSES` (`lib/salesOrderRevenue.ts`: `ACTIVE`, `BACKORDERED`). Cancelling a line, or replacing it, changes its status and **keeps its `netPrice` on the row**, so a total that sums every row charges for cancelled lines and charges a replaced line twice (the original plus its `ACTIVE` replacement). Before this, that is exactly what Stripe checkout, emailed payment links and portal Pay did, since all three charge `calculateOrderBalance()`. `lineItemStatus` is a required field of the balance input, so a caller that forgets to select it is a compile error rather than a silent overcharge. **Known gap:** about 60 other inline line filters (sales journal, AR ledger, revenue reports, commission, lifetime spend) still exclude only `CANCELLED`, or nothing, so a replaced line is still counted twice there. Moving them onto `COUNTED_LINE_STATUSES` is the next step of this work.

## paymentService → CustomerLedger atomic wiring (Phase 0.5.4, 2026-05-12)

`recordPayment` and `processRefund` in `lib/paymentService.ts` now call `appendEntry` from `lib/customerLedger.ts` **inside the same `$transaction`** as the Payment row write. Three things commit together or not at all:

1. `Payment.create` (or the refund payment row)
2. `CustomerLedgerEntry.create` with signed amount (PAYMENT = negative, REFUND_ISSUED = positive — see `signForType`)
3. `Customer.openArBalance` update via `appendEntry`'s atomic balance-bump

**CustomerId resolution order**: `input.customerId` → `SalesOrder.customerId` → null. When both are null (true walk-in cash sale on an unlinked order), the Payment writes but the ledger entry is skipped — the ledger is per-customer; a row with no customer is meaningless. Tested as the third assertion in `paymentServiceLedger.integration.test.ts`.

**Why this matters**: the AR ledger backfill (`POST /api/admin/customer-ledger/backfill`) re-derives every customer's balance from the source-of-truth Payment + SalesOrder + OrderLineItem rows. Before this wiring, every new payment recorded after the backfill ran would silently desync `Customer.openArBalance` from the ledger (the backfill catches up, the live writes drift). The daily AR-drift cron (Phase 0.5.5, next up) would then surface noise that wasn't a real bug — just a missing wire.

**Tests** (B-grade integration, `__tests__/integration/paymentServiceLedger.integration.test.ts`): 7 cases: `recordPayment` writes a negative PAYMENT entry and bumps `openArBalance`; `recordPayment` falls back to `SalesOrder.customerId`; `recordPayment` skips the ledger for a true walk-in; a throw after `Payment.create` rolls the Payment row back too; `processRefund` writes a positive REFUND_ISSUED entry; `processRefund` resolves the customer from the original payment; `processRefund` skips the ledger when neither Payment nor SalesOrder has a customer.

## Verification Checklist

- [ ] `npm test -- legacyPosShared` passes (no test file matches `importHelpers`; the status/return/rewrite helpers moved to `legacyPosShared.test.ts`, which also covers the `lib/importHelpers.ts` coercion helpers)
- [ ] Any line item aggregation uses `COUNTED_ITEM_LINE` / `COUNTED_LINE_FILTER` (rule 33), never `{ not: "CANCELLED" }`
- [ ] Return detection handles return-prefixed patterns (not just R/CR prefix)
- [ ] Order rewrite suffixes (`- A`, `- B`) are not mistakenly treated as returns
- [ ] Invoice import tries rewrite suffixes before base order number
- [ ] Salesperson corrections (salesPersonId set) are preserved on reimport

## Test Coverage

Invoice tools: `__tests__/integration/invoiceTools.integration.test.ts` (real routes and database: line notes, the search and the print; the store's flags, on an order and in the orders list; disclaimers copied, locked and printed; pictures; duplicating, against the same cart rung up at the register; the orders list's totals) and `__tests__/lib/sales/invoiceToolsShared.test.ts` (the shared rules).

Quote holds: `__tests__/integration/quoteHolds.integration.test.ts` (real routes and database: what a quote and an order commit, every way out of a quote, the sweep, archiving, the On hold report, the setting, and made-to-order lines raising no shortfall) and `__tests__/lib/sales/quoteHoldsShared.test.ts` (the day arithmetic and the rule).

Covered in `__tests__/legacyPosShared.test.ts`: `deriveSalesOrderStatus`, `isReturnOrder` (R/CR prefix AND the A-suffix forms of the configured store codes, plus negative cases for M-suffix codes and rewrite suffixes), `isRewriteOrder`, `rewriteBaseOrderno`, `isRefundPayment`

Gaps: no returns-store-prefixed order number is tested at all, so neither the `RETURN_STORE_SUFFIX` returns-store branch nor the bare return-prefix check in `isReturnOrder` has coverage

---

Last verified: 2026-04-17
