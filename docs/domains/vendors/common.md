# Vendor Pricing -- Common Patterns

Shared concepts across all vendor pricing imports. Read this before working on any vendor parser.

## Two-Stage Import

1. **Client-side**: User uploads PDF/CSV. Parser extracts structured data (JSON).
2. **Server-side**: Import API endpoint receives parsed data, creates/updates database records in a transaction.

Parsers live in `lib/pricing/`. Import endpoints live in `pages/api/pricing/import/`.

## VendorStyle vs Product

- **VendorStyle** = catalog template from a vendor price list ("a frame"). Has a style number, grade prices, option overrides. Not a physical item.
- **Product** = physical inventory item. Created alongside the VendorStyle during import, linked via `vendorStyleId`.

`Product` has no unique key on `(productNumber, vendorId)` (checked against
`app/prisma/schema.prisma` 2026-11-02), so nothing upserts a product through
one. Whether every price-book import still creates a Product beside its
VendorStyle is [NEEDS VERIFICATION]: `pages/api/pricing/import/jensen-prices.ts`
upserts the VendorStyle only.

## Pricing Models (VendorPricingModel enum)

| Model | How price is determined | Vendors |
|-------|----------------------|---------|
| GRADE_BASED | Price varies by fabric/leather grade tier | Wesley Hall, CR Laine, Brown Jordan, Jensen, Summer Classics |
| FRAME_PLUS_CUSHION | Base frame price + separate cushion grade price | Kingsley Bate |
| SPECIES_MATRIX | Price varies by wood species | Gat Creek |
| MULTI_AXIS | Up to 3 pricing dimensions (species x size x finish) | Gat Creek custom shop |
| AREA_BASED | Price per square foot/yard | -- |
| SIZE_BASED | Discrete sizes with fixed prices | -- |
| FLAT | Single price per product | Consignment rugs, miscellaneous |

## Grade Systems

**Fabric grades**: Numeric (7-60). Lower = less expensive. COM (Customer's Own Material) is grade 0. Grades auto-extend up to 60 during import to support riser extrapolation.

**Leather grades**: Letter-based (C-Z). COM/COL at grade 0. Grades auto-extend through the alphabet.

**Grade riser**: The cost increment per grade step. Used to extrapolate prices for grades not explicitly listed in the price book. Stored on VendorStyle as `gradeRiser`.

**Sort order**: COM/COL first, then numeric ascending, then letter ascending.

## PriceList Versioning

Each import creates a `PriceList` record tracking the vendor, effective date, and version. This allows historical price tracking. The import UI shows which price list is current.

## FabricCatalog

Maps fabric name + color to a vendor's grade tier. Used by the configurator to auto-select the correct grade when a fabric is chosen. Imported via the `fabrics.ts` endpoint.

## VendorOptionGroup / VendorOption / StyleOptionOverride

- **VendorOptionGroup**: Category of options (e.g., "Cushion Upgrade", "Nailhead Trim")
- **VendorOption**: Specific option within a group (e.g., "Comfort Down", "Spring Down")
- **StyleOptionOverride**: Per-style surcharge for an option (e.g., "Comfort Down on style 100 = $100")

Options are seeded via `VENDOR_OPTION_SEEDS` in the import endpoint. Surcharges are mapped via `VENDOR_SURCHARGE_MAP` from parsed product fields. Manual surcharge edits are preserved (upsert with `update: {}` no-op).

## Vendor Name Aliases

`resolveVendorKey()` in `wholesale-prices.ts` normalizes vendor names for matching:

- "CR Laine" / "C R Laine Furniture" / "cr laine" all resolve to "c r laine"

the POS vendor mapping in `productEntryMapping.ts` bridges vendor names to POS supplier names.

## Merging Duplicate Vendors (GAP-22, since 2026-11-02)

`docs/DECISIONS.md` 32. Source: `app/src/lib/vendors/mergeVendor.ts`,
`app/src/lib/vendors/vendorByName.ts`.

- **Where:** Vendors list, a Merge button on each row, for a holder of
  `admin.data` (the key the customer merge takes). Choosing the vendor to keep
  previews what moves, what the kept vendor takes, and why it can't merge yet
  (`GET /api/vendors/[id]/merge?into=`); Merge carries it out (`POST`, body
  `{ intoId }`).
- **What moves:** every row naming the merged vendor, by `VENDOR_REFERENCES`
  (items, contacts, number prefixes, styles, collections, price books, fabrics,
  option groups, programs, components, other-vendor rows, POs, buyer drafts,
  service cases, consignment, import definitions, earlier names). One
  transaction, with both vendor rows locked first (`FOR UPDATE`), so a row
  written against the merged vendor meanwhile waits and then fails rather than
  landing between the moves and the delete. A buyer draft takes the kept
  vendor's name as well as its id: `lib/buyerDraftRealPoLink.ts` compares the
  two.
- **Refused, each named:** a style number, price list, price dimension, fabric
  and colour, option group, program or component on both; an item listing both
  as other vendors, or that would list the kept vendor as its own and another;
  one consignment vendor and one not; a commission rule for the merged vendor.
  Same-named collections fold into the kept vendor's.
- **The kept vendor** keeps its details and pricing and takes only what it
  lacks: code, website, account number, payment and freight terms, lead time,
  minimum order, address, phone, email. The merged vendor's notes are added to
  its own.
- **Earlier names** (`VendorAlias`): the merged vendor's name, and any earlier
  names it had, point at the kept vendor. The vendor window lists them; a
  holder of `admin.data` can forget one (`DELETE /api/vendors/[id]/aliases`),
  after which the next import of it makes a new vendor.
- **Finding a vendor by name** goes only through `vendorByName.ts`:
  `findVendorByName` / `findVendorsByName` / `vendorIdByName`,
  `findOrCreateVendor(Id)`, and for runners `vendorNameIndex` +
  `findOrCreateInIndex`. A vendor's own name wins over an earlier one, and an
  exact match over one ignoring case; each caller keeps its own matching (exact
  or ignoring case). `__tests__/vendorNameLookups.test.ts` fails on a vendor
  found by name, or created, anywhere else.
- **Adding a vendor** on the vendors screen refuses a name a vendor or earlier
  name already has, ignoring case (409), where it used to fail with a 500 on an
  exact duplicate and accept a case twin.
- **Caches:** the POS import's cached Unknown Vendor id is re-read after
  any merge in the process (`vendorMergeCount`). `lib/vendorPrefixService.ts`
  caches prefixes with their vendor ids until restart; only the prefixes are
  read (`vendorIdForNumber` has no callers), so a merge leaves nothing stale
  that's used.

## Server-Only Module Constraint

`pdf-parse` uses Node's `fs` and cannot be imported from files pulled into client bundles. **If a parser uses `pdf-parse`, it must live in a separate file that is only imported by API routes.**

- `wesleyHallParser.ts` -- imported by client-side import page. SE logic separated to `seParser.ts`.
- `crLaineExtractor.ts` -- API-only import, safe.
- `hdProposalParser.ts` -- API-only, safe.

## Verification Checklist (All Vendors)

- [ ] `npm test -- wesleyHallParser priceCalculator pricingUtils` passes
- [ ] Parser does not import `pdf-parse` if also imported client-side
- [ ] Import creates both VendorStyle and Product in a transaction [NEEDS VERIFICATION]
- [ ] Grade tiers auto-extend correctly
- [ ] Option seeds use upsert with `update: {}` to preserve manual edits
- [ ] New vendor added to `productEntryMapping.ts` for POS matching

---
Last verified: 2026-04-07
