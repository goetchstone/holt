# Buyer Drafts

Pre-the POS item + PO workbench. The buyer (Lisa, primarily) drafts new items + groups them into POs + (now) groups POs into seasonal Buys, all OUTSIDE the POS. When the work is ready, she exports CSVs in the POS-import format. After the POS imports them and the items flow back through the daily Stock-by-Item file, drafts auto-link to the real Product records.

This domain replaces a multi-day workflow that previously lived in Excel + email + paper + the POS re-typing. Each piece below was a real friction the buyer raised. ADMIN-only — designers and managers don't see it.

## Architecture

```
BuyerDraftBuy   (parent — seasonal grouping)
   |
   ├── BuyerDraftPurchaseOrder   (groups items for one supplier order)
   |        |
   |        └── BuyerDraftItem   (the new product being negotiated)
   |
   └── (other POs in the same Buy)
```

Three Prisma models, each with its own page panel and its own modal-driven CRUD.

### Schema (`app/prisma/schema.prisma`)

| Model | Key fields | Status enum |
|---|---|---|
| `BuyerDraftBuy` | `name`, `season`, `year`, `budget Decimal?`, `kickoff DateTime?`, `notes` | `BuyerDraftBuyStatus`: PLANNING / OPEN / EXPORTED / CLOSED |
| `BuyerDraftPurchaseOrder` | `vendorId Int?`, `vendorName`, `referenceNumber`, `expectedShipMonth String?` (`YYYY-MM`), `storeLocationId Int?`, `buyId Int?`, `notes` | `BuyerDraftPoStatus`: DRAFT / READY / EXPORTED / FULFILLED / CANCELLED |
| `BuyerDraftItem` | `partNumber`, `productName`, `cost`, `retail`, `msrp`, dimensions, `itemType` (UPHOLSTERY/CASE_GOODS/OTHER), template-aware fields (grade/fabric/finish/cushions/cleaningCode/tossPillows/hardware/hardwareFinish/options), `description`, `qty`, `stockProgram`, `stockLocationId`, `barcode`, `draftPoId Int?` | `BuyerDraftItemStatus`: DRAFT / READY / EXPORTED / FULFILLED / CANCELLED + `BuyerDraftSource`: MANUAL / HD_PROPOSAL / APPAREL_SCAN / CONFIGURATOR |

All FK relations are `ON DELETE SET NULL` so deleting a parent never cascades through the buyer's work — items stay alive when their PO is deleted, POs stay alive when their Buy is deleted.

### API surface (`app/src/pages/api/admin/buyer-drafts/`)

| Endpoint | Method | Purpose |
|---|---|---|
| `items/index.ts` | GET / POST | List + create items |
| `items/[id].ts` | GET / PATCH / DELETE | Single item CRUD |
| `pos/index.ts` | GET / POST | List + create POs |
| `pos/[id].ts` | GET / PATCH / DELETE | Single PO CRUD |
| `buys/index.ts` | GET / POST | List + create Buys |
| `buys/[id].ts` | GET / PATCH / DELETE | Single Buy CRUD; GET also returns `rollup: { poCount, itemCount, totalSpent }` |
| `lookups.ts` | GET | One-shot for vendors / stockLocations / storeLocations / departments / categories / types / buys (saves the page from 7 parallel calls) |
| `export/items.ts`, `export/pos.ts`, `export/workbook.ts` | GET | CSV for items, CSV for POs, XLSX workbook (multi-sheet) |

All routes wrapped in `requireAuthWithRole(["ADMIN"], handler)`. Body coercion + sparse-patch logic lives in `lib/buyerDraftRequestBody.ts` per CLAUDE.md rule 14 — every PATCH endpoint is a thin Prisma + HTTP wrapper around `buildItemUpdateData` / `buildPoUpdateData` / `buildBuyUpdateData`.

### UI surface (`app/src/pages/admin/buyer-drafts/index.tsx` + components)

| Component | Role |
|---|---|
| `BuyerDraftsPage` (the page itself) | Action bar + filter row + 1fr/320px grid: Items grid + sidebar (Buys panel above Draft POs panel) |
| `DraftItemWizard` | 5-step wizard (Identity → Materials → Pricing → Dimensions → Stocking). Sticky defaults via localStorage. Auto-focuses first input on each step. |
| `VendorStylePickerModal` | Catalog picker (slice 4-lite) — pre-fills wizard from existing VendorStyle (Wesley Hall, CR Laine, etc.) |
| `DraftPoModal` | Create / edit / delete PO. Vendor dropdown (replaces the prior `prompt()`), ETA `<input type="month">`, store, buy, notes |
| `DraftBuyModal` | Create / edit / delete Buy. Mirror of DraftPoModal |
| `DraggableItemCard` / `DroppablePoCard` / `BuyCard` | dnd-kit wrappers |

## The Item type templates

Buyer feedback after slice 4a: *"Here are how we want the descriptions to go"*. Two distinct description shapes by `itemType`:

```
UPHOLSTERY:
  Fabric:           (free text — fabric name + COM)
  Grade:            (number 14-35 or letter C-Z)
  Finish:           (wood / metal finish)
  Cushions:         (down / down-blend / spring-down / etc.)
  Cleaning Code:    (W / S / WS / SW / X / DS — industry standard)
  Dimensions:       (W × D × H, in inches)
  Toss Pillows:     (count + pattern)
  Options:          (trim, build-your-own designators, e.g. "8-way hand-tied")

CASE_GOODS:
  Wood Species:     (oak, walnut, etc.)
  Finish:           (stain code or name)
  Hardware:         (knob/pull style)
  Hardware Finish:  (brass, satin nickel, etc.)
  Dimensions:       (W × D × H, in inches)
```

OTHER skips both templates and lets the buyer fill `description` freely.

### Headerless format (2026-05-09 buyer feedback)

Initial implementation prepended a literal `Upholstery` or `Case Goods` header line. Buyer pushback: *"we don't want the 'Upholstery' on top of the description ok"*. Headers removed in `assembleDescription` / `assembleDescriptionForExport` (`lib/buyerDraftRequestBody.ts`). The `itemType` is still stored in the column — it's no longer LITERALLY echoed as text 1.

### DB-stored vs export

Two assemblers in `lib/buyerDraftRequestBody.ts`:

- `assembleDescription` — comma-joined, fits one DB cell, used for in-page display
- `assembleDescriptionForExport` — newline-joined, used by the CSV/XLSX exporters so the POS renders it with the carriage returns the buyer expects

The textarea input field accepts Enter for natural carriage returns (default HTML behavior — there is NO `onKeyDown` / `preventDefault` interfering). If a future change adds keyboard handlers, preserve the textarea's default Enter behavior.

## Sticky defaults

`hooks/useStickyDraftDefaults` persists vendor, department, category, stocking-program flag, and stock location in localStorage. A buyer batching 30 items from one supplier doesn't re-pick those dropdowns 30 times. Reset is a single click on a "Clear sticky" button in the wizard footer.

## Quick add by barcode (Slice 4.5, 2026-05-12)

"Quick add (barcode)" action-bar button → `BarcodeLookupModal`. The buyer types or scans a UPC, the modal hits `GET /api/admin/buyer-drafts/products/lookup-by-barcode?barcode=X`, and on a hit shows a preview (vendor / name / cost / retail / discontinued flag). "Add to drafts" POSTs a pre-filled body to `/api/admin/buyer-drafts/items` and the new draft appears in the grid.

**Use case**: re-ordering known stock. The buyer scans a UPC from a vendor catalog / a sample tag / an existing inventory label and gets the matching Product's data dropped into a draft without re-typing. They can edit anything in the wizard before/after.

**Pure helper** `lib/buyerDraftFromProduct.ts:buildDraftBodyFromProduct(product)` constructs the create body. 8 A-grade tests pin: identity copy, dimension stringification, null-cost fallback, null-mapPrice fallback, null-dimensions, null-typeId, MANUAL source, audit trail in `notes` field.

**iPad scanner workflow**: `<input inputMode="search" autoFocus>` lets hardware scanners that emit Enter at the end submit the lookup directly. The buyer doesn't have to touch the screen.

**Out of scope for v1**:

- Multi-Product matches (one UPC owns one Product per the unique constraint on `Upc.upc` — so always 1:1)
- VendorStyle templates (slice 4-lite covers that path; this is for concrete Products)
- New / unrecognized barcodes (slice 3 — Apparel scan UI — captures NEW items at vendor showrooms)

## Drag-and-drop assignment (slice 4-po-management, 2026-05-09)

Two drag axes wired through one `<DndContext>` at the page root:

```
item card  →  PO sidebar card    sets BuyerDraftItem.draftPoId
item card  →  "Drop to unassign"  sets BuyerDraftItem.draftPoId = null
PO grip handle  →  Buy card       sets BuyerDraftPurchaseOrder.buyId
PO grip handle  →  "Unassign buy" sets BuyerDraftPurchaseOrder.buyId = null
```

Pure helper `lib/buyerDraftDnd.ts` parses dnd-kit ids of the form `item-<n>` / `po-<n>` / `po-unassigned` / `buy-<n>` / `buy-unassigned` into a typed `DragTarget`. 13 A-grade tests in `__tests__/buyerDraftDnd.test.ts` pin every transition shape and reject path.

### Composition: same id, different hooks

PO cards are BOTH droppable (for items) AND draggable (themselves, to a Buy). Both hooks use `id: po-<n>`. dnd-kit keeps separate registries internally — same id is fine.

### Drag-handle vs whole-card-draggable

Two patterns coexist:

| Card | Drag activation | Why |
|---|---|---|
| ItemCard | Whole card | Simple — just drop on a PO. PointerSensor's `distance: 8` lets short taps on the edit/duplicate/delete buttons through |
| PO card | Dedicated `GripVertical` button | The PO card has more interactive surface (filter button + edit pencil); without a dedicated handle, every tap risks turning into a drag |

If you change one, consider whether the other should match. The user prefers the explicit grip on PO cards but didn't ask for one on item cards — if the buyer reports accidental drags, swap the item card to a grip-only handle.

### Sensor configuration

```ts
PointerSensor: { activationConstraint: { distance: 8 } }
TouchSensor:   { activationConstraint: { delay: 200, tolerance: 5 } }
```

`distance: 8` lets short taps (< 8 pixels of movement) pass through to onClick. `delay: 200` on the touch sensor avoids accidental drags from finger-rest on iPad.

## Buy budget rollup

`buyRollup` memo in the page sums `qty × cost` for items in POs whose `buyId === buy.id`. Computed client-side from the already-loaded items + pos lists — avoids a round trip per Buy. The Buy card renders a progress bar (blue fill, red over-budget, no bar when `budget` is null).

If you add a server-side rollup for performance later, the existing `GET /buys/[id]` endpoint already returns `rollup: { poCount, itemCount, totalSpent }` — just call it for each Buy and replace the client memo.

## Stock locations vs store locations

Two different concepts; both come back from `lookups.ts`:

| Concept | Prisma model | What it represents | Used by |
|---|---|---|---|
| Stock location | `StockLocation` | Warehouse bucket / bin within a store | `BuyerDraftItem.stockLocationId` (where the item will live on receipt) |
| Store location | `StoreLocation` | The actual store (Main Showroom / West Showroom / North Showroom / web sales / B2B) | `BuyerDraftPurchaseOrder.storeLocationId` (where the PO ships to) |

**Don't conflate these.** The lookups endpoint returns both as separate fields. The page state has both; the PO modal uses `storeLocations`, the wizard uses `stockLocations`.

The unmatched-Stock-by-Item catch-all (`StockLocation` with `code: 'UNMATCHED'`) is irrelevant for buyer drafts — drafts haven't hit Stock-by-Item yet.

## Workflow lifecycle

```
DRAFT  →  READY  →  EXPORTED  →  FULFILLED
                                ↘ CANCELLED
```

| Status | Meaning |
|---|---|
| DRAFT | Buyer is still negotiating. Editable, not exported. |
| READY | Buyer marked as good-to-export. Editable, not yet exported. |
| EXPORTED | CSV downloaded; the POS import not yet confirmed. Not editable through the standard CRUD UI. |
| FULFILLED | Stock-by-Item import linked the draft to a real Product. Auto-set by Slice 5 (2026-05-12). |
| CANCELLED | Buyer killed it. Stays for audit. |

### Status drivers — which transitions are auto, which are manual

| Object | Status flow | What drives the flip |
|---|---|---|
| `BuyerDraftBuy` | PLANNING → OPEN → EXPORTED → CLOSED | **Fully manual.** `DraftBuyModal` exposes the status dropdown. |
| `BuyerDraftPurchaseOrder` | DRAFT → READY → EXPORTED → FULFILLED → CANCELLED | **Fully manual.** `DraftPoModal` exposes the status dropdown on edit (added 2026-05-14, PR #268). No auto-driver — slice 5 auto-link only flips ITEM status, not PO. |
| `BuyerDraftItem` | DRAFT → READY → EXPORTED → FULFILLED → CANCELLED | **Mostly manual.** Wizard exposes DRAFT/READY radio on save. Slice 5 (`autoLinkBuyerDrafts` in `importRunners.ts`) automatically flips EXPORTED items to FULFILLED when their barcode appears in the daily Stock-by-Item file. Other transitions (DRAFT/READY → EXPORTED, → CANCELLED) require admin action or a future bulk affordance. |

There is no cascading status mechanic — closing a Buy does NOT flip child POs or items. This is intentional: a buyer might mark a Buy CLOSED while some POs are still in-flight (and should stay EXPORTED until they receive) and others were never executed (and should be CANCELLED). Per-record control is the right granularity.

### Slice 5 — Auto-link via Stock-by-Item (2026-05-12)

Closes the loop. After the buyer downloads the export CSVs and the POS imports them, the resulting Product gets a UPC. When that UPC arrives in the next daily Stock-by-Item file, the post-import sweep (`autoLinkBuyerDrafts` in `lib/importRunners.ts`) finds every EXPORTED draft with a matching `barcode`, sets `fulfilledProductId` + `fulfilledAt`, and flips status to FULFILLED.

**Detection** (pure helper `lib/buyerDraftAutoLink.ts:planAutoLinks`):

- Drafts must have `status = EXPORTED` AND `fulfilledProductId IS NULL` AND non-empty `barcode`
- Match by exact UPC equality against the `Upc` table (one Product can have multiple UPCs; Marjan rugs especially — see CLAUDE.md gotchas)
- Case-sensitive — barcodes are alphanumeric IDs; lowercasing would alias `M1812-91` with `m1812-91` and link to the wrong rug
- Idempotent — already-linked drafts are filtered out by the WHERE clause

**Wire-in**: post-import sweep in `runStockByItemImport`, runs OUTSIDE the per-batch transaction so a single failure doesn't roll back the stock import. The result shape gains an optional `buyerDraftsAutoLinked: number` counter.

**Tests**: 9 A-grade tests in `__tests__/buyerDraftAutoLink.test.ts` covering: single-match, idempotent (already-linked), non-EXPORTED status skips, unmatched, empty-barcode, case-sensitivity, deterministic order, duplicate-UPC edge case.

## Buy performance report (Slice 6, 2026-05-12)

Per-Buy dashboard at `/admin/buyer-drafts/buy/[id]/performance`. Surfaces the question every buyer eventually asks: "did this buy actually sell?" Shows budget vs spent vs revenue vs margin, plus a per-frame breakdown with status hints.

**Why frame-aware**: a draft for `L2272-05SW Grade 13` might end up selling as `L2272-05SW Grade 16` (same frame, different fabric). The buyer's mental model is "did the FRAME sell?" The report rolls up variants via `lib/frameRollup.ts` — strip the last `-`-segment of the SKU, classify the vendor as configurable-frame vs flat, and aggregate sales across all frame mates.

**Side-by-side comparison**: when the buyer opens Spring 2026's performance, the right pane auto-loads Spring 2025 (same `season`, most recent prior `year`). Buyer sees last year's sell-through / dead stock / underbuys next to the current buy's results — informs the next buy's quantities.

**Status hints** (per `lib/buyPerformance.ts:STATUS_THRESHOLDS`):

| Status | Sell-through | Meaning |
|---|---|---|
| `underbuy` | > 100% | Sold more than ordered → scale up next time |
| `healthy` | 60-100% | Solid sell-through → repeat |
| `soft` | < 60% | Below target but not dead → trim quantity |
| `dead` | 0% AND past 60d | Zero sales after the window → skip next time |
| `pending` | 0% but within 60d | Too early to judge |
| `no-link` | — | No draft on this frame got auto-linked via Slice 5 yet |

**Marjan exclusion**: vendor name `Marjan` / `Marjan International Corp` is filtered at the API layer. Marjan consignment has no shared frame stems and a different buying workflow.

**QUOTE exclusion** (bug-fix 2026-05-13): the API filters `salesOrder.status: { in: ["ORDER", "FULFILLED", "RETURNED"] }` so QUOTE-status orders don't inflate the sold count. Matches the canonical `detailed-sales.ts` filter. RETURNED stays in because the POS returns are stored as negative-qty OrderLineItem rows that subtract net-sold correctly. CANCELLED is excluded for both order status and line-item status per CLAUDE.md rule 33. User-reported case that surfaced this: WH-660 reported 31 net-sold for Spring 2026 buy when only 12 were actually sold/ordered/returned — the difference was 19 qty across 10 open quotes.

**Zero-cost fallback** (bug-fix 2026-05-13): some `OrderLineItem.cost` rows are stored as `0` (data-quality issue, not legitimate free items). When `cost` is null / undefined / 0 / negative, the helper falls back to `revenue / 2` (industry-baseline 50% margin) and sets `FramePerformance.hasEstimatedCost = true`. UI marks the margin cell with `(est)`. Once the receiving import populates real vendor costs (Phase 2), the flag clears automatically.

**Stock vs Special split** (Phase 6.3, 2026-05-13): sales are split into two categories based on whether their `productId` matches the buyer's drafted (linked) products on this Buy:

- **Stock sold** = sales of the specific `fulfilledProductId` values the buyer drafted. These came off the planned shelf.
- **Special sold** = sales of OTHER variants of the same frame (customer-spec custom orders). Informational only — doesn't drive status.

Status hints (`underbuy` / `healthy` / `soft` / `dead` / `pending`) compute against **stock S/T** (`qtyStockSold ÷ qtyOrdered`) only. Selling 18 special orders while 4 of your 6 stock units moved is `healthy` — NOT `underbuy`. The status answers "did my stock plan work?" not "is this frame selling at all?"

When `stockProductIds` is omitted (empty set) the helper falls back to all-sales-as-stock for backward compat. The API endpoint builds the set from drafts' `fulfilledProductId` values.

**Pure helper** `lib/buyPerformance.ts:computePerformance(drafts, sales, productToFrame, options)` — 27 A-grade tests. No I/O. The API endpoint hydrates the inputs.

**Sales window (Slice 6.2, 2026-05-12)** — by default, sales attribution is anchored to PO ETA so this buy's frames don't get credit for the PRIOR buy's sales. Resolution order per PO, then MIN across the buy:

1. `BuyerDraftPurchaseOrder.expectedDeliveryDate` (precise) — wins when set
2. `BuyerDraftPurchaseOrder.expectedShipMonth` (`"YYYY-MM"`) → first-of-month
3. Neither set on any PO → fall back to full history with a yellow warning chip in the report header

Pure helper `lib/buyPerformanceWindow.ts:deriveSalesWindow` (15 A-grade tests including parseShipMonth + shiftWindowOneYearBack). API response gains a `salesWindow: { start, end, source, message }` field; UI renders the message as a chip under the buy title.

**Quick add by barcode — qty input (Slice 6.2)** — `BarcodeLookupModal` shows a numeric qty input next to the action buttons once a preview resolves. Defaults to 1; resets on each open; coerced to int >= 1 at submit (empty/garbage falls back to 1). Buyer can scan → bump qty → save in one flow instead of scan-save-edit-save. 44px tap target per iPad rule.

## Buys archive (Slice 6.4, 2026-05-13)

Buyer feedback after weeks of stacking buys side-by-side: *"we need a clean slate once a buy is done but I want to report on it and be able to pull it up. ... maybe some tabs like draft, open, closed?"* The Buys panel is now tabbed by status, and a separate archive page gives a richer table view of closed buys with full rollup.

**Tabs in the Buys panel** — three tabs map the four DB statuses into the buyer's mental model:

| Tab | DB statuses | Behavior |
|---|---|---|
| Draft | PLANNING | Drop targets enabled. The buyer is still building. |
| Open (default) | OPEN + EXPORTED | Drop targets enabled. In-flight work. |
| Closed | CLOSED | Drop targets HIDDEN — closed buys are read-only. Renders a "Full archive report →" link footer. |

Counts render in parentheses next to each tab label when > 0, hidden when 0 so empty buckets stay visually quiet. Default tab = Open (the most-active workspace). Pure helper `tabForBuyStatus` (same file) maps status enum → tab key.

**Auto-tab on deep-link** — when the page mounts with `?buyId=N` and N points at a CLOSED buy, the `BuysPanel` syncs its tab to Closed via a `useEffect` watching `buyFilter` + `buys`. Without this, the buyer would click "Items" on a closed buy in the archive page and land here with the Buys panel still on Open — the selected card wouldn't be visible. Effect handles the OPEN / DRAFT cases identically (any deep-linked buy lands on the matching tab).

**Archive page** — `/admin/buyer-drafts/archive` is the deeper full-page view for CLOSED buys. Lists them grouped by year (year DESC, "Undated" pinned last). Each row shows: name + season, closed-on date (proxy for `updated`), budget, spent rollup, # POs, # items, and two action buttons:

- **Performance** → `/admin/buyer-drafts/buy/{id}/performance` (Slice 6 report)
- **Items** → `/admin/buyer-drafts?buyId={id}` (main page filtered to this Buy with statusFilter widened to ALL + Buys panel tab synced to Closed)

The page is reachable from the "Full archive report →" link inside the Closed tab. The tab itself is the primary "see closed buys at a glance" surface; the archive page is for when the buyer wants the full table with budget and spent columns side-by-side.

**API** — `GET /api/admin/buyer-drafts/buys/archive` returns CLOSED buys with a server-side rollup so the archive page renders without further client-side math. Pre-computes `spent = Σ qty × cost` across every item nested under every PO; `poCount` / `itemCount` from `_count` projections. `closedAt` is `updated.toISOString()` (we don't track a separate transition timestamp — `updated` got bumped to the moment status flipped CLOSED). Sorted `year DESC, updated DESC`. ADMIN-only, GET-only.

**Tests** — `__tests__/integration/buyerDraftBuysArchive.integration.test.ts` (B-grade real-DB) pins: only CLOSED rows returned (active hidden), rollup math (2×$1000 + 1×$500 + 3×$250 = $3250), empty-Buy edge case (spent=0, poCount=0, itemCount=0), ordering (year DESC then updated DESC). Test re-implements the rollup math inline against Prisma since the handler isn't directly callable from integration tests (the `requireAuthWithRole` wrapper) — pragmatic shape per rule 14.

## Linked-Product display fallback (Slice 6.1, 2026-05-12)

Once a draft has `fulfilledProductId` set (via Slice 5 auto-link or a manual override), the buyer wants to see the linked Product's data on the draft card — both for the forward-flow case ("did this draft become the catalog item I planned?") and for the historical/testing case where the draft is a re-creation of an existing Product.

**Fallback rule** (same for every field):

1. If the buyer typed a value on the draft → use it. Their plan is authoritative; the link is for verification/lookup.
2. Else if the linked Product has a value → use it. Catalog fills in the blanks.
3. Else → null/zero.

Whitespace-only draft descriptions count as blank.

**Pure helper** `lib/buyerDraftDisplay.ts:resolveDraftDisplay(draft, linked)` returns `{description, cost, retail, msrp, productWidth, productLength, productHeight, source}`. The `source` record names the origin per field (`"draft"` or `"linked"`) so the UI can render a "from catalog" hint marker. 18 A-grade tests in `__tests__/buyerDraftDisplay.test.ts`.

**Field mapping** (draft ← linked):

| Draft field | Linked Product field | Notes |
|---|---|---|
| `description` | `description` | Whitespace-only on draft falls back |
| `cost` | `baseCost` | Draft `"0"` falls back |
| `retail` | `baseRetail` | Draft `"0"` falls back |
| `msrp` | `mapPrice` | Draft `null`/empty falls back |
| `productWidth` | `width` | Numeric → string via `String(n)` |
| `productLength` | `depth` | Note: linked `depth` maps to draft `productLength` |
| `productHeight` | `height` | |

**API wire-in**: the list endpoint (`pages/api/admin/buyer-drafts/items/index.ts`) includes `fulfilledProduct: { select: { id, productNumber, name, description, baseCost, baseRetail, mapPrice, width, depth, height } }`. The detail/edit views can include the same shape when needed.

**UI**: `ItemCard` in `pages/admin/buyer-drafts/index.tsx` calls `resolveDraftDisplay(draft, item.fulfilledProduct ?? null)` and renders each field with a small "from catalog" hint when `source[field] === "linked"`. A "🔗 Linked to catalog: {productNumber}" anchor jumps to `/products/{id}`.

## Export endpoints — filter semantics (2026-05-14 fix)

The three CSV/XLSX export endpoints share a pure WHERE-builder helper
at `lib/buyerDraftExportFilters.ts` (A-grade unit tested). All three
accept the same query-param shape so the page can pass through the
buyer's current Buy / Status / Vendor filters:

| Param | Meaning |
|---|---|
| `ids=1,2,3` | Limit to specific record ids |
| `status=DRAFT\|READY\|EXPORTED\|FULFILLED\|CANCELLED` | Filter by status |
| `vendorId=N` | Scope to one vendor |
| `buyId=N` | Scope to one Buy (items: via `draftPo.buyId`; POs: direct) |
| `buyId=unassigned` | Items/POs not bucketed into any Buy |
| `dryRun=1` | items / pos only — build the CSV but skip the EXPORTED stamp |

**The legacy READY default fires ONLY on `items.ts` + `pos.ts` AND only when none of `ids`, `buyId`, or `status` are passed.** This preserves the production-handoff flow ("I marked things READY, now export the batch and stamp EXPORTED") without trapping buy-scoped or id-scoped exports inside an empty result.

The `workbook.ts` endpoint never applies a status default — it's a buyer-side review artifact and the buyer expects the whole picture.

**Stamping (items.ts + pos.ts only)** is now scoped to READY rows. DRAFT items pulled into a buy-archival dump pass through to the CSV unchanged; the audit trail (`exportedAt`, `exportBatchId`) still gets stamped on every line item that flows through pos.ts so we can identify which CSV any given line shipped on. POs already in EXPORTED / FULFILLED / CANCELLED are pass-through.

**Origin** (user-reported bug 2026-05-14): clicking Export Items / Export POs against a CLOSED Spring 2026 buy returned an empty CSV. Two reasons: (a) the UI didn't pass any page filters to the export URL, and (b) the endpoint defaulted to `status=READY` on bare GETs, and the buyer's 80 items + 13 POs were all DRAFT. Fix: UI now passes `buyId` / `status` / `vendorId` query params, and the helper drops the READY default whenever the caller is being specific.

## Linked Real POs — empirical productId join (Slice 6.7, 2026-05-14)

Read-only view on the Buy performance page that answers "which real the POS POs cover this Buy?" Joins on `BuyerDraftItem.fulfilledProductId === PurchaseOrderItem.productId` — the link the buyer sets at draft-time via barcode-lookup, catalog picker, or slice 5 auto-link.

**Origin** — user gave 20 real PON numbers for Spring 2026, ad-hoc SQL proved the productId join works empirically: 74 of 80 drafts mapped cleanly, 4 draft POs spanned multiple real PONs (Bradington Young covered PON07054 + PON07576 + PON08313; CR Laine covered four PONs; Essentials two; Wesley Hall two), and one cosmetic vendor-name mismatch surfaced (Gat Creek / Caperton). This view lifts that ad-hoc query into a permanent per-Buy panel.

### Pure helper + API + UI

| File | Role |
|---|---|
| `lib/buyerDraftRealPoLink.ts` | Pure helper `computeLinkedPos` + `detectVendorMismatches`. A-grade, 15 unit tests. |
| `pages/api/admin/buyer-drafts/buys/[id]/linked-pos.ts` | Thin handler. Hydrates inputs from Prisma + calls the helper. ADMIN-only. |
| `pages/admin/buyer-drafts/buy/[id]/performance.tsx` | `LinkedRealPosPanel` component below the per-frame performance grid. |
| `__tests__/integration/buyerDraftLinkedPos.integration.test.ts` | B-grade real-DB. 4 tests pin the hydration shape against Postgres. |

### What it shows

1. **Top-line totals**: drafts in buy, drafts linked to catalog, draft POs, matched real POs, unmatched drafts.
2. **Real POs table**: one row per matched real PO with PON / vendor / order date / status / matched-lines / matched-qty. Sorted vendor → oldest-first within vendor so a multi-PON write-up reads chronologically.
3. **By-draft-PO table**: one row per draft PO listing the PON numbers it covers. This is where 1:N becomes visible — "Draft PO 3 (BY) → PON07054, PON07576, PON08313."
4. **Vendor mismatches**: surfaces draft PO vendor names that don't match the real PO's vendor (case-insensitive, whitespace-trimmed). Cosmetic, not blocking.
5. **Unmatched drafts** (collapsible): drafts with `reason: "no-link"` (fulfilledProductId is null — buyer hasn't picked a catalog Product) OR `reason: "not-on-any-real-po"` (linked, but no real PO line yet).

### What it does NOT do

- **Does not infer matches** when `fulfilledProductId` is null. If the buyer didn't link via barcode-lookup / catalog picker / slice 5, the item shows under unmatched. Predictive matching is fuzzy and rejected per the 2026-05-14 audit.
- **Does not change any data.** Read-only. Same query can be re-run any time; no side effects.
- **Does not require the buyer to set vendor reference numbers** on draft POs. the POS doesn't reliably carry `vendorReference` through anyway (verified empty on every recent Kingsley Bate PO in the 2026-05-13 backup).

### Market-order pattern — season-of-floor, not season-of-order

Important context for reading the linked-POs view: furniture buyers go to market events (High Point April + October, Las Vegas Market) and place stock orders for the **next** selling season. So Spring 2026 buyer-draft items mostly trace back to PONs from October 2025 (the October market write-up) or January-March 2026 (April market + fill-ins). The `BuyerDraftBuy.season` + `year` fields refer to **floor season**, not when the order was placed. A draft labeled "Spring 2026" can legitimately contain items ordered six months earlier.

Implication for slice 6's sales window: anchor to `BuyerDraftPurchaseOrder.expectedShipMonth` / `expectedDeliveryDate`, NOT to the draft's creation date or the linked real PO's `orderDate`. The helper `lib/buyPerformanceWindow.ts:deriveSalesWindow` already does this correctly — verified 2026-05-14 against Spring 2026 data.

### Per-frame sales window (Slice 6.8.1, 2026-05-15)

The buy-wide sales window (Slice 6.2 + 6.8) gives ONE start date for the whole buy: the earliest receivedDate across all the linked real POs. That works for "did this whole buy sell?" but is wrong when frames arrived on staggered dates. A Hooker frame received Oct 2025 has a different "available to sell" anchor than a CRL frame received Feb 2026 — the buy-wide window would let CRL sales from Nov-Jan inflate the CRL frame's qtySold even though the items couldn't have arrived yet.

**Buyer feedback 2026-05-15**: *"the sales should be from when ever the item get received from the PO if possible."*

Fix: per-frame windowing. The helper `computePerformance` now accepts an optional `frameWindowStartByKey: Map<string, Date>`. The caller (API) builds the map from the linked-PO receivings (productId → earliest receivedDate → roll up to frame). A sale is folded into a frame's bucket only if `sale.orderDate >= frameWindowStartByKey.get(frameKey)`. Frames absent from the map fall through (buy-wide SQL window still applies). Sales with `orderDate === null` are excluded conservatively when their frame is in the map.

Backward compat: when `frameWindowStartByKey` is undefined the helper behaves exactly as before. Existing tests + integration tests still pass without modification.

7 A-grade tests in `__tests__/buyPerformance.test.ts` cover: in-window, before-window, exactly-AT boundary (>= inclusive), null orderDate, multiple frames different anchors, frame absent from map (fall-through), undefined map (backward-compat).

### Why we didn't auto-link draft PO to real PO directly (no schema change)

Considered: a `BuyerDraftPurchaseOrder.linkedPurchaseOrderIds Int[]` field plus an auto-link rule. **Decided against**:

1. **the POS doesn't ship split-parentage.** When a partial-receive splits into a remainder PO, the fresh PON has no `parentPoId` reference. Same-vendor sibling POs within 7 days are the norm (10-12 routinely for active vendors like Kingsley Bate) — inference from item-set overlap is noisy.
2. **The empirical productId join already answers the question.** No persistent link needed; the view recomputes on every page load against current data. Cheap (a few hundred rows scanned per buy) and always-fresh.
3. **1:N is first-class without a schema change.** One draft PO can span N real PONs; one real PON can cover lines from multiple draft POs. Both directions fall out of the empirical join naturally.

If a future workflow asks "which specific real PON covered this draft PO line?" or "track receiving variance against the draft" — that's when a persistent link with line-level granularity becomes worth it. For now: read-only view, no schema cost.

## Historical PO import (Slice 6.13, 2026-05-22)

The forward flow (buyer drafts items → exports CSV → the POS imports → Slice 5 auto-links the draft to a real Product → Slice 6.7 finds the real PO via the empirical productId join → Slice 6 performance report renders) is designed for new buys going forward. To test the reports against HISTORICAL buys without re-typing every item, the buyer needs a way to bag existing real PurchaseOrders into a BuyerDraftBuy and let the existing reports light up automatically.

**Origin** — user direction 2026-05-22: *"I think if we has a way to group specific purchase orders from the system into a 'buy' and report on it ... we should be able to use the same model as the drafts ... a po can only belong to one buy generally ... we should be able to make it all work as that was the original idea."*

### Architecture

One small schema addition + a search/import flow that creates draft graph rows pointing at real catalog data:

| Surface | What |
|---|---|
| Schema | `BuyerDraftPurchaseOrder.importedFromPurchaseOrderId Int? @unique` — FK to `PurchaseOrder`. `@unique` enforces the "one buy per PO" rule structurally. `ON DELETE SET NULL` so killing the real PO doesn't cascade through buyer work. |
| Schema | `BuyerDraftSource.HISTORICAL_PO_IMPORT` — fifth enum value, stamped on every item created by this flow so it's visually distinguishable from MANUAL drafts. |
| Helper | `lib/historicalPoImport.ts:buildImportFromPurchaseOrder(po)` — pure, returns `{ draftPo, draftItems, skipped }`. 15 A-grade tests cover field copy, partNo / productName fallbacks, retail fallback to unitCost when product.baseRetail is null, qty truncation for fractional fabric yardage, qty clamp to 1 for zero/negative orderedQty, expectedShipMonth derivation order (estimatedShipDate → expectedDelivery → orderDate), notes concatenation when the real PO has notes, empty-lineItems edge case, all-skipped edge case. |
| API | `GET /api/admin/buyer-drafts/search-purchase-orders?q&startDate&endDate` — ADMIN-only. Searches by PON prefix/contains or vendor-name contains, plus optional orderDate range. Excludes CANCELLED. Caps at 50 results. Returns each row with `alreadyImported: { draftPoId, buyId, buyName } \| null` flagged via the `buyerDraftImport` back-relation so the UI can show "Already in <Buy>" without a separate lookup. |
| API | `POST /api/admin/buyer-drafts/import-purchase-order` body `{ buyId, purchaseOrderId }` — ADMIN-only. Pre-checks idempotency (single indexed `findUnique` on the unique FK), refuses CANCELLED POs, runs a single transaction that creates the draft PO + every draft item. Returns `{ draftPoId, buyId, buyName, itemsImported, skipped }`. The 409 response on duplicate import carries `alreadyImported: { draftPoId, buyId, buyName }` so the modal can give a useful message. **Skipped reasons**: `no-product-link` (PurchaseOrderItem.productId is NULL), `zero-quantity` (CLAUDE.md rule 31 — orderedQuantity = 0 means the POS cancelled the line, e.g. partial-receive remainder; importing as qty=1 would inflate "qty ordered" in the Slice 6 report). |
| API | `GET /api/admin/buyer-drafts/find-sibling-pos?purchaseOrderId=N` — ADMIN-only. Surfaces sibling PONs the buyer should ALSO import after a successful import. Use case: the POS's partial-receive workflow creates a NEW PO for the un-received remainder with no parent reference. Endpoint pulls same-vendor + ± 90-day POs with partNo overlap, scores them via `lib/historicalPoSiblings.ts:scoreSiblings`, returns top 10 ranked by `overlapCount DESC, fullyContainedBySource DESC, orderDate ASC`. Excludes the source itself + candidates already imported into any buy. |
| UI | `HistoricalPoImportModal` (`components/admin/buyer-drafts/HistoricalPoImportModal.tsx`) — Headless UI Dialog with search box (PON or vendor, 2+ chars), optional date range, result table with "Import" / "In <Buy>" per row, confirm dialog before commit, success toast. After import, a "Likely sibling POs" panel appears with one-click import buttons for the suggestions returned by `find-sibling-pos`. Importing a sibling auto-fetches THAT sibling's suggestions (chains a 3-way split case naturally). |
| UI | `BuyCard` (in `pages/admin/buyer-drafts/index.tsx`) gains an "Import historical PO" action next to "View performance →". Page-level modal state so a single modal instance handles every Buy. |
| Tests | A-grade pure helpers: 17 tests in `__tests__/historicalPoImport.test.ts` (`buildImportFromPurchaseOrder` + qty=0 / negative-qty / NaN-qty skip per rule 31) + 12 tests in `__tests__/historicalPoSiblings.test.ts` (`scoreSiblings` — self-exclude, already-imported skip, zero-overlap skip, fully-contained flag, sort order, partial-receive remainder shape). Source-text tripwires: 16 tests in `__tests__/historicalPoImport.tripwire.test.ts` covering ADMIN-gating, idempotency pre-check, CANCELLED refusal, transaction wrap, HISTORICAL_PO_IMPORT source stamp, FULFILLED status stamp, qty=0 skip pattern, siblings API vendor+date window, siblings helper zero-overlap drop + sort. Real-DB integration: 3 tests in `__tests__/integration/historicalPoImport.integration.test.ts` covering happy-path create chain, @unique FK rejection on second import, idempotency findUnique pattern. |
| Migration | `20260522c_buyer_drafts_historical_po_import` — adds the column, the unique constraint, the FK, and the enum value. Idempotent (`IF NOT EXISTS` on the column + `ADD VALUE IF NOT EXISTS` on the enum + existence guards on the constraint/FK). |

### Why a stored FK here when Slice 6.7 rejected one

Slice 6.7's decision (runbook lines 385-393) was about the FORWARD direction (1 draft → N real POs, where the POS's split-receive churn makes a stored multi-FK unreliable). The historical-import direction is structurally different:

- **1:1 by construction** — one real PO → one draft PO created in one shot by the import flow. No churn, no inference.
- **No partial-receive split risk** — the real PO is whatever it is at import time; we're not predicting future receives, we're recording what already happened.
- **Idempotency wants an indexed lookup** — without the unique FK, "is this PON already imported?" becomes an item-set overlap heuristic (look for items with fulfilledProductId in {PO's productIds} grouped by draftPoId; flag candidates where the overlap ratio exceeds some threshold). That's the kind of fuzzy match 6.7 correctly rejected for the forward direction. For 1:1 historical imports, a single `findUnique` is dramatically simpler and exact.

Forward-flow drafts still use the empirical productId join via Slice 6.7. The two coexist: a draft PO can have `importedFromPurchaseOrderId` set OR be null + auto-linked via 6.7. The Slice 6 performance report doesn't care which path produced the draft — it reads `fulfilledProductId` on items either way.

### Forward-flow auto-link (Slice 6.14, 2026-05-22)

**The piece the owner imagined from day one.** When the POS's nightly import brings in a real PO that the buyer drafted + exported, the draft PO auto-attaches via the `BuyerDraftPoRealPoLink` join table — no more clicking through the historical-PO-import modal for forward-flow buys.

**Schema**: `BuyerDraftPoRealPoLink { id, draftPoId, realPoId @unique, linkSource enum, audit }`. Replaces the Slice 6.13 1:1 `importedFromPurchaseOrderId @unique` FK. Migration `20260522e_buyer_draft_po_real_po_link` converts existing 1:1 rows to join-table rows + drops the old column. `linkSource` enum: `AUTO` (forward-flow sweep), `MANUAL` (operator-set), `HISTORICAL_IMPORT` (Slice 6.13 modal). Each real PO still attaches to at most one draft PO globally (the `@unique` constraint moved to `realPoId` on the join table); but each draft PO can have N real POs linked — covers partial-receive splits where the POS creates a new PON for the remainder (Slice 6.15 future work will surface that case explicitly).

**Auto-link logic** lives in `lib/buyerDraftPoAutoLink.ts:planPoAutoLinks`:

1. Skip real POs that already have a link (`buyerDraftLink: null` filter at the DB).
2. Match candidates by `vendorId` then by item-overlap (partNo set ∪ fulfilledProductId set).
3. Score = overlap ratio against the REAL PO's signals. Default threshold = **60%** (constant `DEFAULT_MATCH_THRESHOLD`).
4. If exactly one candidate clears threshold → propose link. If multiple → log + skip (operator handles manually). If zero → skip.

**Wire-in** in `runPurchaseOrdersImport`: after the per-batch insert AND after `autoFulfillBuyerDraftPos` (so newly-RECEIVED draft POs that just hit FULFILLED don't also get auto-linked to themselves). Result counter `buyerDraftPoAutoLinked` surfaces the run count.

**Manual override endpoint** `POST /api/admin/buyer-drafts/draft-pos/[id]/link-real-po` body `{ realPoId }` — attaches a specific real PON to a draft PO when the auto-link doesn't fire (ambiguous candidates, vendor typo, or the operator just knows better). 409 if the real PO is already linked elsewhere; 200 (idempotent) if it's already linked to THIS draft PO.

**Slice 6.13 path stays available**: when the buyer wants to bag *historical* PONs that were never drafted (Christmas 2025 reconstruction), the modal still creates new draft POs + writes the link with `linkSource = HISTORICAL_IMPORT`. The forward-flow auto-link and the historical-import modal both use the same join table.

**Test coverage**: 19 A-grade tests on `planPoAutoLinks` (vendor mismatch, threshold boundary, no-signal skip, ambiguous skip, custom threshold, single-real-many-drafts, fulfilledProductId-only match, dedupe semantics, realistic batch shape). 3 source-text tripwires on `runPurchaseOrdersImport`. Integration test in `__tests__/integration/historicalPoImport.integration.test.ts` exercises the new join-table create path.

### Linked-PO scoping (Slice 6.13.1, 2026-05-22 — tightening after the Spring 2026 audit)

The forward-flow empirical productId join, by itself, gave the Spring 2026 buy a Linked Real POs panel of **54 PONs** spanning 2025-01 through 2026-05. Root cause: stocking SKUs (Bradington Young deep-seating recurring items, CR Laine standing-order pieces) have continuous PO history across years, and the productId match treats every one of those PONs as relevant. The buyer's mental model is "Spring 2026 = the October 2025 market writeup"; the algorithm has no way to know that without an explicit signal.

Two improvements layered on the empirical join:

1. **Cutoff tightened from −12 months to −3 months (in two passes).** `computeBuyLinkCutoff` already accepts a `monthsBefore` parameter. Both the `linked-pos` and `performance` endpoints now pass `3` instead of the default `12`. For a buy with earliest draft `expectedShipMonth` = 2026-01, the cutoff moves from 2025-01-01 → 2025-10-01. Owner expectation 2026-05-22: *"For a Spring buy (Jan-Apr ETAs) I wouldn't expect anything older than October 2025."* October-market writeups (typically placed ~3 months before the earliest January ETA) still pass; prior-summer stocking POs no longer surface. Buys with unusually long lead times (custom furniture, long-lead-time vendors) override via the Slice 6.13 explicit-import path.
2. **Explicit-import precedence (Slice 6.13).** When the buy has any `BuyerDraftPurchaseOrder.importedFromPurchaseOrderId IS NOT NULL`, those PONs are AUTHORITATIVE — the empirical join is skipped entirely. The Linked Real POs panel shows exactly the buyer's selected set. The performance report's qtyReceived + sales-window math anchors to receivings on ONLY those PONs.

Implementation lives in `lib/buyerDraftRealPoLink.ts:computeLinkedPos` (new optional `LinkedPosScope` parameter — `explicitRealPoIds` wins, `windowStart` falls through). Both endpoints query `importedFromPurchaseOrderId` on the buy's draft POs and pass the resulting Set when non-empty. 6 new A-grade tests in `__tests__/buyerDraftRealPoLink.test.ts:scope filtering` pin: no-scope all-time behavior, windowStart filter, null-orderDate defensive keep, explicit set overrides window, empty explicit set falls through to window, unmatchedDrafts respect the scope.

**Operator recipe for fixing an already-drafted Buy whose panel looks noisy**:

1. Apply migration `20260522c_buyer_drafts_historical_po_import` if not yet on prod.
2. On the BuyCard, click "Import historical PO."
3. Search by vendor + appropriate date window. Pick the real PON(s) that ACTUALLY are this buy.
4. Each click creates a new `BuyerDraftPurchaseOrder` with `importedFromPurchaseOrderId` set.
5. The Linked Real POs panel + performance report immediately switch to the authoritative set.

**Risk noted**: a Buy that already has forward-flow drafts AND gets explicit Slice 6.13 imports will see the budget rollup count BOTH sets of draft items. To avoid double-counting, either delete the forward-flow drafts (`status=CANCELLED` or hard-delete) OR don't mix the paths on the same Buy. A future safeguard could refuse Slice 6.13 imports when the buy already has overlapping `fulfilledProductId` drafts — tracked as a followup, not yet shipped.

### Field mapping

`PurchaseOrder` + `PurchaseOrderItem` → `BuyerDraftPurchaseOrder` + `BuyerDraftItem`:

| Target field | Source |
|---|---|
| `BuyerDraftPurchaseOrder.vendorId / vendorName` | `PurchaseOrder.vendorId` / `vendor.name` |
| `BuyerDraftPurchaseOrder.referenceNumber` | `PurchaseOrder.poNumber` (the real PON) |
| `BuyerDraftPurchaseOrder.expectedShipMonth` | first-of-month UTC from `estimatedShipDate` → `expectedDelivery` → `orderDate` |
| `BuyerDraftPurchaseOrder.expectedDeliveryDate` | `PurchaseOrder.expectedDelivery` |
| `BuyerDraftPurchaseOrder.status` | `FULFILLED` (the items already exist; the buyer never needs to "promote" this draft to a real PO — the real PO is what we imported FROM) |
| `BuyerDraftPurchaseOrder.importedFromPurchaseOrderId` | `PurchaseOrder.id` |
| `BuyerDraftPurchaseOrder.notes` | "Imported from PON {poNumber}..." + the real PO's notes if any |
| `BuyerDraftItem.partNumber` | `PurchaseOrderItem.partNo` ?? `product.productNumber` |
| `BuyerDraftItem.productName` | `PurchaseOrderItem.productName` ?? `product.name` |
| `BuyerDraftItem.cost` | `PurchaseOrderItem.unitCost` |
| `BuyerDraftItem.retail` | `product.baseRetail` ?? `unitCost` (avoids divide-by-zero in margin math; Slice 6.1 display fallback still surfaces catalog values when the draft is blank, but items have non-nullable Decimal columns — must seed SOMETHING) |
| `BuyerDraftItem.qty` | `PurchaseOrderItem.orderedQuantity`, truncated to int, clamped to >= 1 |
| `BuyerDraftItem.fulfilledProductId` | `PurchaseOrderItem.productId` (the entire reason this flow exists — Slice 6 / 6.7 / 6.8.1 reports all key off this) |
| `BuyerDraftItem.fulfilledAt` | `PurchaseOrder.orderDate` (best-available proxy for "when the buyer committed") |
| `BuyerDraftItem.status` | `FULFILLED` |
| `BuyerDraftItem.source` | `HISTORICAL_PO_IMPORT` |

### Skipped line items

`PurchaseOrderItem.productId IS NULL` happens when the POS's products import auto-created a PurchaseOrderItem without an existing matching Product (covered by `findProduct` in `lib/importHelpers.ts`). Without `productId`, Slice 6 / 6.7 reports can't roll up sales — there's no productId to join against `OrderLineItem.productId`. So the helper SKIPS these line items + reports them in `skipped: [{ purchaseOrderItemId, reason: "no-product-link", partNo }]`. The handler surfaces the count in the response so the modal can toast "imported N items (M skipped — no Product link)." Operator can fix the linkage via the Categorize Products admin tool, but the draft graph for this PO doesn't get re-imported (the @unique FK blocks the second attempt) — known gap.

### Edge cases handled

- **CANCELLED real POs** — refused by the handler with a 400; surfaced in search results pre-filtered.
- **Fractional `orderedQuantity`** (fabric yardage, etc.) — truncated to int in the draft `qty`.
- **Zero or negative `orderedQuantity`** — clamped to 1 so the draft has a sane non-zero quantity.
- **Missing `partNo`** on the line — falls back to `product.productNumber`.
- **Missing `productName`** on the line — falls back to `product.name`.
- **Real PO has `notes`** — appended after the "Imported from PON…" header so the buyer sees both.

### What this enables

The owner's stated use case (verbatim, 2026-05-22): *"what we are looking for is to see sell thru dead stock, budgeting for future buys etc etc."* All three are existing Slice 6 capabilities:

- **Sell-through %** — `qtyStockSold / qtyOrdered` per frame, status hints (`underbuy` / `healthy` / `soft` / `dead` / `pending`)
- **Dead stock** — frames with `status: "dead"` (0 sales after 60d) called out distinctly in the performance grid
- **Future-buy budgeting** — side-by-side comparison with prior-year same-season, plus the linked-POs panel showing actual receivings

Now they run against historical data too. Open `/admin/buyer-drafts`, create or pick a Buy ("Christmas 2025"), click "Import historical PO" on the Buy card, search for PONs from that season, click Import on each. Then click "View performance →" on the Buy card and the report runs.

## XLSX workbook export

`export/workbook.ts` produces a multi-sheet Excel file matching what the buyer used to keep in her own OTB workbook:

| Sheet | Source | Purpose |
|---|---|---|
| `TOTAL` | items × ship-month pivot | One row per vendor, columns are ship months (default Jan-Dec + Unscheduled) — the buyer's monthly cost forecast |
| `<Vendor name>` (one per supplier) | items in that supplier's bucket | Buyer's full row-per-item view: Item# / Item Name / Description / Qty / Cost / Total Cost / MSRP / Retail / Total Retail / SKU# / PON / Stocking |
| `Buys` (slice 4-buys, 2026-05-09) | buys + items rolled up | One row per Buy: name / season / year / status / budget / spent / remaining / over flag / # POs / # items. Plus a synthetic `(Unassigned)` row for items not bucketed into any Buy. Plus a TOTAL row. Skipped if no buys exist. |

**Per-vendor sheet columns** (`VENDOR_SHEET_HEADERS`, 2026-05-13): `Item# / Item Name / Description / Barcode / Qty / Cost / Total Cost / MSRP / Retail / Total Retail / SKU# / PON / Stocking`. Barcode column shows the scanned UPC for items added via the barcode-lookup quick-add modal. SKU# shows the linked catalog Product's productNumber (distinct from the buyer's `partNumber` which may diverge). Description falls back to the linked Product's description when the draft itself has none — same Slice 6.1 precedence as the card view.

**Pivot column matching** (2026-05-13): the TOTAL pivot's column headers are long English month names (`"January"`, `"February"`, …). Items' `expectedShipMonth` (stored as `YYYY-MM` canonical or `MM-YYYY` legacy) is mapped to the matching month-name key via `expectedShipMonthToMonthName`. Unparseable strings (e.g. legacy free-text "March", which the strict parser rejects) and null values land under `"Unscheduled"`.
| `Floor Plan` | items grouped by store + vignette | Per-vignette layout for showroom planning |

Pure assembler `lib/buyerDraftWorkbook.ts` builds row arrays; the API endpoint just calls SheetJS `XLSX.utils.aoa_to_sheet` per sheet. Tests pin the assembler shape; the SheetJS call itself is mechanical.

The API endpoint is responsible for hydrating raw data — including loading buys via `prisma.buyerDraftBuy.findMany` and threading `draftPo.buy.name` into each `WorkbookItem.buyName` — so the helper stays pure.

## Test grading

| File | Grade | Notes |
|---|---|---|
| `buyerDraftRequestBody.test.ts` | A | Pure body-coercion + assembleDescription tests. 163 tests covering every branch. |
| `buyerDraftWorkbook.test.ts` | A | Pure workbook assembler tests. |
| `buyerDraftDnd.test.ts` | A | parseDragIds — every transition + reject path. 13 tests. |
| `buyerDraftDisplay.test.ts` | A | resolveDraftDisplay fallback rules — description, cost/retail, msrp, dimensions, source attribution. 18 tests. |
| `buyPerformanceWindow.test.ts` | A | deriveSalesWindow + parseShipMonth + shiftWindowOneYearBack — full date/format permutations. 15 tests. |
| `buyerDraftValidation.test.ts` | A | isCompatiblePoForItem cross-vendor drop guard. 6 tests. |
| `buyerDraftCrossVendorGuard.integration.test.ts` | B | helper against hydrated Prisma rows. 3 tests. |
| `buyerDraftAutoLink.test.ts` | A | planAutoLinks pure logic — 9 tests covering match, no-match, idempotent, status filter, case sensitivity, empty barcode. |
| `buyerDraftAutoLink.integration.test.ts` | B | (2026-05-14) real-DB sweep verifying the Prisma WHERE + UPC join + per-row update writes work end-to-end. 4 tests covering happy-path, multi-UPC Product (Marjan rugs), non-EXPORTED status skip, already-linked idempotency. |
| `buyerDraftAutoFulfillPo.test.ts` | A | planAutoFulfill pure logic — 9 tests covering DRAFT/READY/EXPORTED eligibility, FULFILLED/CANCELLED skip, unlinked-items tolerance, partial-match skip. |
| `buyerDraftAutoFulfillPo.integration.test.ts` | B | (2026-05-14) real-DB sweep verifying the join through PurchaseOrderItem → PurchaseOrder.status IN ('RECEIVED_FULL', 'RECEIVED_PARTIAL') + updateMany writes. 4 tests covering happy-path, RECEIVED_PARTIAL counts, mixed-state skip, idempotent. |
| `buyerDraftRealPoLink.test.ts` | A | computeLinkedPos pure helper. 15 tests covering 1:1, 1:N, partial coverage, no-link, not-on-any-real-po, sort + dedup. |
| `buyerDraftLinkedPos.integration.test.ts` | B | real-DB version of the linked-POs hydration. 4 tests. |
| `frameSalesHistory.test.ts` | A | computeFrameSalesHistory + trailingWindowStart. 9 tests covering empty input, multi-line aggregation, distinct-order dedup, RETURNED netting, float rounding, year underflow, immutability. |
| `BuyerDraftsPage` (page-level) | (none) | UI integration test infrastructure doesn't exist yet. Phase 0.6 testing roadmap covers this. |
| `DraftItemWizard` / `DraftPoModal` / `DraftBuyModal` | (none) | Same as above. |

The page-level test gap is what causes the local Sonar gate's `new_coverage` to land in the 50-60% range whenever this domain ships work — the React component lines never get instrumented. Acknowledged trade-off; covered under Phase 0.6 in `~/.claude/plans/check-the-repo-familiarize-lovely-leaf.md`.

## Roadmap (active slices, oldest first)

| Slice | What | Status |
|---|---|---|
| 4a | Structured fields + dept/cat enforcement + buyer XLSX workbook | Shipped (PR #236) |
| 4b | Wizard + sticky defaults + carriage-return preview | Shipped (PR #237) |
| 4-lite | VendorStyle catalog picker | Shipped (PR #237) |
| 4-buys | Buys parent table + ETA in PO sidebar | Shipped (PR #238) |
| 4-po-management | Edit / delete / drag-drop on PO + Buy | Shipped |
| 4.5 | Barcode lookup of existing Products into a draft | Shipped (PR #248) |
| 5 | Auto-link draft items to real Products via Stock-by-Item reimport | Shipped (PR #247) |
| 6 | Buy performance + compare-to-last-buy report | Shipped (PR #250) |
| 6.1 | Linked-Product display fallback on draft cards | Shipped (PR #251) |
| 6.2 | Sales-window anchored to PO ETA + qty input on barcode modal | Shipped |
| 6.3 | Stock vs Special split on performance report | Shipped (PR #263) |
| 6.4 | Buys archive — clean slate planning + historical drill-down | Shipped (PR #266) |
| 6.5 | PO status dropdown on edit modal (was a gap in 4-po-management) | Shipped (PR #268) |
| 6.6 | Export endpoints respect Buy/Status/Vendor filters; READY default scoped | Shipped (PR #269) |
| 6.7 | Linked Real POs panel on performance page — empirical productId join | Shipped (PR #270) |
| 6.8 | qtyReceived per frame + sales window anchors to actualReceivedDate | Shipped (PR #271) |
| 6.8a | Receipts + window scoped to linked real POs only (no all-time bleed) | Shipped (PR #272) |
| 6.8.1 | **Per-frame sales window** — each frame's sales counted from ITS own first receivedDate, not the buy-wide minimum | In flight (this PR) |
| 6.9 | Draft POs panel default visibility follows the buy filter | Shipped (PR #271) |
| 6.10 | Auto-flip draft PO to FULFILLED when every linked product is RECEIVED_FULL/PARTIAL | Shipped (PR #271) |
| 6.11 | Per-frame margin split: stock vs special-order | Shipped (PR #271) |
| 6.12 | Trailing 12-month frame sales surfaced in BarcodeLookupModal preview | Shipped (PR #271) |
| 6.13 | Historical PO import — bulk-import an existing real PurchaseOrder into a Buy so Slice 6 reports run against past buys | Shipped (2026-05-22) |
| 5.5 | Optional receiving UI (manual override of auto-link) | Pending |

## Verification checklist (before shipping a buyer-drafts PR)

- [ ] `npm run validate && npm test` (unit project) green
- [ ] If schema changed: migration applied to dev DB, `BuyerDraftBuy` (and any new model) added to `lib/testing/withTestDb.ts` ALL_TABLES list
- [ ] If a new field on Item/PO/Buy: extend the matching `BuilderBody` interface + `build*Data` helper + tests in `buyerDraftRequestBody.test.ts`
- [ ] If a new modal field: confirm both create + edit paths handle it (sparse-patch contract on PATCH)
- [ ] Description format unchanged unless explicit user request — don't re-add the `Upholstery` / `Case Goods` headers
- [ ] Sonar gate result documented in PR body (rule 48). `new_coverage` RED is acceptable if it's the page-level gap; if it's RED for a different reason (a NEW pure helper without tests), fix before shipping
- [ ] PR body cites the user's verbatim request that motivated the change

## Common gotchas

1. **dnd-kit collision detection**: invalid drops (e.g. dragging an item over a Buy card, or dragging a PO over another PO) currently still highlight the wrong drop target visually because every droppable receives the same `over` event. The `handleDragEnd` parser correctly rejects invalid combinations, but the hover highlight is misleading. Fix would require `useDndMonitor` + filtering — not worth it for v1.
2. **Optimistic updates can desync**: `moveItemToPo` and `movePoToBuy` set local state first, then PATCH. On 4xx/5xx the local state rolls back, but only the touched record. Other state (the PO's item-count, the Buy's spent rollup) is recomputed via memos so it picks up automatically. If you add a non-memoized derived value, you must also rollback it.
3. **`expectedShipMonth` is a `DateTime?`** (promoted from `String?` on 2026-05-13). First-of-month UTC. Write boundary (`buildPoCreateData` / `buildPoUpdateData`) accepts ISO datetime, `YYYY-MM`, `MM-YYYY`, or `Date` and coerces to Date via `coerceShipMonthInput`. Read boundary: API returns ISO datetime string (Next.js JSON serialization); UI formats for display via `formatShipMonthForDisplay` ("March 2026") and for HTML input via `formatShipMonthForInput` ("2026-03"). Legacy free-text like "March" stored before the promotion was converted to NULL by the `20260513b_expected_ship_month_to_datetime` migration.
4. **Cross-vendor drops are blocked**. `lib/buyerDraftValidation.ts:isCompatiblePoForItem` enforces this on both UI and API: when an item.vendorId and a target po.vendorId both non-null and differ, the drop is rejected (UI: toast warning; API: 400). Lenient when either side is null so mid-edit workflows aren't broken. Pure helper, 6 A-grade tests + 3 B-grade integration tests against hydrated rows.
5. **PO item count is derived from `items` state, not the server's `_count` projection**. The `_count` only refreshes on a full `pos` reload; deriving from local state means drag-drop reflects instantly. See `itemCountByPo` useMemo in `pages/admin/buyer-drafts/index.tsx`.
6. **All imported drafts default to MANUAL source**. The other source values (HD_PROPOSAL, APPAREL_SCAN, CONFIGURATOR) are reserved for future slices. Don't repurpose without a plan.
7. **Draft fields beat linked Product fields, always**. The Slice 6.1 fallback (`resolveDraftDisplay`) only fills in BLANK draft fields from the linked Product — it never overwrites what the buyer typed. The "from catalog" hint marker is the user-visible signal that a value came from the link, not the draft. If you ever need a "force-reload from catalog" action, build it as an explicit button that overwrites draft fields server-side; don't invert the precedence in the display helper.
