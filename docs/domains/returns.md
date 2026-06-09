# Returns

Customer returns processing. **Two parallel realities** must be understood before working on this domain — the master-plan-required runbook (Phase 0 B3).

## The dual reality

| Path | Where the data lives | Completeness |
|---|---|---|
| **Imported the POS returns** | Negative line items on a `SalesOrder` with status `RETURNED` (e.g. orderno `SR-13252` is the accounting-return shape) PLUS a negative `Payment` row for the refund tender | **Gappy** — no return reason, no link to original the sale prefix, no restock/writeoff flag |
| **ERP-native returns** | Populated `Return` model with reason, condition, pickup address, inspection notes, restock flag | **Complete** |

Reports must understand both. The `Return` table is empty for 12K+ historical the POS returns; data lives on the SalesOrder side instead.

## ERP-native `Return` model

Fields driving the workflow:

| Field | Notes |
|---|---|
| `returnNumber` | `RET-YYMMDD-NNN` autogen on create |
| `status` | `INITIATED` → `INSPECTED` → `APPROVED` → `RESTOCKED`/`WRITTEN_OFF`/`REFUNDED`/`EXCHANGED` |
| `reason` | enum: DEFECTIVE, DAMAGED_IN_DELIVERY, WRONG_ITEM, CUSTOMER_CHANGED_MIND, NOT_AS_DESCRIBED, DUPLICATE_ORDER, OTHER |
| `inspectionCondition` | LIKE_NEW, MINOR_DAMAGE, MAJOR_DAMAGE, UNSALVAGEABLE — drives restock-vs-writeoff |
| `salesOrderId` + `lineItemId` | Direct FK to the original sale (NOT available for imported returns) |
| `pickupRequired` + `pickupAddressId` | Optional pickup scheduling — feeds the dispatch board if true |
| `restockingFeePct` | Optional fee retained |
| `exchangeOrderId` | If the return triggers a replacement order, this links to it |

## UI + API

| Surface | Endpoint |
|---|---|
| Returns list | `pages/sales/returns/index.tsx` → `GET /api/returns` |
| New return | `pages/sales/returns/new.tsx` → `POST /api/returns` |
| Return detail | `pages/sales/returns/[id].tsx` → `GET /api/returns/[id]` |
| State transitions | `POST /api/returns/[id]/[action]` (inspect, approve, restock, etc.) |
| Exchange | `POST /api/returns/[id]/exchange` — creates an exchange `SalesOrder` linked via `exchangeOrderId`, mirrors the original storeLocation + salesperson + customer |
| Pickup planning | dispatch board reads `pickupRequired = true && status IN INITIATED/INSPECTED` |

Auth: `roles: ["ADMIN", "MANAGER", "REGISTER", "WAREHOUSE"]` per `pages/api/returns/[id]/exchange.ts` and similar.

## Accounting view — returns are sales-in-reverse

User direction 2026-04-28: *"returns aren't shrinkage — they're sales in reverse."*

The JE shape (per `docs/domains/accounting.md`):

| Event | JE shape |
|---|---|
| Return | Debit Sales (reverse the credit), debit Sales-Tax-Payable (reverse the tax), credit Cash/Card (refund tender), then EITHER debit Inventory + credit COGS (restock) OR debit Loss + credit COGS (writeoff). The "Returns" GL account in the schema is mostly informational — actual lines hit Sales / Tax / Cash. |
| Shrinkage | Debit Shrinkage, credit Inventory. No cash movement. **Separate from returns.** |

**Owner rule** (master plan): all imported returns are assumed restocks. Anything actually written off goes through the manual transfer-out workflow, not through the return path. This collapses the restock-vs-writeoff branching for imported returns; native ERP returns still capture the decision at the counter via `InspectionCondition`.

## Imported-the POS-return gaps

What we can't get from any current the POS export:

| Data hole | Impact | Recovery |
|---|---|---|
| No link to original sale (accounting returns) | Limits return-rate analytics | Heuristic (orderno pattern + customer + date proximity + line-item overlap) — reconstructible as a one-off if needed |
| No return reason | Can't categorize for vendor scorecards | Imported returns lump under "Customer Return — reason not captured." Document in runbook. |
| No restock-vs-writeoff flag per item | All imported returns assumed restock per owner rule | Manual transfer-out for any item actually written off |
| Tax computed at return-date rate, not sale-date rate | Small edge case (CT rate hasn't changed in years) | Accept the POS's value |
| Refund tender doesn't reference line items | OK for JE (sum at order level); gap for partial-refund analytics | Native ERP path captures this |
| `Return` model never populated by import | Two parallel realities | Document the duality (this runbook) |

## Same-day rewrite edge case

Per CLAUDE.md gotcha "Same-day rewrites drop dangling lines in the base" (post-failure 2026-05-12, recalibrated 2026-05-15):

When the POS same-day-rewrites an order, dropped lines get left ACTIVE on the base order with no offsetting return. Detection + cancellation happens in `lib/sameDayRewriteCleanup.ts` (combined 3-axis heuristic) — runs post-import in `runSalesImport`. See the gotcha in CLAUDE.md for the full pattern.

## Restocking fees

Native ERP returns: `restockingFeePct` on `Return` reduces the refund amount; the difference is retained as a fee. Visible on the return detail page.

Imported the POS returns: math falls out of the line-item totals (return total < original sale total = fee retained). No extra data needed beyond what's already imported.

## Exchange orders

`POST /api/returns/[id]/exchange` creates a new `SalesOrder` with prefix `EX-YYMMDD-NNN`, status `QUOTE`, linked to the return via `exchangeOrderId`. Inherits the original's customer + storeLocation + salesperson. The original return's status moves toward `EXCHANGED` once the new order is fulfilled.

The exchange order is a regular sales order from that point — runs through the normal sales flow.

## Audit trail

Every state transition writes to `OrderChangeLog` for the linked `salesOrderId`:

| Action | changeType |
|---|---|
| Exchange created | `RETURN_EXCHANGE_CREATED` |
| Inspection complete | `RETURN_INSPECTED` |
| Approved for refund | `RETURN_APPROVED` |
| Restocked | `RETURN_RESTOCKED` |
| Written off | `RETURN_WRITTEN_OFF` |

## Verification checklist (before touching returns code)

- [ ] Read this runbook + `docs/domains/sales-orders.md` (RETURNED status, A-suffix detection)
- [ ] Read the RETURNED-status NULL-trap rule (CLAUDE.md rule 51 / canonical `SALES_REVENUE_STATUSES`)
- [ ] If touching JE math for returns, read `docs/domains/accounting.md` "returns are sales-in-reverse"
- [ ] Confirm role gates: `roles: ["ADMIN", "MANAGER", "REGISTER", "WAREHOUSE"]`
- [ ] If touching the imported-returns path, remember the `Return` model is empty for historical data — read from `SalesOrder` + `OrderLineItem` instead

## Test coverage

| Surface | Coverage |
|---|---|
| `returnService.ts` state transitions | Unit tests TBD |
| `reports.salesRevenueStatusFilter.test.ts` | Source-text tripwire ensuring RETURNED is included in revenue aggregations |
| `integration/mailchimpAttributionRewriteChain.integration.test.ts` | Real-DB test of the rewrite + return net-out math |
| Exchange order creation | None — gap |
| Inspection workflow | None — gap |

## Known gaps (master plan)

- **Native pickup scheduling integration** with dispatch board — `pickupRequired` flag exists but the dispatch UI doesn't yet pull return-pickups into the run-planner
- **Vendor return path** for damaged items (consignment-specific in `docs/domains/consignment.md`; non-consignment vendor returns have no formal workflow)
- **Restocking-fee policy table** — currently per-return manual entry; no store-wide default

---
Last verified: 2026-05-20
