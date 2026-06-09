# Consignment (Marjan Rugs)

Marjan International Corp consigns rugs to the business. Rugs remain Marjan's property until sold. The business pays Marjan monthly via purchase orders in the POS.

## Matching Rule

**Always match by barcode first.** The barcode (e.g., `M1812-91`) is printed on the physical rug and never changes. The customerNumber (e.g., `9381-25`) maps to the current the POS product number (`MAR-9381-25`) but changes when a rug is returned to Marjan and re-consigned with a new number. If you match by customerNumber you will miss rugs that have been renumbered.

- Primary: `ConsignmentItem.barcode` -- immutable physical rug ID (M-format, e.g., `M6704-11`)
- Fallback: `ConsignmentItem.customerNumber` -- only when barcode is unavailable in the source data
- In the sales CSV, "Barcode No" is the POS's internal number (e.g., `10053877`), NOT the physical barcode. The physical barcode is the M-format UPC on the resolved Product. If the CSV barcode starts with `M`, it IS the physical barcode.
- Bridge functions in `lib/consignment.ts`: `isMarjanRug()`, `toMarjanBarcode()`, `toMarjanCustomerNumber()`

## Lifecycle

```
Manifest upload -> ON_FLOOR
  |
  +--> ON_APPROVAL (customer trial) --> ON_FLOOR or SOLD
  +--> SOLD (via sales import or manual)
  |      +--> PAID (PO received in the POS -> auto-creates payment batch)
  |      +--> ON_FLOOR (customer return -> order marked RETURNED)
  |
  +--> RETURNED_VENDOR (shipped back to Marjan, terminal)
  +--> MISSING (inventory discrepancy)

PAID -> ON_FLOOR (customer return after payment -> creditOwed=true)
MISSING -> ON_FLOOR (found during count)
```

Valid transitions enforced by `isValidConsignmentTransition()` in `lib/consignment.ts`.

**Re-consignment**: Marjan can take a rug back and send it out again. When a rug returns from vendor and sells again, it transitions RETURNED_VENDOR -> SOLD directly. The sales import sync matches ON_FLOOR, ON_APPROVAL, AND RETURNED_VENDOR statuses.

## Automation

| Trigger | What happens | Code location |
|---------|-------------|---------------|
| Sales import detects Marjan rug on ORDER | ConsignmentItem marked SOLD | `importRunners.ts` after batch transaction |
| Sales import detects RETURNED order (accounting returns) | ConsignmentItem reverted to ON_FLOOR | `paymentService.ts` `syncConsignmentReturns()` |
| PO import sees Marjan PO become RECEIVED_FULL | Payment batch created, SOLD items → PAID, ON_FLOOR items → PAID + creditOwed | `importRunners.ts` consignment sync block |
| Return of PAID item | ON_FLOOR + `creditOwed=true` | `paymentService.ts` `syncConsignmentReturns()` |
| Same-batch sell+return (wash) | Revert to ON_FLOOR instead of marking SOLD | `importRunners.ts` wash reconciliation |
| Re-sale of PAID+creditOwed item | Clear `creditOwed` on SOLD transition | `importRunners.ts` consignment sync |

## Pricing

`cost * 7 = anchorPrice`, `anchorPrice / 2 = retailPrice`. Implemented in `calculateRugPricing()`.

## the POS Quirks

- the POS creates a NEW product record when a rug is re-consigned. Same physical rug, different `MAR-xxxx-yy` product number, different barcode in the POS's product record. The physical barcode sticker on the rug stays the same.
- The sales side and purchase side of the POS can use different product numbers for the same rug. The sales order uses whatever product number existed when the rug sold. The PO uses whatever product number exists when payment is processed.
- Dedicated consignment-only POs started with PON08290 (March 2026). Before that, consignment items were mixed into regular purchase POs (1-2 consignment items per PO of 15-50 items).
- `ConsignmentVendorReturn` model groups return shipments. The return scanner UI and the CSV import both create these records.

## PO Management (Manual Workflow)

The PO management page at `/inventory/consignment/po-management` provides a manual workflow for linking SOLD rugs to payment batches, preparing for post-the POS handoff.

**PO Viewer**: Select a Marjan PO to see its line items and which consignment items match via `toMarjanCustomerNumber()`. Shows matched/unmatched/paid counts.

**Unassigned SOLD Rugs**: Lists all SOLD items with no payment batch. Multi-select checkboxes for batch creation with optional PO link and check number.

**API endpoints** (`pages/api/consignment/po-management/`):

- `purchase-orders.ts` -- list Marjan POs with batch status
- `po-items.ts` -- PO line items with matched consignment items
- `unassigned-sold.ts` -- SOLD items without a payment batch
- `assign-to-batch.ts` -- create payment batch from selected items

All endpoints require MANAGER or ADMIN role. The assign endpoint validates all items are SOLD, same vendor, no existing batch.

## Credits Owed

Page at `/inventory/consignment/credits-owed` shows PAID consignment items where `creditOwed=true`. These represent items the business already paid Marjan for, but the customer returned them. Marjan owes a credit for these. Used to create negative PO lines in the POS for reconciliation.

## Wash Reconciliation

When the sales import processes a batch of orders and the same rug appears on both a sale order (the sale prefix) and a return order (accounting returns) in the same import batch, the net effect is zero. Instead of marking the item SOLD and then reverting it, the import detects this "wash" scenario and reverts the item to ON_FLOOR directly. This prevents transient status flicker and incorrect payment batch creation.

## creditOwed Clearing on Re-sale

When a PAID item with `creditOwed=true` re-sells (appears on a new sale order), the import clears `creditOwed` because the credit is no longer owed -- Marjan keeps the original payment and the new sale generates a new payment cycle.

## Key Files

- `lib/consignment.ts` -- matching functions, pricing, state machine
- `lib/paymentService.ts` -- `syncConsignmentSales()`, `syncConsignmentReturns()`
- `lib/importRunners.ts` -- sales import SOLD sync, PO import PAID sync
- `pages/api/consignment/` -- 33 API endpoints (27 + 4 PO management + credits owed)
- `pages/inventory/consignment/` -- 12 UI pages (10 + PO management + credits owed)
- `pages/admin/import/consignment-filemaker.tsx` -- backfill + import tools
- `pages/api/consignment/import/manifest.ts` -- `findOrCreateMarjan()` looks up vendor by name variants then code "MJ" fallback. Prod vendor name is "Marjan International Corp".

## Verification Checklist

- [ ] `npm test -- consignment` passes
- [ ] Any rug matching uses barcode as primary key, customerNumber as fallback
- [ ] Status transitions use `isValidConsignmentTransition()` -- never set status directly without checking
- [ ] RETURNED_VENDOR is terminal -- nothing transitions out of it
- [ ] PAID -> ON_FLOOR sets `creditOwed=true`
- [ ] New consignment API endpoints have corresponding UI

## Test Coverage

Covered: `calculateRugPricing`, `mapFileMakerStatus`, `isValidConsignmentTransition`, `getValidConsignmentTransitions`

Gaps: `isMarjanRug()` edge cases, `toMarjanBarcode()`, `toMarjanCustomerNumber()` all paths

## Verification re-check (2026-05-20)

Walked the doc against current code:

- PO Management workflow (4 API endpoints + UI) — documented ✓
- Credits Owed page — documented ✓
- Wash reconciliation — documented ✓
- `creditOwed` clearing on re-sale — documented ✓
- Re-consignment + RETURNED_VENDOR sync inclusion — documented ✓
- Barcode-first matching invariant — documented ✓

No new code paths since last verification need adding. Refresh below is just a date stamp.

---
Last verified: 2026-05-20
