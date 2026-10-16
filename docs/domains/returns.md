# Returns

Customer returns processing. **Two parallel realities** must be understood before working on this domain — the master-plan-required runbook (Phase 0 B3).

## The dual reality

| Path                         | Where the data lives                                                                                                                                                                                                                        | Completeness                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Imported the POS returns** | Negative line items on a `SalesOrder` with status `RETURNED` (e.g. orderno `ABOA001234` — the store-code + `A` shape matched by `isReturnOrder()` in `lib/adapters/ordorite/shared.ts`) PLUS a negative `Payment` row for the refund tender | **Gappy** — no return reason, no link to the original sale, no restock/writeoff flag |
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
| `refundPaymentId` + `refundAmount`   | Stamped by the refund endpoint once a refund `Payment` is issued                                                                                                                                                                                                                                                                                                  |
| `portalToken` + `portalRequestedAt`  | Set when staff mint a customer-portal return link; the portal routes key off them                                                                                                                                                                                                                                                                                 |

## UI + API

| Surface           | Endpoint                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Returns list      | `/app/sales/returns` (`app/(dashboard)/app/sales/returns/page.tsx`) → `GET /api/returns`                                                                                                   |
| New return        | `/app/sales/returns/new` → `POST /api/returns`                                                                                                                                             |
| Return detail     | `/app/sales/returns/[id]` → `GET /api/returns/[id]`; `PUT /api/returns/[id]` edits pickup fields + `reasonNotes` only                                                                      |
| Returns queue     | `/app/warehouse/returns` → `GET /api/warehouse/returns/queue` (pickup / inspection / decision tabs)                                                                                        |
| State transitions | `PUT /api/returns/[id]/status` with the target status in the body — rejected unless `isValidTransition` allows the edge                                                                    |
| Refund            | `POST /api/returns/[id]/refund` → `processRefund` in `lib/paymentService.ts`, then stamps `refundPaymentId` + `refundAmount`                                                               |
| Exchange          | `POST /api/returns/[id]/exchange` — creates an exchange `SalesOrder` linked via `exchangeOrderId`, mirrors the original storeLocation + salesperson + customer                             |
| Pickup planning   | `/app/warehouse/pickups` → `GET /api/warehouse/returns/pickups` reads `pickupRequired = true && status IN INITIATED/PICKUP_SCHEDULED`                                                      |
| Customer portal   | `GET /api/portal/returns/[token]` + `POST /api/portal/returns/request` — token-only, no staff session; staff mint the token with `POST /api/sales/orders/[id]/return-link` (`sales.write`) |

Auth is mixed. `/api/returns`, `/api/returns/[id]` and `/api/returns/[id]/exchange` gate on `requirePermission("sales.return")`, which MANAGER, REGISTER and WAREHOUSE hold by default (`lib/auth/permissionCatalog.ts`) on top of ADMIN/SUPER_ADMIN. `/api/returns/[id]/status` takes `sales.return` too since 2026-10-17 (it was a role list without WAREHOUSE, whose staff work the returns queue), as do `/api/returns/[id]/disposition` and `/api/warehouse/returns/returned-stock` (either `sales.return` or `inventory.transfer`); and `/api/returns/[id]/refund` is `requireAuthWithRole(["SUPER_ADMIN", "MANAGER", "ADMIN", "REGISTER", "WAREHOUSE"])`. The list/new/detail pages require only a signed-in user. The warehouse queue and pickup PAGES are MANAGER/ADMIN/WAREHOUSE, but the endpoints behind them are not: `/api/warehouse/returns/queue` and `/api/warehouse/returns/pickups` are bare `getServerSession` with no role check, so any signed-in user can read the customer names, phone numbers and pickup addresses they return.

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

**Visibility**: the "Unclassified Returns" report (`/app/reports/unclassified-returns`, MANAGER/ADMIN) lists every line that took the default path — date, order #, store, customer, amount, and why (no Return record / ambiguous match / not yet inspected) — so an accountant can review the assumption instead of it being silent. See `docs/domains/reporting.md` "Unclassified Returns (B3 exception report)" for the query and invariants. Anything confirmed as an actual writeoff still goes through the manual transfer-out workflow OR gets a `Return` record classified to `WRITTEN_OFF` so the next JE run books it correctly.

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

When the POS same-day-rewrites an order, dropped lines get left ACTIVE on the base order with no offsetting return. Detection is `findDroppedBaseLineIds` in `lib/adapters/ordorite/sameDayRewriteCleanup.ts` (combined 3-axis heuristic); the cancellation runs post-import inside `runSalesImport` (`lib/adapters/ordorite/runners.ts`), stamping `lineItemStatus = CANCELLED` plus `SAME_DAY_REWRITE_DROP_CANCEL_REASON`. See that section for the full pattern.

## Exchange orders

`POST /api/returns/[id]/exchange` creates a new `SalesOrder` with prefix `EX-YYMMDD-NNN`, status `QUOTE`, linked to the return via `exchangeOrderId`. Inherits the original's customer + storeLocation + salesperson. The call is refused if `exchangeOrderId` is already set, and it does not touch the return's own status — there is no `EXCHANGED` status.

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
- [ ] Read the RETURNED-status revenue rule (CLAUDE.md rule 47 / canonical `SALES_REVENUE_STATUSES`)
- [ ] If touching JE math for returns, read `docs/domains/accounting.md` "returns are sales-in-reverse"
- [ ] Confirm the gate on the exact route you are touching — most `/api/returns` routes are `requirePermission("sales.return")`, but `status` and `refund` are `requireAuthWithRole`
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

- **Native pickup scheduling integration** with dispatch board — `pickupRequired` flag exists but the dispatch UI doesn't yet pull return-pickups into the run-planner
- **Vendor return path** for damaged items (consignment-specific in `docs/domains/consignment.md`; non-consignment vendor returns have no formal workflow)
- **Restocking fees** — not modelled at all: no field on `Return`, and nothing in `app/src` computes one

## Returns money: found 2026-10-16, scheduled for ledger-plan PR 2b

Owner direction 2026-10-16: a return never holds up the customer. The refund
goes back to the original payment method **or** onto the customer's account as
store credit, usable toward a new sale or a rewrite, and a return may carry a
restocking fee. Putting the piece back on the shelf or writing it off is a
separate per-store queue (ledger plan PR 2, phase 8), not a step the customer
waits on.

Found reading the code (static read, nothing exercised), each tracked here
until PR 2b closes it (rule 50):

| Finding | Where |
|---|---|
| Refunding a card payment "to store credit" refunds the card **and** issues credit: the processor refund does not depend on the chosen method | `lib/paymentService.ts` `processRefund` (~647) |
| Refund to store credit issues nothing when the payment row has no customer (no fallback to the order's customer), while the refund row says "Store Credit" | `processRefund` (~698) |
| The processor call runs inside the database transaction: a rollback after it leaves the customer refunded and nothing recorded | `processRefund` (613/650) |
| The refund route checks neither the return's status (a CANCELLED return can refund), that the payment belongs to the return's order, nor a cap at the returned line's value; a second refund overwrites the first's record | `pages/api/returns/[id]/refund.ts` |
| `computeRefundable` is exported and tested but unused; `processRefund` re-derives it inline (rule 42) | `paymentService.ts:105` vs `:625` |
| Store credit can be spent on another customer's order: `recordPayment` never checks the credit's customer against the order's | `paymentService.ts` STORE_CREDIT branch (~248) |
| No screen offers store credit: the register's tenders are cash/check/card/gift card; nothing calls `/api/customers/[id]/credit`; manual credit adjustments reach no GL | `PosView.tsx:101`, `credit/adjust.ts` |
| The return detail screen reads fields the API does not send (`order`, `createdAt`, `payments`, …). **Reproduced 2026-10-17 on a seeded scratch database:** opening a return crashes with "RangeError: Invalid time value" at `ReturnDetailView.tsx:339` (`format(new Date(returnData.createdAt))`), so no refund can be issued from it. The New Return screen now lands there after a successful submit | `ReturnDetailView.tsx` vs `pages/api/returns/[id].ts` |
| Native returns write no negative lines, so revenue is never reversed and `computeBalance` shows a refunded order owing the refund again — chargeable by payment links and portal Pay | `pages/api/returns/index.ts` |
| `REFUND_ISSUED`'s ledger sign is +1 in code and negative in the schema comment and accounting.md; refund-to-credit raises open AR while raising the credit balance | `lib/customerLedger.ts:294` |
| No restocking fee field, computation or GL account | — |

PR 2 changes what the journal generator reads for a return's disposition:
`resolveReturnBookingPath()` classified a return by its terminal status
(`RESTOCKED`/`WRITTEN_OFF`). Once the returned-stock queue puts pieces back or
writes them off after the customer's return is closed, the classification reads
the return's recorded disposition instead.

---

Last verified: 2026-07-24 (B3 — restock/writeoff JE branching + Unclassified Returns report)
