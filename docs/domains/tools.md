# Admin Tools

Power-user surfaces under `/tools/*` and `/admin/tools/*`. Mostly ADMIN-only or SUPER_ADMIN-only. These are deliberately not surfaced on hub pages — direct URL access.

## Tool inventory

| Tool                        | Path                                    | Role gate      | Purpose                                                                                                   |
| --------------------------- | --------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| Query Builder               | `/app/tools/query-builder`              | `reporting.adhoc` | List or total allowlisted data: filter, group, pivot, export CSV                                          |
| Categorize Products         | `/admin/tools/categorize-products`      | ADMIN          | Multi-select products → bulk-assign vendor/dept/category/type                                             |
| Merge Customers             | `/admin/tools/merge-customers`          | ADMIN          | Manual merge of two customer rows (post-import cleanup)                                                   |
| Customer Ledger Backfill    | `/admin/tools/customer-ledger-backfill` | ADMIN          | Phase 0.5 ledger backfill driver                                                                         |
| Configurator                | `/tools/configurator`                   | DESIGNER+      | Retail-only product configurator (Wesley Hall SE, grade pricing)                                         |
| Create Project              | `/tools/create-project`                 | DESIGNER+      | Generate a Google Drive project folder from a customer                                                    |
| Import shortcuts            | `/tools/import/*`                       | ADMIN          | Manual triggers for individual the POS import runners                                                     |
| Apparel Order Import        | `/app/tools/apparel-order`              | **ADMIN only** | Parse a vendor apparel order (PDF/CSV) into a draft Purchase Order + items in Buyer Drafts                |
| Home Accessory Order Import | `/app/tools/home-accessory-order`       | **ADMIN only** | Parse a home-accessory vendor order file and create Buyer Drafts PO(s) + items directly (no CSV download) |

The designer-facing tools (Configurator, Create Project) are role-gated separately and are NOT the focus of this runbook — they're covered by their respective domain runbooks (`pricing-catalog.md` for Configurator, `staff-auth.md` for permissions).

## Apparel Order Import — `lib/apparelOrderVendors.ts` + `lib/apparelOrderToBuyerDraft.ts`

App Router tool (`app/(dashboard)/app/tools/apparel-order/`) that ports the predecessor ERP's
apparel-order tool to feed holt's own Buyer Drafts domain (`buyer-drafts.md`) instead of downloading
the POS CSVs directly — holt is its own system of record, so the tool writes DB rows.

**Flow**: pick a vendor format → upload a PDF (parsed server-side by the same vendor parsers
`lib/pricing/{nuorderParser,nuorderPrintoutParser,zSupplyParser,frankEileenParser}.ts` use for
pricing) or a CSV (parsed client-side with PapaParse) → review/edit the normalized rows (one row
per size/part-number) → pick the destination PO's vendor/department/category/stock location/buy →
"Create Draft PO + Items" creates one `BuyerDraftPurchaseOrder` + one `BuyerDraftItem` per row in a
single transaction (`pages/api/tools/apparel-order/commit.ts`). From there the buyer curates and
exports exactly like any other draft via the existing Buyer Drafts workbench.

**No catalog matching**: the predecessor's version ran a second pass matching parsed rows against existing
the POS `Product` rows (NEW vs UPDATE, style/color candidate suggestions) because its output was a
CSV headed straight into the POS. Holt's Buyer Drafts domain has no such step — every row becomes a
brand-new DRAFT item regardless of whether a similar catalog Product exists; the buyer links to the
real catalog afterward via the existing barcode-lookup or Vendor Style picker flows in the workbench.

**Source stamp**: items are created with `source: APPAREL_SCAN` (BuyerDraftSource has no dedicated
"parsed from a vendor order file" value — APPAREL_SCAN was already reserved for apparel-specific
buyer-drafts and is the closest fit; see the reasoning in `lib/apparelOrderToBuyerDraft.ts`). No
schema migration was added for this tool.

**Vendor part-number prefix**: the predecessor resolved two vendors' (Hunter Bell, PISTOLA) prefix from a
`Vendor.partNumberPrefix` DB column holt doesn't have. Both prefixes (`HBEL`, `PST`) are hardcoded
into the registry instead, straight from the predecessor's own code comments.

## Query Builder — `lib/queryBuilderConfig.ts`

Ad-hoc reporting (GAP-34, DECISIONS 53). Read-only rows or totals over a curated list of ten models, without raw SQL. It also has a card on the Reports hub, shown to whoever holds the key. Source read for this section: `lib/queryBuilderConfig.ts`, `queryBuilderQuery.ts`, `queryBuilderSummary.ts`, `pages/api/tools/query-builder.ts` (2026-11-07).

### Allowlist-driven

`queryBuilderConfig.ts` exports `ENTITIES: EntityDef[]` — every entity is explicitly allowlisted. Adding a new model means:

1. Add an entry to `ENTITIES`
2. List the columns the UI is allowed to expose (`columns: ColumnDef[]`), with `cost: true` on anything the store pays
3. List the joins (`joins: JoinDef[]`) — also allowlisted
4. List filterable fields (`filters: FilterOption[]`), with `nullable: true` where the column can hold NULL
5. State `totals`: which rows count (`where`), the same in words (`says`), and its groups and measures. The type requires it, so no entity can total without saying who counts

**Never** wire the UI to read arbitrary Prisma fields — every exposed surface is intentional. The allowlist is the security model.

The server enforces it, not just the UI. `lib/queryBuilderQuery.ts` resolves each requested filter against the entity's `filters` and each join against its `joins`, and writes only the configured names into the Prisma `where`/`include`: an unknown filter field is a 400, an unknown join is skipped. Until 2026-10-15 the route wrote the request's field names straight into `where`, so a filter on `__proto__.x` polluted `Object.prototype` process-wide and any column could be filtered on (CodeQL #19, #39–#42; `__tests__/queryBuilderQuery.test.ts`). A nested filter (`relation.field`) still works if one is ever added to `filters`; none is today.

### Column types

| Type      | Behavior                                             |
| --------- | ---------------------------------------------------- |
| `string`  | LIKE filter, contains-text                           |
| `number`  | =, >, <, between                                     |
| `decimal` | Same as number but rendered with currency formatting |
| `date`    | Date range picker                                    |
| `boolean` | Yes/no toggle                                        |

### Rows

Server-side query → JSON response → the screen prints it as a table, up to 500 rows, with every row as it stands, cancelled ones included. Only the entity's columns and the joins asked for are selected, so a model's other columns (a customer's tax-exempt number, say) never leave the database. A to-many join shows its count and first values.

### Totals (`lib/queryBuilderSummary.ts`)

Group by one thing, optionally go across by a second (the pivot), and total a count or the entity's measures. Going across shows one total at a time. Dates group by month in the store's time (`lib/reports/businessDay.ts`). Rows with nothing in the group's column stay in, under `(none)` (rule 51).

**Which rows count is stated per entity and shown beside the total (rules 31, 33, 47):**

| Entity | Counts | Totals |
| --- | --- | --- |
| Order Line Items | ACTIVE and BACKORDERED lines, not zero quantity, on ORDER, FULFILLED or RETURNED orders | Count, net price, tax, quantity, cost |
| Sales Orders | Everything but CANCELLED. Quotes and returns show under their own status | Count only: a sale's money comes from its lines |
| Purchase Orders | Everything but CANCELLED | Count only |
| PO Line Items | Not zero quantity, on POs that aren't CANCELLED | Count, quantity, cost (quantity × unit cost) |
| Stock Transfers | Everything but CANCELLED | Count, quantity, quantity received |
| Consignment Items | Every item | Count, retail price, cost |
| Receiving Records | Every receipt | Count, quantity, line cost |
| Products, Customers, Service Cases | Every row | Count only |

**Replaced lines are out** where the rest of the reports only exclude CANCELLED, because the replacement carries the amount (`COUNTED_LINE_STATUSES`). See "Known gaps" in `reporting.md`.

**It reads rows and adds them in JS,** so a group can reach through relations and a month can follow the store's time. Past 100,000 rows it refuses and says to narrow it, rather than total part of them.

### Filters

Each filter is its own condition, so two on a column make a range. A date is a day in the store's time. Operators follow the column's type (`FILTER_OPS`, shared with the screen), and anything else is a 400 that says what's wrong. "Not equal" keeps NULL rows on a column that can hold them.

### Who can use it

- **`reporting.adhoc`** on the page and the route, which owners and administrators start with and a store can grant in Roles. Its description says it shows customer details. The Reports hub card follows the key, and the Tools card stays for administrators.
- **Cost needs View cost** (`catalog.cost`). Without it, cost columns and totals are gone from the screen and the route (`entityFor`), and no filter or group touches cost.
- **Export needs Export data** (`reporting.export`). The button runs the query again with `export: true`, so the route can refuse it and write `DATA_EXPORTED` to the audit trail: which entity and how many rows, not what was searched for.
- **Just looking isn't recorded.** `lib/requestLog.ts`'s `withLogging` was meant to provide a per-query trail but has no callers (verified 2026-10-15 by `grep -rn withLogging app/src`). A failed query returns a generic 500 and the Prisma error goes to `logError`.

## Categorize Products

Bulk taxonomy assignment for products whose department/category is blank (typical of auto-created products from the POS import).

Flow:

1. List defaults to filter "Uncategorized" department
2. Multi-select rows via checkboxes (with select-all-on-page)
3. `TaxonomyPicker` cascading dropdowns (Vendor → Department → Category → Type)
4. Click Apply → `POST /api/admin/bulk-categorize` updates up to 500 ids per call

The 500-id cap prevents an accidental "categorize the entire catalog" from running. If you genuinely need to bulk-categorize 10K products, slice into 20 batches.

Single-item shortcut: the Detailed Sales drilldown's edit modal has a "Create new product" tab using the same `TaxonomyPicker` — creates `Product` + optional `Upc` + relinks the line item in one action via `POST /api/products/quick-create`. Useful for fixing one-off uncategorized line items mid-report.

## Merge Customers

Manual two-row merge for cases the dedup migrations didn't catch. UI flow:

1. Search for two customer rows
2. Side-by-side comparison: which fields take precedence
3. Submit → move all FK references from `loser → winner`, then delete `loser`
4. Audit log entry stored

The migration-driven dedup (per `docs/domains/import-pipeline.md`) handles bulk patterns. This tool handles the long tail — a real merge of two known-same people the heuristics didn't catch.

## Customer Ledger Backfill

Phase 0.5 tooling. One-time backfill driver that walks historical Payment + SalesOrder + OrderLineItem + Invoice data and reconstructs the `CustomerLedgerEntry` stream + computes `Customer.openArBalance`.

UI shows progress + drift detection.

**Idempotency model** (verified against `lib/customerLedgerBackfill.ts` on 2026-05-20):

- Customer-level skip, not event-level resume. The contract is: "running on a customer who already has ledger entries is a no-op."
- First check per customer: if ANY `CustomerLedgerEntry` rows exist for that customer, result is `"skipped-already-backfilled"` and nothing changes.
- A partial-failure mid-customer leaves zero entries for that customer (the writes happen as one `createMany` per customer). Re-running picks the customer up fresh, not from the failing event.
- Bypasses the forward-flow `appendEntry()` (which would do query + insert + update per row) — instead computes the full chronological run in JS and writes via `createMany`. Trades the per-row safety net for speed.

Reconciles ledger total against `paymentService.computeBalance` per customer at the end. Drifted customers are TAGGED in the result, not auto-corrected. Per the file's own contract comment: "neither side is the unconditional truth — the POS has produced wrong numbers before."

See `docs/domains/accounting.md` for the AR ledger architecture.

## Import shortcuts

`/tools/import/*` — manual one-off triggers for individual import runners (sales, customers, payments, etc.). Most operators don't need these — the cron-driven auto-import handles daily refresh per `docs/domains/import-pipeline.md`.

Use when:

- A specific report needs to re-run mid-day (e.g., a corrected CSV was re-emailed)
- Debugging an import issue — manual trigger gives immediate feedback
- Backfilling historical data from a one-off CSV file

## Home Accessory Order Import (2026-07-22)

Ported from the predecessor ERP's `pages/tools/home-accessory-order.tsx` and adapted to write into holt's own Buyer Drafts pipeline instead of downloading the POS CSVs — holt is its own system of record (see `docs/domains/buyer-drafts.md`), unlike the predecessor, where the POS is the system of record.

**Flow**: upload a home-accessory vendor order file (K&K Interiors, Wendover Art Group, MarketTime/Graf & Lantz, BrandWise/Zodax, Aesthetic Movement, SuperCatSolutions, Simblist Group CSV, or Beatriz Ball) → `POST /api/tools/home-accessory-order/preview` parses it (vendor parsers already live at `lib/pricing/*OrderParser.ts`) → the buyer reviews a one-card-per-item preview (classify department/category per item, optionally split a "Set of N" line into its priced pieces, optionally apply a markup to fill Selling + MSRP) → `POST /api/tools/home-accessory-order/commit` creates the rows.

**Output mapping** (the adaptation): the composed rows group by their effective order reference — one `BuyerDraftPurchaseOrder` per distinct reference, so a vendor bundle carrying several orders (a K&K PDF can hold two) creates several draft POs in one commit ("multi-PO bundles"). Every composed row becomes exactly one `BuyerDraftItem` regardless of PO assignment; a row the buyer takes "off PO" (already ordered elsewhere) still gets created, just with `draftPoId: null`. Field mapping and the full rationale live in `lib/homeAccessoryBuyerDraftMapping.ts`. `BuyerDraftItem.source` is stamped `HOME_ACCESSORY_ORDER_IMPORT` (migration `20260722134701_home_accessory_order_source`, additive `ALTER TYPE ... ADD VALUE`).

**Dropped relative to the predecessor** (see `lib/homeAccessoryRows.ts` header comment): the POS catalog-match / "adopt the catalog's existing split" flow has no holt analog — buyer drafts are pre-catalog negotiation records, not reconciled against `Product` rows at import time (a buyer who wants to link a draft to an existing catalog Product already has the barcode-lookup quick-add flow, `lib/buyerDraftFromProduct.ts`, for that). The Oversell field is also dropped — no `BuyerDraftItem` column for it.

**Files**: `lib/homeAccessoryOrders.ts` (vendor registry + normalizers + split-cost math), `lib/homeAccessoryRows.ts` (row composition + split-set grouping), `lib/homeAccessoryBuyerDraftMapping.ts` (the buyer-drafts field mapping), `pages/api/tools/home-accessory-order/{preview,commit}.ts`, `app/(dashboard)/app/tools/home-accessory-order/{page.tsx,HomeAccessoryOrderView.tsx}`.

## Verification checklist (before touching tools code)

- [ ] Query Builder: any new ENTITY added to the config has its columns AND joins explicitly allowlisted, and states who counts in its totals. `__tests__/queryBuilderConfig.test.ts` checks every name against the schema
- [ ] Categorize: 500-id cap stays in place
- [ ] Merge: audit log entry written for every merge (forensics)
- [ ] Auth: `reporting.adhoc` on Query Builder; `roles: ["ADMIN"]` on Merge + Ledger Backfill; SUPER_ADMIN auto-passes via the auto-promotion-over-ADMIN mechanism (see `docs/domains/staff-auth.md`)

## Test coverage

| Surface                             | Coverage                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Query Builder allowlist enforcement | `__tests__/queryBuilderQuery.test.ts` — filters and joins outside the entity's config are refused |
| Query Builder config vs the schema  | `__tests__/queryBuilderConfig.test.ts` — every name exists, cost flagged both ways, status lists match their enums, NULL flags both ways |
| Query Builder totals                | `__tests__/queryBuilderSummary.test.ts`; which rows count, who may see what, every entity against a real database: `__tests__/integration/queryBuilder.integration.test.ts` |
| Bulk categorize 500-cap             | None                                                                              |
| Merge audit trail                   | None                                                                              |
| `csvExport.ts`                      | Unit tests for the formatter                                                      |

## Known gaps

- No saved-query feature in Query Builder — every session rebuilds filters from scratch
- Exported CSV cells aren't protected against spreadsheet formulas. That's every export using `lib/csvExport.ts`, not just this one
- No undo on merge — destructive operation with no rollback
- Categorize doesn't support multi-category (a product is single-dept-single-category by schema; some real items legitimately span categories)

---

Last verified: 2026-11-07 (Query Builder); 2026-05-20 (the rest)
