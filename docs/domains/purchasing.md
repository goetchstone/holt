# Purchasing & Receiving

Purchase orders track vendor orders from creation through receiving. POR numbers uniquely identify each line item across the PO lifecycle.

## Key Concepts

- **PON** = Purchase Order Number (e.g., `PON00001`). Unique per PO.
- **POR** = Purchase Order Request (e.g., `POR00001`). Unique per line item. A POR is created when an item needs ordering and follows it through PO placement and receiving.
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
- `runInboundItemsImport` -- updates ESD from `<Org>_Inbound_Items` (no POR#)
- `runTempItemsImport` -- creates draft PO items from `Prior_Day_Temp_Items`

## PO Status

`derivePOStatus()` maps: "received" -> RECEIVED_FULL, "part received" -> RECEIVED_PARTIAL, "cancelled" -> CANCELLED, default -> CONFIRMED.

**Auto-recalculation**: The receiving import (`runReceivedItemsImport`) now auto-updates PO status after processing each batch by comparing total received items to total ordered items. Migration `20260408_recalculate_po_status` fixed the historical POs that had stale statuses. Going forward, PO status stays in sync automatically as receiving records come in.

**0-qty lines are excluded from the recalc** (the 0-qty PO line receiving-status incident, CLAUDE.md rule 39). the POS sometimes exports a PO line that was zeroed out at source (`orderedQuantity = 0`) but not removed. These are effectively cancelled lines -- they must not count toward the "total ordered items" denominator or the PO gets stuck at RECEIVED_PARTIAL forever. The recalc filters both counts to `orderedQuantity > 0`, and the UI renders 0-qty lines as an `N/A` badge (not "Pending"). Pure helper: `classifyPOReceiptStatus()` in `lib/adapters/ordorite/shared.ts` (this said `lib/importHelpers.ts`). Native receiving (`purchasing/orders/[id]/receive.ts`) uses `nativeReceiptStatus()` in `lib/purchasing/receiptStatus.ts`, which also leaves zero-quantity lines out of both counts (it did not until 2026-10-17). The two still disagree on "partial": native counts any quantity, the import a complete line -- an open owner decision.

**Native receiving into stock** (since 2026-10-17, `lib/inventory/receiving.ts`): Damaged and Wrong Item go to the store's quarantine place (`lib/purchasing/receiptConditions.ts`, the list the Receive PO screen offers); a line raised for an open order -- its own line, or a PO raised for the whole order -- arrives committed to the order up to what it still needs, the rest free; quantities parse as fractions. See `docs/domains/inventory.md` "Document flows".

## Consignment PO Integration

When a consignment vendor's PO (`Vendor.isConsignment`) transitions to RECEIVED_FULL, the import runner auto-creates a `ConsignmentPaymentBatch` and marks matching ConsignmentItems as PAID. See `docs/domains/consignment.md` for matching rules.

## Expected Delivery Dates

The `<Org>_Inbound_Items` report provides ESD (`Expecteddate`). The `runInboundItemsImport` runner stores this as `PurchaseOrder.expectedDelivery`. The `Inbound_Items` report does NOT have ESD.

## Invoice Import and Order Rewrites

The invoice import (`runInvoicesImport`) links invoices to sales orders by matching the Invoice Memo field to an order number. Because the POS uses the base order number in the Memo (e.g., `SO-10008`) even when the active order is a rewrite (`SO-10008 - A`), the import tries rewrite suffixes in reverse order (`- D`, `- C`, `- B`, `- A`) before falling back to the base order. This ensures invoices link to the latest active version of the order.

**Bulk reimport**: A one-time invoice reimport (a multi-file historical reimport) was performed in April 2026 using `scripts/reimport-invoices-direct.js`. This script found the orders the original import had missed via rewrite matching.

## Warehouse Inbound Dashboard

`/inventory/warehouse/inbound` provides a month/week drill-down view of incoming POs with clickable summary cards and filters for stock type, customer, vendor, and department. Uses the same PO data but presents it in an operations-focused layout for warehouse staff.

## Import form fields

`import-nuorder.ts` and `import-zsupply.ts` read their multipart fields with
`pickFormFields(rawFields, FIELD_NAMES)` (`lib/importFormFields.ts`): only the
named fields, via `Object.hasOwn`, each flattened to one string (`""` when
absent). Copying every client-chosen field name into an object let a field
named `constructor` shadow the object's members (CodeQL
js/remote-property-injection, 2026-10-15). A new import route lists its
fields the same way.

## Key Files

- `lib/importHelpers.ts` -- `derivePOStatus()`, `findProduct()`
- `lib/importRunners.ts` -- 4 PO-related runners
- `lib/purchasing/receivePurchaseOrder.ts` -- goods in against a PO, one function for the Receive PO screen (`orders/[id]/receive.ts`) and the handheld (`pages/api/scan/receive.ts`, rule 42): the receiving records, the stock (`lib/inventory/receiving.ts`), and the PO status recalc (rule 39). A multi-box unit that arrives short of boxes is received as one unit into quarantine with a box note naming what is missing (`docs/domains/inventory.md` → "The handheld floor"). `ReceiveError` carries its status (404 for a PO that does not exist).
- `pages/api/purchasing/` -- PO CRUD, receiving endpoints. Native receiving (`orders/[id]/receive.ts`) adds stock through `lib/inventory/ledger.ts`, the single writer of `InventoryPosition` (see `docs/domains/inventory.md`). Until 2026-10-14 it wrote the user's email into `ReceivingRecord.receiverUserId`, a foreign key to `User.id`, so every native receipt failed; it now uses the session's user id.
- `pages/api/purchasing/orders/index.ts` -- the PO list, gated on `purchasing.read` ("View purchasing"); its totals go only to holders of "View cost" (`catalog.cost`). A service case does not use it: it finds a PO to link through `pages/api/service/purchase-order-lookup.ts`, which returns number and vendor only
- `pages/purchasing/` -- PO list, detail, receiving UI
- `pages/inventory/warehouse/inbound.tsx` -- Warehouse inbound dashboard
- `scripts/reimport-invoices-direct.js` -- One-time invoice reimport with rewrite matching

## Verification Checklist

- [ ] `npm test -- importHelpers` passes
- [ ] PO imports handle column name variants (Porno/porno, Pono/pono)
- [ ] ReceivingRecords use compound unique key `[externalGipNo, externalPorNo]`
- [ ] Inbound items runner matches by `(purchaseOrderId, partNo)` when POR# unavailable
- [ ] Consignment-vendor PO receipt triggers consignment PAID sync

## Test Coverage

Covered: `derivePOStatus`, `classifyPOReceiptStatus` in `importHelpers.test.ts`

Covered: `handheldReceive.integration.test.ts` (the handheld receive through `receivePurchaseOrder`: whole units, box scans assembled, an incomplete set held in quarantine and completed later, a resend done once); `stockReceive.integration.test.ts` (where receipts land).

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

- 0-qty line exclusion in PO status recalc — documented ✓ (the 0-qty PO line receiving-status incident, CLAUDE.md rule 39)
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
