# Consignment

A consigning vendor's goods sit on the floor but stay **theirs** until sold. The business pays the consignor via purchase orders in the POS.

**A vendor consigns when `Vendor.isConsignment` is true.** Nothing resolves a consignor by name. Routes used to — `where: { name: { contains: "the consignor" } }`, with one import route carrying six spellings and three routes CREATING a vendor of that name when they could not find one, which is how a catalog ends up with the same supplier three times. `lib/consignmentVendor.ts` resolves by flag, and a missing configuration is an error rather than a new vendor.

**A deployment with no consigning vendor gets a 404 before any work.** Every route that writes against the single consigning vendor asks `consignmentVendorOr404(prisma, res)` first (rule 42): with none flagged it answers `404 { error: NO_CONSIGNMENT_VENDOR }` ("No consignment vendor configured. Set isConsignment on the vendor first.") and the route returns, having written nothing. The six callers: the consignment-items, manifest, payment-lines and sale-lines imports, the backfill from POS data, and the vendor-return import. Until 2026-11-21 the four imports threw the message from inside their transaction, so it reached the caller only as the body of a 500, the same status as a real fault; the manifest's second message, "Configured consignment vendor no longer exists.", went with its second lookup, since a vendor that no longer exists is not flagged either. `return-items.ts` is the one caller that carries on without a vendor (it sends rugs back without a vendor-return record). `__tests__/consignmentVendor.test.ts` lists every file that calls `getPrimaryConsignmentVendorId(` without the shared check, each with its reason (only `return-items.ts`), and fails both ways: a new such caller, or a listed one that stops calling it. It sees only that call. A route that takes the vendor some other way, such as `(await getConsignmentVendorIds(prisma))[0]` or a `vendor.findFirst` on `isConsignment`, passes it. The admin import tool's CSV section panel (`ConsignmentImportView.tsx`, `ImportSectionPanel`) counts a refused chunk as failed rows and does not show the message; the manifest screen, the backfill and the vendor-return panels show it.

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
| Sales import detects the consignor rug on ORDER                 | ConsignmentItem marked SOLD                                                  | `runSalesImport` in `lib/adapters/legacyPos/runners.ts`, after the batch transaction     |
| Sales import detects RETURNED order (accounting returns) | ConsignmentItem reverted to ON_FLOOR                                         | `paymentService.ts` `syncConsignmentReturns()` |
| PO import sees the consignor PO become RECEIVED_FULL            | Payment batch created, SOLD items → PAID, ON_FLOOR items → PAID + creditOwed | `runPurchaseOrdersImport` in `lib/adapters/legacyPos/runners.ts`, consignment sync block      |
| Return of PAID item                                      | ON_FLOOR + `creditOwed=true`                                                 | `paymentService.ts` `syncConsignmentReturns()` |
| Same-batch sell+return (wash)                            | Revert to ON_FLOOR instead of marking SOLD                                   | `runSalesImport` in `lib/adapters/legacyPos/runners.ts`, wash reconciliation         |
| Re-sale of PAID+creditOwed item                          | Clear `creditOwed` on SOLD transition                                        | `runSalesImport` in `lib/adapters/legacyPos/runners.ts`, consignment sync            |

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

## The Item Page's Actions

`inventory/consignment/[id]/ConsignmentDetailView.tsx`. Each button sends its own request, written out where `__tests__/clientApiRoutes.test.ts` can read it against the route it reaches.

| Button | Request | From |
|---|---|---|
| Send on Approval | `POST items/mark-approval` with `itemIds`, `onApprovalCustomer`, `onApprovalNotes` | ON_FLOOR |
| Mark Sold | `POST items/mark-sold` with `itemIds`, `saleCustomerName`, `saleDate` | ON_FLOOR, ON_APPROVAL |
| Return to Vendor | `POST items/mark-returned` with `itemIds` | ON_FLOOR |
| Return to Floor | `POST items/return-from-approval` with `itemIds`; clears who had it | ON_APPROVAL |
| Mark Missing | `PUT items/[id]` with `status: "MISSING"` | ON_FLOOR |
| Found - Return to Floor | `PUT items/[id]` with `status: "ON_FLOOR"` | MISSING |

The `items/*` actions take a list because they are batch routes. The `PUT` holds the transition rules (`isValidConsignmentTransition`). A sale date is a calendar day stored at UTC midnight, so the page reads it through `parseLocalDate`.

Until 2026-11-06 every button posted to `items/<id>/<action>`, which is no route, with other names for the fields. Real routes and bodies: `__tests__/integration/consignmentItemActions.integration.test.ts`.

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
- `lib/adapters/legacyPos/runners.ts` -- sales import SOLD sync (`runSalesImport`), PO import PAID sync (`runPurchaseOrdersImport`)
- `pages/api/consignment/` -- 33 API endpoints (27 + 4 PO management + credits owed)
- `pages/inventory/consignment/` -- 12 UI pages (10 + PO management + credits owed)
- `app/(dashboard)/app/admin/import/consignment/ConsignmentImportView.tsx` -- backfill + import tools
- `lib/consignmentVendor.ts` -- `getConsignmentVendorIds()` / `getPrimaryConsignmentVendorId()` by `Vendor.isConsignment`, and `consignmentVendorOr404()`, the one refusal for a deployment with none (above)
- `pages/api/consignment/import/manifest.ts` -- resolves the vendor through `consignmentVendorOr404()` and REFUSES when none is configured. It used to search six name variants, fall back to a hardcoded vendor code, and create a vendor when it still found nothing.

## Verification Checklist

- [ ] `npm test -- consignment` passes
- [ ] Any rug matching uses barcode as primary key, customerNumber as fallback
- [ ] Status transitions use `isValidConsignmentTransition()` -- never set status directly without checking
- [ ] RETURNED_VENDOR is terminal -- nothing transitions out of it
- [ ] PAID -> ON_FLOOR sets `creditOwed=true`
- [ ] New consignment API endpoints have corresponding UI

## Test Coverage

Covered: `calculateRugPricing`, `mapFileMakerStatus`, `isValidConsignmentTransition`, `getValidConsignmentTransitions`

Covered: `__tests__/vendorNumbering.test.ts` (every case the hardcoded version proved, now driven by configuration, plus a second vendor) and `__tests__/consignmentVendor.test.ts` (no route names a consignor; no import creates one; `consignmentVendorOr404` answers 404 or returns the vendor; every caller but `return-items.ts` goes through it)

Real database: `__tests__/integration/consignmentVendorRefusal.integration.test.ts` (each of the six routes answers 404 with the message and writes nothing when no vendor is flagged; with one flagged, the backfill and the vendor-return import get past the check)

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

Last verified: 2026-11-21 (the missing-vendor 404 and its callers; Cost visibility 2026-10-01; the rest as of 2026-05-20)
