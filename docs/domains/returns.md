# Returns

Customer returns processing. **Two parallel realities** must be understood before working on this domain — the master-plan-required runbook (Phase 0 B3).

## The dual reality

| Path                         | Where the data lives                                                                                                                                                                                                                        | Completeness                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Imported POS returns** | Negative line items on a `SalesOrder` with status `RETURNED` (e.g. orderno `ABOA001234` — the store-code + `A` shape matched by `isReturnOrder()` in `lib/adapters/legacyPos/shared.ts`) PLUS a negative `Payment` row for the refund tender | **Gappy** — no return reason, no link to the original sale, no restock/writeoff flag |
| **ERP-native returns**       | Populated `Return` model with reason, condition, pickup address, inspection notes, restock/write-off disposition                                                                                                                            | **Complete**                                                                         |

Reports must understand both. The `Return` table is empty for every historical POS return; data lives on the SalesOrder side instead.

## ERP-native `Return` model

Fields driving the workflow:

| Field                                | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `returnNumber`                       | `RET-YYMMDD-NNN` autogen on create                                                                                                                                                                                                                                                                                                                                |
| `status`                             | `INITIATED` → `PICKUP_SCHEDULED` → `PICKUP_COMPLETED` → `RECEIVED` → `INSPECTED` → `RESTOCKED`/`WRITTEN_OFF`/`CLOSED`; `INITIATED` may also go straight to `RECEIVED`, and `CANCELLED` is reachable from every state before `INSPECTED`. Legal edges are `VALID_TRANSITIONS` in `lib/returnService.ts` — there is no `APPROVED`, `REFUNDED` or `EXCHANGED` status |
| `reason`                             | enum: DEFECTIVE, DAMAGED_IN_DELIVERY, WRONG_ITEM, CUSTOMER_CHANGED_MIND, NOT_AS_DESCRIBED, DUPLICATE_ORDER, OTHER                                                                                                                                                                                                                                                 |
| `inspectionCondition`                | LIKE_NEW, MINOR_DAMAGE, MAJOR_DAMAGE, UNSALVAGEABLE — drives restock-vs-writeoff                                                                                                                                                                                                                                                                                  |
| `salesOrderId` + `lineItemId`        | Direct FK to the original sale (NOT available for imported returns)                                                                                                                                                                                                                                                                                               |
| `pickupRequired` + `pickupAddressId` | Optional pickup scheduling — feeds the warehouse returns queue's pickup tab and the pickup schedule at `/app/warehouse/pickups` if true                                                                                                                                                                                                                           |
| `exchangeOrderId`                    | If the return triggers a replacement order, this links to it                                                                                                                                                                                                                                                                                                      |
| `returnOrderId` + `restockingFeeLineItemId` | Set the first time money moves: the return's own RETURNED order and the fee line on it (see "Returns money"). Refunds are `Payment` rows carrying `returnId`, so a return can be paid out in several payments |
| `portalToken` + `portalRequestedAt`  | Set when staff mint a customer-portal return link; the portal routes key off them                                                                                                                                                                                                                                                                                 |

## UI + API

| Surface           | Endpoint                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Returns list      | `/app/sales/returns` (`app/(dashboard)/app/sales/returns/page.tsx`) → `GET /api/returns`                                                                                                   |
| New return        | `/app/sales/returns/new` → `POST /api/returns`. A delivery fee line is refused (409): it isn't goods, and its reversal would book to no account (sales-orders.md, "Delivery fee") |
| Return detail     | `/app/sales/returns/[id]` → `GET /api/returns/[id]`; `PUT /api/returns/[id]` edits pickup fields + `reasonNotes` only                                                                      |
| Returns queue     | `/app/warehouse/returns` → `GET /api/warehouse/returns/queue` (pickup / inspection / decision tabs)                                                                                        |
| State transitions | `PUT /api/returns/[id]/status` with the target status in the body — rejected unless `isValidTransition` allows the edge                                                                    |
| Refund            | `POST /api/returns/[id]/refund` → `refundReturn` in `lib/returns/refundReturn.ts` (to the original payment, or to store credit; `retryRefundPaymentId` finishes one waiting on its processor) |
| Exchange          | `POST /api/returns/[id]/exchange` — creates an exchange `SalesOrder` linked via `exchangeOrderId`, mirrors the original storeLocation + salesperson + customer                             |
| Pickup planning   | `/app/warehouse/pickups` → `GET /api/warehouse/returns/pickups` reads `pickupRequired = true && status IN INITIATED/PICKUP_SCHEDULED`                                                      |
| Customer portal   | `GET /api/portal/returns/[token]` + `POST /api/portal/returns/request` — token-only, no staff session; staff mint the token with `POST /api/sales/orders/[id]/return-link` (`sales.write`), which writes an `INITIATED` return with reason `OTHER` and a random UUID token. No screen calls that endpoint yet (checked 2026-11-21), so a link is minted only by a hand-made API call; the demo seed writes one (`prisma/seed/demo/returnLinks.ts`). Both answer `PortalReturn` only (see "The return's line" below) |

Auth is mixed. `/api/returns`, `/api/returns/[id]` and `/api/returns/[id]/exchange` gate on `requirePermission("sales.return")`, which MANAGER, REGISTER and WAREHOUSE hold by default (`lib/auth/permissionCatalog.ts`) on top of ADMIN/SUPER_ADMIN. `/api/returns/[id]/status` takes `sales.return` too since 2026-10-17 (it was a role list without WAREHOUSE, whose staff work the returns queue), as do `/api/returns/[id]/disposition` and `/api/warehouse/returns/returned-stock` (either `sales.return` or `inventory.transfer`); and `/api/returns/[id]/refund` is `requirePermission({ anyOf: ["payment.refund", "payment.return-refund"] })`: Refund payment, or Refund returns, which Register and Warehouse hold by default so they keep paying out returns as the role list it replaced let them. A General Manager reaches it through Refund payment. The list and detail pages are `sales.read` and the new-return page `sales.write`. The warehouse queue and pickup PAGES are `sales.return` since 2026-11-21 (they were MANAGER/ADMIN/WAREHOUSE role lists). The endpoints behind them, `/api/warehouse/returns/queue` and `/api/warehouse/returns/pickups`, are `requirePermission("sales.return")` (checked 2026-10-16; this line used to say they had no role check).

### The return's line (2026-11-21)

A return is valued from its line when it is paid out (`bookReturn` reads the line's
price, tax and cost), so which line a return names is not a label. Three routes write
`Return.lineItemId` from what a caller sends, and two of them ask `returnLineProblem()`
in `lib/returns/returnLine.ts`: the customer's portal request, where a token holder
names a line, and the staff return link. The third, New return, does not (below). A
line passes `returnLineProblem` when it is on the return's own
order, still counted (not CANCELLED or REPLACED, `orderedQuantity` above zero: rules 31
and 33, through `isCountedItemLine`), and goods: not a gift card (the item kind of the
counted filter leaves it out) and not the order's delivery fee (as `POST /api/returns`
refuses it). Anything else is a 400: one message for a line not on the order, one
naming the other reasons. A line id that is not a whole
number above zero is a 400 before any lookup. The portal request used to write any line
id it was sent, so a token holder could point their return at another customer's line.

The portal request also checks its body before Prisma does
(`parsePortalReturnRequest` in `lib/returns/portalReturn.ts`): an unknown `reason` is
a 400 naming the `ReturnReason` values (it was a 500 from the enum column). Both portal
routes answer `PortalReturn` (`lib/returns/portalReturnContract.ts`, imported by both
portal pages): return number, status, product name, quantity, created and customer
notes, the fields the two pages read. The reason is stored but not sent back, since
neither page reads it. The request route used to answer with the whole `Return` row.

**New return is the third writer, and it does not ask `returnLineProblem`**, so this is
not one guard on every path (CLAUDE.md rule 42). `POST /api/returns` takes the
`lineItemId` from the body, finds the line within the order, refuses the delivery fee
(`deliveryFeeLineEditProblem`) and defers a gift card to the store's "Refund unused gift
cards" setting (`giftCardLineEditProblem`). It checks neither the line's status nor its
quantity, so staff holding `sales.return` can start a return on a cancelled or replaced
line, and `bookReturn` values it at that line's price when it is paid out (cancel and
replace keep the line's price and quantity). A zero-quantity line is taken too, though
`computeReturnValue` refuses to value it. An unknown reason there is still a 500.
Moving it onto `returnLineProblem` needs care: that function refuses every gift card,
where New return honours the store's setting (`giftCardSaleBooks.integration.test.ts`
returns an unused card through it). Listed under "Known gaps" below.

## Returned stock: the piece, not the paperwork (since 2026-10-17)

Owner direction 2026-10-16 (DECISIONS #19): a return never holds up the
customer. What happens to the returned piece is the store's, through
`lib/inventory/returnStock.ts`:

- **RECEIVED** puts the piece into the store's **returns place** -- the store's
  `returnsStockLocationId`, or a `RETURNS` place of type QUARANTINE created the
  first time -- as a `RETURN` movement, and records the store and place on the
  return (`receivedLocationId`, `receivedStockLocationId`). The store is the one
  named, or where it was received, or the order's own: receipt is never refused
  for want of one. A store that points its returns place at a sellable place has
  returns back on sale at once.
- The return can then be inspected and closed whenever the customer side is
  done.
- **The returned-stock queue** (Warehouse > Returns > Returned stock;
  `/api/warehouse/returns/returned-stock`, per store) lists every return whose
  piece was received and neither put back nor written off. **Put back** moves
  the piece from its recorded place to a sellable place at that store (the
  store's receiving place when none is chosen); **Write off** takes it out of
  the books (`WRITE_OFF`). Each is claimed on the return first
  (`restockedAt` / `writtenOffAt`), so a second click is a 409, and neither
  changes the return's status. `/api/returns/[id]/disposition` does both.
- The status route's RESTOCKED and WRITTEN_OFF do the same, for screens that
  close a return that way. A return received before returns places existed has
  no recorded place; restocking it adds the piece from outside the books, the
  old way.
- The journal generator's `classifyReturnDisposition` reads the recorded
  disposition first (`writtenOffAt`, then `restockedAt`), then a terminal
  status, then the inspection condition: a piece put back after the return was
  closed books as a restock.
- `Return.quantity` is Decimal(12,3): a part roll comes back as a length.

## Accounting view — returns are sales-in-reverse

User direction 2026-04-28: _"returns aren't shrinkage — they're sales in reverse."_

The JE shape (per `docs/domains/accounting.md`):

| Event     | JE shape                                                                                                                                                                                                                                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Return    | Debit Sales (reverse the credit), debit Sales-Tax-Payable (reverse the tax), credit Cash/Card (refund tender), then EITHER debit Inventory + credit COGS (restock) OR debit the department's shrinkage/write-off GL + credit COGS (writeoff). The "Returns" GL account in the schema is mostly informational — actual lines hit Sales / Tax / Cash. |
| Shrinkage | Debit Shrinkage, credit Inventory. No cash movement. **Separate from returns.**                                                                                                                                                                                                                                                                     |

**B3 shipped 2026-07-24**: the restock-vs-writeoff decision is now wired into the JE generator (`resolveReturnBookingPath()` in `lib/journalEntry.ts`), not just modeled in the schema. Three named paths:

- **`CLASSIFIED_RESTOCK`** / **`CLASSIFIED_WRITEOFF`** — a `Return` record covers the return-shaped line (matched via exact `lineItemId` FK, then unique same-order `productId`, then "sole `Return` on the order") AND is classified (terminal `status` of `RESTOCKED`/`WRITTEN_OFF`, or an `inspectionCondition` of `LIKE_NEW`/`MINOR_DAMAGE` → restock, `MAJOR_DAMAGE`/`UNSALVAGEABLE` → writeoff — the same mapping `suggestDisposition()` in `lib/returnService.ts` already suggested at the counter). `CLASSIFIED_WRITEOFF` debits the account group's `shrinkageAccount` GL instead of Inventory; falls back to restock (with a JE warning) if that GL isn't configured.
- **`UNCLASSIFIED_DEFAULT_RESTOCK`** — no `Return` record matches, or one exists but hasn't been inspected yet. Books exactly like `CLASSIFIED_RESTOCK` (debit Inventory) — this IS the owner-directed default, just made an explicit, named, greppable code path instead of an implicit fallthrough. **Every imported historical return takes this path** — the `Return` table is never populated by import, so there is nothing to classify against. Native ERP returns take it too until someone inspects them.

**Visibility**: the "Unclassified Returns" report (`/app/reports/unclassified-returns`, View management reports: `reporting.management`, held by the Manager, Administrator and Owner by default) lists every line that took the default path — date, order #, store, customer, amount, and why (no Return record / ambiguous match / not yet inspected) — so an accountant can review the assumption instead of it being silent. See `docs/domains/reporting.md` "Unclassified Returns (B3 exception report)" for the query and invariants. Anything confirmed as an actual writeoff still goes through the manual transfer-out workflow OR gets a `Return` record classified to `WRITTEN_OFF` so the next JE run books it correctly.

## Imported-the POS-return gaps

What we can't get from any current the POS export:

| Data hole                                            | Impact                                                                                                                        | Recovery                                                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No link to original sale (accounting returns)        | Limits return-rate analytics                                                                                                  | Heuristic (orderno pattern + customer + date proximity + line-item overlap) — reconstructible as a one-off if needed |
| No return reason                                     | Can't categorize for vendor scorecards                                                                                        | Imported returns lump under "Customer Return — reason not captured." Document in runbook.                            |
| No restock-vs-writeoff flag per item                 | All imported returns take the `UNCLASSIFIED_DEFAULT_RESTOCK` path (owner rule) — visible on the "Unclassified Returns" report | Manual transfer-out, OR classify a `Return` record to `WRITTEN_OFF`, for any item actually written off               |
| Tax computed at return-date rate, not sale-date rate | Small edge case (the state rate rarely changes)                                                                               | Accept the POS's value                                                                                               |
| Refund tender doesn't reference line items           | OK for JE (sum at order level); gap for partial-refund analytics                                                              | Native ERP path captures this                                                                                        |
| `Return` model never populated by import             | Two parallel realities                                                                                                        | Document the duality (this runbook)                                                                                  |

## Same-day rewrite edge case

Per `docs/domains/import-pipeline.md` "Same-day rewrites — the dropped-line edge case" (post-failure 2026-05-12, recalibrated 2026-05-15):

When the POS same-day-rewrites an order, dropped lines get left ACTIVE on the base order with no offsetting return. Detection is `findDroppedBaseLineIds` in `lib/adapters/legacyPos/sameDayRewriteCleanup.ts` (combined 3-axis heuristic); the cancellation runs post-import inside `runSalesImport` (`lib/adapters/legacyPos/runners.ts`), stamping `lineItemStatus = CANCELLED` plus `SAME_DAY_REWRITE_DROP_CANCEL_REASON`. See that section for the full pattern.

## Exchange orders

`POST /api/returns/[id]/exchange` creates a new `SalesOrder` with prefix `EX-YYMMDD-NNN`, status `QUOTE`, linked to the return via `exchangeOrderId`. Inherits the original's customer, store (its name and, since 2026-10-29, its `storeLocationId`, so a line added to the exchange is taxed by the store's district) and salesperson. The call is refused if `exchangeOrderId` is already set, and it does not touch the return's own status — there is no `EXCHANGED` status.

The exchange order is a regular sales order from that point — runs through the normal sales flow.

## Audit trail

Every state transition writes to `OrderChangeLog` for the linked `salesOrderId`. `changeType` is a free-text `String` column, and the status route builds it as `RETURN_` + the new status — so the transition set is every `ReturnStatus` value that is a legal transition TARGET, prefixed (`INITIATED` is never a target; `RETURN_INITIATED` only comes from the create paths):

| Action                                             | changeType                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Return created (also when a portal link is minted) | `RETURN_INITIATED`                                                                                           |
| Any status transition                              | `RETURN_<NEW_STATUS>` — e.g. `RETURN_RECEIVED`, `RETURN_INSPECTED`, `RETURN_RESTOCKED`, `RETURN_WRITTEN_OFF` |
| Refund issued                                      | `RETURN_REFUND_ISSUED`                                                                                       |
| Exchange created                                   | `RETURN_EXCHANGE_CREATED`                                                                                    |

## Verification checklist (before touching returns code)

- [ ] Read this runbook + `docs/domains/sales-orders.md` (RETURNED status, A-suffix detection)
- [ ] Read the RETURNED-status revenue rule (CLAUDE.md rule 47 / canonical `SALES_REVENUE_STATUSES`; `isRevenueStatus(status)` asks it of one order, as the customer ledger does)
- [ ] If touching JE math for returns, read `docs/domains/accounting.md` "returns are sales-in-reverse"
- [ ] Confirm the gate on the exact route you are touching — most `/api/returns` routes are `requirePermission("sales.return")`; `refund` takes `payment.refund` or `payment.return-refund`
- [ ] If touching the imported-returns path, remember the `Return` model is empty for historical data — read from `SalesOrder` + `OrderLineItem` instead

## Test coverage

| Surface                                                                                                          | Coverage                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `returnService.ts` state transitions                                                                             | `__tests__/returnTransitions.test.ts` (pure: `isValidTransition`, `getValidTransitions`, `isTerminalState`, `suggestDisposition`)                                                                |
| `reports.salesRevenueStatusFilter.test.ts`                                                                       | Source-text tripwire ensuring RETURNED is included in revenue aggregations                                                                                                                       |
| `integration/mailchimpAttributionRewriteChain.integration.test.ts`                                               | Real-DB test of the rewrite + return net-out math                                                                                                                                                |
| B3 restock/writeoff JE branching (`resolveReturnBookingPath`, `matchReturnForLine`, `classifyReturnDisposition`) | `__tests__/journalEntry.test.ts` (pure, 21 scenarios) + `__tests__/integration/generateSalesJournal.integration.test.ts` (2 real-DB scenarios: classified `WRITTEN_OFF`, classified `RESTOCKED`) |
| Unclassified Returns exception report                                                                            | `__tests__/unclassifiedReturns.test.ts` (pure, row selection + reason text + invariants)                                                                                                         |
| Exchange order creation                                                                                          | None — gap                                                                                                                                                                                       |
| Inspection workflow                                                                                              | None — gap                                                                                                                                                                                       |

## Known gaps (master plan)

- **New return takes a cancelled, replaced or zero-quantity line** (found 2026-11-21).
  `POST /api/returns` should refuse what `returnLineProblem` refuses, except that a gift
  card line stays the store's choice (`giftCardLineEditProblem`), and a reason outside
  `ReturnReason` should be a 400. "The return's line" above has the detail.
- ✅ **Pickups on a delivery run.** "Add to run" on the pickup schedule makes the pickup a run stop; completing it sets PICKUP_COMPLETED (`lib/fulfilment/returnPickup.ts`, `docs/domains/service-dispatch.md` → "Run stop outcomes"). The run planner does not suggest pickups by zone yet.
- **Vendor return path** for damaged items (consignment-specific in `docs/domains/consignment.md`; non-consignment vendor returns have no formal workflow)

## Returns money (since ledger-plan PR 2b)

Owner direction 2026-10-16: a return never holds up the customer. The refund
goes back to the original payment method **or** onto the customer's account as
store credit, usable toward a new sale or a rewrite, and a return may carry a
restocking fee. Putting the piece back or writing it off is the store's
returned-stock queue (above), not a step the customer waits on.

**A return books as its own order** (DECISIONS #20, `lib/returns/bookReturn.ts`)
the first time money moves for it: a RETURNED `SalesOrder` numbered with the
return number, carrying one negative line for what came back (its share of the
original line's net, tax and cost, by quantity; the return that completes a
line takes the remainder) and one positive line for the restocking fee. It gets
an invoice dated the return day **only when the original order was invoiced**:
a sale that was recognised is reversed the same way, on the day the return
happens. The original order is never rewritten. The customer's AR ledger gets a
negative SALE entry for what they are owed; the refunds that pay it out bring
it back. Once booked, the return cannot be cancelled and its order cannot be
edited through the order or line routes (`returnOrderEditProblem`).

**Paying it out** (`lib/returns/refundReturn.ts`, the return detail screen's
Refund panel):

1. What the original order still owes is paid first, from the return, as store
   credit spent on that order. A customer who owes $500 and returns a $400 piece
   owes $100 and is refunded nothing. A walk-in sale has no customer to hold the
   credit, so it is skipped.
2. What is left is refundable: the value, less the fee, less every refund that
   is COMPLETED or still PENDING (`returnMoney.ts`). Refunds may be split.
3. **To the original payment:** a payment on the original order, refunded the
   way it was taken (`processRefund`). A card refund is reserved as a PENDING
   row, sent to the processor outside any transaction with the key
   `holt-refund-<id>`, then settled. If the processor errors, the row stays
   PENDING: it still counts against the cap, stays out of balances and the
   journal, and Retry sends the same key, so a refund that did go through is
   never repeated. Past 24 hours a retry is refused and the operator checks the
   processor's dashboard; the stale-payment sweeper never touches a PENDING
   refund.
4. **To store credit:** credit on the customer's account (`lib/customerCredit.ts`),
   with no processor and no till. Nothing goes back to the card.

**Restocking fee:** typed per return by the person refunding it, as a percent
of the goods' net or an amount, 0 unless they say otherwise. It is fixed by the
first refund. A nonzero fee needs `POS_TRANSACTIONS`/"Restocking Fee" mapped to
an income account (the migration adds the row unmapped); the journal books the
fee line there, and the daily reconciliation counts that account as revenue.
**Defaults pending the owner** (asked 2026-10-16): the fee is per return rather
than a store default percent; the fee is not taxed, so the full tax goes back;
the salesperson's commission is not adjusted for the fee (a native return
claws back commission in its own period, as an imported one does).

**Store credit** is spent at the register (a "Store Credit" tender, shown when
the order's customer has some), on an order's screen ("Apply store credit",
for rewrites and exchanges), or on an invoice's "Record payment" (GAP-26, offered
when the invoice's customer has some). Credit is spent only on the same customer's
order or invoice, under a per-customer lock, and never past zero (CHECK
`Customer_creditBalance_nonnegative`).

The findings of 2026-10-16, all closed here (rule 48):

| Finding | Closed by |
|---|---|
| Refunding a card payment "to store credit" refunded the card **and** issued credit | `processRefund` has no method override; store credit is its own destination with no processor (`refundReturn`) |
| Refund to store credit issued nothing when the payment row had no customer | The credit goes to the return's customer, else the order's; with neither, the refund is refused before anything is written |
| The processor call ran inside the database transaction | Reserve, call, settle (`processRefund`); test: the processor error and retry case in `returnMoney.integration.test.ts` |
| The refund route checked neither the return's status, the payment's order, nor a cap; a second refund overwrote the first's record | `POST /api/returns/[id]/refund`: 409 for a cancelled return, 400 for another order's payment or over the cap; refunds are rows with `returnId` |
| `computeRefundable` was unused; `processRefund` re-derived it | `processRefund`'s cap is `computeRefundable`, counting COMPLETED and PENDING refunds only |
| Store credit could be spent on another customer's order | `spendStoreCredit` refuses any order but the credit's customer's, and an order with no customer |
| No screen offered store credit; manual credit adjustments reached no GL | The register tender and "Apply store credit". **Manual adjustments still post no journal**: tracked below |
| The return detail screen crashed on load (`createdAt`, `order`, `payments` never sent) | One contract, `lib/returns/returnDetailContract.ts`, for the API and the screen |
| Native returns wrote no negative lines, so a refunded order showed owing the refund again | The return's own RETURNED order |
| `REFUND_ISSUED`'s sign was +1 in code and negative in the comments and accounting.md | The comments and runbook now say +1; the return's SALE entry is what makes refund-to-credit net out |
| No restocking fee | Above |

Also fixed on the way: the sales journal now leaves out PENDING, FAILED and
VOIDED payments (it journaled every row on the day), and so does the till's
expected count; the register's tender route was refused to the REGISTER role
(it was a MANAGER/ADMIN list) and now takes `payment.take`.

**Not done, tracked here (rule 50):**

| Gap | Why it waits |
|---|---|
| A manual store-credit adjustment (`customer.credit.adjust`) moves the balance but posts no journal entry | Needs an adjustment journal type and an account pair to post between; its own change |
| A return booked against an original that is invoiced **later** is never reversed in the journal (it had no invoice to mirror when it was booked) | Native sales are rarely invoiced today (see accounting.md "The billing service could not invoice a sales order"); revisit when delivery invoices them |
| A write-off decided after the return day's journal is posted still books as restock on that day | The queue's write-off should post its own Dr Shrinkage / Cr Inventory; with returned-stock journal work |
| A PENDING processor refund older than 24 hours can only be voided, not marked as paid, from the screen | Needs an admin settle action with the processor's refund id |
| Refunds paid at the returns desk are not tied to a till | The returns desk has no register context today |
| The register's "return mode" cart writes negative lines with no Return record and no payout path | A separate flow; left as it is |

---

Last verified: 2026-07-24 (B3 — restock/writeoff JE branching + Unclassified Returns report)
