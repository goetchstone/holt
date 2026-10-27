# Inventory & Warehouse

Stock positions, physical counts, reconciliation, transfers, warehouse dashboards. The receiving side of inventory (POs, expected dates) is in `docs/domains/purchasing.md`; the consignment-specific side is in `docs/domains/consignment.md`.

## Models

| Model | Purpose |
|---|---|
| `Product` | Catalog item (vendor + part number + name) |
| `ProductVariant` | Size/color/finish for flat-priced vendors |
| `Upc` | UPC/barcode → Product link (one product can have many barcodes) |
| `StockLocation` | Physical floor location (Main Showroom front, West Showroom warehouse, etc.) — has `name` + `code` + `locationAliases` array, plus `holdsCommittedStock` (stock here is on hand but already sold — see "Two signals" below) |
| `InventoryPosition` | On-hand quantity per place: (product, store, stock location, owning order or free). Written **only** by `lib/inventory/ledger.ts` — see "One writer" below. The Stock-by-Item import still sets imported places' totals daily. |
| `InventorySnapshot` | The expected on-hand baseline a physical count is measured against. Transient working table — regenerated per count, and cleared by `clear-snapshot` (scoped by `source`). Identity is holt's own `productId` + `storeLocationId`, not a POS id — see "Inventory snapshot generation" below. |
| `PhysicalInventoryCount` | Per-scan log during a physical count event |
| `Reconciliation` | Variance reconciliation record (resolved discrepancy after a physical count) |
| `UnidentifiedScan` | Photo of an item that scanned to nothing during a count |
| `InventoryTransfer` | Operational inter-store transfer (no JE impact — see `docs/domains/accounting.md`) |

## Allocation: how selling decrements stock

Until 2026-08, **nothing decremented on-hand for a sale**. Every writer of
`InventoryPosition` either added stock (import, PO receiving, returns) or moved
it sideways (transfers, manual edits). A store could sell the same sofa five
times and the floor still said one.

The schema was already built for the fix and nobody had used it:
`InventoryPosition.salesOrderId` is nullable with a unique key including it —
that shape only makes sense as **allocate-then-consume**.

| Operation | When | Effect |
|---|---|---|
| `allocate` | sale | commits free stock to the order, splitting a position if the sale takes part of it |
| `release`  | cancel, line edit | returns committed stock to free, **merging** into the existing free row |
| `consume`  | fulfilment / delivery | deletes the committed rows — the goods left the building |
| `availableQuantity` | display | free stock only |

All in `lib/inventory/allocation.ts`; wiring lives in
`lib/inventory/orderInventorySync.ts`. Every function takes the caller's
transaction client and runs inside it — allocation that is not atomic with the
order write commits stock to an order that failed to save.

### Two signals for "spoken for", honoured not unified

- `salesOrderId` set — committed by a **native** holt sale.
- `StockLocation.holdsCommittedStock` — the stock is physically here but
  already sold. Set per location by an admin (Warehouse → Locations → edit a
  stock location), or derived by an import adapter from its source's own
  convention.

Free stock requires *neither*, and a sellable place. `buyersReport.ts` splits
floor from `Cust Stock` with `freePositionSql()`, the SQL twin of the
allocator's predicate, so the two can't drift: stock committed by a native sale
counts as the customer's, and quarantine or transit stock as neither.

**This was a hardcoded string until 2026-08.** Both `allocation.ts` and
`buyersReport.ts` tested `StockLocation.name ILIKE 'customer%'` — an
one deployment's naming convention living in shared inventory code, so any
deployment that named its holding locations differently silently counted
committed stock as available to sell. Migration
`20260806163000_stock_location_holds_committed_stock` added the flag and
backfilled it from exactly that string test, which is the whole equivalence
guarantee: an existing Ordorite-fed database classifies every position the
same after the migration as before it. The prefix itself now lives in
`ordoriteHoldsCommittedStock()` in `lib/adapters/ordorite/shared.ts`, applied
wherever that adapter creates a stock location — one adapter's fact about its
source, not a product assumption (CLAUDE.md rule 61/62).

Free stock is one predicate, `freePositionWhere()` in `lib/inventory/allocation.ts`
(and `freePositionSql()`, its raw-SQL twin for reports): not committed to an
order (`salesOrderId: null`), not in a flagged place, and in a place whose type
is sellable (`lib/inventory/locationTypes.ts`). Every position has a place
(`stockLocationId` is NOT NULL since 2026-10-16), so there is no "no place"
branch for a reader to forget. Callers spread `freePositionWhere()` into a
larger clause or nest it under `AND`.

### Every unit has a place (since 2026-10-16)

A place's type comes from one catalog, `lib/inventory/locationTypes.ts`:

| Type | Sellable | For |
|---|---|---|
| `FLOOR` | yes | the sales floor |
| `STOCK` | yes | a stock room or warehouse bay |
| `RECEIVING` | yes | arrived, not yet put away |
| `STAGING` | no | picked and waiting to load |
| `QUARANTINE` | no | damaged, an incomplete set, a return awaiting inspection |
| `TRANSIT` | no | on its way between sites |
| `GROUP` | — | a building or a floor: holds places, never stock |

Owned is not sellable: quarantine and transit stock is counted and valued, but
not offered for sale or allocated. The stock-location routes and the preset
refuse a type that is not in the catalog.

A caller that names a store but no place in it (a receipt with no destination,
a transfer to "the store", an admin entry, a restock) gets the store's
**receiving place**: `StoreLocation.defaultReceivingStockLocationId`, or a place
coded `RECEIVING` that `lib/inventory/places.ts` creates and points the setting
at the first time the store needs one. `postMovement` refuses a place that
belongs to a different store. The database refuses a position with no place
(`NOT NULL`) or with nothing in it (`InventoryPosition_quantity_positive`, a
CHECK mirrored in `prisma/testing/db-guards.sql`). A stock location that stock
has moved through cannot be deleted, only deactivated, since the journal keeps
its history.

Migration `20261016120000_stock_places_and_journal` moved any place-less rows to
their store's receiving place, merged rows that then shared a place, and removed
rows holding zero or less. Measured on a restored copy first (rules 41, 59):
22,165 rows, none place-less; 2,843 negative rows (−6,514 units) and 5 zero rows,
all written before the single writer. The POS import already reads a negative
on-hand as zero, so removing them leaves each place where the import would put
it. After the migration: 19,317 rows holding 43,146 units, the sum of the
positive rows before it.

### Places contain places

A store's places form a tree through `StockLocation.parentId`: North Barn ›
Floor 2 › Stock Sofas › Shelf 3 are all places, nested as deep as a store
wants, and a small store stays flat. A `GROUP` place (a building, a floor)
holds only places. `postMovement` refuses stock into one, and a place still
holding stock cannot become one.

Every writer of a place applies the same rules through
`lib/inventory/placeTree.ts` (rule 42): the stock-location routes and the
stock-locations preset. A parent is an active place at the same store. A place
is never inside itself, however deep the loop. A place still holding stock, or
one a store lands stock in (its receiving, returns or other landing place),
never becomes a group, and no landing place can point at a group. A place with
active places inside it stays active, and one with any places inside it is not
deleted (the database's `ON DELETE RESTRICT` backs the route). A place left
inside an inactive one (a preset can drop a group that a hand-made place sits
in) shows, and exports, at the top of its store. Warehouse › Locations shows each store's
places as a tree and sets a place's parent with "Inside". The preset says it
with `inside` (`docs/domains/config-presets.md`). Totals for a building, a
floor or a store are the sum of everything inside it (`descendantIds`).

Migration `20261018120000_places_contain_places` retired the free-text
`building`, `floor` and `area` columns. Each building at a store became a GROUP
place coded `BLDG-<name>`. Each floor became a GROUP place coded
`FLR-[<building>-]<n>` and named "<building> Floor <n>", inside its building.
Every place went inside its floor, else its building. `area` was an index within
a floor that every place's code already carried, so it was not kept. The
migration refuses to finish if any place that had a building or a floor would
end up in no group. Measured on a restored copy first (rule 41): 60 places, 42
with a building across 3 buildings, 54 with a floor. After it: 13 GROUP places
(8 of them floors inside a building), 54 of the 60 places inside a group, and
stock unchanged at 19,317 rows and 43,146 units.

**Stock and space** (Reports › Stock and Space, `lib/reports/stockBy.ts`) reads
this tree; see `docs/domains/reporting.md`.

### Overselling is allowed, deliberately

If a cashier scans it, it sells — mis-tagged, mis-counted, floor model, special
order. `allocate` commits what exists, returns the shortfall, and never throws.
The discrepancy becomes **back-office work**, not a checkout interruption:
shortfalls land in `InventoryException` (Admin → Inventory Exceptions) with
order, product, store, requested, allocated and shortfall, resolvable once
handled.

**Made-to-order lines never allocate.** `CONFIGURED` and `CUSTOM` cart lines
mint a brand-new `Product` during the sale, so they have no `InventoryPosition`
by construction. Allocating them would post a full-shortfall exception on every
custom order — for a furniture retailer, a large share of them — and a queue
full of the normal case is a queue nobody reads. The filter is per-line, so a
mixed cart still reports its stocked lines.

### One writer (since 2026-10-14)

`lib/inventory/ledger.ts` is the only code that writes `InventoryPosition`.
Every stock change is one primitive — **N units of one product move from a
place to a place** — where a place is (store, stock location, owner) and either
side may be outside Holt's books (supplier, customer, write-off):

| Function | Does |
|---|---|
| `postMovement` | Takes the units from exactly the `from` place (oldest row first, refusing with `InsufficientStockError` and writing nothing if it holds fewer) and adds them to the `to` place, merging into its existing row. Never goes negative. |
| `drawLegs` | Plans "take N from wherever this `where` matches" without writing; the caller posts one movement per leg. |
| `setPlaceQuantity` | Makes one place hold exactly N, as a movement of the difference. For the POS import and admin edits, which state on-hand. |
| `dropEmptyRow` | Removes a row holding zero or less (old data). Refuses a row that still holds units. |

`allocate`/`release`/`consume` are compositions of these (allocation is a
movement that changes the owner, not the place). Every write takes a
transaction-scoped advisory lock on the product before reading the balance it
changes, so two registers cannot both sell the last unit. Locks are held until
commit, so **a transaction that touches several products must lock all of them
once, up front, with `lockProducts`** (which sorts them) before moving any stock
— a flow that locked 9 now and 2 later could deadlock with one locking 2 then 9.
Allocation, release and consume do this for their own lines; flows that combine
them or touch several products (order resync, PO receipt, each POS-import batch)
lock their whole set first. The root Prisma client is told apart from a
transaction client by `$disconnect`: on Prisma 7 a transaction client also has
`$transaction`, which would open a nested savepoint.

**Why.** Nine files used to write the table, each with its own arithmetic. The
unique key `[productId, storeLocationId, stockLocationId, salesOrderId]` holds two
nullable columns and Postgres treats NULLs as distinct in a unique index unless
declared `NULLS NOT DISTINCT` (it was not), so it never prevented duplicate free
rows, and four routes upserted through it — PO receive, return restock,
transfer cancel, admin position create. Those upserts never matched a free row,
so every call created another duplicate (CLAUDE.md rule 64). Migration
`20261014120000_inventory_position_single_writer` merged the existing duplicates
(summed into each place's oldest row, lossless) and dropped the key, so an
upsert through it no longer compiles.

**The gate.** `__tests__/stockWriterTripwire.test.ts` fails if any file under
`src/`, `prisma/seed/` or `scripts/` writes the table outside `ledger.ts`, and
also if its manifest names a file that no longer writes it (rule 65). Tests
put fixture stock in place through `__tests__/helpers/stock.ts`, so it has a
journal row behind it like any other stock.

### The journal (since 2026-10-16)

Every movement `postMovement` makes is also a `StockMovement` row, written in
the same transaction: product, quantity, the place it came from and the place it
went to (a side with no store is outside the books), why (`MOVEMENT_REASONS` in
`ledger.ts`: `OPENING`, `RECEIVE`, `ALLOCATE`, `RELEASE`, `DELIVER`, `RETURN`,
`TRANSFER`, `ADJUST`, `IMPORT_SYNC`), the document that moved it
(`sourceType` and `sourceId`), who, and when. Every caller must name a reason; the compiler
enforces it.

- **Append-only.** A trigger (`stock_movement_append_only`) refuses UPDATE and
  DELETE. A correction is a new movement. CHECKs require a positive quantity, at
  least one side in the books, and each side a whole place.
- **Opening balance.** The migration wrote one `OPENING` movement per existing
  position, so the journal sums to the balance from its first day.
- **The check.** `ledgerDrift(db)` lists every place where the balance is not
  what moved in minus what moved out. It is the instrument that can disagree:
  a write that skipped the ledger, or a lost journal row, shows up there.
  `jest.integration.afterEach.ts` runs it after **every** integration test, so a
  code path that changes stock without the journal fails whichever suite
  exercises it.
- **Order ids are facts, not keys.** `fromSalesOrderId`/`toSalesOrderId` are plain
  ids: an order can be deleted (its stock is released first) and the journal
  keeps that the stock was once committed to it.

### The register reads free stock

The register's "on hand here" asks `/api/warehouse/positions` for the product's
free positions (`freeOnly`) and folds them by store with `onHandByStore`
(`lib/inventory/onHandSummary.ts`). It used to read `storeLocation.name`, which
the route does not send, so every line said nothing was on hand, and it asked for
all stock, committed included. `InventoryPositionsView.tsx` is an admin audit
table and still reads the raw rows on purpose.

## Stock-by-Item import (daily)

CSV: `<Org>_Stock_by_Item.csv` from the POS (Gmail auto-import, e.g. 06:10 local). Runner: `runStockByItemImport` in `lib/adapters/ordorite/runners.ts`. One row per (product, POS location) with current on-hand qty. On a live site this is a one-time opening load (DECISIONS #18).

**The location-matching gotcha** (post-failure 2026-04-24):

the POS emits `Stocklocation` as a free-text string per row. The import matches it against `StockLocation.locationAliases` only (case-insensitive, exact — no fuzzy match, and not the place's name). Historically, unmatched rows were silently dropped, causing the Buyers Report to understate on-hand by several units when an alias was missing.

Since 2026-04-24:

- **Unmatched rows land at a catch-all** — `StockLocation.code = "UNMATCHED"`, name "Unmatched — Needs Review", at the store `AppSettings.unmatchedStockStoreLocationId` names (Settings > Configuration). The POS names are kept in `InventoryPosition.notes`. **With no store set, unmatched rows are reported (`unmatchedRowsNotWritten`, and the result message says so) and not written** (rule 63); this replaced a store found by the name "Warehouse", then any active store (rule 61). Migration `20261017120000_document_stock_flows` set the setting from the store already holding the catch-all place.
- **Known the POS placeholders** like `Z_TEMP_MISS_INV` also route here.
- **Result surfaces `unmappedLocations`** array. Admin should add aliases (or create the proper StockLocation) so future imports land correctly.

**Rule for any new inventory-bearing import**: never silently drop a row with an unmappable location. Always route to the catch-all and surface the unmapped name to the admin.

**How it writes (since 2026-10-17, a ledger client):** the runner resolves each row's product and place, then applies the whole file at once (`lib/inventory/importSync.ts`):

- `planImportSync` (pure) makes one **physical** target per place: rows landing on one place are **summed** (two aliases of one place, several unmatched names at the catch-all), each row clamped at zero first (`negativeClampedToZero`); a **zero row zeroes** its place; and a product the file no longer lists at a place it **covers** (any row resolved there) is set to zero. Places the file does not mention are untouched.
- `applyImportSync` writes it through `setPlaceQuantity` (`IMPORT_SYNC`), a hundred products per transaction under their locks, setting **free** stock to physical minus what is committed to orders at that place. A commitment survives the file; where the file says fewer than are committed, free goes to zero and the place is counted in `shortOfCommitted`. A second run of the same file changes nothing (`positionsUpserted` counts only places that changed).

## Inventory snapshot generation (Step 1 of a physical count)

`InventorySnapshot` had exactly one writer for most of this domain's history: a CSV importer fed by the POS, keyed on `Product.externalId` and a free-text POS location string. Since `Product.externalId` is nullable, every product created natively in holt (never imported from the POS) was silently absent from its own inventory count — a correctness bug, not a wiring gap, and it went undetected because nothing failed loudly. Migration `20260801170000_inventory_snapshot_local_identity` (2026-08-01) changed `InventorySnapshot`'s identity to holt's own `productId` (FK to `Product`) and `storeLocationId` (FK to `StoreLocation`, the counting grain — matches how counts are actually run, per store rather than per bin). `stockLocationId` is captured too when known, but deliberately excluded from the unique key.

**The migration dropped the table rather than backfilling it** (see the migration's own header comment for the reasoning) — any snapshot that was mid-count when this deployed is gone and **must be regenerated from Physical Inventory Hub, Step 1** before counting resumes.

- **Normal path**: `POST /api/inventory/snapshot/generate` (MANAGER/ADMIN) builds `InventorySnapshot` rows with `source: LOCAL` straight from `InventoryPosition` — the same aggregation `InventoryFreeze` uses (`lib/inventory/snapshot.ts:aggregateCurrentInventory`, shared so the two can never drift on what "current inventory" means). `snapshotDate` is truncated to the start of today, so re-running mid-day (e.g. after fixing a department mapping) replaces today's `LOCAL` rows rather than tripping the `(snapshotDate, productId, storeLocationId)` unique constraint. Wired to the Hub's Step 1 card in `InventoryHubView.tsx`.
- **Cutover/parallel-run path**: `pages/api/import/inventory-snapshot.ts` (POS CSV upload) still exists, demoted to a secondary tool for validating the cutover. Writes `source: IMPORT` rows, resolving POS identifiers to holt's own before writing: `externalId` → `Product.externalId` → `productId`, and the POS `Stocklocation` string → `StockLocation.locationAliases` (case-insensitive, trimmed) → `storeLocationId`/`stockLocationId`. A row that resolves to neither a product nor a location is reported back (count + samples) in the response, never silently dropped — same discipline as the Stock-by-Item catch-all above. Surfaced in the Hub UI under "Migration & Cutover Tools", worded so it isn't mistaken for the normal Step 1.
  - The upload UI (`InventorySnapshotImportView.tsx`) calls `clear-snapshot` with `{ source: "IMPORT" }` first, so it replaces only prior imported rows and a locally generated baseline survives the upload. That makes side-by-side comparison the default: generate `LOCAL`, upload the POS file, and both sets sit in the table at once keyed by `source`.
  - It did NOT start out this way. The clear was unscoped (`deleteMany({})`), so importing a POS file destroyed the local baseline and the count silently reverted to being measured against whatever the POS knew — the exact coupling generating locally was meant to remove. Scoped in `clearSnapshotScope.integration.test.ts`, which asserts each source survives the other's clear.

## Physical count workflow

This is the store-grain count against the POS, kept for the cutover. Holt's own
count is by place: see "The handheld floor" → "Counting" (DECISIONS #21).

1. **Freeze** — `pages/inventory/freeze.tsx` declares a count event for a location. Locks edits while the count runs.
2. **Scan** — barcode scanner posts UPCs to `/api/inventory/physical-count`. Each scan creates a `PhysicalInventoryCount` row. Unidentified UPCs (no `Upc` row, no `Product` match) become `UnidentifiedScan` with an optional photo.
3. **Reconcile** — `pages/inventory/reconcile-photos.tsx` walks each unidentified scan; admin either creates a new Product (with the photo attached) or marks the scan as "not stock" (e.g., display fixture).
4. **Variance report** — `pages/inventory/variance-report.tsx` shows scanned-qty vs expected-qty per product. Admin posts a reconciliation per product (accept count, accept book, or split).
5. **Reconcile a variance** — `pages/api/inventory/reconcile.ts` stamps a `Reconciliation` row per product and place (found, confirmed, or a corrected count). It does not change stock: nothing reads `Reconciliation` back into `InventoryPosition`, and only `lib/inventory/ledger.ts` writes positions. `undo-reconciliation.ts` deletes the row.

Counts are fractional like the balance (`Decimal(12,3)`, since 2026-10-16): a roll of fabric is counted in yards. `PhysicalInventoryCount.quantity` and `Reconciliation`'s expected, counted and variance columns were `Int`, and Prisma truncated silently: a count of 12.5 yards was stored as 12, and two scans of 0.1 and 0.2 as 0 and 0. The sums, the variance and the numbers sent to a screen go through `lib/inventory/storeCount.ts`; a typed count is read with `parseCount` (`lib/inventory/qtyInput.ts`), where zero is a count. Tests: `storeCount.test.ts`, `storeCountFractional.integration.test.ts`.

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
| `warehouse/locations.tsx` | StockLocation admin: rename, add aliases, mark a location as holding committed stock, view position counts |

**Reading stores and stock locations (SEC-15, 2026-09-30).** Three reads, one per need, all returning `{ locations }`:

| Route | Key | Returns | Used by |
|---|---|---|---|
| `GET /api/store-locations` | `staff.self` (everyone) | id, name, code, type, isActive; `?type=` (validated) and `?isActive=` | Home, Admin → Staff, New Quote, Till, POS, Registers, Consignment Receive, Receiving Gaps, Service, New Service Case, New House Call, Till Reconciliation (directly or through `useStoreLocations` / `useActiveStore`) |
| `GET /api/store-locations/stock-locations` | Transfer stock *or* Write purchase orders | each store with its stock locations (id, code, name, type, active) and default receiving location; no aliases, committed flag or addresses | Receive PO, New Transfer, Inventory Positions |
| `GET /api/warehouse/locations` | Set up stores and stock locations, Manage configuration *or* Transfer stock | the full setup records, which the edit forms send back whole | Admin → Setup → Stores, Warehouse → Locations |

**Setting up stores and stock locations** is its own switch, "Set up stores and stock locations" (`inventory.locations.manage`, SEC-15 2026-09-30). It covers:

- creating, editing and deleting a store (`POST /api/warehouse/locations`, `PUT`/`DELETE /api/warehouse/locations/[id]`), which also accept "Manage configuration" because Admin → Setup → Stores is on that key;
- creating a stock location (`POST /api/warehouse/locations/[id]/stock-locations`);
- editing and deleting one (`PUT`/`DELETE /api/warehouse/stock-locations/[id]`), including its "holds committed stock" flag.

Before this key, store writes needed "Transfer stock" **and** a hardcoded MANAGER/ADMIN staff role inside the routes, and stock-location edits needed "Adjust inventory". So whoever the owner let move stock or adjust counts also decided store setup.

- **Defaults:** one switch cannot split the two old audiences, so it starts on for their union, and nobody loses a setup action: SUPER_ADMIN, ADMIN, GENERAL_MANAGER and MANAGER. Migration `20260930120000` grants it to edited and custom roles holding Adjust inventory, or holding Transfer stock with key ADMIN or MANAGER. Some roles gain:
  - SUPER_ADMIN can now set up stores (the old exact MANAGER/ADMIN check refused it);
  - GENERAL_MANAGER, which could edit stock locations, can now also create and edit stores, through the API only, since neither write screen admits it;
  - a custom or edited role holding only Adjust inventory gains store writes;
  - an edited ADMIN/MANAGER holding Transfer stock but not Adjust inventory gains stock-location edits.

  WAREHOUSE staff can still view Warehouse → Locations but not change it; the owner can tick the switch for them in Roles.
- **The screen:** Warehouse → Locations itself is still gated on a MANAGER/ADMIN/WAREHOUSE role list (pending in `pagePermissions.ts`). The switch decides who can **save**; who can **open** that screen moves with the page keys (PERM-01).
- **What it does not cover:** moving stock (Transfer stock); the traffic-counter mapping on a store (a settings preset, `admin.config`); and the UNMATCHED stock location the Ordorite import creates (the import's own key).

## Transfers

`InventoryTransfer` model + `pages/warehouse/transfers/*`. Operational only — no journal entry (per master plan, stores are not separate cost centers in the JE).

Status changes move the stock (`pages/api/warehouse/transfers/[id]/status.ts`, through the ledger):

| Transition | Stock |
|---|---|
| DRAFT → IN_TRANSIT | Takes the units from the source. A chosen stock location gives up its uncommitted units even if it is flagged as holding customers' stock; with none chosen, only genuinely free stock at that store is used. If the source holds fewer, the ship is refused with a 409 naming what is available, and nothing moves. |
| IN_TRANSIT → RECEIVED | Adds the shipped units at the destination as free stock, then (best-effort) commits them to the transfer's order, if it has one. |
| IN_TRANSIT → CANCELLED | Puts the shipped units back at the source. |

Each change claims the transfer inside its transaction (an update conditioned on the status it read), so a double-submitted "Ship" returns 409 instead of taking the units twice. Return status changes are claimed the same way.

Until 2026-10-14 the ship step looked only for a free row at exactly the chosen stock location — none, for "any" — and silently did nothing when it found none. Imported stock always carries a stock location, so the ordinary path shipped nothing and RECEIVED then created the units at the destination: stock appeared from nowhere.

Known limits, tracked in the roadmap below: with no source stock location chosen, a cancel returns units to the store with no stock location rather than to the exact places they left (needs the movement journal, phase 6); and the best-effort commit on RECEIVED cannot actually fail softly, because an error inside a Postgres transaction aborts the whole transaction.

## Variance reports (apparel + general)

- `variance-apparel.tsx` — specific apparel variance (department-filtered). Smaller items, higher count cadence.
- `variance-report.tsx` — general variance across all categories.

Both compare `PhysicalInventoryCount` with `InventorySnapshot` (the expected baseline), per product. Per CLAUDE.md rule 33, cancelled line items must never inflate book qty — handled at the import side.

## On-hand reporting

`api/inventory/onhand-by-department.ts`, `onhand-by-location.ts` and `summary-details.ts` are read-only aggregations behind the Inventory hub's Snapshot vs. Physical Count Summary and its Summary Details page.

- Each returns `{ rows, costVisible }`.
- The cost fields (`expectedCost`, `countedCost`, `varianceCost`) go only to a caller holding "View cost" (`catalog.cost`; see Cost Visibility in `docs/domains/staff-auth.md`).
- Anyone else gets quantities only.

**Inventory Health report** (`/app/reports/inventory-health`, MANAGER+ADMIN) — valuation + dead-stock view. Engine `lib/reports/inventoryHealth.ts` exposes a pure `summarizeInventoryHealth` (testable, no I/O) plus the Prisma loader: on-hand value = units × unit cost, grouped by department/vendor, with a dead-stock band for positions that have on-hand but no sales in the lookback window. Lives under `/reports`, not `/inventory`, but reads the same `InventoryPosition` data. Cost value, dead-stock cost, dead % and uncosted units need View cost; without it the report shows units, retail value and dead units, ordered by retail value (`inventoryHealthForCaller`).

The classic "where's the missing inventory" debugging path:

1. Check `InventoryPosition` for the (product, location) row in question
2. If position looks low, query the most recent `AutoImportLog` row for `<Org>_Stock_by_Item` — see if `unmappedLocations` includes the location's CSV name
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
- [ ] Never write `InventoryPosition` directly: compose `postMovement` / `drawLegs` / `setPlaceQuantity` from `lib/inventory/ledger.ts` (the tripwire will fail otherwise)
- [ ] If touching stock, verify the daily Stock-by-Item import won't trample your change (it sets imported places' totals)
- [ ] Variance reports filter `lineItemStatus != CANCELLED` per CLAUDE.md rule 33

## Test coverage

- `buyersStockSpecialClassifier.integration.test.ts` — real-DB classifier for stock-special items
- `buyersCommittedStockSplit.integration.test.ts` — real-DB floor-vs-customer split, fixtured **inverted** against the retired name heuristic (a flagged "Warehouse B", an unflagged "Customer Overflow")
- `inventoryAllocation.integration.test.ts` — allocate/release/consume lifecycle, including the same inversion for the free-stock predicate and the no-stock-location case
- `stockLedgerWriter.integration.test.ts` — the single writer, against real Postgres: receive, restock, transfer cancel and admin set each leave one row per place (rule 64); a transfer from "any stock location" takes units from where they sit and refuses (409) when short; deleting an order releases its committed stock; a place never goes negative; two concurrent sales of the last unit leave one sale short. Mutation-checked: removing the merge fails 4 cases, removing the product lock fails the race case.
- `stockWriterTripwire.test.ts` — only `ledger.ts` writes `InventoryPosition`; fails both ways (new writer, stale manifest)
- `warehouseQuantities.integration.test.ts` — every response under `warehouse/positions/*` and `warehouse/transfers/*` sends a 12.625 quantity as the number 12.625, not text, through a mock `res.json` that serialises as Next does. Failed 7/7 with `"string"` before the fix.
- `ordoriteShared.test.ts` — `ordoriteHoldsCommittedStock`, the adapter-local name convention
- No dedicated tests for `runStockByItemImport`'s catch-all routing — **gap, worth a tripwire**
- No tests for the reconcile + undo-reconcile round-trip
- `inventorySnapshot.test.ts` — unit tests for `summarizeInventoryAggregate` (the shared freeze/snapshot roll-up)
- `snapshotImport.test.ts` — unit tests for `resolveSnapshotImportRow` (the POS cutover importer's per-row resolution)
- `inventorySnapshotGenerate.integration.test.ts` — real-DB coverage for `POST /api/inventory/snapshot/generate`, including a product with no `externalId` and same-day re-run idempotency
- The handheld floor, phases 15–20: `scanCodes.test.ts`, `labelRender.test.ts`, `boxes.test.ts`, `countDifference.test.ts`, `deliveredLines.test.ts`; real-DB `resolveScan`, `withAction`, `handheldReceive`, `stockCount`, `stockMove`, `stockPick`, `stockDelivery` and `returnPickupStop` (`*.integration.test.ts`)
- The run's truck: `stockTruck.integration.test.ts` (loading boards the bay, a delivery draws from the truck first, a failed stop's units stay aboard until unloaded, completion refused while anything is aboard, another run's truck still to pull)

## Document flows (since 2026-10-17)

Every flow below is a composition of `postMovement`; each has one home in
`lib/inventory/` (rule 42) and a real-DB suite.

**Landing places** (`lib/inventory/places.ts`, catalog `landingPlaces.ts`). Each
store says where stock lands when a flow names no place: receiving, returns,
quarantine, in transit, pickup (`StoreLocation.*StockLocationId`, set in
Warehouse > Locations). The first four are created the first time a store that
has none needs one (codes `RECEIVING`, `RETURNS`, `QUARANTINE`, `TRANSIT`);
pickup has no default and a pull asks for one. A setting must point at a place
in its own store, of a type it allows (`landingPlaceProblem`). The same screen
sets the store an order also draws from and the move mode.

**Transfers** (`lib/inventory/transfers.ts`; `stockTransfer.integration.test.ts`).
Ship moves the units into the source store's transit place: owned, counted, not
for sale. A transfer for an order takes the order's own units first and commits
every unit it ships to the order, so the commitment travels and nothing
re-allocates on arrival (the old best-effort `allocate` on receipt, which could
abort the receipt, is gone). Receipts can be partial (`receivedQuantity`); the
transfer is RECEIVED once all of it has arrived. Cancel sends what is still on
its way back to the exact places it left, from the transfer's journal legs,
newest first. **Move modes** (`lib/inventory/moveModes.ts`): QUICK (one
movement) or TRACKED (a transfer); a place's setting, else its store's, else
QUICK within a store and TRACKED between stores; the stricter end wins. "Move
now" on New Transfer and an admin position move are quick moves and are refused
(409) where the mode is TRACKED. Transfers shipped before transit places existed
are received and cancelled the old way.

**Receiving** (`lib/inventory/receiving.ts`; `stockReceive.integration.test.ts`).
Damaged and Wrong Item go to the store's quarantine place
(`lib/purchasing/receiptConditions.ts`, the one list the screen also reads). A
PO line raised for an open order (its own line, or a PO for the whole order)
arrives committed to the order up to what it still needs; the rest arrives
free. PO status after a receipt is `nativeReceiptStatus`
(`lib/purchasing/receiptStatus.ts`), which leaves zero-quantity lines out of
both counts (rule 39).

**Returns** (`lib/inventory/returnStock.ts`; `stockReturns.integration.test.ts`;
DECISIONS #19). RECEIVED puts the piece in the store's returns place and records
it; the store's returned-stock queue (Warehouse > Returns > Returned stock)
lists every piece waiting to be put back on a sellable place or written off
(`WRITE_OFF`, out of the books). Neither waits on, or changes, the customer's
return. See `docs/domains/returns.md`.

**Pull list** (`lib/fulfilment/pullList.ts`; `pullList.integration.test.ts`).
One builder for delivery-run and per-order pick lists: active lines only (rule
33), what is still to fulfil, from the order's own committed stock at the place
it sits; units already where the order leaves from (its pickup place, or a
STAGING place for a delivery) count as pulled; what it holds none of is a row
with no place; units committed at another store are flagged for a transfer.

**Allocation scope** (`allocationTiers` in `allocation.ts`;
`allocationScope.test.ts`, `allocationScope.integration.test.ts`). A sale draws
back stock in reach -- its own store, then `fulfilmentStoreLocationId` (one hop)
-- before floor models, own store first. A take-with line (marked TAKE, or the
order TAKEN) draws at its own store only, the floor piece first. Delivery
consumes from wherever the units were committed. An order's resync after a line
edit is a per-product delta (`releaseUnits` / allocate the deficit), so a
commitment in transit or staged is never released and lost.

**Oversold** (`lib/reports/oversold.ts`; Reports > Oversold;
`oversoldReport.integration.test.ts`). One open `InventoryException` per order
and product; `settleShortfalls` closes it once the order holds what it needs
(after a sale or resync, a receipt for the order, a transfer arriving for it).
The report groups open shortfalls by product with a suggested fix -- free stock
at another store, units on an open PO (earliest due), or start a draft PO -- and
exports CSV. The warehouse dashboard shows its count and the returned-stock
queue's.

## The handheld floor

Ledger plan phases 15–20 (PR 4). Web pages under `/app/scan` for a scanner
that types what it reads (a Zebra running DataWedge, or any keyboard-wedge
scanner). Each page sits behind the permission of the desk screen that does
the same job, and the API routes under `pages/api/scan/` behind the same
permission. Tested with keyboard-wedge input in a browser. A real Zebra on
HTTPS staging is **unverified** until someone runs it on one (rule 58).

| Page | Permission | Does |
|---|---|---|
| `/app/scan` | signed in | the menu |
| `/app/scan/lookup` | `inventory.read` | what a product is and where it is, or what a place holds; free and committed apart |
| `/app/scan/receive` | `purchasing.receive` | goods in against a PO |
| `/app/scan/count` | `inventory.count` | count a place; posting needs `inventory.adjust` too |
| `/app/scan/move` | `inventory.transfer` | put away and move |
| `/app/scan/pick` | `warehouse.operate` | pick a run to the loading bay, load it onto the run's truck, and unload what came back |

**What a scan is** (`lib/scan/resolveScan.ts`, one resolver for every page
and `GET /api/scan/resolve`). Holt's own labels come first: `L-<placeId>` for
a place and `B-<productId>-<box>-<of>` for one box of a multi-box unit
(`lib/scan/scanCodes.ts`). Then the text as scanned: a UPC, a consignment
rug's barcode, a product number, and last a place's own code at the store the
scanner is working in.

**Done once.** Every handheld write carries an action key the page chose
(`lib/inventory/withAction.ts`). The first request with a key does the work
and stores its answer in `StockAction`; a resend gets that answer back and
moves nothing. Each movement records its key (`StockMovement.actionKey`).

**Labels.** Product, place and box labels render through one function,
`lib/labels/renderTemplate.ts`, whose `LABEL_FIELDS` lists what each label may
use. See `docs/domains/printing.md`.

**Boxes are evidence** (DECISIONS #22). `Product.boxesPerUnit` is the only box
fact stored. A manufacturer's UPC repeats on every box, so a multi-box product
is received by Holt's box labels, printed first, or by "+1 whole". Box scans
are assembled into whole units (`lib/inventory/boxes.ts`). A unit short of
boxes is an **incomplete set**: received as one unit into quarantine
(condition "Incomplete set") with an INCOMPLETE `BoxNote` naming the missing
boxes. When the missing boxes arrive, the unit moves to stock, is committed if
its PO's order still needs it, and the note clears
(`addBoxesToIncompleteSet`). A box moved on its own leaves a STRAY note.

**Counting** (`lib/inventory/count.ts`, DECISIONS #21). A count is of one place
(never a GROUP place).

- **PLACE scope:** everything at the place. A product on the books there but
  not counted is counted absent.
- **PRODUCTS scope:** a quick count, which speaks only for the products listed.

Submitting needs `inventory.count`. Posting changes the books, so it needs
`inventory.adjust`, on the handheld or from Inventory › Counts. Posting moves
the difference as ADJUST movements:

- extra stock is added as free stock;
- a shortfall takes free stock first, then committed units, and those orders
  are resynced;
- box notes the count answers are cleared.

The Oversold report shows, for each short product, the last posted count's
difference at a place holding it ("Last count off by"). That tells a miscount
from an oversale.

**Moving** (`lib/inventory/floorMove.ts`). Quick moves only: free units first,
then committed units, each keeping its order. A move that a place's mode wants
tracked is refused and raised as a transfer instead. A place without a mode
takes the nearest one above it in the place tree, then its store's
(`lib/inventory/moveModes.ts`).

**Picking** (`lib/fulfilment/pick.ts`).

- A pick moves the order's own unit from where the pull list says it is to a
  STAGING place (the loading bay), still committed, and ticks the run's
  printed pick list.
- A multi-box unit is picked only whole.
- A stray box picked with its unit is reunited (its note clears).
- `loadRun` refuses while anything is left to pull. Loading moves the units at
  the loading bay onto the run's truck (below).
- "Transfer it first" on a pull row: a pickup's units must be at its pickup
  store; a delivery's at its order's store or the store that fulfils for it
  (`fulfilmentStoreLocationId`). Once the loading bay is scanned, the pick page
  compares with the bay's store instead.

**The truck** (`lib/fulfilment/truck.ts`, DECISIONS #25). A run's truck is a
place: a TRANSIT place (owned, not for sale) whose `deliveryRunId` names the
run, one per store the run loads at. Holt makes it on the run's first load at
that store, coded `TRUCK-<run number>` and named after the vehicle.

- Loading (`loadRun` on the handheld, or the desk moving the run to LOADED)
  moves every unit the run's orders hold at a STAGING place onto the truck,
  still each order's. A second load moves only what was picked since.
- On the run's pull list its own truck counts as pulled; on an order's pull
  list any truck does. A unit on another run's truck (a stop that could not be
  done, not yet unloaded) is still to pull for this run.
- Back at the site, Pick and load shows what is on the truck, and so does the
  desk's run page (`/app/dispatch/run/[id]`, from the same `aboardLines`). Only
  the handheld unloads: scan a loading bay and unload, and everything aboard
  that was loaded at the bay's store moves there, still each order's
  (`unloadRun`).
- A run is not completed while anything is aboard, and completing it retires
  its truck places (inactive; their journal stays). Warehouse > Locations, the
  landing places, the buyer-draft place list and the stock-locations preset
  export leave run trucks out (`NOT_A_RUN_TRUCK`).

**Delivery** (`lib/fulfilment/stops.ts`, DECISIONS #23).

- The driver says how many of each line went (`lib/fulfilment/deliveredLines.ts`).
- **A part delivery:** what went leaves stock from the run's truck first, then
  a loading bay, then wherever else the order holds it (`consume`'s
  `takeFirst`), and `OrderLineItem.fulfilledQty` goes up. The rest stays
  committed, and a DELIVERY appointment for it goes back in the dispatch pool.
- **The last units are the handover** (`markHandedOver`). It consumes only
  what was still to fulfil: `getActiveOrderLines` returns ordered less
  fulfilled, so a resync never commits stock again for units already gone. A
  delivery's handover draws from the truck first too, so none are left
  reading as aboard.
- **A stop that could not be done** comes off the run. The reason goes on the
  order, and the stock stays committed to it where it is: on the run's truck,
  until the truck is unloaded to a loading bay, where it waits for the order's
  next run.
- **A return pickup** is a stop of its own: see `docs/domains/service-dispatch.md`.

## Roadmap: stock as a ledger of movements

The tracked plan for the rest of the warehouse model (rule 50). Phase 1, the
single writer, shipped 2026-10-14 (#13); phase 2, fractional record columns,
2026-10-15 (#28). Each phase has a named real-DB regression test.

**Delivery: four PRs and one for returns money (planned 2026-10-16).** A CI run
takes 20–30 minutes, so the remaining phases ship as four PRs, not eighteen;
the owner's returns direction of the same day adds 2b, for the money side. Each PR is pushed once,
after the full local gate (`npm run check:local`) passes. Every finding in the
table at the end of this section belongs to one of them:

| PR | Phases | Also closes | Waits for |
|---|---|---|---|
| 1. Stock you can trust | 3, 4 | the register never shows stock; the Buyers report rounds | — |
| 2. Documents move stock correctly | 5–11 | the transfer commit inside the receipt; `parseInt` on new transfers; a zero-quantity line counted as received; the returns UI's restock; `Return.quantity`; cancelled lines on pick lists | 1 |
| 2b. Returns money ✅ built | — | refund to the original method or to store credit, a store-credit tender, restocking fees, and the refund bugs listed in `docs/domains/returns.md` → "Returns money" (closed there; what is left is tracked there) | 2 |
| 3. Places and space | 12–14 | — | 1 (after 2: one test database, rule 59) |
| 4. Handheld floor | 15–20, plus the retry key (`withAction`) phase 4 named, built with the handheld pages that use it | native counts by place, with the store-grain count kept as the cutover tool (DECISIONS #21); the Oversold count flag | 2, 3 |

PR 4's device gate stands. Its pages are tested with keyboard-wedge input in a
browser; a real Zebra on HTTPS staging stays unverified until it is run on one
(rule 58).

**A. Make stock trustworthy**

1. ✅ Single writer (`ledger.ts`), duplicate rows merged, nullable unique key dropped.
2. ✅ Fractional quantity columns: `InventoryException.{requested,allocated,shortfall}`, `InventoryFreeze.totalUnits`, `InventoryFreezeItem.quantity` and `PickListItem.quantity` are `Decimal(12,3)` like the balance (migration `20261015120000_fractional_stock_records`). Exercised first, it was not a crash: the Int columns **truncated silently** — a 4.5-yard oversell recorded as 4 asked, a 37.625-yard freeze as 37, a 12.5-yard pick line as 12. The routes that send these to a screen convert with `toQty` (`pickListForClient` for pick lists), since JSON sends a Decimal as a string. Freeze compare tests equality with `qtyEquals`. Also fixed: the delivery-run pick list wrote 1 on every line (`li.quantity`, a field that does not exist, read through an `any` client); `generatePickList` now takes a typed client and reads `orderedQuantity`. Test: `fractionalStock.integration.test.ts`.
3. ✅ Every unit has a place: `stockLocationId` NOT NULL, a `quantity > 0` CHECK, the location-type catalog (`lib/inventory/locationTypes.ts`), and a receiving place per store for units written with none (`lib/inventory/places.ts`). Preflight counts on a restored copy are under "Every unit has a place" above. The other system places (quarantine, transit) arrive with their flows in phases 6–8. Test: `stockPlaces.integration.test.ts`.
4. ✅ `StockMovement`: an append-only journal written by `postMovement`, with `ledgerDrift()` asserted after every integration test (`jest.integration.afterEach.ts`). The retry key (`withAction`) moves to PR 4 with the handheld pages that use it. Test: `stockJournal.integration.test.ts`.

**B. Fix the document flows**

5. ✅ The POS import as a ledger client (see "Stock-by-Item import"). Tests: `importSync.test.ts`, `stockImportSync.integration.test.ts`.
6. ✅ Transfers through an in-transit place, partial receipts, cancel to the exact places, quick and tracked move modes (scans with PR 4). Test: `stockTransfer.integration.test.ts`.
7. ✅ Receiving: quarantine for damaged and wrong goods; receipts for an order arrive committed. Test: `stockReceive.integration.test.ts`.
8. ✅ Returns into the store's returns place and a per-store returned-stock queue; landing places for every store. Tests: `stockReturns.integration.test.ts`.
9. ✅ One pull-list builder. Test: `pullList.integration.test.ts`.
10. ✅ Allocation scope. Tests: `allocationScope.test.ts`, `allocationScope.integration.test.ts`.
11. ✅ Oversold report (the count-variance flag comes with count by area, PR 4). Test: `oversoldReport.integration.test.ts`.

**C. Places and space**

12. ✅ Places contain places (`parentId`), replacing the free `building`/`floor`/`area` fields (see "Places contain places"). Place labels (`L-<id>`) move to phase 15, where the scanner reads them. Tests: `placeTree.test.ts`, `stockPlaceTree.integration.test.ts`.
13. ✅ Stock and space by any place or product field (Reports › Stock and Space). Tests: `splitSpaceBy.test.ts`, `stockBy.integration.test.ts`.
14. ✅ A declarative stock-location preset: the `stock-locations` kind already existed, and now says where a place is with `inside`. It refuses the retired fields rather than dropping them, and never makes a group of a place holding stock. Tests: `stockLocationsPreset.test.ts`, `stockLocationsPreset.integration.test.ts`.

**D. Handheld floor** (web pages on DataWedge scanners; HTTPS required)

Detail under "The handheld floor" below.

15. ✅ The scanner shell and lookup: `/app/scan`, installable from the browser (`app/manifest.ts`), reading a keyboard-wedge scanner (`useWedgeScan`). One resolver for every scan (`lib/scan/resolveScan.ts`). Lookup by product or place. Place labels (`L-<id>`) printed from Warehouse › Locations. The retry key (`withAction`). Admin › Stock ledger (`ledgerDrift`). Tests: `scanCodes.test.ts`, `labelRender.test.ts`, `resolveScan.integration.test.ts`, `withAction.integration.test.ts`.
16. ✅ Boxes as evidence (DECISIONS #22): `Product.boxesPerUnit`, box labels (`B-<product>-<box>-<of>`), incomplete sets held in quarantine with a `BoxNote`. The desk and the handheld receive through one function, `lib/purchasing/receivePurchaseOrder.ts` (rule 42). Tests: `boxes.test.ts`, `handheldReceive.integration.test.ts`.
17. ✅ Count by place (DECISIONS #21), posted from Inventory › Counts; the Oversold report's count flag. Tests: `countDifference.test.ts`, `stockCount.integration.test.ts`, `oversoldReport.integration.test.ts`.
18. ✅ Put away and move, with stray-box notes; move modes inherited down the place tree. Test: `stockMove.integration.test.ts`.
19. ✅ Pick to the loading bay, tick the run's pick list, load the run. Test: `stockPick.integration.test.ts`.
20. ✅ Part and failed deliveries, and return pickups as run stops (DECISIONS #23). Tests: `deliveredLines.test.ts`, `stockDelivery.integration.test.ts`, `returnPickupStop.integration.test.ts`.

Not built in PR 4, tracked in `ROADMAP.md` → "Handheld floor" (rule 50): an offline outbox and the SCANNED move mode. The store-grain count's whole-number columns were made fractional in #35. The truck place per run was built after it (DECISIONS #25; `stockTruck.integration.test.ts`).

**Found while building phases 1 and 2, scheduled rather than fixed in them** (rule 48):

| Finding | Where | Scheduled |
|---|---|---|
| ✅ A transfer's "best-effort" commit on RECEIVED ran inside the transaction and could abort the receipt. Gone: a transfer for an order carries the commitment the whole way, so nothing re-allocates on arrival | `lib/inventory/transfers.ts` | fixed (PR 2) |
| ✅ Native PO receiving counted a zero-quantity line as fully received, so a PO with nothing received could read RECEIVED_PARTIAL (rule 39). `nativeReceiptStatus` leaves such lines out of both counts | `lib/purchasing/receiptStatus.ts` | fixed (PR 2) |
| ✅ Restocking from the returns screen added no stock while the journal booked it. A return's piece now enters the books when it is RECEIVED and is put back or written off from the store's returned-stock queue | `lib/inventory/returnStock.ts`, `ReturnedStockPanel.tsx` | fixed (PR 2) |
| ✅ Pick-list builders included cancelled and replaced lines (rule 33) and diverged. One builder, the pull list | `lib/fulfilment/pullList.ts` | fixed (PR 2) |
| ✅ `InventoryPosition` and `InventoryTransfer` quantities reached screens as strings: the positions and transfers routes sent the Prisma Decimal as-is, and JSON writes a Decimal as `"12.625"`, so anything summing them with `+` concatenated (`0 + "3"` is `"03"`). All seven responses under these routes now convert with `toQty`. Test: `warehouseQuantities.integration.test.ts`. The register's sum never showed `"03"` on screen because of the next row | `warehouse/positions/*`, `warehouse/transfers/*` | fixed (#29) |
| ✅ The register never showed stock: it read `storeLocation.name`, which `/api/warehouse/positions` does not send, and asked for all stock rather than free stock. It now asks with `freeOnly` and folds by `locationName` (`onHandByStore`). Test: `onHandSummary.test.ts` | `sales/pos/PosView.tsx` | fixed (PR 1) |
| ✅ `Return.quantity` was `Int` read with `parseInt`, so a returned part roll became whole units. Decimal(12,3), parsed with `parseQty`, sent as a number | `Return`, `returns/*` | fixed (PR 2) |
| ✅ `PhysicalInventoryCount.quantity` and `Reconciliation`'s expected/counted/variance columns were `Int`: counting a 12.5-yard roll recorded 12. The native count is by place (phase 17), and this store-grain flow stays as the POS cutover check (DECISIONS #21), so its columns are `Decimal(12,3)` now (migration `20261021120000_store_count_decimal`). Test: `storeCountFractional.integration.test.ts` | `inventory/physical-count.ts`, `inventory/reconcile.ts` | fixed (#35) |
| ✅ A transfer could not be entered as a part roll (`parseInt`); the same on Receive PO and New Return. All three read the quantity as typed and parse with `parseQty` (`lib/inventory/qtyInput.ts`) | `NewTransferView`, `ReceivePOView`, `NewReturnView` | fixed (PR 2) |
| ✅ The Buyers report cast on-hand sums to `bigint`, which rounds: a 12.625-yard roll read 13 and a 0.375-yard remnant read 0. The sums are sent as text now, and floor stock is `freePositionSql()`. Test: `stockPlaces.integration.test.ts` | `lib/reports/buyersReport.ts` | fixed (PR 1) |
| ✅ The New Return screen sent `orderId`; the route reads `salesOrderId`, so every return created from the screen was refused with a 400. Found writing the returns tests; fixed | `NewReturnView.tsx` | fixed (PR 2) |
| ✅ The returns status route was gated on a role list without WAREHOUSE, whose staff work the returns queue; it now takes `sales.return` like the other returns routes | `returns/[id]/status.ts` | fixed (PR 2) |
| ✅ The inventory-exceptions page was gated on `admin.settings` while its API needs `inventory.adjust`; both are `inventory.adjust` now | `admin/inventory-exceptions/page.tsx` | fixed (PR 2) |
| What makes a PO "partially received" differs: native receiving counts any quantity, the POS import a complete line. Owner decision (ROADMAP, "Decisions only you can make" #3); not merged until decided | `lib/purchasing/receiptStatus.ts`, `runners.ts` `classifyPOReceiptStatus` | owner |
| ✅ The Buyers report would have counted a committed receipt twice (ledger and PO chain). Per order and product, the PO-chain half now counts only what the ledger does not already hold as committed | `lib/reports/buyersReport.ts` (query 2) | fixed (PR 2) |

---
Last verified: 2026-10-21
