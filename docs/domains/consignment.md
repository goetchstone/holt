# Consignment

A consigning vendor's goods sit on the floor but stay **theirs** until sold. The business pays the consignor via purchase orders in the POS.

**A vendor consigns when `Vendor.isConsignment` is true.** Nothing resolves a consignor by name. Routes used to — `where: { name: { contains: "the consignor" } }`, with one import route carrying six spellings and three routes CREATING a vendor of that name when they could not find one, which is how a catalog ends up with the same supplier three times. `lib/consignmentVendor.ts` resolves by flag, and a missing configuration is an error rather than a new vendor.

**Number prefixes** (`VendorNumberPrefix`) carry the vendor's numbering: `ATR-1000` on the POS, `A1000` on the physical tag. They exist because two suppliers both ship a part numbered "1827" — prefixing makes it unique. See `lib/vendorNumbering.ts`.

## Matching Rule

**Always match by barcode first.** The barcode (e.g., `C0000-01`) is printed on the physical rug and never changes. The customerNumber (e.g., `1234-56`) maps to the current the POS product number (`CON-1234-56`) but changes when a rug is returned to the consignor and re-consigned with a new number. If you match by customerNumber you will miss rugs that have been renumbered.

- Primary: `ConsignmentItem.barcode` -- immutable physical rug ID (tag format, e.g., `C0000-02`)
- Fallback: `ConsignmentItem.customerNumber` -- only when barcode is unavailable in the source data
- In the sales CSV, "Barcode No" is the POS's internal number (e.g., `10000001`), NOT the physical barcode. The physical barcode is the tag-format UPC on the resolved Product. If the CSV barcode is in the tag format (a hardcoded single-letter prefix check in the POS sales runner), it IS the physical barcode.
- Bridge functions in `lib/vendorNumbering.ts`: `isVendorNumber()`, `toBarcode()`, `toVendorNumber()` — driven by `VendorNumberPrefix` rows, not hardcoded prefixes

## Lifecycle

```
Manifest upload -> ON_FLOOR
  |
  +--> ON_APPROVAL (customer trial) --> ON_FLOOR or SOLD
  +--> SOLD (via sales import or manual)
  |      +--> PAID (PO received in the POS -> auto-creates payment batch)
  |      +--> ON_FLOOR (customer return -> order marked RETURNED)
  |
  +--> RETURNED_VENDOR (shipped back to the consignor, terminal)
  +--> MISSING (inventory discrepancy)

PAID -> ON_FLOOR (customer return after payment -> creditOwed=true)
MISSING -> ON_FLOOR (found during count)
```

Valid transitions enforced by `isValidConsignmentTransition()` in `lib/consignment.ts`.

**Re-consignment**: the consignor can take a rug back and send it out again. When a rug returns from vendor and sells again, it transitions RETURNED_VENDOR -> SOLD directly. The sales import sync matches ON_FLOOR, ON_APPROVAL, AND RETURNED_VENDOR statuses.

## Automation

| Trigger                                                  | What happens                                                                 | Code location                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| Sales import detects the consignor rug on ORDER                 | ConsignmentItem marked SOLD                                                  | `importRunners.ts` after batch transaction     |
| Sales import detects RETURNED order (accounting returns) | ConsignmentItem reverted to ON_FLOOR                                         | `paymentService.ts` `syncConsignmentReturns()` |
| PO import sees the consignor PO become RECEIVED_FULL            | Payment batch created, SOLD items → PAID, ON_FLOOR items → PAID + creditOwed | `importRunners.ts` consignment sync block      |
| Return of PAID item                                      | ON_FLOOR + `creditOwed=true`                                                 | `paymentService.ts` `syncConsignmentReturns()` |
| Same-batch sell+return (wash)                            | Revert to ON_FLOOR instead of marking SOLD                                   | `importRunners.ts` wash reconciliation         |
| Re-sale of PAID+creditOwed item                          | Clear `creditOwed` on SOLD transition                                        | `importRunners.ts` consignment sync            |

## Pricing

`cost * 7 = anchorPrice`, `anchorPrice / 2 = retailPrice`. Implemented in `calculateRugPricing()`.

## Cost visibility

A rug's cost is behind "View cost" (`catalog.cost`; see Cost Visibility in
`docs/domains/staff-auth.md`).

- **Covered screens:** the consignment list and item page, the count and
  return scanners, receiving gaps and the returns history. Each serves everyone
  its own key admits. A caller without View cost gets the rugs without cost,
  and the response says which (`costVisible`).
- **Edits:** the item page's PUT drops `cost` from such a caller, so a screen
  that never received it cannot save it back as empty or zero. A holder's
  `null`, empty or negative cost is refused with 400.
- **Tag prices** (anchor, retail) stay for everyone. They derive from cost by
  the fixed rule above, so anyone who knows the rule can work back to an
  unedited rug's cost.
- **Rug cost still reaches other screens.** The manifest and consignment-items
  imports copy it into `Product.baseCost`, which the product catalog still
  returns under its own key until products move under View cost. The query
  builder also lists consignment cost. The import tool's rebuild shows the
  outstanding total owed to consignors; it is on Destructive data operations,
  exempt by design (see Cost Visibility in `staff-auth.md`).
- **Consignor payouts:** payment batches, PO Management, unpaid sales, credits
  owed and the Consignment Summary report leave out what is owed or paid
  (batch totals, each rug's cost, the credit total, the report's values) for a
  caller without View cost, who still sees the rugs and counts. Such a caller
  can still create a batch and apply credits: the server totals stored cost,
  and the response carries counts only (`costVisible: false`).

## the POS Quirks

- the POS creates a NEW product record when a rug is re-consigned. Same physical rug, different `CON-xxxx-yy` product number, different barcode in the POS's product record. The physical barcode sticker on the rug stays the same.
- The sales side and purchase side of the POS can use different product numbers for the same rug. The sales order uses whatever product number existed when the rug sold. The PO uses whatever product number exists when payment is processed.
- Dedicated consignment-only POs started partway through the imported history. Before that, consignment items were mixed into regular purchase POs.
- `ConsignmentVendorReturn` model groups return shipments. The return scanner UI and the CSV import both create these records.

## PO Management (Manual Workflow)

The PO management page at `/inventory/consignment/po-management` provides a manual workflow for linking SOLD rugs to payment batches, preparing for post-the POS handoff.

**Unassigned SOLD Rugs**: Lists all SOLD items with no payment batch. Multi-select checkboxes for batch creation with optional PO link and check number.

**API endpoints** (`pages/api/consignment/po-management/`):

- `purchase-orders.ts` -- list the consignor POs with batch status
- `unassigned-sold.ts` -- SOLD items without a payment batch
- `assign-to-batch.ts` -- create payment batch from selected items

All endpoints require MANAGER or ADMIN role. The assign endpoint validates all items are SOLD, same vendor, no existing batch.

## Credits Owed

Page at `/inventory/consignment/credits-owed` shows PAID consignment items where `creditOwed=true`. These represent items the business already paid the consignor for, but the customer returned them. the consignor owes a credit for these. Used to create negative PO lines in the POS for reconciliation.

## Wash Reconciliation

When the sales import processes a batch of orders and the same rug appears on both a sale order and an accounting return in the same import batch, the net effect is zero. Instead of marking the item SOLD and then reverting it, the import detects this "wash" scenario and reverts the item to ON_FLOOR directly. This prevents transient status flicker and incorrect payment batch creation.

## creditOwed Clearing on Re-sale

When a PAID item with `creditOwed=true` re-sells (appears on a new sale order), the import clears `creditOwed` because the credit is no longer owed -- the consignor keeps the original payment and the new sale generates a new payment cycle.

## Key Files

- `lib/consignment.ts` -- matching functions, pricing, state machine
- `lib/paymentService.ts` -- `syncConsignmentSales()`, `syncConsignmentReturns()`
- `lib/importRunners.ts` -- sales import SOLD sync, PO import PAID sync
- `pages/api/consignment/` -- 33 API endpoints (27 + 4 PO management + credits owed)
- `pages/inventory/consignment/` -- 12 UI pages (10 + PO management + credits owed)
- `pages/admin/import/consignment-filemaker.tsx` -- backfill + import tools
- `pages/api/consignment/import/manifest.ts` -- `resolveConsignmentVendor()` resolves by `Vendor.isConsignment` and REFUSES when none is configured. It used to search six name variants, fall back to a hardcoded vendor code, and create a vendor when it still found nothing.

## Verification Checklist

- [ ] `npm test -- consignment` passes
- [ ] Any rug matching uses barcode as primary key, customerNumber as fallback
- [ ] Status transitions use `isValidConsignmentTransition()` -- never set status directly without checking
- [ ] RETURNED_VENDOR is terminal -- nothing transitions out of it
- [ ] PAID -> ON_FLOOR sets `creditOwed=true`
- [ ] New consignment API endpoints have corresponding UI

## Test Coverage

Covered: `calculateRugPricing`, `mapFileMakerStatus`, `isValidConsignmentTransition`, `getValidConsignmentTransitions`

Covered: `__tests__/vendorNumbering.test.ts` (every case the hardcoded version proved, now driven by configuration, plus a second vendor) and `__tests__/consignmentVendor.test.ts` (no route names a consignor; no import creates one)

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

Last verified: 2026-10-01 (Cost visibility; the rest as of 2026-05-20)
