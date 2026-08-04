# Inventory & Warehouse

Stock positions, physical counts, reconciliation, transfers, warehouse dashboards. The receiving side of inventory (POs, expected dates) is in `docs/domains/purchasing.md`; the consignment-specific side is in `docs/domains/consignment.md`.

## Models

| Model | Purpose |
|---|---|
| `Product` | Catalog item (vendor + part number + name) |
| `ProductVariant` | Size/color/finish for flat-priced vendors |
| `Upc` | UPC/barcode → Product link (one product can have many barcodes) |
| `StockLocation` | Physical floor location (Main Showroom front, West Showroom warehouse, etc.) — has `name` + `code` + `locationAliases` array |
| `InventoryPosition` | One row per (product, location) with on-hand quantity. Daily-overwritten by Stock-by-Item import. |
| `InventorySnapshot` | The expected on-hand baseline a physical count is measured against. Transient working table — regenerated per count, and cleared by `clear-snapshot` (scoped by `source`). Identity is holt's own `productId` + `storeLocationId`, not a POS id — see "Inventory snapshot generation" below. |
| `PhysicalInventoryCount` | Per-scan log during a physical count event |
| `Reconciliation` | Variance reconciliation record (resolved discrepancy after a physical count) |
| `UnidentifiedScan` | Photo of an item that scanned to nothing during a count |
| `InventoryTransfer` | Operational inter-store transfer (no JE impact — see `docs/domains/accounting.md`) |

## Stock-by-Item import (daily)

CSV: `SH_Stock_by_Item.csv` from the POS (Gmail auto-import 06:10 ET). Runner: `runStockByItemImport` in `lib/importRunners.ts`. One row per (product, store location) with current on-hand qty.

**The location-matching gotcha** (post-failure 2026-04-24):

the POS emits `Stocklocation` as a free-text string per row. The import matches against `StockLocation.name` AND `StockLocation.locationAliases` (case-insensitive, exact — no fuzzy match). Historically, unmatched rows were silently dropped, causing the Buyers Report to understate on-hand by 18+ units when an alias was missing.

Since 2026-04-24:

- **Unmatched rows land at a catch-all** — `StockLocation.code = "UNMATCHED"`, name "Unmatched — Needs Review". Original CSV location preserved in `InventoryPosition.notes`.
- **Known the POS placeholders** like `Z_TEMP_MISS_INV` also route here.
- **Result surfaces `unmappedLocations`** array. Admin should add aliases (or create the proper StockLocation) so future imports land correctly.

**Rule for any new inventory-bearing import**: never silently drop a row with an unmappable location. Always route to the catch-all and surface the unmapped name to the admin.

## Inventory snapshot generation (Step 1 of a physical count)

`InventorySnapshot` had exactly one writer for most of this domain's history: a CSV importer fed by the POS, keyed on `Product.externalId` and a free-text POS location string. Since `Product.externalId` is nullable, every product created natively in holt (never imported from the POS) was silently absent from its own inventory count — a correctness bug, not a wiring gap, and it went undetected because nothing failed loudly. Migration `20260801170000_inventory_snapshot_local_identity` (2026-08-01) changed `InventorySnapshot`'s identity to holt's own `productId` (FK to `Product`) and `storeLocationId` (FK to `StoreLocation`, the counting grain — matches how counts are actually run, per store rather than per bin). `stockLocationId` is captured too when known, but deliberately excluded from the unique key.

**The migration dropped the table rather than backfilling it** (see the migration's own header comment for the reasoning) — any snapshot that was mid-count when this deployed is gone and **must be regenerated from Physical Inventory Hub, Step 1** before counting resumes.

- **Normal path**: `POST /api/inventory/snapshot/generate` (MANAGER/ADMIN) builds `InventorySnapshot` rows with `source: LOCAL` straight from `InventoryPosition` — the same aggregation `InventoryFreeze` uses (`lib/inventory/snapshot.ts:aggregateCurrentInventory`, shared so the two can never drift on what "current inventory" means). `snapshotDate` is truncated to the start of today, so re-running mid-day (e.g. after fixing a department mapping) replaces today's `LOCAL` rows rather than tripping the `(snapshotDate, productId, storeLocationId)` unique constraint. Wired to the Hub's Step 1 card in `InventoryHubView.tsx`.
- **Cutover/parallel-run path**: `pages/api/import/inventory-snapshot.ts` (POS CSV upload) still exists, demoted to a secondary tool for validating the cutover. Writes `source: IMPORT` rows, resolving POS identifiers to holt's own before writing: `externalId` → `Product.externalId` → `productId`, and the POS `Stocklocation` string → `StockLocation.locationAliases` (case-insensitive, trimmed) → `storeLocationId`/`stockLocationId`. A row that resolves to neither a product nor a location is reported back (count + samples) in the response, never silently dropped — same discipline as the Stock-by-Item catch-all above. Surfaced in the Hub UI under "Migration & Cutover Tools", worded so it isn't mistaken for the normal Step 1.
  - The upload UI (`InventorySnapshotImportView.tsx`) calls `clear-snapshot` with `{ source: "IMPORT" }` first, so it replaces only prior imported rows and a locally generated baseline survives the upload. That makes side-by-side comparison the default: generate `LOCAL`, upload the POS file, and both sets sit in the table at once keyed by `source`.
  - It did NOT start out this way. The clear was unscoped (`deleteMany({})`), so importing a POS file destroyed the local baseline and the count silently reverted to being measured against whatever the POS knew — the exact coupling generating locally was meant to remove. Scoped in `clearSnapshotScope.integration.test.ts`, which asserts each source survives the other's clear.

## Physical count workflow

1. **Freeze** — `pages/inventory/freeze.tsx` declares a count event for a location. Locks edits while the count runs.
2. **Scan** — barcode scanner posts UPCs to `/api/inventory/physical-count`. Each scan creates a `PhysicalInventoryCount` row. Unidentified UPCs (no `Upc` row, no `Product` match) become `UnidentifiedScan` with an optional photo.
3. **Reconcile** — `pages/inventory/reconcile-photos.tsx` walks each unidentified scan; admin either creates a new Product (with the photo attached) or marks the scan as "not stock" (e.g., display fixture).
4. **Variance report** — `pages/inventory/variance-report.tsx` shows scanned-qty vs expected-qty per product. Admin posts a reconciliation per product (accept count, accept book, or split).
5. **Apply** — `pages/api/inventory/reconcile.ts` writes the accepted qty back to `InventoryPosition` and stamps a `Reconciliation` row for audit. `undo-reconciliation.ts` reverses if needed.

## Warehouse dashboards

Operational views over the same inventory data:

| Page | Purpose |
|---|---|
| `warehouse/overview.tsx` | Per-store on-hand cards (count by department) |
| `warehouse/inbound.tsx` | Month/week drill-down of expected receipts (PO-driven) |
| `warehouse/outbound.tsx` | Pending deliveries, transfers, needs-scheduling buckets |
| `warehouse/awaiting-delivery.tsx` | All ORDER-status orders w/ balance due, age, linked-PO status (see `docs/domains/sales-orders.md`) |
| `warehouse/dispatch.tsx` | Drag-and-drop assignment to delivery runs (see `docs/domains/service-dispatch.md`) |
| `warehouse/returns.tsx` | Pending vendor returns (consignment) and customer-return staging |
| `warehouse/locations.tsx` | StockLocation admin: rename, add aliases, view position counts |

## Transfers

`InventoryTransfer` model + `pages/warehouse/transfers/*`. Operational only — no journal entry (per master plan, stores are not separate cost centers in the JE).

A transfer marks `qtyOut` at source location + `qtyIn` at destination. The next Stock-by-Item import overwrites positions, so transfers are *advisory* — they shape what the warehouse expects to see when the next snapshot lands.

## Variance reports (apparel + general)

- `variance-apparel.tsx` — specific apparel variance (department-filtered). Smaller items, higher count cadence.
- `variance-report.tsx` — general variance across all categories.

Both read from `PhysicalInventoryCount` + `InventoryPosition` and compute scanned vs book delta. Per CLAUDE.md rule 33, cancelled line items must never inflate book qty — handled at the import side.

## On-hand reporting

`api/inventory/onhand-by-department.ts`, `onhand-by-location.ts`, `summary-details.ts` — read-only aggregations used by hub cards and the Buyers Report (`docs/domains/reporting.md`).

**Inventory Health report** (`/app/reports/inventory-health`, MANAGER+ADMIN) — valuation + dead-stock view. Engine `lib/reports/inventoryHealth.ts` exposes a pure `summarizeInventoryHealth` (testable, no I/O) plus the Prisma loader: on-hand value = units × unit cost, grouped by department/vendor, with a dead-stock band for positions that have on-hand but no sales in the lookback window. Lives under `/reports`, not `/inventory`, but reads the same `InventoryPosition` data.

The classic "where's the missing inventory" debugging path:

1. Check `InventoryPosition` for the (product, location) row in question
2. If position looks low, query the most recent `AutoImportLog` row for `SH_Stock_by_Item` — see if `unmappedLocations` includes the location's CSV name
3. If yes → add an alias on the `StockLocation` row, re-trigger the import
4. If no → check `PhysicalInventoryCount` for recent scans that might indicate a manual correction was made

## Cleanup / admin endpoints

- `clear-snapshot.ts` — `POST { source?: "LOCAL" | "IMPORT" }`. Omitting `source` clears everything (the deliberate start-over); passing one clears only that source. An unrecognised value is rejected rather than falling back to a wider delete. Returns the deleted count, and audits as `INVENTORY_SNAPSHOT_CLEAR` — it destroys the baseline a count is judged against.
- `clear-location.ts` — zeroes positions at a location
- `clear-all-data.ts` — wipes count data (NOT positions). Use with backup in hand.

All gated `roles: ["ADMIN"]`. No MANAGER access — variance reconciliation can affect downstream financials.

## Known gaps

- **No real-time reserve** at quote-confirm (master plan G2 / Phase 1). Inventory is only as fresh as the daily Stock-by-Item import.
- **No real-time deduct** at fulfillment for ERP-native orders. Same gap.
- **Cycle counting** beyond apparel — variance report exists but cadence isn't scheduled.
- **Transfer audit** — operational rows exist but no audit trail tying a transfer to a specific physical move.

## Verification checklist (before touching inventory code)

- [ ] Read this runbook + `docs/domains/import-pipeline.md` (Stock-by-Item is the largest daily importer touching this domain)
- [ ] Confirm any new import path routes unmappable locations to the catch-all (NEVER silent-drop)
- [ ] If touching `InventoryPosition` writes, verify the daily Stock-by-Item import won't trample your change (it overwrites)
- [ ] Variance reports filter `lineItemStatus != CANCELLED` per CLAUDE.md rule 33

## Test coverage

- `buyersStockSpecialClassifier.integration.test.ts` — real-DB classifier for stock-special items
- No dedicated tests for `runStockByItemImport`'s catch-all routing — **gap, worth a tripwire**
- No tests for the reconcile + undo-reconcile round-trip
- `inventorySnapshot.test.ts` — unit tests for `summarizeInventoryAggregate` (the shared freeze/snapshot roll-up)
- `snapshotImport.test.ts` — unit tests for `resolveSnapshotImportRow` (the POS cutover importer's per-row resolution)
- `inventorySnapshotGenerate.integration.test.ts` — real-DB coverage for `POST /api/inventory/snapshot/generate`, including a product with no `externalId` and same-day re-run idempotency

---
Last verified: 2026-08-04
