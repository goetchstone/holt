# Purchasing & Receiving

Purchase orders track vendor orders from creation through receiving. POR numbers uniquely identify each line item across the PO lifecycle.

## Key Concepts

- **PON** = Purchase Order Number (e.g., `PON08290`). Unique per PO.
- **POR** = Purchase Order Request (e.g., `POR45203`). Unique per line item. A POR is created when an item needs ordering and follows it through PO placement and receiving.
- **GIP** = Goods In Process number. Assigned when items are received. Used with POR as the compound unique key for ReceivingRecords.

## Data Flow

```
Item needs ordering -> POR created in the POS
  -> POR placed on a PO (gets PON) -> PO sent to vendor
  -> Vendor ships -> PO received in the POS (GIP assigned)
  -> ReceivingRecord created in our system
```

Daily imports:

- `runPurchaseOrdersImport` -- creates PO + items from `Inbound_Items`/`Prior_Day_POR_Export`
- `runReceivedItemsImport` -- creates ReceivingRecords from `Prior_Day_Received_Items`
- `runInboundItemsImport` -- updates ESD from `Company_Inbound_Items` (no POR#)
- `runTempItemsImport` -- creates draft PO items from `Prior_Day_Temp_Items`

## PO Status

`derivePOStatus()` maps: "received" -> RECEIVED_FULL, "part received" -> RECEIVED_PARTIAL, "cancelled" -> CANCELLED, default -> CONFIRMED.

**Auto-recalculation**: The receiving import (`runReceivedItemsImport`) now auto-updates PO status after processing each batch by comparing total received items to total ordered items. Migration `20260408_recalculate_po_status` fixed 426 historical POs that had stale statuses. Going forward, PO status stays in sync automatically as receiving records come in.

**0-qty lines are excluded from the recalc** (GitHub #113, CLAUDE.md rule 39). the POS sometimes exports a PO line that was zeroed out at source (`orderedQuantity = 0`) but not removed. These are effectively cancelled lines -- they must not count toward the "total ordered items" denominator or the PO gets stuck at RECEIVED_PARTIAL forever. The recalc filters both counts to `orderedQuantity > 0`, and the UI renders 0-qty lines as an `N/A` badge (not "Pending"). Pure helper: `classifyPOReceiptStatus()` in `lib/importHelpers.ts`.

## Consignment PO Integration

When a Marjan vendor PO transitions to RECEIVED_FULL, the import runner auto-creates a `ConsignmentPaymentBatch` and marks matching ConsignmentItems as PAID. See `docs/domains/consignment.md` for matching rules.

## Expected Delivery Dates

The `Company_Inbound_Items` report provides ESD (`Expecteddate`). The `runInboundItemsImport` runner stores this as `PurchaseOrder.expectedDelivery`. The `Inbound_Items` report does NOT have ESD.

## Invoice Import and Order Rewrites

The invoice import (`runInvoicesImport`) links invoices to sales orders by matching the Invoice Memo field to an order number. Because the POS uses the base order number in the Memo (e.g., `SO-38549`) even when the active order is a rewrite (`SO-38549 - A`), the import tries rewrite suffixes in reverse order (`- D`, `- C`, `- B`, `- A`) before falling back to the base order. This ensures invoices link to the latest active version of the order.

**Bulk reimport**: A one-time invoice reimport (93K rows from 40 Excel files) was performed in April 2026 using `scripts/reimport-invoices-direct.js`. This script found 871 orders via rewrite matching that the original import had missed.

## Warehouse Inbound Dashboard

`/inventory/warehouse/inbound` provides a month/week drill-down view of incoming POs with clickable summary cards and filters for stock type, customer, vendor, and department. Uses the same PO data but presents it in an operations-focused layout for warehouse staff.

## Key Files

- `lib/importHelpers.ts` -- `derivePOStatus()`, `findProduct()`
- `lib/importRunners.ts` -- 4 PO-related runners
- `pages/api/purchasing/` -- PO CRUD, receiving endpoints
- `pages/purchasing/` -- PO list, detail, receiving UI
- `pages/inventory/warehouse/inbound.tsx` -- Warehouse inbound dashboard
- `scripts/reimport-invoices-direct.js` -- One-time invoice reimport with rewrite matching

## Verification Checklist

- [ ] `npm test -- importHelpers` passes
- [ ] PO imports handle column name variants (Porno/porno, Pono/pono)
- [ ] ReceivingRecords use compound unique key `[externalGipNo, externalPorNo]`
- [ ] Inbound items runner matches by `(purchaseOrderId, partNo)` when POR# unavailable
- [ ] Marjan PO receipt triggers consignment PAID sync

## Test Coverage

Covered: `derivePOStatus`, `classifyPOReceiptStatus` in `importHelpers.test.ts`

Gaps: `findProduct()`, received items runner, inbound items runner (all need Prisma for integration tests)

## Buyer Drafts handoff

Buyer Drafts (`docs/domains/buyer-drafts.md`) is the pre-the POS ADMIN workbench where buyers compose items + POs before they exist in the POS. The handoff to this domain happens when:

1. Buyer marks a Buy as "submitted" → exports to a CSV
2. CSV imported into the POS to create the real POs
3. Next Daily POR Export comes back through `runPurchaseOrdersImport` → POs land in the Postgres `PurchaseOrder` table with real PON / POR numbers
4. `lib/buyerDraftRealPoLink.ts` matches the imported real PO back to the original `BuyerDraftPurchaseOrder` for traceability

Look at `buyer-drafts.md` for the pre-the POS side; this runbook covers everything that happens after the real PO is created in the POS.

## ESD (Expected Ship Date) as DateTime

Per CLAUDE.md gotcha + migration `20260513b_expected_ship_month_to_datetime`: `PurchaseOrder.expectedShipMonth` was previously a `YYYY-MM` string. Now a real `DateTime` (always set to the first of the month). Date arithmetic and range filters work correctly across the dispatch board, warehouse inbound dashboard, and buyer-drafts.

If you're touching ESD code, verify the DateTime semantics — string comparisons against the old format will silently misorder when crossing year boundaries.

## Auto-created products from imports

Per CLAUDE.md gotcha: `findProduct()` in `importHelpers.ts` accepts `{ autoCreate: true }`. When a part number on a PO line is not in the catalog, it creates a minimal `Product` row using CSV data (part number, name, vendor, cost). Used by all 5 import runners: sales, PO import, received items, inbound items, PO line export.

Side effect: auto-created products land with `department: null` (CLAUDE.md memory item — the gap the user noted as "should come from the POS 80% of the time"). Manual cleanup via the Categorize Products tool (per `docs/domains/tools.md`).

## Dispatch board interplay

Open POs feed the dispatch board (per `docs/domains/service-dispatch.md`). The `/dispatch/planner` view groups inbound POs by ESD week and shows the customer context. Pencil-in operations on the planner write a planned-delivery row that DOES NOT change the underlying PO status — receiving still happens via the daily import.

## Verification re-check (2026-05-20)

- 0-qty line exclusion in PO status recalc — documented ✓ (GitHub #113, CLAUDE.md rule 39)
- ESD as DateTime — documented ✓
- Buyer Drafts handoff — added in this refresh
- Auto-create products from imports — added in this refresh
- Dispatch board interplay — added in this refresh

## Temp POs — Postatus → status mapping (2026-05-21)

The the POS "Daily Quote Temp Purchase Orders" report (formerly named "Prior_Day_Temp_Items") emits rows with `Postatus = "Temporary"` representing POs that have been created but not yet finalized / submitted to a vendor. Two-part history:

1. **Pre-2026-05-21** — `runTempItemsImport` hardcoded `status: "CONFIRMED"` on insert, ignoring the POS's `Postatus` column. Mismatched the other 3 PO-creating runners which use `derivePOStatus`. The bug was latent: the runner had never executed (`AutoImportLog` shows 0 runs of `temp-items`) because the router regex was looking for the old filename. No production rows were ever miscategorized as a result.
2. **2026-05-21 fix** — `runTempItemsImport` now calls `derivePOStatus(row.Postatus)` like its 3 siblings. `PO_STATUS_MAP` gained a `temporary: "DRAFT"` entry. Temp POs landing in our DB are now distinguishable from real confirmed ones.

**Reports that filter by status need to understand DRAFT semantics**:

- Dispatch board / planner: DRAFT POs should NOT appear in "ready to receive" or "delivery imminent" surfaces — they're not yet vendor-committed
- Warehouse inbound dashboard: DRAFT POs may show in "future inbound" cards but should be visually distinct from CONFIRMED
- Buyer Drafts integration: a temp PO landing in DRAFT status is the POS-side signal that the buyer-draft workflow's "submitted" intent has been received but not yet finalized into a real CONFIRMED PO

The owner-facing decision for "is this temp PO actionable yet?" is the `status = CONFIRMED` filter that already applies to most operational surfaces. No code changes needed beyond the runner fix itself.

---
Last verified: 2026-05-21
