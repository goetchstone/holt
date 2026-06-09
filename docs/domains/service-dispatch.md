# Service Dispatch

Scheduling and tracking of service appointments: measure, install, delivery, house calls. Installer roster and delivery zone management.

## Appointment Status Transitions

```
PENDING -> SCHEDULED -> CONFIRMED -> IN_PROGRESS -> COMPLETED
   \           \            \            \
    +-----------+------------+------------+--> CANCELLED
```

All transitions enforced by `isValidTransition()` in `serviceDispatchService.ts`. Never set status directly.

## Auto-Sync

`syncServiceAppointments()` creates PENDING appointments for service line items when an order is confirmed (QUOTE -> ORDER via first payment). Cancels appointments when line items are cancelled. Called from `postPayment()` in `paymentService.ts`.

## Delivery Zones

ZIP-based delivery zone pricing. `DeliveryZone` has `DeliveryZoneZip` children mapping ZIP codes to the zone. Zone pricing stored on the zone record.

**Seeded zones**: Migration `20260408_seed_delivery_zones` created 5 CT delivery zones with 288 ZIPs. This migration may still need to be applied on production -- verify before relying on zone data in prod.

- Capitol (Hartford area)
- Eastern (New London, Windham)
- Lower Valley (Main Showroom, Middletown corridor)
- South Central (New Haven, Milford)
- Western (Fairfield, Litchfield)

**ZIP+4 handling**: the POS customer addresses include ZIP+4 format (e.g., `06475-1234`). All dispatch APIs strip ZIP to 5 digits before zone lookup. Any new zone-matching code must do the same (`zip.substring(0, 5)`).

**Customer address fallback**: the POS does not export delivery addresses (`SalesOrder.deliveryAddressId` is NULL for all imported orders). All dispatch APIs use the fallback chain: `deliveryAddress ?? customer.addresses[0]`. Any new dispatch code must follow this pattern.

## Conveyance / Delivery Method

the POS does not export `deliveryMethod` or `dispatchStatus`. Both fields exist on SalesOrder but are NULL / defaulted for all imported orders. Until the POS conveyance data is available, **all orders are treated as deliveries**. When conveyance comes over, re-add `deliveryMethod` filtering to the dispatch APIs:

- `api/dispatch/ready-to-deliver.ts`
- `api/dispatch/delivery-planner.ts`
- `api/dispatch/orders-by-zone.ts`

The `DispatchStatus` enum (PO_PLACED, RECEIVED_IN_WAREHOUSE, READY_FOR_PICKUP, SCHEDULED_DELIVERY, FULFILLED, CANCELLED) is also unused -- the dispatch pages use PO-based in-stock detection instead. Re-evaluate `DispatchStatus` when conveyance is available.

## Dispatch Dashboards

Three dispatch planning pages under `/dispatch/`:

### Ready to Deliver (`/dispatch/ready-to-deliver`)

Shows ORDER-status orders where all items are physically in the warehouse. "Ready" is determined by PO-based in-stock logic: an order is ready when it has no POs, or every PO is `RECEIVED_FULL` / `SHORT_CLOSED`. Orders already assigned to a delivery run are excluded.

Grouped by delivery zone. Shows days waiting (color-coded: green <3d, amber 3-7d, red >7d) and scheduling status. Summary cards: total orders, scheduled, needs scheduling, zone count.

**API**: `GET /api/dispatch/ready-to-deliver`

### Delivery Planner (`/dispatch/planner`)

Forward-looking planning tool for inbound POs (SUBMITTED, CONFIRMED, RECEIVED_PARTIAL) linked to sales orders. Grouped by delivery zone with week sub-grouping (e.g., "Week of Apr 13").

**Features**:

- Zones start collapsed. Clickable metric cards filter by "Due This Week", "Due Next Week", "No ESD", or all.
- Customer context badges: green "N in stock" (other orders ready now), blue "N more inbound" (other orders also pending). Helps decide partial vs. full delivery.
- Pencil-in: inline date picker per PO row. Creates/reuses a PLANNING delivery run for the chosen date and assigns the order. Green "Planned: date" badge appears; tap to remove. Penciled-in orders appear on the dispatch board for that date.

**APIs**: `GET /api/dispatch/delivery-planner`, `POST/DELETE /api/dispatch/pencil-in`

### Pencil-In Flow

The pencil-in creates real records (ServiceAppointment SCHEDULED + DeliveryStop PENDING on a PLANNING run) so the dispatch board shows them. Shared `assignOrderToRun()` and `findOrCreatePlanningRun()` in `lib/deliveryService.ts` are used by both the pencil-in endpoint and the dispatch board's `assign-order.ts`.

### Dispatch Board (`/dispatch`)

Drag-and-drop board for assigning customer orders to delivery runs (trucks). Left panel shows unassigned customers grouped by zone (collapsed by default). Right panel shows trucks with sortable stop lists.

Uses `@dnd-kit/core` with reusable components in `components/dnd/`. Dropping a customer auto-creates a `ServiceAppointment` (DELIVERY type) and `DeliveryStop` record for each of their orders.

In-stock filter (default: on) requires ALL of a customer's orders to have all POs received. A customer with any order still pending will not appear when the filter is on.

**API**: `GET /api/dispatch/orders-by-zone` (unassigned orders by zone), plus run/stop/vehicle CRUD endpoints under `api/dispatch/`.

## Key Files

- `lib/serviceDispatchService.ts` -- transitions, number generation, auto-sync
- `lib/deliveryService.ts` -- delivery zone resolution, assignOrderToRun(), findOrCreatePlanningRun()
- `lib/paymentService.ts` -- `computeBalance()` used by dispatch board for balance due
- `pages/api/dispatch/` -- dispatch API endpoints (orders-by-zone, ready-to-deliver, delivery-planner, pencil-in, runs, stops, vehicles, assign-order)
- `pages/dispatch/` -- dispatch pages (board, ready-to-deliver, planner)
- `pages/api/service/` -- service appointment API endpoints
- `pages/service/` -- service pages (dispatch queue, house calls)
- `components/dnd/` -- reusable drag-and-drop components (DndBoard, DroppableColumn, SortableList, SortableItem)

## Verification Checklist

- [ ] `npm test -- serviceDispatch` passes
- [ ] Status transitions use `isValidTransition()` -- never set directly
- [ ] New appointment types added to `ServiceAppointmentType` enum in schema
- [ ] Auto-sync tested when modifying payment flow
- [ ] Dispatch APIs use customer address fallback (not just deliveryAddress)
- [ ] Dispatch APIs strip ZIP to 5 digits before zone lookup

## Test Coverage

Covered: `serviceDispatch.test.ts` (transitions, number generation)

Gaps: `deliveryService.ts` has no tests. Dispatch API endpoints have no tests. Pencil-in endpoint has no tests.

## Data Cleanup

Migration `20260410_cleanup_test_dispatch_data` removes 3 test DELIVERY ServiceAppointments (DEL-20260409-001/002/003) and 2 PLANNING DeliveryRuns (DR-260408-1, DR-260409-1) created during dispatch board development. Apply on production to clear test data.

## Customer Service Sheet importer (`/admin/import/service-cases`, 2026-05-26)

Cutover bridge for the team's Excel-based customer-service workflow. Until the Google Form intake is rewired directly into the ERP, the operator periodically uploads the latest `Updated Customer Service Sheet.xlsx` and the importer syncs deltas into `ServiceCase` + `ServiceCaseNote`.

**Sheets read**: `C.S. In process` (active), `C.S. Completed` (closed), `Repair`. The `Form Responses 1` and `Deliveries to Schedule` tabs are skipped (intake-only + different domain shape).

**Idempotency**:

- Each row's idempotency key is `cs-sheet:` + sha256(name + orderno_raw + sheetName), stored on `ServiceCase.externalSourceId` (unique). The Timestamp cell is intentionally NOT in the hash — pre-2026-05-27 it was, and the change to remove it produced 366 duplicate case-pairs (see Recovery + Fallback below).
- **Two-step lookup on re-import** (added 2026-05-28): the orchestrator first tries `findUnique({ externalSourceId: row.rowKey })` (fast path). If that misses, it falls back to a content match — same `customerId`, same `salesOrderId`, same `itemDescription`, same lowercased `summary` prefix — and on a hit UPDATES the case's `externalSourceId` to the current rowKey so the next import takes the fast path. Without this, any future rowKey schema change would produce dups again.
- Each threaded cell comment becomes a `ServiceCaseNote` keyed by `cs-sheet-note:content:` + sha256(rowKey + utcDay + text). **Content-based, NOT GUID-based** (changed 2026-05-28 after audit found 1,780 dup groups / 5,268 dup rows). Background: the original key was `cs-sheet-note:{commentGuid}` because Excel-native threaded comments have stable global GUIDs. The Customer Service Sheet lives in Google Sheets, however, and **Google REGENERATES the threaded-comment GUIDs on every .xlsx export** — so every re-import landed the same physical comment under a new key and dedup never fired. The content-based key collapses re-imports of the same (case row, calendar day, text) to a single note even when the source GUID churns. Same-day edits that change the text get a new key (intentional — treated as a new comment). The hash format `sha256(rowKey + "|" + YYYY-MM-DD + "|" + text)` truncated to 24 hex chars MUST stay in sync between `threadedNoteKey()` in `lib/runServiceCaseSheetImport.ts` and the SQL in `20260528c_dedupe_service_case_notes`.
- **Date precedence** for the case's `created` ("Opened" date in the UI) AND for the synthetic initial-issue note (revised 2026-05-27 per owner direction *"the open date should be the same as the earliest date in the comments"*):
  1. **earliest threaded comment date** — wins when comments exist. The Timestamp cell is unreliable in real-world spreadsheets (Y2K-style typos, future dates, blanks) while the comment `dT` attributes come from Excel's threaded-comment GUIDs and are accurate.
  2. **`row.timestamp`** (Timestamp / Start Date cell) — used only when the row has no comments.
  3. **`now()`** — last resort, when neither signal exists (e.g. Repair sheet rows with no Timestamp column AND no comments).
- The initial-issue cell text becomes a single synthetic note with key `cs-sheet-note:initial:{rowKey}` — but **only when one of the first two signals exists**. When the row has neither comments nor a Timestamp, the initial-issue note is SKIPPED rather than fabricated with `now()`. The initial-issue TEXT is still surfaced on the case's `summary` field. Origin: user-reported 2026-05-27 — *"the initial date for the comments is showing today's date for a lot if not all the imported services."*
- On re-import, if a row no longer resolves to a real source date, any pre-existing initial-issue note (left over from a buggy prior import that stamped it with `now()`) is **deleted** so the UI stops showing the wrong date. Threaded-comment notes are never touched.
- **Invariant (owner direction 2026-05-27)**: an initial-issue note's `created` is NEVER newer than the case's earliest threaded comment. The initial-issue text IS the form-submission content that opens the case; it logically predates any follow-up commentary. Pinned by the integration test `invariant: initial-issue note's created is NEVER newer than the earliest threaded comment` in `runServiceCaseSheetImport.integration.test.ts`.
- **Recovery for already-imported wrong-dated rows**: migration `20260527b_backfill_service_case_initial_note_dates` is a one-time UPDATE that pulls any cs-sheet initial-issue note (and the matching `ServiceCase.created`) BACK to the earliest threaded comment on the same case. Idempotent — re-running on already-correct data is a no-op. Touches only cs-sheet rows; native ERP cases are untouched. Apply once on prod to fix existing data without forcing an operator re-import.
- **Recovery for the rowKey schema-change duplicates**: migration `20260528b_merge_service_case_dupes` walks every dup group (keyed by customerId + salesOrderId + itemDescription + LOWER(LEFT(summary,80))), keeps the case with `MAX(id)` (the latest import — it has the current rowKey AND the PR #337 backfilled `created`), moves all notes / tasks / emails onto it (the `ServiceCaseNote.externalSourceId` unique index collapses redundant threaded comments naturally), and deletes the older copies. Idempotent — re-running picks up zero groups. Touches only cs-sheet rows. **Audit against the 2026-05-28 backup**: 742 cases → 370 (372 dropped), 4274 notes → 3910 (364 dropped). Apply once on prod, then the content-fallback lookup above keeps it from recurring.
- **Recovery for the GUID-churn duplicate notes**: migration `20260528c_dedupe_service_case_notes` walks every cs-sheet note group keyed by (caseId, UTC day, normalized text), keeps the OLDEST id, relabels its `externalSourceId` to the new content-based key, and deletes the rest. **Audit against the 2026-05-28 backup**: 5,693 notes → 2,206 (3,487 dropped across 1,781 groups). Idempotent. Apply ONCE before any new import.
- **Backfill `created` + `resolvedAt`** (migration `20260528d_backfill_service_case_resolved_at`): two clamps on cs-sheet cases. (1) Force `created = MIN(note.created)` when notes exist — closes a gap in PR #337's backfill that left ~265 cases with `created = 2001-01-02` (Excel-epoch artifact from corrupt Timestamp cells) untouched because the original condition was `created > min_created` and 2001 < 2025. (2) Set `resolvedAt = MAX(note.created)` for closed cases with NULL resolvedAt — without this, imported Completed cases never populate the Service KPIs resolution-time stats. Both clamps are sanity-bounded: when the resulting duration would be negative OR exceed 5 years, `resolvedAt` stays NULL (the case is still visible in the queue but excluded from the KPI math). Same bound enforced by `computeResolvedAt()` in `runServiceCaseSheetImport.ts` on every future import.
- `ServiceCase.externalSourceLastSeen` is bumped on every touched case; the admin page surfaces MAX(lastSeen) as "Last sync".

**"Last Action" column** (`/service` list view): computed server-side as `max(case.created, latest note.created)`. Intentionally excludes `case.updated` — Prisma's `@updatedAt` bumps that on every re-import, which collapsed every imported row's "last action" to today. The computation lives in the pure helper `lib/serviceCaseLastAction.ts` so the bug shape can't sneak back in via the type signature (the helper doesn't accept an `updated` field). The cell also renders a one-line preview of the most-recent comment text (via `summarizeNoteText` in the same helper file — collapses whitespace, truncates at 100 chars on a word boundary, returns null when empty so the UI skips the line). Hover for the full text + author. Origin: owner direction 2026-05-28 — *"maybe we see the last comment on the cases page too?"*

**Status mapping**: `Service Call` and `Needs Attention` are seeded as new `ServiceCaseStatus` rows by migration `20260526_service_case_external_source`. `Replacement on Order` maps to existing `Waiting on Vendor`. `Completed` and the Completed tab map to `Completed`. Anything unrecognized falls back to `Open` — operator reclassifies in the UI.

**Match strategy**: customer by phone (digits-only tail) → email (case-insensitive) → last-name + first-initial. Sales order by the sale prefix/the sale prefix/the sale prefix/the B2B prefix token extracted from the raw cell, with rewrite-suffix (`- A`) tried after exact-match misses. Designer by `StaffMember.displayName` + `aliases` + first-name disambiguation. Empirical match rate against prod 2026-05-26: ~92% on sales orders, ~77% on customers (slash-couples and business names dominate the misses; surfaced on the unmatched list for operator review).

**Native UX**: imported cases land at `/service/cases/[id]` indistinguishable from native-created cases. `caseNumber` uses a `CSI-` prefix so import-vs-native is obvious at a glance. The detail page falls back to `ServiceCaseNote.authorDisplayName` (snapshot from the original threaded comment) when the author can't be resolved to a current `StaffMember`, so notes from former staff still attribute correctly.

**Key files**:

- `lib/serviceCaseSheetImport.ts` — pure parsers + matchers (xlsx unzip, person.xml + threadedComment*.xml decoders, status mapper, sales-order token extractor, row-key hasher, author resolver)
- `lib/runServiceCaseSheetImport.ts` — orchestrator (taxonomy caches, customer/order matching, upserts, dry-run accounting, initial-issue note date-precedence + stale-cleanup)
- `lib/serviceCaseLastAction.ts` — pure helpers for the `/service` list view's "Last Action" column. `computeLastActionAt` computes `max(case.created, latest note.created)` and intentionally does NOT take a `case.updated` parameter. `summarizeNoteText` produces the truncated one-line comment preview rendered below the relative time.
- `pages/api/admin/service/import-sheet.ts` — POST endpoint (multipart, `dryRun` flag, ADMIN/SUPER_ADMIN only) + GET endpoint for last-sync status
- `pages/admin/import/service-cases.tsx` — admin UI with file picker, dry-run toggle (default on), results panel, unmatched list with copy-as-TSV

**Cutover path**: once the operator is happy with the data + the team works natively in the ERP, the Google Form intake rewires to call a new `POST /api/service/cases/from-intake` endpoint (Phase 2, not in this PR). The importer stays around for occasional historical refreshes.

---
Last verified: 2026-05-28
