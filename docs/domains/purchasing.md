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

## Vendor lead time (since 2026-10-17)

`Vendor.leadTimeDays` is the vendor's standard lead time, in days from order to
arrival. Set it on Inventory -> Vendors (the Edit modal; the list shows it as a
column), which saves through `PATCH /api/vendors/[id]` (`catalog.pricing`, held
by Buyer). The PATCH whitelist lives in `lib/vendorPatch.ts`: pricing defaults,
contact details and lead time. The vendor NAME stays out -- importers find a
vendor by name, so a rename would make the next import create a second one.

- A **native special-order PO** (raised as a DRAFT on the order's first payment,
  `lib/paymentService.ts` `onPaymentReceived`) takes `expectedDelivery = order
  date + lead time` (`lib/vendorLeadTime.ts` `expectedArrival`).
- **Unknown stays unknown.** A vendor with no lead time gives its PO no date --
  the Delivery Planner's "No ESD" row, the one a buyer chases. No default lead
  time is ever assumed (DECISIONS 24).
- **Imported POs keep the date the vendor's file gave**; lead time is not
  applied to them.

Tested by `__tests__/vendorLeadTime.test.ts` and
`__tests__/integration/specialOrderLeadTime.integration.test.ts`.

## Stock POs written by hand (GAP-01, since 2026-10-30)

A buyer writes a purchase order for stock on Purchasing -> Purchase Orders ->
New purchase order (`/app/purchasing/orders/new`): vendor, where it ships,
expected date, notes, and lines picked from that vendor's products. It is
created as a DRAFT. All of it lives in `lib/purchasing/stockPurchaseOrder.ts`,
one function per act, each called by its route:

| Act | Route | Key |
|---|---|---|
| Create | `POST /api/purchasing/orders` | `purchasing.write` |
| Change | `PUT /api/purchasing/orders/[id]/edit` | `purchasing.write` |
| Duplicate | `POST /api/purchasing/orders/[id]/duplicate` | `purchasing.write` |
| Print | `GET /api/purchasing/orders/[id]/pdf` | `purchasing.read` |
| Email to the vendor | `POST /api/purchasing/orders/[id]/email` | `purchasing.write` |
| The editor's product picker | `GET /api/purchasing/vendor-products` | `purchasing.write` |

- **Lines are the vendor's products.** A line names a catalog product whose
  `vendorId` is the PO's vendor; anything else is refused with the product's
  name. The picker offers only the vendor's active, non-discontinued products.
  Part number and name are copied from the product onto the line.
- **Ship to** is `PurchaseOrder.shipToLocationId`, an open store or warehouse
  (migration `20261030140000_stock_purchase_orders`). It is printed on the PO,
  and the Receive screen starts on that store. Special-order and imported POs
  have none.
- **Expected date** starts at today plus the vendor's lead time
  (`lib/vendorLeadTime.ts`, the same rule special orders use) and the buyer may
  change or clear it. Unknown stays unknown.
- **A PO can be changed until anything is received against it**, in DRAFT,
  SUBMITTED or CONFIRMED (`poEditProblem`, `lib/purchasing/purchaseOrderShared.ts`,
  shared by the editor and the server). The change rechecks receipts inside its
  transaction. The editor sends the PO's whole set of lines: a line left out is
  removed. Only receiving records point at a PO line, and none exist by then.
  A vendor return is not changed here. A line raised for a customer's order
  (`orderLineItemId` set) keeps its product and quantity and can't be removed;
  only its cost moves.
- **Duplicate** makes a new draft with the vendor, ship-to, notes and lines at
  the costs they had, and a fresh expected date from lead time. Zero-quantity
  lines are cancelled lines and are left behind (rule 31). A line with no
  catalog product, or whose product another vendor now supplies, is left
  behind and named in the answer. A duplicate of a special-order PO is a stock
  PO: no sales order, no linked lines.
- **Cost follows "View cost"** (strip, never deny). A writer without
  `catalog.cost` still writes POs. A new line takes the product's `baseCost`, a
  line already on the PO keeps its own, and any cost sent is ignored. The PDF
  that writer prints or emails carries quantities and no prices.
- **Numbering.** `lib/purchasing/poNumber.ts` is the one numberer: `PO-YYMMDD-NNN`
  by business day, used by the special-order draft (`lib/paymentService.ts`)
  and stock POs alike, so the two share one daily sequence. Two POs raised at
  once may read the same next number; the unique index refuses the second, and
  it is renumbered (up to five tries) instead of failing.
- **The PDF** (`lib/purchasing/purchaseOrderPdf.ts`, pure jsPDF, loaded by
  `purchaseOrderDocument.ts`) carries:
  - the store's name and theme colours (AppSettings), like the invoice PDF;
  - the PO number, date and expected date;
  - the vendor's address, phone and our account number with it;
  - the Ship To store's address;
  - payment and freight terms;
  - the live lines (zero-quantity lines left off), the total and the notes.

  The logo is not drawn.
- **Email** attaches that same PDF. It goes to the address the buyer
  confirms, prefilled with `Vendor.email`, else the primary contact's. It goes
  through the email queue and is tried at once (`deliverQueuedEmail`,
  `docs/domains/email.md`). Sent: a DRAFT becomes SUBMITTED, and a PO further
  along keeps its status. Failed: 502, the email stays queued with its PDF, and
  the status is unchanged. SMTP not configured: 409, and nothing is queued. A
  cancelled PO is not sent.

**Who opens what.**

- The PO list and detail pages are on `purchasing.read`, the key their routes
  were already on. They had been held to MANAGER/ADMIN/WAREHOUSE, which kept
  Buyers out of their own POs.
- The detail route's GET is `purchasing.read`. Its PUT (status,
  acknowledgement, dates, notes) is `purchasing.receive` or `purchasing.write`.
- The Receive page is `purchasing.receive`, the key its receive route is on.
  It was `purchasing.write`, which kept out the warehouse.

Tested by `__tests__/integration/stockPurchaseOrders.integration.test.ts`. It
calls the real routes through their real gates, and email goes over a real
SMTP conversation to a sink on localhost. Also tested by
`__tests__/lib/purchasing/purchaseOrderShared.test.ts` and
`__tests__/purchaseOrderPdf.test.ts`, both of which read the PDF back through a
text extractor.

**Not built (ROADMAP GAP-01):**

- apparel size/colour variants on a hand-written line;
- a logo on the PDF;
- a vendor-facing confirmation link.

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
- `pages/api/purchasing/orders/index.ts` -- the PO list, gated on `purchasing.read` ("View purchasing"); its totals go only to holders of "View cost" (`catalog.cost`). A service case does not use it: it finds a PO to link through `pages/api/service/purchase-order-lookup.ts`, which returns number and vendor only. Its POST creates a stock PO (`purchasing.write`, above)
- `lib/purchasing/stockPurchaseOrder.ts`, `purchaseOrderShared.ts`, `poNumber.ts`, `purchaseOrderDocument.ts`, `purchaseOrderPdf.ts` -- stock POs written by hand: create, change, duplicate, number, print and email (section above)
- `app/(dashboard)/app/purchasing/orders/PurchaseOrderEditor.tsx` -- the New and Edit PO screen
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
Last verified: 2026-10-30 (stock POs by hand; sections before it 2026-05-21)
