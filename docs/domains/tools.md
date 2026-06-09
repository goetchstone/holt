# Admin Tools

Power-user surfaces under `/tools/*` and `/admin/tools/*`. Mostly ADMIN-only or SUPER_ADMIN-only. These are deliberately not surfaced on hub pages — direct URL access.

## Tool inventory

| Tool | Path | Role gate | Purpose |
|---|---|---|---|
| Query Builder | `/tools/query-builder` | **ADMIN only** | Build allowlisted SQL queries via UI, export CSV |
| Categorize Products | `/admin/tools/categorize-products` | ADMIN | Multi-select products → bulk-assign vendor/dept/category/type |
| Merge Customers | `/admin/tools/merge-customers` | ADMIN | Manual merge of two customer rows (post-import cleanup) |
| Customer Ledger Backfill | `/admin/tools/customer-ledger-backfill` | ADMIN | Phase 0.5 ledger backfill driver |
| Configurator | `/tools/configurator` | DESIGNER+ | Retail-only product configurator (Wesley Hall SE, grade pricing) |
| Create Project | `/tools/create-project` | DESIGNER+ | Generate a Google Drive project folder from a customer |
| Import shortcuts | `/tools/import/*` | ADMIN | Manual triggers for individual the POS import runners |

The designer-facing tools (Configurator, Create Project) are role-gated separately and are NOT the focus of this runbook — they're covered by their respective domain runbooks (`pricing-catalog.md` for Configurator, `staff-auth.md` for permissions).

## Query Builder — `lib/queryBuilderConfig.ts`

The big-ticket admin tool. Lets the owner build read-only SQL queries against a curated list of models without writing raw SQL. CSV-exportable.

### Allowlist-driven

`queryBuilderConfig.ts` exports `ENTITIES: EntityDef[]` — every entity is explicitly allowlisted. Adding a new model means:

1. Add an entry to `ENTITIES`
2. List the columns the UI is allowed to expose (`columns: ColumnDef[]`)
3. List the joins (`joins: JoinDef[]`) — also allowlisted
4. List filterable fields (`filters: FilterOption[]`)

**Never** wire the UI to read arbitrary Prisma fields — every exposed surface is intentional. The allowlist is the security model.

### Column types

| Type | Behavior |
|---|---|
| `string` | LIKE filter, contains-text |
| `number` | =, >, <, between |
| `decimal` | Same as number but rendered with currency formatting |
| `date` | Date range picker |
| `boolean` | Yes/no toggle |

### Output

Server-side query → JSON response → client renders as a paginated table → "Export CSV" button uses `lib/csvExport.ts` to emit the current filtered/sorted view.

### Auth boundary

Hard-gated `roles: ["ADMIN"]` on every endpoint AND on the page itself. Query Builder is the closest thing to direct DB access we expose. Audit trail: every query run is logged via `lib/requestLog.ts`.

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

## Verification checklist (before touching tools code)

- [ ] Query Builder: any new ENTITY added to the config has its columns AND joins explicitly allowlisted
- [ ] Categorize: 500-id cap stays in place
- [ ] Merge: audit log entry written for every merge (forensics)
- [ ] Auth: `roles: ["ADMIN"]` on Query Builder + Merge + Ledger Backfill; SUPER_ADMIN auto-passes via PR #308 promotion

## Test coverage

| Surface | Coverage |
|---|---|
| Query Builder allowlist enforcement | Unit tests TBD — **gap**, would assert the runtime query rejects unlisted columns |
| Bulk categorize 500-cap | None |
| Merge audit trail | None |
| `csvExport.ts` | Unit tests for the formatter |

## Known gaps

- No saved-query feature in Query Builder — every session rebuilds filters from scratch
- No undo on merge — destructive operation with no rollback
- Categorize doesn't support multi-category (a product is single-dept-single-category by schema; some real items legitimately span categories)

---
Last verified: 2026-05-20
